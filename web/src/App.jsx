import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';
import { Loading } from './ui.jsx';
import Overview from './pages/Overview.jsx';
import Content from './pages/Content.jsx';
import Learners from './pages/Learners.jsx';
import Connect from './pages/Connect.jsx';
import Alerts from './pages/Alerts.jsx';

const NAV = [
  ['/', 'Overview'],
  ['/content', 'Content insights'],
  ['/learners', 'Learners'],
  ['/connect', 'Connect a course'],
  ['/alerts', 'Alerts & reports']
];

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="#60A5FA" strokeWidth="3" />
      <line x1="18" y1="18" x2="25" y2="25" stroke="#60A5FA" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Login({ onDone }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setToken(value.trim());
    try {
      const s = await api('/api/session');
      if (s.ok) onDone(); else setError('That token is not correct.');
    } catch { setError('Could not reach the server.'); }
  }
  return (
    <form className="card login stack" onSubmit={submit}>
      <div className="title-row"><Logo /><h1 style={{ fontSize: 22 }}>LearnLens</h1></div>
      <p className="muted" style={{ margin: 0 }}>Enter the admin token for this LearnLens server (the ADMIN_TOKEN it was started with).</p>
      <label className="field">Admin token
        <input className="input" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus required />
      </label>
      {error && <div className="error-box" role="alert">{error}</div>}
      <button className="btn primary" type="submit">Sign in</button>
    </form>
  );
}

export default function App() {
  const [auth, setAuth] = useState({ checked: false, ok: false, required: false });

  async function check() {
    try {
      const s = await api('/api/session');
      setAuth({ checked: true, ok: s.ok, required: s.authRequired });
    } catch {
      setAuth({ checked: true, ok: false, required: true });
    }
  }
  useEffect(() => {
    check();
    const onUnauthorized = () => { setToken(''); setAuth((a) => ({ ...a, ok: false })); };
    window.addEventListener('learnlens:unauthorized', onUnauthorized);
    return () => window.removeEventListener('learnlens:unauthorized', onUnauthorized);
  }, []);

  if (!auth.checked) return <Loading what="LearnLens" />;
  if (!auth.ok) return <Login onDone={check} />;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <NavLink to="/" className="brand"><Logo /><span>LearnLens</span></NavLink>
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{label}</NavLink>
        ))}
        <div className="nav-foot">
          LearnLens 0.1 · open source (MIT)
          {auth.required && getToken() && (
            <><br /><button className="btn ghost small" style={{ color: '#93C5FD', padding: 0, minHeight: 28 }} onClick={() => { setToken(''); check(); }}>Sign out</button></>
          )}
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/content" element={<Content />} />
          <Route path="/learners" element={<Learners />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
