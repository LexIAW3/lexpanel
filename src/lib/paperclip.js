const API_URL = import.meta.env.VITE_PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
const COMPANY_ID = import.meta.env.VITE_PAPERCLIP_COMPANY_ID || '';
const API_KEY = import.meta.env.VITE_PAPERCLIP_API_KEY || '';
const OCR_API_URL = import.meta.env.VITE_OCR_API_URL || 'http://127.0.0.1:3200';

function requiredConfig() {
  if (!API_URL || !COMPANY_ID || !API_KEY) {
    throw new Error('Faltan variables de entorno de Paperclip. Revisa tu .env');
  }
}

async function apiGet(path) {
  requiredConfig();
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });

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

function requiredOcrConfig() {
  if (!OCR_API_URL) {
    throw new Error('Servicio de documentos no disponible');
  }
}

async function ocrApiGet(path) {
  requiredOcrConfig();
  const response = await fetch(`${OCR_API_URL}${path}`);
  if (!response.ok) {
    let message = '';
    try {
      const data = await response.json();
      message = data?.error || '';
    } catch {
      message = '';
    }
    throw new Error(message || 'Servicio de documentos no disponible');
  }
  return response.json();
}

export async function fetchDocuments(issueId) {
  if (!issueId) return [];
  return ocrApiGet(`/api/documents?issueId=${encodeURIComponent(issueId)}`);
}

export function getDocumentFileUrl(fileId) {
  requiredOcrConfig();
  return `${OCR_API_URL}/api/documents/${encodeURIComponent(fileId)}/file`;
}

export async function getDocumentText(fileId) {
  if (!fileId) return { text: '' };
  return ocrApiGet(`/api/documents/${encodeURIComponent(fileId)}/text`);
}

export function uploadDocument(issueId, file, onProgress) {
  requiredOcrConfig();
  if (!issueId) {
    return Promise.reject(new Error('Caso no seleccionado'));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `${OCR_API_URL}/api/documents/upload?issueId=${encodeURIComponent(issueId)}`,
      true,
    );

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onProgress !== 'function') return;
      const progress = Math.round((event.loaded / event.total) * 100);
      onProgress(progress);
    };

    xhr.onload = () => {
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
