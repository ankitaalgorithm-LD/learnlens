import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

/** Fetch JSON from the API; re-runs when `path` changes. */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) { setState({ data: null, error: null, loading: false }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error) => live && setState({ data: null, error, loading: false }));
    return () => { live = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={setMsg}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Loading({ what = 'data' }) {
  return <div className="spinner" role="status">Loading {what}…</div>;
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="error-box" role="alert">
      {error?.message || 'Something went wrong.'}{' '}
      {onRetry && <button className="btn small" onClick={onRetry} style={{ marginLeft: 8 }}>Try again</button>}
    </div>
  );
}

export function PageHead({ title, subtitle, sample, children }) {
  return (
    <header className="page-head">
      <div>
        <div className="title-row">
          <h1>{title}</h1>
          {sample && <span className="pill sample" title="Data created by the bot learner simulator">Demo data</span>}
        </div>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

export function Kpi({ label, value, trend, trendGood, note }) {
  const cls = !trend ? '' : trend.value === 0 ? 'flat' : (trend.value > 0) === trendGood ? 'up' : 'down';
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="num kpi-value">{value}</div>
      {trend && <div className={`kpi-trend ${cls}`}>{trend.text} <span className="muted" style={{ fontWeight: 400 }}>vs. previous period</span></div>}
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}

/** Multi-series line chart in plain SVG (values 0..1). */
export function LineChart({ labels, series, height = 230, min = null, max = null, ariaLabel }) {
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  if (!all.length) return <p className="muted small">Not enough data yet.</p>;
  let lo = min ?? Math.max(0, Math.floor((Math.min(...all) - 0.05) * 10) / 10);
  let hi = max ?? Math.min(1, Math.ceil((Math.max(...all) + 0.05) * 10) / 10);
  if (hi - lo < 0.2) { lo = Math.max(0, lo - 0.1); hi = Math.min(1, hi + 0.1); }
  const W = 640, H = height, L = 44, R = 20, T = 16, B = 30;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, labels.length - 1);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = hi - lo > 0.4 ? 0.2 : hi - lo > 0.2 ? 0.1 : 0.05;
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#EEF1F4" />
          <text x={4} y={y(t) + 4} fontSize="11" fill="#5B6474">{Math.round(t * 100)}%</text>
        </g>
      ))}
      {labels.map((l, i) => (i % 3 === 0 || i === labels.length - 1) && (
        <text key={l} x={x(i)} y={H - 8} fontSize="11" fill="#5B6474" textAnchor="middle">{l}</text>
      ))}
      {series.map((s) => {
        const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [x(i), y(v)])).filter(Boolean);
        return (
          <g key={s.name}>
            <polyline fill="none" stroke={s.color} strokeWidth="3" strokeLinejoin="round" strokeDasharray={s.dashed ? '7 5' : undefined} points={pts.map((p) => p.join(',')).join(' ')} />
            {s.values.map((v, i) => v !== null && v !== undefined && (
              <circle key={i} cx={x(i)} cy={y(v)} r={i === s.values.length - 1 ? 5 : 3} fill={s.color}>
                <title>{`${s.name}, ${labels[i]}: ${Math.round(v * 100)}%`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export function Bar({ value, color = 'var(--accent)', height = 26, marker = null, label }) {
  return (
    <div className="bar-track" style={{ height }} aria-label={label}>
      <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(1, value || 0)) * 100}%`, background: color }} />
      {marker !== null && <div style={{ position: 'absolute', top: -4, bottom: -4, width: 2, background: 'var(--ink)', left: `${Math.min(1, marker) * 100}%` }} />}
    </div>
  );
}
