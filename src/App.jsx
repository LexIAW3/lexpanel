import { useCallback, useEffect, useMemo, useState } from 'react';
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

const POLL_MS = 30000;
const MAX_DOC_SIZE = 10 * 1024 * 1024;
const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const INVOICE_STORAGE_KEY = 'lexpanel_invoices_v1';
const INVOICE_TYPE_OPTIONS = [
  { value: 'inicial', label: 'Inicial' },
  { value: 'complementaria', label: 'Complementaria' },
  { value: 'exito', label: 'Honorarios de exito' },
];
const INVOICE_STATE_OPTIONS = ['Todos', 'Borrador', 'Enviada', 'Pagada'];

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getSeriesPrefix(caseType) {
  const type = normalizeText(caseType);
  if (type.includes('irph') || type.includes('clausul') || type.includes('banc')) return 'IRPH';
  if (type.includes('monitor') || type.includes('deuda')) return 'MON';
  if (type.includes('administ')) return 'ADM';
  return 'GEN';
}

function buildInvoiceNumber(invoices, prefix, nowDate = new Date()) {
  const year = nowDate.getUTCFullYear();
  const maxInSeries = invoices
    .filter((invoice) => invoice.seriesPrefix === prefix && invoice.year === year)
    .reduce((max, invoice) => Math.max(max, Number(invoice.sequence) || 0), 0);
  const sequence = maxInSeries + 1;
  return {
    year,
    sequence,
    invoiceNumber: `${prefix}-${year}-${String(sequence).padStart(4, '0')}`,
  };
}

function canCreateSuccessFee(issue) {
  if (!issue) return false;
  const closed = issue.status === 'done' || issue.status === 'cancelled';
  const recovered = Number(issue.details?.importeCobrado || 0) > 0;
  if (closed && !recovered) return false;
  return true;
}

function formatInvoiceType(type) {
  return INVOICE_TYPE_OPTIONS.find((t) => t.value === type)?.label || type;
}

function formatInvoiceAmountText(value) {
  return `${Number(value || 0).toFixed(2)} EUR`;
}

