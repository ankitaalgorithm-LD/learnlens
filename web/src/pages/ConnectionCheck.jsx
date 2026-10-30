import { useEffect, useState } from 'react';
import { api, download } from '../api.js';
import { ago } from '../format.js';

/** Re-fetch a path every few seconds while the component is on screen. */
function usePoll(path, ms = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    let timer;
    const tick = async () => {
      try { const d = await api(path); if (live) { setData(d); setError(null); } } catch (e) { if (live) setError(e); }
      if (live && !document.hidden) timer = setTimeout(tick, ms);
      else if (live) timer = setTimeout(tick, ms * 3);
    };
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [path, ms]);
  return { data, error };
}

const ICON = {
  ok: ['✓', 'var(--good)'],
  true: ['✓', 'var(--good)'],
  warn: ['!', '#B45309'],
  error: ['!', 'var(--warn)'],
  false: ['!', 'var(--warn)'],
  info: ['i', '#64748B']
};

function StatusIcon({ status }) {
  const [sym, color] = ICON[String(status)] || ICON.info;
  return (
    <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', background: color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flex: 'none' }}>{sym}</span>
  );
}

function CheckRow({ status, label, detail, fix }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr)', gap: 10, padding: '10px 0', borderTop: '1px solid var(--line-2)' }}>
      <StatusIcon status={status} />
      <div>
        <div style={{ fontWeight: 600 }}>{label}<span className="sr-only"> ({String(status)})</span></div>
        {detail && <div className="small" style={{ color: 'var(--ink-2)', marginTop: 2, wordBreak: 'break-word' }}>{detail}</div>}
        {fix && <div className="callout warn" style={{ marginTop: 6 }}>{fix}</div>}
      </div>
    </div>
  );
}

/** Server configuration checklist (HTTPS, public address, secrets, database). */
export function SetupCheck() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { api('/api/setup-check').then(setData).catch(() => {}); }, []);
  if (!data) return null;
  const problems = data.items.filter((i) => i.status === 'error' || i.status === 'warn');
  const errors = data.items.filter((i) => i.status === 'error').length;
  const expanded = open;
  return (
    <section className="card" style={{ borderColor: errors ? '#F5C2A5' : undefined }}>
      <div className="card-head">
        <div className="title-row">
          <StatusIcon status={errors ? 'error' : problems.length ? 'warn' : 'ok'} />
          <h2>Server setup</h2>
          <span className="small muted">
            {errors ? `${errors} thing${errors > 1 ? 's' : ''} to fix before real learners can be tracked` : problems.length ? 'Ready for testing on this computer' : 'Ready for real learners'}
          </span>
        </div>
        <button className="btn small" aria-expanded={expanded} onClick={() => setOpen((v) => !v)}>{expanded ? 'Hide details' : 'Show details'}</button>
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {data.items.map((i) => <CheckRow key={i.id} status={i.status} label={i.label} detail={i.detail} fix={i.status === 'ok' || i.status === 'info' ? null : i.fix} />)}
          <p className="tiny muted" style={{ margin: '10px 0 0' }}>Settings are environment variables on the server. See the README section “Put it online for real learners”.</p>
        </div>
      )}
    </section>
  );
}

