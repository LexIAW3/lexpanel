import { useEffect, useMemo, useState } from 'react';
import {
  LEGAL_AGENT_NAMES,
  STATUS_OPTIONS,
  STATUS_STYLE,
  formatDate,
  formatMoney,
  mapPaperclipStatus,
} from './lib/format';
import { parseIssueDetails } from './lib/parser';
import {
  fetchAgents,
  fetchDocuments,
  getDocumentFileUrl,
  getDocumentText,
  fetchIssueComments,
  fetchIssues,
  uploadDocument,
} from './lib/paperclip';

const ADMIN_USER = import.meta.env.VITE_ADMIN_USER || 'abogado';
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || 'lexreclama2026';
const POLL_MS = 30000;
const MAX_DOC_SIZE = 10 * 1024 * 1024;
const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

// ── Icons ────────────────────────────────────────────────────────────────────

function IconBriefcase() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      <line x1="12" y1="12" x2="12" y2="12.01" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function IconLogOut() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 16 12 12 8 16" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
    </svg>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE['En proceso'];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ backgroundColor: style.bg, color: style.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: style.dot }} aria-hidden="true" />
      {style.label}
    </span>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className={`stat-value ${accent ? 'stat-value--accent' : ''}`}>{value}</p>
    </div>
  );
}

// ── Document section ──────────────────────────────────────────────────────────

function fileTypeLabel(mimeType) {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'image/png') return 'PNG';
  if (mimeType === 'image/jpeg') return 'JPG';
  return 'ARCHIVO';
}