function escapePdfText(input) {
  return String(input || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildInvoicePdfBlob(invoice) {
  const lines = [
    `Factura ${invoice.invoiceNumber}`,
    `Fecha: ${new Date(invoice.createdAt).toLocaleDateString('es-ES')}`,
    `Serie: ${invoice.seriesPrefix}`,
    `Tipo: ${formatInvoiceType(invoice.invoiceType)}`,
    `Cliente: ${invoice.clientName}`,
    `Email: ${invoice.clientEmail}`,
    `Expediente: ${invoice.issueIdentifier}`,
    `Concepto: ${invoice.concept}`,
    `Importe: ${formatInvoiceAmountText(invoice.amount)}`,
    `Estado: ${invoice.state}`,
  ];

  const textContent = lines
    .map((line, index) => `1 0 0 1 48 ${790 - index * 22} Tm (${escapePdfText(line)}) Tj`)
    .join('\n');
  const stream = `BT\n/F1 12 Tf\n${textContent}\nET`;

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += `${object}\n`;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Blob([pdf], { type: 'application/pdf' });
}

function downloadInvoicePdf(invoice) {
  const blob = buildInvoicePdfBlob(invoice);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `factura-${invoice.invoiceNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getBillingPrefillFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      issueId: params.get('issueId') || '',
      invoiceType: params.get('invoiceType') || 'inicial',
      concept: params.get('concept') || '',
    };
  } catch {
    return { issueId: '', invoiceType: 'inicial', concept: '' };
  }
}

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

function IconReceipt() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 3h16v18l-2.5-1.8L15 21l-2.5-1.8L10 21l-2.5-1.8L5 21 4 20z" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </svg>
  );
}

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

function StatCard({ label, value, accent }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className={`stat-value ${accent ? 'stat-value--accent' : ''}`}>{value}</p>
    </div>
  );
}

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

  const loadDocuments = useCallback(async () => {
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
  }, [issueIdentifier]);

  useEffect(() => {
    setExpandedId('');
    setTextByFileId({});
    if (!issueIdentifier) { setDocuments([]); return; }
    loadDocuments();
  }, [issueIdentifier, loadDocuments]);

  const onUpload = async (file) => {
    if (!file || uploading) return;
    if (!ALLOWED_DOC_TYPES.includes(file.type)) { setError('Solo se permiten archivos JPG, PNG o PDF'); return; }
    if (file.size > MAX_DOC_SIZE) { setError('El archivo supera el tamaño maximo de 10MB'); return; }
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
          <span>Procesando OCR... {uploadProgress}%</span>
        </div>
      ) : null}

      {error ? <p className="doc-error">{error}</p> : null}

      {loadingDocs ? (
        <p className="doc-empty">Cargando documentos...</p>
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
                      value={extractedText === undefined ? 'Cargando texto extraido...' : extractedText}
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

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/lexpanel/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || 'Usuario o contrasena incorrectos');
        return;
      }
      setError('');
      onLogin(username);
    } catch {
      setError('Error de conexion. Intentalo de nuevo.');
    }
  };

  return (
    <main className="login-root">
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo-mark" aria-hidden="true">
            <svg width="36" height="36" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2.78824 11V4.09091H4.249V9.79563H7.211V11H2.78824Z" fill="white"/>
              <path d="M8.17838 11V4.09091H10.9042C11.426 4.09091 11.8713 4.18424 12.2402 4.37092C12.6113 4.55534 12.8935 4.81735 13.0869 5.15696C13.2826 5.49432 13.3804 5.89128 13.3804 6.34783C13.3804 6.80664 13.2815 7.20135 13.0836 7.53196C12.8856 7.86032 12.5989 8.11222 12.2233 8.28764C11.85 8.46307 11.3979 8.55078 10.8671 8.55078H9.04201V7.37678H10.631C10.9099 7.37678 11.1415 7.33854 11.3259 7.26207C11.5104 7.18561 11.6475 7.0709 11.7375 6.91797C11.8297 6.76503 11.8758 6.57499 11.8758 6.34783C11.8758 6.11843 11.8297 5.92501 11.7375 5.76758C11.6475 5.61014 11.5092 5.49094 11.3226 5.40998C11.1381 5.32676 10.9054 5.28516 10.6242 5.28516H9.63914V11H8.17838ZM11.9096 7.85582L13.6267 11H12.0141L10.3341 7.85582H11.9096Z" fill="#2563EB"/>
            </svg>
          </span>
        </div>
        <h1 className="login-title">LexPanel</h1>
        <p className="login-subtitle">Acceso para equipo juridico</p>

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
            Contrasena
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

function CaseDetail({ issue, onClose, onAddAdditionalCharge }) {
  const [comments, setComments] = useState([]);

  useEffect(() => {
    if (!issue) return undefined;
    let active = true;
    fetchIssueComments(issue.id)
      .then((list) => { if (active) setComments(Array.isArray(list) ? list : []); })
      .catch(() => { if (active) setComments([]); });
    return () => { active = false; };
  }, [issue]);

  if (!issue) {
    return (
      <div className="detail-empty">
        <IconBriefcase />
        <p>Selecciona un caso para ver su ficha</p>
      </div>
    );
  }

  const { details, lexStatus, identifier, updatedAt } = issue;

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
            <button type="button" className="detail-action-btn" onClick={() => onAddAdditionalCharge(issue)}>
              Anadir cobro adicional
            </button>
          </div>
          <dl className="detail-grid">
            {[
              ['Cliente', details.nombre],
              ['Email', details.email],
              ['Telefono', details.telefono],
              ['Tipo', details.tipo],
              ['Importe reclamado', formatMoney(details.importeReclamado)],
              ['Importe cobrado', formatMoney(details.importeCobrado)],
              ['Ultima actualizacion', formatDate(updatedAt)],
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
            <p className="doc-empty">Sin comentarios todavia</p>
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

function BillingModule({ issues }) {
  const [invoices, setInvoices] = useState(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(INVOICE_STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const initialPrefill = getBillingPrefillFromUrl();
  const [issueId, setIssueId] = useState(initialPrefill.issueId);
  const [invoiceType, setInvoiceType] = useState(initialPrefill.invoiceType);
  const [concept, setConcept] = useState(initialPrefill.concept);
  const [amount, setAmount] = useState('');
  const [statusFilter, setStatusFilter] = useState('Todos');
  const [seriesFilter, setSeriesFilter] = useState('Todas');
  const [clientFilter, setClientFilter] = useState('');
  const [issueFilter, setIssueFilter] = useState('');
  const [formError, setFormError] = useState('');
  const [flash, setFlash] = useState('');

  useEffect(() => {
    localStorage.setItem(INVOICE_STORAGE_KEY, JSON.stringify(invoices));
  }, [invoices]);

  const issueMap = useMemo(() => {
    const map = new Map();
    for (const issue of issues) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const orderedIssues = useMemo(
    () => issues.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)),
    [issues],
  );

  const selectedIssue = issueMap.get(issueId) || null;

  const uniqueSeries = useMemo(() => {
    const set = new Set(invoices.map((invoice) => invoice.seriesPrefix));
    return ['Todas', ...Array.from(set).sort()];
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    return invoices
      .filter((invoice) => statusFilter === 'Todos' || invoice.state === statusFilter)
      .filter((invoice) => seriesFilter === 'Todas' || invoice.seriesPrefix === seriesFilter)
      .filter((invoice) => {
        if (!clientFilter.trim()) return true;
        return normalizeText(invoice.clientName).includes(normalizeText(clientFilter));
      })
      .filter((invoice) => {
        if (!issueFilter.trim()) return true;
        return normalizeText(invoice.issueIdentifier).includes(normalizeText(issueFilter));
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [invoices, statusFilter, seriesFilter, clientFilter, issueFilter]);

  const billingStats = useMemo(() => {
    const total = invoices.length;
    const sent = invoices.filter((invoice) => invoice.state === 'Enviada').length;
    const paid = invoices.filter((invoice) => invoice.state === 'Pagada').length;
    const totalAmount = invoices.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
    return { total, sent, paid, totalAmount };
  }, [invoices]);

  const createInvoice = (e) => {
    e.preventDefault();
    const issue = issueMap.get(issueId);
    if (!issue) {
      setFormError('Selecciona un expediente.');
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setFormError('Introduce un importe valido mayor que 0.');
      return;
    }
    if (!concept.trim()) {
      setFormError('El concepto es obligatorio.');
      return;
    }
    if (invoiceType === 'exito' && !canCreateSuccessFee(issue)) {
      setFormError('No se puede facturar exito: expediente cerrado sin recuperacion economica.');
      return;
    }

    const now = new Date();
    const prefix = getSeriesPrefix(issue.details?.tipo);
    const numbering = buildInvoiceNumber(invoices, prefix, now);
    const clientEmail = issue.details?.email && issue.details.email !== '-' ? issue.details.email : '';

    const invoice = {
      id: `inv_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      invoiceNumber: numbering.invoiceNumber,
      seriesPrefix: prefix,
      year: numbering.year,
      sequence: numbering.sequence,
      invoiceType,
      concept: concept.trim(),
      amount: numericAmount,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      clientId: clientEmail ? clientEmail.toLowerCase() : issue.id,
      clientName: issue.details?.nombre || 'Cliente',
      clientEmail,
      state: 'Borrador',
      createdAt: now.toISOString(),
      sentAt: null,
      linkedIssueStatus: issue.status,
    };

    setInvoices((prev) => [invoice, ...prev]);
    setFormError('');
    setFlash(`Factura ${invoice.invoiceNumber} creada y vinculada a ${issue.identifier}.`);
    setAmount('');
    setConcept(invoiceType === 'complementaria' ? 'Cobro adicional' : '');
  };

  const updateInvoiceState = (invoiceId, nextState) => {
    setInvoices((prev) => prev.map((invoice) => (invoice.id === invoiceId ? { ...invoice, state: nextState } : invoice)));
  };

  const sendInvoiceEmail = (invoice) => {
    if (!invoice.clientEmail) {
      setFormError('El expediente no tiene email de cliente para el envio.');
      return;
    }

    const subject = `Factura ${invoice.invoiceNumber}`;
    const body = [
      `Hola ${invoice.clientName},`,
      '',
      `Adjuntamos la factura ${invoice.invoiceNumber}.`,
      `Concepto: ${invoice.concept}`,
      `Importe: ${formatMoney(invoice.amount)}`,
      `Expediente: ${invoice.issueIdentifier}`,
      '',
      'Gracias.',
    ].join('\n');

    const mailto = `mailto:${encodeURIComponent(invoice.clientEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const a = document.createElement('a');
    a.href = mailto;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setInvoices((prev) => prev.map((current) => (current.id === invoice.id
      ? { ...current, state: current.state === 'Pagada' ? 'Pagada' : 'Enviada', sentAt: new Date().toISOString() }
      : current)));
    setFlash(`Email de factura ${invoice.invoiceNumber} preparado para ${invoice.clientEmail}.`);
  };

  const successFeeBlocked = invoiceType === 'exito' && selectedIssue && !canCreateSuccessFee(selectedIssue);

  return (
    <div className="billing-layout">
      <div className="page-header">
        <div>
          <h1 className="page-title">Facturacion</h1>
          <p className="page-subtitle">Series automaticas por tipo de expediente y numeracion correlativa anual</p>
        </div>
      </div>

      <div className="stats-row">
        <StatCard label="Total facturas" value={billingStats.total} />
        <StatCard label="Enviadas" value={billingStats.sent} />
        <StatCard label="Pagadas" value={billingStats.paid} accent />
        <StatCard label="Importe total" value={formatMoney(billingStats.totalAmount)} accent />
      </div>

      {formError ? <div className="error-banner">{formError}</div> : null}
      {flash ? <div className="success-banner">{flash}</div> : null}

      <section className="billing-card">
        <h2 className="billing-title">Nueva factura</h2>
        <form className="billing-form" onSubmit={createInvoice}>
          <label className="field-label">
            Expediente
            <select className="field-input" value={issueId} onChange={(e) => setIssueId(e.target.value)} required>
              <option value="">Seleccionar expediente</option>
              {orderedIssues.map((issue) => (
                <option key={issue.id} value={issue.id}>
                  {issue.identifier} · {issue.details.nombre}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label">
            Tipo de factura
            <select className="field-input" value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}>
              {INVOICE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="field-label billing-form-wide">
            Concepto
            <input
              className="field-input"
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              placeholder="Ej.: Honorarios iniciales de estudio"
              required
            />
          </label>

          <label className="field-label">
            Importe (EUR)
            <input
              className="field-input"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </label>

          <div className="billing-meta">
            {selectedIssue ? (
              <>
                <p><strong>Serie:</strong> {getSeriesPrefix(selectedIssue.details?.tipo)}-{new Date().getUTCFullYear()}-NNNN</p>
                <p><strong>expedienteId:</strong> {selectedIssue.id}</p>
                <p><strong>clienteId:</strong> {(selectedIssue.details?.email && selectedIssue.details.email !== '-') ? selectedIssue.details.email.toLowerCase() : selectedIssue.id}</p>
              </>
            ) : (
              <p>Selecciona expediente para calcular serie y vinculos automáticos.</p>
            )}
            {successFeeBlocked ? (
              <p className="billing-warning">Bloqueado: no se permite factura de exito en expediente cerrado sin recuperacion.</p>
            ) : null}
          </div>

          <button type="submit" className="btn-primary">Crear factura</button>
        </form>
      </section>

      <section className="billing-card">
        <div className="billing-filters">
          <label className="field-label">
            Serie
            <select className="field-input" value={seriesFilter} onChange={(e) => setSeriesFilter(e.target.value)}>
              {uniqueSeries.map((series) => (
                <option key={series} value={series}>{series}</option>
              ))}
            </select>
          </label>

          <label className="field-label">
            Estado
            <select className="field-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {INVOICE_STATE_OPTIONS.map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </select>
          </label>

          <label className="field-label">
            Cliente
            <input className="field-input" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} placeholder="Nombre cliente" />
          </label>

          <label className="field-label">
            Expediente
            <input className="field-input" value={issueFilter} onChange={(e) => setIssueFilter(e.target.value)} placeholder="LEX-123" />
          </label>
        </div>

        <div className="case-table-wrap billing-table-wrap">
          <table className="case-table billing-table">
            <thead>
              <tr>
                <th>Factura</th>
                <th>Serie</th>
                <th>Estado</th>
                <th>Cliente</th>
                <th>Expediente</th>
                <th>Importe</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan="7" className="table-empty">No hay facturas con estos filtros</td>
                </tr>
              ) : (
                filteredInvoices.map((invoice) => (
                  <tr key={invoice.id} className="case-row">
                    <td className="case-cell case-cell--name">
                      {invoice.invoiceNumber}
                      <div className="billing-subline">{formatInvoiceType(invoice.invoiceType)} · {formatDate(invoice.createdAt)}</div>
                    </td>
                    <td className="case-cell">{invoice.seriesPrefix}</td>
                    <td className="case-cell">{invoice.state}</td>
                    <td className="case-cell">{invoice.clientName}</td>
                    <td className="case-cell">{invoice.issueIdentifier}</td>
                    <td className="case-cell">{formatMoney(invoice.amount)}</td>
                    <td className="case-cell">
                      <div className="billing-actions">
                        <button type="button" className="doc-download-btn" onClick={() => downloadInvoicePdf(invoice)}>
                          PDF
                        </button>
                        <button type="button" className="doc-download-btn" onClick={() => sendInvoiceEmail(invoice)}>
                          Email
                        </button>
                        <button type="button" className="doc-download-btn" onClick={() => updateInvoiceState(invoice.id, 'Pagada')}>
                          Marcar pagada
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function App() {
  const storedAuthed = localStorage.getItem('lexpanel_authed') === '1';
  const initialView = window.location.pathname.startsWith('/facturacion') ? 'facturacion' : 'casos';

  const [isAuthed, setIsAuthed] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(!storedAuthed);
  const [username, setUsername] = useState(localStorage.getItem('lexpanel_user') || 'abogado');
  const [theme, setTheme] = useState(localStorage.getItem('lexpanel_theme') || 'dark');
  const [activeView, setActiveView] = useState(initialView);
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
    if (!storedAuthed) return;
    fetch('/api/lexpanel/session')
      .then((r) => {
        if (r.ok) {
          setIsAuthed(true);
        } else {
          localStorage.removeItem('lexpanel_authed');
          localStorage.removeItem('lexpanel_user');
        }
      })
      .catch(() => {
        localStorage.removeItem('lexpanel_authed');
        localStorage.removeItem('lexpanel_user');
      })
      .finally(() => setSessionChecked(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isAuthed) return;
    let active = true;

    const load = async () => {
      try {
        const [agentList, issueList] = await Promise.all([fetchAgents(), fetchIssues()]);
        if (!active) return;
        if (!agentList || !issueList) return;
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

  useEffect(() => {
    const onPopState = () => {
      setActiveView(window.location.pathname.startsWith('/facturacion') ? 'facturacion' : 'casos');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const filteredIssues = useMemo(() => {
    if (statusFilter === 'Todos') return issues;
    return issues.filter((i) => i.lexStatus === statusFilter);
  }, [issues, statusFilter]);

  const selectedIssue =
    filteredIssues.find((i) => i.id === selectedIssueId) ||
    issues.find((i) => i.id === selectedIssueId) ||
    null;

  const stats = useMemo(() => {
    const total = issues.length;
    const inProgress = issues.filter((i) => i.lexStatus === 'En proceso').length;
    const pending = issues.filter((i) => i.lexStatus === 'Pendiente documentación').length;
    const totalCobrado = issues.reduce((s, i) => s + (i.details?.importeCobrado || 0), 0);
    return { total, inProgress, pending, totalCobrado };
  }, [issues]);

  const logout = async () => {
    try { await fetch('/api/lexpanel/logout', { method: 'POST' }); } catch { /* ignore */ }
    localStorage.removeItem('lexpanel_authed');
    localStorage.removeItem('lexpanel_user');
    setIsAuthed(false);
  };

  useEffect(() => {
    const onExpired = () => logout();
    window.addEventListener('lexpanel:session-expired', onExpired);
    return () => window.removeEventListener('lexpanel:session-expired', onExpired);
  }, []);

  const onLogin = (user) => {
    localStorage.setItem('lexpanel_authed', '1');
    localStorage.setItem('lexpanel_user', user);
    setUsername(user);
    setIsAuthed(true);
  };

  const navigate = (view) => {
    const nextPath = view === 'facturacion' ? '/facturacion' : '/';
    if (window.location.pathname !== nextPath || window.location.search) {
      window.history.pushState({}, '', nextPath);
    }
    setActiveView(view);
  };

  const openAdditionalCharge = (issue) => {
    const params = new URLSearchParams({
      issueId: issue.id,
      invoiceType: 'complementaria',
      concept: 'Cobro adicional',
    });
    window.history.pushState({}, '', `/facturacion?${params.toString()}`);
    setActiveView('facturacion');
  };

  if (!sessionChecked) return null;
  if (!isAuthed) return <Login onLogin={onLogin} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <span className="sidebar-logo-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.78824 11V4.09091H4.249V9.79563H7.211V11H2.78824Z" fill="white"/>
                <path d="M8.17838 11V4.09091H10.9042C11.426 4.09091 11.8713 4.18424 12.2402 4.37092C12.6113 4.55534 12.8935 4.81735 13.0869 5.15696C13.2826 5.49432 13.3804 5.89128 13.3804 6.34783C13.3804 6.80664 13.2815 7.20135 13.0836 7.53196C12.8856 7.86032 12.5989 8.11222 12.2233 8.28764C11.85 8.46307 11.3979 8.55078 10.8671 8.55078H9.04201V7.37678H10.631C10.9099 7.37678 11.1415 7.33854 11.3259 7.26207C11.5104 7.18561 11.6475 7.0709 11.7375 6.91797C11.8297 6.76503 11.8758 6.57499 11.8758 6.34783C11.8758 6.11843 11.8297 5.92501 11.7375 5.76758C11.6475 5.61014 11.5092 5.49094 11.3226 5.40998C11.1381 5.32676 10.9054 5.28516 10.6242 5.28516H9.63914V11H8.17838ZM11.9096 7.85582L13.6267 11H12.0141L10.3341 7.85582H11.9096Z" fill="#2563EB"/>
              </svg>
            </span>
            <span className="sidebar-brand-name">LexPanel</span>
          </div>

          <nav className="sidebar-nav">
            <button
              type="button"
              className={`sidebar-nav-item ${activeView === 'casos' ? 'sidebar-nav-item--active' : ''}`}
              onClick={() => navigate('casos')}
            >
              <IconBriefcase />
              <span>Casos</span>
            </button>
            <button
              type="button"
              className={`sidebar-nav-item ${activeView === 'facturacion' ? 'sidebar-nav-item--active' : ''}`}
              onClick={() => navigate('facturacion')}
            >
              <IconReceipt />
              <span>Facturacion</span>
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
            <button type="button" className="sidebar-icon-btn" onClick={logout} title="Cerrar sesion">
              <IconLogOut />
            </button>
          </div>
        </div>
      </aside>

      <div className="main-area">
        {activeView === 'facturacion' ? (
          <BillingModule issues={issues} />
        ) : (
          <>
            <div className="page-header">
              <div>
                <h1 className="page-title">Casos activos</h1>
                <p className="page-subtitle">
                  {refreshAt ? `Actualizado ${formatDate(refreshAt)}` : 'Cargando...'}
                </p>
              </div>
            </div>

            <div className="stats-row">
              <StatCard label="Total casos" value={loading ? '...' : stats.total} />
              <StatCard label="En proceso" value={loading ? '...' : stats.inProgress} accent />
              <StatCard label="Pendiente docs" value={loading ? '...' : stats.pending} />
              <StatCard label="Total cobrado" value={loading ? '...' : formatMoney(stats.totalCobrado)} accent />
            </div>

            {error ? (
              <div className="error-banner">{error}</div>
            ) : null}

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

            <div className={`content-grid ${selectedIssue ? 'content-grid--split' : ''}`}>
              <section className="case-list-panel">
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
                          <td colSpan="7" className="table-empty">Cargando casos...</td>
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

                <div className="case-cards">
                  {loading ? (
                    <p className="doc-empty">Cargando casos...</p>
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

              <CaseDetail
                issue={selectedIssue}
                onClose={() => setSelectedIssueId('')}
                onAddAdditionalCharge={openAdditionalCharge}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
