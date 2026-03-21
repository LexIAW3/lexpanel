import { parseEuroAmount } from './format';

const FIELD_ALIASES = {
  nombre: ['nombre', 'cliente', 'name'],
  email: ['email', 'correo', 'mail'],
  telefono: ['telefono', 'teléfono', 'phone', 'movil', 'móvil'],
  tipo: ['tipo', 'tipo reclamacion', 'tipo reclamación', 'reclamacion', 'reclamación'],
  importeReclamado: ['importe reclamado', 'importe_reclamado', 'amount_claimed', 'reclamado'],
  importeCobrado: ['importe cobrado', 'importe_cobrado', 'amount_collected', 'cobrado'],
};

function pickField(obj, aliases) {
  const entries = Object.entries(obj || {});
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase().trim();
    if (aliases.includes(normalized)) return value;
  }
  return '';
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonBlock(description) {
  const trimmed = description.trim();
  const direct = safeJsonParse(trimmed);
  if (direct && typeof direct === 'object') return direct;

  const blockMatch = description.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!blockMatch) return null;
  const parsed = safeJsonParse(blockMatch[1]);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function captureFromText(description, aliases) {
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:=-]\\s*(.+)`, 'i');
    const match = description.match(regex);
    if (match) return match[1].trim();
  }
  return '';
}

export function parseIssueDetails(issue) {
  const description = issue?.description || '';
  const jsonData = parseJsonBlock(description) || {};

  const nombre = pickField(jsonData, FIELD_ALIASES.nombre) || captureFromText(description, FIELD_ALIASES.nombre);
  const email = pickField(jsonData, FIELD_ALIASES.email) || captureFromText(description, FIELD_ALIASES.email);
  const telefono = pickField(jsonData, FIELD_ALIASES.telefono) || captureFromText(description, FIELD_ALIASES.telefono);
  const tipo = pickField(jsonData, FIELD_ALIASES.tipo) || captureFromText(description, FIELD_ALIASES.tipo);

  const importeReclamadoRaw =
    pickField(jsonData, FIELD_ALIASES.importeReclamado) || captureFromText(description, FIELD_ALIASES.importeReclamado);
  const importeCobradoRaw =
    pickField(jsonData, FIELD_ALIASES.importeCobrado) || captureFromText(description, FIELD_ALIASES.importeCobrado);

  const amountMatches = description.match(/(?:\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]?\d*)\s*€/g) || [];
  const fallbackReclamado = amountMatches[0] ? parseEuroAmount(amountMatches[0]) : 0;
  const fallbackCobrado = amountMatches[1] ? parseEuroAmount(amountMatches[1]) : 0;

  return {
    nombre: nombre || 'Sin nombre',
    email: email || '-',
    telefono: telefono || '-',
    tipo: tipo || 'No especificado',
    importeReclamado: parseEuroAmount(importeReclamadoRaw) || fallbackReclamado,
    importeCobrado: parseEuroAmount(importeCobradoRaw) || fallbackCobrado,
  };
}