function DocumentsSection({ issueIdentifier }) {
  const [documents, setDocuments] = useState([]);
  const [expandedId, setExpandedId] = useState('');
  const [textByFileId, setTextByFileId] = useState({});
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const loadDocuments = async () => {
    if (!issueIdentifier) return;
    setLoadingDocs(true);
    try {
      const docs = await fetchDocuments(issueIdentifier);
      setDocuments(Array.isArray(docs) ? docs : []);
      setError('');
    } catch {
      setDocuments([]);
      setError('Servicio de documentos no disponible');
    } finally {
      setLoadingDocs(false);
    }
  };

  useEffect(() => {
    setExpandedId('');
    setTextByFileId({});
    if (!issueIdentifier) { setDocuments([]); return; }
    loadDocuments();
  }, [issueIdentifier]);

  const onUpload = async (file) => {
    if (!file || uploading) return;
    if (!ALLOWED_DOC_TYPES.includes(file.type)) { setError('Solo se permiten archivos JPG, PNG o PDF'); return; }
    if (file.size > MAX_DOC_SIZE) { setError('El archivo supera el tamaño máximo de 10MB'); return; }
    setUploading(true);
    setUploadProgress(0);
    setError('');
    try {
      await uploadDocument(issueIdentifier, file, setUploadProgress);
      await loadDocuments();
    } catch {
      setError('Servicio de documentos no disponible');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const onExpand = async (fileId) => {
    const nextId = expandedId === fileId ? '' : fileId;
    setExpandedId(nextId);
    if (!nextId || textByFileId[fileId] !== undefined) return;
    try {
      const data = await getDocumentText(fileId);
      setTextByFileId((prev) => ({ ...prev, [fileId]: data?.text || '' }));
    } catch {
      setTextByFileId((prev) => ({ ...prev, [fileId]: 'No se pudo cargar el texto extraido.' }));
    }
  };

  return (
    <div className="detail-section">
      <div className="detail-section-header">
        <IconFolder />
        <h3 className="detail-section-title">Documentos</h3>
        <span className="detail-section-count">{documents.length}</span>
      </div>

      <div
        className={`upload-zone ${isDragging ? 'upload-zone--active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!uploading) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer?.files?.[0]; if (f) onUpload(f); }}
      >
        <label className="upload-btn">
          <IconUpload />
          <span>Subir documento</span>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
          />
        </label>
        <span className="upload-hint">JPG, PNG o PDF · max 10 MB</span>
      </div>

      {uploading ? (
        <div className="upload-progress">
          <div className="upload-progress-bar" style={{ width: `${uploadProgress}%` }} />
          <span>Procesando OCR… {uploadProgress}%</span>
        </div>
      ) : null}

      {error ? <p className="doc-error">{error}</p> : null}

      {loadingDocs ? (
        <p className="doc-empty">Cargando documentos…</p>
      ) : documents.length === 0 ? (
        <p className="doc-empty">No hay documentos en este caso</p>
      ) : (
        <ul className="doc-list">
          {documents
            .slice()
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .map((doc) => {
              const isExpanded = expandedId === doc.fileId;
              const extractedText = textByFileId[doc.fileId];
              return (
                <li key={doc.fileId} className="doc-item">
                  <div className="doc-item-row">
                    <button type="button" className="doc-item-btn" onClick={() => onExpand(doc.fileId)}>
                      <span className={`doc-type-chip doc-type-chip--${doc.mimeType === 'application/pdf' ? 'pdf' : 'img'}`}>
                        {fileTypeLabel(doc.mimeType)}
                      </span>
                      <div className="doc-item-info">
                        <p className="doc-item-name">{doc.filename || 'Documento'}</p>
                        <p className="doc-item-date">{doc.createdAt ? formatDate(doc.createdAt) : '-'}</p>
                      </div>
                      <span className={`doc-chevron ${isExpanded ? 'doc-chevron--open' : ''}`}>
                        <IconChevronRight />
                      </span>
                    </button>
                    <a
                      href={getDocumentFileUrl(doc.fileId)}
                      target="_blank"
                      rel="noreferrer"
                      className="doc-download-btn"
                    >
                      Descargar
                    </a>
                  </div>
                  {isExpanded ? (
                    <textarea
                      readOnly
                      value={extractedText === undefined ? 'Cargando texto extraido…' : extractedText}
                      className="doc-text-area"
                    />
                  ) : null}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

// ── Login ─────────────────────────────────────────────────────────────────────

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
      setError('');
      onLogin(username);
      return;
    }
    setError('Usuario o contraseña incorrectos');
  };

  return (
    <main className="login-root">
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo-mark">L</span>
        </div>
        <h1 className="login-title">LexPanel</h1>
        <p className="login-subtitle">Acceso para equipo jurídico</p>

        <form onSubmit={submit} className="login-form">
          <label className="field-label">
            Usuario
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="field-input"
              placeholder="abogado"
              required
            />
          </label>
          <label className="field-label">
            Contraseña
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field-input"
              required
            />
          </label>
          {error ? <p className="field-error">{error}</p> : null}
          <button type="submit" className="btn-primary btn-primary--full">
            Entrar
          </button>
        </form>
      </div>
    </main>
  );
}

// ── Case detail panel ─────────────────────────────────────────────────────────

function CaseDetail({ issue, onClose }) {
  const [comments, setComments] = useState([]);

  useEffect(() => {
    if (!issue) { setComments([]); return; }
    let active = true;
    fetchIssueComments(issue.id)
      .then((list) => { if (active) setComments(Array.isArray(list) ? list : []); })
      .catch(() => { if (active) setComments([]); });
    return () => { active = false; };
  }, [issue?.id]);

  if (!issue) {
    return (
      <div className="detail-empty">
        <IconBriefcase />
        <p>Selecciona un caso para ver su ficha</p>
      </div>
    );
  }

  const { details, lexStatus, identifier, title, updatedAt } = issue;

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <div className="detail-header-top">
          <div>
            <p className="detail-id">{identifier}</p>
            <p className="detail-name">{details.nombre}</p>
          </div>
          <button type="button" className="detail-close-btn" onClick={onClose} aria-label="Cerrar">
            <IconX />
          </button>
        </div>
        <StatusBadge status={lexStatus} />
      </div>

      <div className="detail-body">
        <div className="detail-section">
          <div className="detail-section-header">
            <h3 className="detail-section-title">Datos del caso</h3>
          </div>
          <dl className="detail-grid">
            {[
              ['Cliente', details.nombre],
              ['Email', details.email],
              ['Teléfono', details.telefono],
              ['Tipo', details.tipo],
              ['Importe reclamado', formatMoney(details.importeReclamado)],
              ['Importe cobrado', formatMoney(details.importeCobrado)],
              ['Última actualización', formatDate(updatedAt)],
            ].map(([k, v]) => (
              <div key={k} className="detail-row">
                <dt className="detail-dt">{k}</dt>
                <dd className="detail-dd">{v || '-'}</dd>
              </div>
            ))}
          </dl>
        </div>

        <DocumentsSection issueIdentifier={identifier} />

        <div className="detail-section">
          <div className="detail-section-header">
            <h3 className="detail-section-title">Comunicaciones</h3>
            <span className="detail-section-count">{comments.length}</span>
          </div>
          {comments.length === 0 ? (
            <p className="doc-empty">Sin comentarios todavía</p>
          ) : (
            <ul className="comments-list">
              {comments.map((c) => (
                <li key={c.id} className="comment-item">
                  <p className="comment-date">{formatDate(c.createdAt)}</p>
                  <p className="comment-body">{c.body || '(sin contenido)'}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────

function App() {
  const [isAuthed, setIsAuthed] = useState(localStorage.getItem('lexpanel_authed') === '1');
  const [username, setUsername] = useState(localStorage.getItem('lexpanel_user') || ADMIN_USER);
  const [theme, setTheme] = useState(localStorage.getItem('lexpanel_theme') || 'dark');
  const [issues, setIssues] = useState([]);
  const [selectedIssueId, setSelectedIssueId] = useState('');
  const [statusFilter, setStatusFilter] = useState('Todos');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshAt, setRefreshAt] = useState('');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('lexpanel_theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!isAuthed) return;
    let active = true;

    const load = async () => {
      try {
        const [agentList, issueList] = await Promise.all([fetchAgents(), fetchIssues()]);
        if (!active) return;
        const legalIds = new Set(
          agentList.filter((a) => LEGAL_AGENT_NAMES.has(a?.name)).map((a) => a.id),
        );
        const mapped = issueList
          .filter((i) => legalIds.has(i.assigneeAgentId))
          .map((i) => {
            const details = parseIssueDetails(i);
            return { ...i, details, lexStatus: mapPaperclipStatus(i, details.importeCobrado) };
          })
          .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        setIssues(mapped);
        setRefreshAt(new Date().toISOString());
        setError('');
        if (!selectedIssueId && mapped[0]) setSelectedIssueId(mapped[0].id);
      } catch (err) {
        setError(err.message || 'No se pudieron cargar los casos');
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    const timer = setInterval(load, POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [isAuthed, selectedIssueId]);

  const filteredIssues = useMemo(() => {
    if (statusFilter === 'Todos') return issues;
    return issues.filter((i) => i.lexStatus === statusFilter);
  }, [issues, statusFilter]);

  const selectedIssue =
    filteredIssues.find((i) => i.id === selectedIssueId) ||
    issues.find((i) => i.id === selectedIssueId) ||
    null;

  // KPI stats
  const stats = useMemo(() => {
    const total = issues.length;
    const inProgress = issues.filter((i) => i.lexStatus === 'En proceso').length;
    const pending = issues.filter((i) => i.lexStatus === 'Pendiente documentación').length;
    const totalCobrado = issues.reduce((s, i) => s + (i.details?.importeCobrado || 0), 0);
    return { total, inProgress, pending, totalCobrado };
  }, [issues]);

  const onLogin = (user) => {
    localStorage.setItem('lexpanel_authed', '1');
    localStorage.setItem('lexpanel_user', user);
    setUsername(user);
    setIsAuthed(true);
  };

  const logout = () => {
    localStorage.removeItem('lexpanel_authed');
    localStorage.removeItem('lexpanel_user');
    setIsAuthed(false);
  };

  if (!isAuthed) return <Login onLogin={onLogin} />;

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <span className="sidebar-logo-mark">L</span>
            <span className="sidebar-brand-name">LexPanel</span>
          </div>

          <nav className="sidebar-nav">
            <button type="button" className="sidebar-nav-item sidebar-nav-item--active">
              <IconBriefcase />
              <span>Casos</span>
            </button>
          </nav>
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-user">
            <div className="sidebar-avatar">{username[0]?.toUpperCase()}</div>
            <span className="sidebar-username">{username}</span>
          </div>
          <div className="sidebar-actions">
            <button
              type="button"
              className="sidebar-icon-btn"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
            >
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
            <button type="button" className="sidebar-icon-btn" onClick={logout} title="Cerrar sesión">
              <IconLogOut />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="main-area">
        {/* Page header */}
        <div className="page-header">
          <div>
            <h1 className="page-title">Casos activos</h1>
            <p className="page-subtitle">
              {refreshAt ? `Actualizado ${formatDate(refreshAt)}` : 'Cargando…'}
            </p>
          </div>
        </div>

        {/* KPI row */}
        <div className="stats-row">
          <StatCard label="Total casos" value={loading ? '…' : stats.total} />
          <StatCard label="En proceso" value={loading ? '…' : stats.inProgress} accent />
          <StatCard label="Pendiente docs" value={loading ? '…' : stats.pending} />
          <StatCard label="Total cobrado" value={loading ? '…' : formatMoney(stats.totalCobrado)} accent />
        </div>

        {/* Error banner */}
        {error ? (
          <div className="error-banner">{error}</div>
        ) : null}

        {/* Filter pills */}
        <div className="filter-row">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setStatusFilter(opt)}
              className={`filter-pill ${statusFilter === opt ? 'filter-pill--active' : ''}`}
            >
              {opt}
            </button>
          ))}
          <span className="filter-count">
            {filteredIssues.length} caso{filteredIssues.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Content grid */}
        <div className={`content-grid ${selectedIssue ? 'content-grid--split' : ''}`}>
          {/* Case list */}
          <section className="case-list-panel">
            {/* Desktop table */}
            <div className="case-table-wrap">
              <table className="case-table">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Tipo</th>
                    <th>Reclamado</th>
                    <th>Cobrado</th>
                    <th>Estado</th>
                    <th>Actualizado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan="7" className="table-empty">Cargando casos…</td>
                    </tr>
                  ) : filteredIssues.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="table-empty">No hay casos para este filtro</td>
                    </tr>
                  ) : (
                    filteredIssues.map((issue) => (
                      <tr
                        key={issue.id}
                        onClick={() => setSelectedIssueId(issue.id)}
                        className={`case-row ${selectedIssueId === issue.id ? 'case-row--active' : ''}`}
                      >
                        <td className="case-cell case-cell--name">{issue.details.nombre}</td>
                        <td className="case-cell case-cell--muted">{issue.details.tipo}</td>
                        <td className="case-cell">{formatMoney(issue.details.importeReclamado)}</td>
                        <td className="case-cell">{formatMoney(issue.details.importeCobrado)}</td>
                        <td className="case-cell"><StatusBadge status={issue.lexStatus} /></td>
                        <td className="case-cell case-cell--muted">{formatDate(issue.updatedAt)}</td>
                        <td className="case-cell case-cell--chevron"><IconChevronRight /></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="case-cards">
              {loading ? (
                <p className="doc-empty">Cargando casos…</p>
              ) : filteredIssues.length === 0 ? (
                <p className="doc-empty">No hay casos para este filtro</p>
              ) : (
                filteredIssues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => setSelectedIssueId(issue.id)}
                    className={`case-card ${selectedIssueId === issue.id ? 'case-card--active' : ''}`}
                  >
                    <div className="case-card-top">
                      <p className="case-card-name">{issue.details.nombre}</p>
                      <StatusBadge status={issue.lexStatus} />
                    </div>
                    <p className="case-card-tipo">{issue.details.tipo}</p>
                    <div className="case-card-bottom">
                      <span>{formatMoney(issue.details.importeReclamado)}</span>
                      <span className="case-cell--muted">{formatDate(issue.updatedAt)}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* Detail panel */}
          <CaseDetail
            issue={selectedIssue}
            onClose={() => setSelectedIssueId('')}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