/** Downloadable test package + results reported from inside the LMS. */
export function ConnectionTest({ course }) {
  const { data } = usePoll(`/api/courses/${course.id}/diagnostics`, 5000);
  const latest = data && data[0];
  return (
    <div className="card grow-3 stack" style={{ gap: 14 }}>
      <div className="card-head"><h2>Test the connection from your LMS</h2></div>
      <p className="small" style={{ margin: 0, color: 'var(--ink-2)' }}>Before tracking a real course, check that your LMS lets courses send data to LearnLens. The test package runs every check from inside the LMS and reports back here.</p>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <li className="stat">
          <div className="label">Step 1</div>
          <div style={{ marginTop: 4, marginBottom: 8 }}>Download the test package</div>
          <button className="btn small primary" onClick={() => download(`/api/courses/${course.id}/test-package`, 'learnlens-connection-test.zip')}>Download test .zip</button>
        </li>
        <li className="stat"><div className="label">Step 2</div><div style={{ marginTop: 4 }}>Add it to your LMS as a <strong>SCORM package</strong> and open it as a learner</div></li>
        <li className="stat"><div className="label">Step 3</div><div style={{ marginTop: 4 }}>Results appear here automatically</div></li>
      </ol>
      {!latest && (
        <div className="callout plain" role="status"><span className="dot" style={{ background: '#94A3B8', marginRight: 8 }} />Waiting for a test run… (this updates by itself)</div>
      )}
      {latest && (
        <div>
          <div className={`callout ${latest.ok ? 'info' : 'warn'}`} style={latest.ok ? { background: 'var(--good-soft)', color: 'var(--good-ink)' } : undefined} role="status">
            <strong>{latest.ok ? 'Passed.' : 'Problems found.'}</strong> Test run from <span className="code">{latest.origin || 'unknown site'}</span>, {ago(latest.created_at)}.
            {latest.ok ? ' Courses in this LMS can send data to LearnLens.' : ' Fix the items below, then open the test again.'}
          </div>
          {latest.results.map((c) => <CheckRow key={c.id} status={c.ok} label={c.label} detail={c.detail} />)}
          <CheckRow status="ok" label="Send data to LearnLens" detail="These results reached LearnLens from inside the LMS." />
          {data.length > 1 && (
            <details style={{ marginTop: 8 }}>
              <summary className="small" style={{ cursor: 'pointer' }}>Earlier runs ({data.length - 1})</summary>
              {data.slice(1).map((d) => (
                <div key={d.id} className="small" style={{ padding: '6px 0' }}>
                  <StatusIcon status={d.ok ? 'ok' : 'error'} /> {d.origin || 'unknown'} · {ago(d.created_at)}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      <p className="tiny muted" style={{ margin: 0 }}>The test package sends only these check results, never learner activity.</p>
    </div>
  );
}

const EVENT_LABEL = {
  session_started: 'Opened the course',
  page_viewed: 'Viewed',
  question_answered: 'Answered',
  decision_made: 'Decision',
  hint_used: 'Used a hint',
  error_made: 'Error',
  score_reported: 'Score',
  course_completed: 'Completed',
  course_passed: 'Passed',
  course_failed: 'Failed'
};

function describe(e) {
  const parts = [];
  if (e.object_id) parts.push(e.object_id);
  if (e.success === true) parts.push('correct');
  if (e.success === false) parts.push('incorrect');
  if (e.score !== null && e.score !== undefined) parts.push(`${Math.round(e.score * 100)}%`);
  return parts.join(' · ');
}

/** Events arriving for this course, refreshed every few seconds. */
export function LiveEvents({ course }) {
  const { data, error } = usePoll(`/api/courses/${course.id}/live`, 4000);
  return (
    <div className="card grow-2 stack" style={{ gap: 10 }}>
      <div className="card-head">
        <h2>Live events</h2>
        {data && <span className="small muted">{data.day} in the last 24 h · {data.total} total</span>}
      </div>
      {error && <div className="error-box">{error.message}</div>}
      {data && !data.events.length && (
        <div className="stack small" style={{ gap: 8 }}>
          <div className="callout plain" role="status"><span className="dot" style={{ background: '#94A3B8', marginRight: 8 }} />Waiting for the first event… Open the tracked course in your LMS (or use “Test it in your browser”) and events will appear here.</div>
          <div className="muted">Nothing arriving? Run the connection test on the left: it shows exactly what is blocking the data.</div>
        </div>
      )}
      {data && data.events.length > 0 && (
        <div aria-live="polite">
          {data.events.map((e) => (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr)', gap: 10, padding: '8px 0', borderTop: '1px solid var(--line-2)', fontSize: 13 }}>
              <span className="muted">{ago(e.ts)}</span>
              <span style={{ minWidth: 0 }}>
                <strong>{EVENT_LABEL[e.type] || e.type}</strong> <span className="muted">{describe(e)}</span>
                <span className="tiny muted" style={{ display: 'block' }}>{e.learner} · via {e.source.toUpperCase()}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
