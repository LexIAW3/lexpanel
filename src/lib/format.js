export const LEGAL_AGENT_NAMES = new Set([
  'GestorReclamaciones',
  'AbogadoBancario',
  'AbogadoMonitorio',
  'AbogadoAdministrativista',
]);

export const STATUS_OPTIONS = [
  'Todos',
  'Nuevo lead',
  'En proceso',
  'Pendiente documentación',
  'Resuelto',
  'Cobrado',
];

export const STATUS_STYLE = {
  'Nuevo lead': { label: 'Nuevo lead', bg: '#DBEAFE', fg: '#1E40AF', dot: '#3B82F6' },
  'En proceso': { label: 'En proceso', bg: '#FEF3C7', fg: '#92400E', dot: '#F59E0B' },
  'Pendiente documentación': { label: 'Pendiente documentación', bg: '#FFEDD5', fg: '#9A3412', dot: '#F97316' },
  Resuelto: { label: 'Resuelto', bg: '#DCFCE7', fg: '#166534', dot: '#22C55E' },
  Cobrado: { label: 'Cobrado', bg: '#E5E7EB', fg: '#374151', dot: '#6B7280' },
};

export function parseEuroAmount(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (!input) return 0;
  const normalized = String(input)
    .replace(/€/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const value = Number(normalized.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

export function formatMoney(value) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(value || 0);
}

export function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function mapPaperclipStatus(issue, importeCobrado) {
  const state = issue?.status;
  if (state === 'todo' || state === 'backlog') return 'Nuevo lead';
  if (state === 'in_progress') return 'En proceso';
  if (state === 'blocked') return 'Pendiente documentación';
  if (state === 'done') return importeCobrado > 0 ? 'Cobrado' : 'Resuelto';
  return 'En proceso';
}
