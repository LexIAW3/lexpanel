'use strict';
/**
 * LexPanel BFF (Backend For Frontend)
 *
 * Replaces `vite preview` as the production runtime for LexPanel.
 * - Serves static files from dist/
 * - POST /api/lexpanel/login   — validates credentials, sets HttpOnly session cookie
 * - POST /api/lexpanel/logout  — clears session cookie
 * - GET  /api/lexpanel/proxy/* — authenticated read-only proxy to Paperclip API
 * - *    /api/lexpanel/ocr/*   — authenticated proxy to OCR server (upload/download)
 *
 * IMPORTANT: LEXPANEL_API_KEY, LEXPANEL_PANEL_USER, LEXPANEL_PANEL_PASSWORD
 * are server-side secrets — never VITE_* prefixed, never in the bundle.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader — no extra dependencies.
// Only sets vars NOT already in process.env (inherited vars take precedence).
(function loadEnv(envPath) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* file not found — rely on inherited env */ }
}(path.join(__dirname, '.env')));

const PORT = Number(process.env.LEXPANEL_PORT) || 8090;
const DIST_DIR = process.env.LEXPANEL_DIST_DIR || path.join(__dirname, 'bff-dist');
const PAPERCLIP_API = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || '';
const LEXPANEL_API_KEY = process.env.LEXPANEL_API_KEY || '';
const PANEL_USER = process.env.LEXPANEL_PANEL_USER || '';
const PANEL_PASSWORD = process.env.LEXPANEL_PANEL_PASSWORD || '';
const OCR_SERVER = process.env.OCR_SERVER_URL || 'http://127.0.0.1:3200';
const OCR_SHARED_SECRET = String(
  process.env.OCR_SHARED_SECRET || process.env.PAPERCLIP_API_KEY || ''
).trim();
const COOKIE_SECURE =
  process.env.NODE_ENV === 'production' ||
  String(process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const SESSION_COOKIE = 'lex_panel_session';
const sessions = new Map(); // token → { username, expiresAtMs }

// ── Login rate limiting ────────────────────────────────────────────────────────
const LOGIN_MAX_ATTEMPTS = 10;       // max failed attempts before lockout
const LOGIN_WINDOW_MS    = 15 * 60 * 1000; // 15-minute rolling window
const loginAttempts = new Map();    // ip → { count, windowStart }

function getClientIp(req) {
  // nginx injects X-Real-IP; fall back to socket address for direct access
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (now - entry.windowStart > LOGIN_WINDOW_MS) { loginAttempts.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  if (!header) return {};
  return header.split(';').reduce((acc, pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return acc;
    try { acc[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim()); } catch { /* skip */ }
    return acc;
  }, {});
}

function getSession(req) {
  const token = String(parseCookies(req)[SESSION_COOKIE] || '').trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAtMs <= Date.now()) { sessions.delete(token); return null; }
  return session;
}

function buildSessionCookie(token, maxAge) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/api/lexpanel',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

// ── Security headers ──────────────────────────────────────────────────────────

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // CSP for the staff panel: self-hosted SPA + Google Fonts
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
    ].join('; '),
  );
}

// ── Util ──────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

async function handleLogin(req, res) {
  if (!PANEL_USER || !PANEL_PASSWORD || !LEXPANEL_API_KEY) {
    return sendJson(res, 503, { error: 'Panel no configurado. Contacte al administrador.' });
  }
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return sendJson(res, 429, { error: 'Demasiados intentos fallidos. Inténtelo de nuevo en 15 minutos.' });
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'JSON inválido' });
  }
  const validUser = typeof body?.username === 'string' &&
    crypto.timingSafeEqual(Buffer.from(body.username.padEnd(256)), Buffer.from(PANEL_USER.padEnd(256)));
  const validPass = typeof body?.password === 'string' &&
    crypto.timingSafeEqual(Buffer.from(body.password.padEnd(256)), Buffer.from(PANEL_PASSWORD.padEnd(256)));
  if (!validUser || !validPass) {
    recordFailedLogin(ip);
    return sendJson(res, 401, { error: 'Usuario o contraseña incorrectos' });
  }
  clearLoginAttempts(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: body.username, expiresAtMs: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', buildSessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
  sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  const token = String(parseCookies(req)[SESSION_COOKIE] || '');
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', buildSessionCookie('', 0));
  sendJson(res, 200, { ok: true });
}

function handleSessionCheck(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'No autenticado' });
  sendJson(res, 200, { ok: true, username: session.username });
}

// ── Paperclip proxy ───────────────────────────────────────────────────────────

// Whitelist of allowed API path prefixes (read-only access for LexPanel)
function isAllowedPaperclipPath(apiPath) {
  if (!COMPANY_ID) return false;
  return (
    apiPath === `/api/companies/${COMPANY_ID}/agents` ||
    apiPath.startsWith(`/api/companies/${COMPANY_ID}/agents?`) ||
    apiPath === `/api/companies/${COMPANY_ID}/issues` ||
    apiPath.startsWith(`/api/companies/${COMPANY_ID}/issues?`) ||
    (apiPath.startsWith('/api/issues/') && !apiPath.includes('..'))
  );
}

