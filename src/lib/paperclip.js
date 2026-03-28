// All API calls go through the BFF server-side proxy (server.cjs).
// No API key in the client bundle — authentication via HttpOnly session cookie.
const COMPANY_ID = import.meta.env.VITE_PAPERCLIP_COMPANY_ID || '';

// ── Paperclip API proxy ───────────────────────────────────────────────────────

async function apiGet(path) {
  const response = await fetch(`/api/lexpanel/proxy${path}`);
  if (response.status === 401) {
    // Session expired — notify App component to show login screen
    localStorage.removeItem('lexpanel_authed');
    window.dispatchEvent(new Event('lexpanel:session-expired'));
    return null;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Error API (${response.status}): ${text || 'sin detalle'}`);
  }
  return response.json();
}

export async function fetchAgents() {
  return apiGet(`/api/companies/${COMPANY_ID}/agents`);
}

export async function fetchIssues() {
  return apiGet(`/api/companies/${COMPANY_ID}/issues?status=todo,in_progress,blocked,done`);
}

export async function fetchIssueComments(issueId) {
  return apiGet(`/api/issues/${issueId}/comments`);
}

export async function fetchIssueDocuments(issueId) {
  try {
    return await apiGet(`/api/issues/${issueId}/documents`);
  } catch {
    return [];
  }
}

// ── OCR API proxy ─────────────────────────────────────────────────────────────

async function ocrApiGet(path) {
  const response = await fetch(`/api/lexpanel/ocr${path}`);
  if (response.status === 401) {
    localStorage.removeItem('lexpanel_authed');
    window.dispatchEvent(new Event('lexpanel:session-expired'));
    return null;
  }
  if (!response.ok) {
    let message = '';
    try {
      const data = await response.json();
      message = data?.error || '';
    } catch { /* ignore */ }
    throw new Error(message || 'Servicio de documentos no disponible');
  }
  return response.json();
}

export async function fetchDocuments(issueId) {
  if (!issueId) return [];
  return ocrApiGet(`/api/documents?issueId=${encodeURIComponent(issueId)}`);
}

export function getDocumentFileUrl(fileId) {
  // Relative same-origin URL — browser includes session cookie automatically
  return `/api/lexpanel/ocr/api/documents/${encodeURIComponent(fileId)}/file`;
}

export async function getDocumentText(fileId) {
  if (!fileId) return { text: '' };
  return ocrApiGet(`/api/documents/${encodeURIComponent(fileId)}/text`);
}

export function uploadDocument(issueId, file, onProgress) {
  if (!issueId) {
    return Promise.reject(new Error('Caso no seleccionado'));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/lexpanel/ocr/api/documents/upload?issueId=${encodeURIComponent(issueId)}`, true);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onProgress !== 'function') return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status === 401) {
        localStorage.removeItem('lexpanel_authed');
        window.dispatchEvent(new Event('lexpanel:session-expired'));
        reject(new Error('Sesión expirada'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || '{}'));
          return;
        } catch {
          resolve({});
          return;
        }
      }
      try {
        const data = JSON.parse(xhr.responseText || '{}');
        reject(new Error(data?.error || 'Servicio de documentos no disponible'));
      } catch {
        reject(new Error('Servicio de documentos no disponible'));
      }
    };

    xhr.onerror = () => reject(new Error('Servicio de documentos no disponible'));

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}
