export const pct = (v, digits = 0) => (v === null || v === undefined || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(digits)}%`);

export function delta(cur, prev, { points = true } = {}) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  const d = points ? (cur - prev) * 100 : prev ? ((cur - prev) / prev) * 100 : null;
  if (d === null) return null;
  const r = Math.round(d);
  return { value: r, text: `${r > 0 ? '▲' : r < 0 ? '▼' : '■'} ${Math.abs(r)}${points ? ' pts' : '%'}` };
}

export function minutes(m) {
  if (m === null || m === undefined) return '–';
  if (m < 1) return `${Math.round(m * 60)}s`;
  if (m < 60) return `${Math.floor(m)}m ${String(Math.round((m % 1) * 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

export function ago(iso) {
  if (!iso) return 'Never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(iso).toLocaleDateString();
}

export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('') || '?';

export function heatColor(v) {
  if (v === null || v === undefined) return { bg: '#F1F4F8', fg: '#5B6474' };
  if (v >= 0.8) return { bg: 'var(--heat-4)', fg: '#fff' };
  if (v >= 0.65) return { bg: 'var(--heat-3)', fg: 'var(--ink)' };
  if (v >= 0.5) return { bg: 'var(--heat-2)', fg: 'var(--ink)' };
  return { bg: 'var(--heat-1)', fg: '#fff' };
}

export const CRON_PRESETS = [
  { cron: '0 9 * * 1', label: 'Every Monday, 9:00' },
  { cron: '0 17 * * 5', label: 'Every Friday, 17:00' },
  { cron: '0 8 * * *', label: 'Every day, 8:00' },
  { cron: '0 8 1 * *', label: '1st of every month, 8:00' }
];
export const cronLabel = (c) => (CRON_PRESETS.find((p) => p.cron === c) || { label: `Schedule: ${c}` }).label;