async function handlePaperclipProxy(req, res, reqUrl) {
  if (!getSession(req)) return sendJson(res, 401, { error: 'No autenticado' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Método no permitido' });

  const apiPath = reqUrl.pathname.replace('/api/lexpanel/proxy', '');
  if (!isAllowedPaperclipPath(apiPath)) return sendJson(res, 403, { error: 'Ruta no permitida' });

  const fullPath = apiPath + reqUrl.search;
  try {
    const r = await fetch(`${PAPERCLIP_API}${fullPath}`, {
      headers: { Authorization: `Bearer ${LEXPANEL_API_KEY}` },
    });
    const body = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(body);
  } catch {
    sendJson(res, 502, { error: 'API no disponible' });
  }
}

// ── OCR proxy ─────────────────────────────────────────────────────────────────

async function handleOcrProxy(req, res, reqUrl) {
  if (!getSession(req)) return sendJson(res, 401, { error: 'No autenticado' });

  const ocrPath = reqUrl.pathname.replace('/api/lexpanel/ocr', '');
  const fullPath = ocrPath + reqUrl.search;

  const fetchOpts = { method: req.method };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await readBody(req);
    fetchOpts.body = body;
    if (req.headers['content-type']) {
      fetchOpts.headers = { 'content-type': req.headers['content-type'] };
    }
  }
  if (OCR_SHARED_SECRET) {
    fetchOpts.headers = {
      ...(fetchOpts.headers || {}),
      'x-ocr-shared-secret': OCR_SHARED_SECRET,
    };
  }

  try {
    const r = await fetch(`${OCR_SERVER}${fullPath}`, fetchOpts);
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    const body = await r.arrayBuffer();
    res.writeHead(r.status, { 'Content-Type': contentType });
    res.end(Buffer.from(body));
  } catch {
    sendJson(res, 502, { error: 'Servicio de documentos no disponible' });
  }
}

// ── Static file server ────────────────────────────────────────────────────────

function serveStatic(req, res, reqUrl) {
  const raw = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  const filePath = path.join(DIST_DIR, raw);

  // Security: prevent path traversal
  if (!filePath.startsWith(DIST_DIR + path.sep) && filePath !== DIST_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath);
  // No extension → SPA route: fall back to index.html
  const target = ext ? filePath : path.join(DIST_DIR, 'index.html');

  fs.readFile(target, (err, data) => {
    if (err) {
      // Static assets (paths with extensions) must return 404 — never SPA fallback.
      // Only extension-less paths (SPA routes) fall back to index.html, and those
      // already set target = index.html above, so this branch handles only asset 404s.
      if (ext) { res.writeHead(404); res.end('Not Found'); return; }
      // Extension-less path where index.html itself is missing
      res.writeHead(404); res.end('Not Found'); return;
    }
    const mime = MIME[path.extname(target)] || 'application/octet-stream';
    const headers = { 'Content-Type': mime };
    const e = path.extname(target);
    if (e === '.js' || e === '.css') {
      // Vite outputs content-hashed filenames — safe to cache aggressively
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (e && e !== '.html') {
      // Non-hashed static assets (favicon/images/fonts) should be cacheable
      // with a shorter TTL so branding/content updates propagate quickly.
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ── Request router ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const { pathname } = reqUrl;

    if (pathname === '/api/lexpanel/login' && req.method === 'POST') {
      await handleLogin(req, res); return;
    }
    if (pathname === '/api/lexpanel/logout' && req.method === 'POST') {
      handleLogout(req, res); return;
    }
    if (pathname === '/api/lexpanel/session' && req.method === 'GET') {
      handleSessionCheck(req, res); return;
    }
    if (pathname.startsWith('/api/lexpanel/proxy/')) {
      await handlePaperclipProxy(req, res, reqUrl); return;
    }
    if (pathname.startsWith('/api/lexpanel/ocr/')) {
      await handleOcrProxy(req, res, reqUrl); return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, reqUrl); return;
    }

    res.writeHead(404); res.end('Not Found');
  } catch (err) {
    console.error('[LexPanel BFF] Unhandled error:', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
  }
});

// Periodically sweep expired sessions and stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAtMs <= now) sessions.delete(token);
  }
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[LexPanel BFF] http://127.0.0.1:${PORT}`);
  if (!LEXPANEL_API_KEY) console.warn('[LexPanel BFF] WARN: LEXPANEL_API_KEY not set — proxy disabled');
  if (!PANEL_USER || !PANEL_PASSWORD) console.warn('[LexPanel BFF] WARN: credentials not set — login disabled');
});

// Prevent unhandled errors from crashing the process (and wiping in-memory sessions)
process.on('uncaughtException', (err) => {
  console.error('[LexPanel BFF] Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[LexPanel BFF] Unhandled rejection:', reason);
});
