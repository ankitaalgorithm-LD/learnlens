import { useEffect, useRef, useState } from 'react';
import { ConnectionTest, LiveEvents, SetupCheck } from './ConnectionCheck.jsx';
import { api, download } from '../api.js';
import { ago } from '../format.js';
import { ErrorBox, Loading, PageHead, Toggle, useApi, useToast } from '../ui.jsx';

const TABS = [['scorm', 'SCORM package'], ['xapi', 'xAPI / cmi5'], ['sdk', 'JavaScript SDK']];

export default function Connect() {
  const courses = useApi('/api/courses');
  const [courseId, setCourseId] = useState('');
  const [tab, setTab] = useState('scorm');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!courses.data) return;
    if (!courses.data.length) setAdding(true);
    else if (!courseId || !courses.data.some((c) => String(c.id) === String(courseId))) {
      setCourseId(String(courses.data[0].id));
      setTab(courses.data[0].method);
    }
  }, [courses.data]);

  if (courses.error) return <ErrorBox error={courses.error} onRetry={courses.reload} />;
  if (!courses.data) return <Loading what="courses" />;
  const course = courses.data.find((c) => String(c.id) === String(courseId));

  return (
    <>
      <PageHead title="Connect a course" subtitle="Works with Storyline, Rise, Captivate, iSpring, Lectora or custom HTML5, and with any LMS that plays SCORM or xAPI.">
        {courses.data.length > 0 && (
          <>
            <label className="sr-only" htmlFor="ccourse">Course</label>
            <select id="ccourse" className="select inline" value={courseId} onChange={(e) => { setCourseId(e.target.value); setAdding(false); const c = courses.data.find((x) => String(x.id) === e.target.value); if (c) setTab(c.method); }} style={{ fontWeight: 600 }}>
              {courses.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </>
        )}
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add a course</button>
      </PageHead>

      <SetupCheck />

      {adding && <AddCourse defaultMethod="scorm" onCancel={courses.data.length ? () => setAdding(false) : null} onCreated={(id, method) => { setAdding(false); setCourseId(String(id)); setTab(method); courses.reload(); }} />}

      {course && !adding && (
        <>
          <div role="tablist" aria-label="Connection method" className="tabs">
            {TABS.map(([k, label]) => <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          <section className="row">
            <div className="card grow-3">
              <CourseConnect course={course} tab={tab} onChange={courses.reload} />
            </div>
            <Privacy />
          </section>
          <section className="row">
            <ConnectionTest course={course} />
            <LiveEvents course={course} />
          </section>
        </>
      )}

      <ConnectedCourses courses={courses.data} reload={courses.reload} onPick={(c) => { setCourseId(String(c.id)); setTab(c.method); setAdding(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
    </>
  );
}

function AddCourse({ defaultMethod, onCancel, onCreated }) {
  const [form, setForm] = useState({ name: '', method: defaultMethod || 'scorm', sourceTool: '', lms: '', designedMinutes: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    try {
      const r = await api('/api/courses', { method: 'POST', body: form });
      onCreated(r.id, form.method);
    } catch (err) { setError(err.message); }
  }
  return (
    <form className="card stack" onSubmit={submit} style={{ gap: 14 }}>
      <h2>Add a course</h2>
      <label className="field">Course name<input className="input" value={form.name} onChange={set('name')} required placeholder="e.g. Fire Safety Essentials" /></label>
      <div className="field-grid">
        <label className="field">How will it send data?
          <select className="select" value={form.method} onChange={set('method')}>
            <option value="scorm">SCORM package (Storyline, Captivate, iSpring…)</option>
            <option value="xapi">xAPI / cmi5</option>
            <option value="sdk">JavaScript SDK (custom HTML5, 3D, games)</option>
          </select>
        </label>
        <label className="field">Authoring tool (optional)<input className="input" value={form.sourceTool} onChange={set('sourceTool')} placeholder="e.g. Storyline" /></label>
        <label className="field">LMS (optional)<input className="input" value={form.lms} onChange={set('lms')} placeholder="e.g. Moodle" /></label>
        <label className="field">Designed length in minutes (optional)<input className="input" type="number" min="1" value={form.designedMinutes} onChange={set('designedMinutes')} /></label>
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn primary" type="submit">Create course</button>
        {onCancel && <button className="btn" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function Copy({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn small" onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? 'Copied ✓' : label}
    </button>
  );
}

function CourseConnect({ course, tab, onChange }) {
  const { data, error, reload } = useApi(`/api/courses/${course.id}/connect`);
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [showSecret, setShowSecret] = useState(false);
  const [version, setVersion] = useState(course.version);
  const toast = useToast();
  const inputRef = useRef(null);
  useEffect(() => { setResult(null); setFile(null); setVersion(course.version); }, [course.id]);

  async function upload(f) {
    setFile(f); setBusy(true); setResult(null);
    const fd = new FormData();
    fd.append('package', f);
    try {
      const r = await api(`/api/courses/${course.id}/scorm`, { method: 'POST', body: fd });
      setResult(r); reload(); onChange();
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  }
  async function saveVersion() {
    try { await api(`/api/courses/${course.id}`, { method: 'PATCH', body: { version } }); toast(`Version set to ${version}. Re-wrap the package so it reports this version.`); onChange(); } catch (e) { toast(e.message); }
  }

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading what="connection details" />;

  const versionRow = (
    <div className="actions" style={{ marginTop: 16 }}>
      <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>Course version
        <input className="input inline" style={{ width: 100 }} value={version} onChange={(e) => setVersion(e.target.value)} />
      </label>
      {version !== course.version && <button className="btn small" onClick={saveVersion}>Save version</button>}
      <span className="tiny muted">Change it when you publish an updated course, to compare versions.</span>
    </div>
  );

  if (tab === 'scorm') {
    return (
      <div>
        <h2 style={{ fontSize: 18 }}>Wrap a SCORM package</h2>
        <p className="small" style={{ color: 'var(--ink-2)', margin: '6px 0 20px' }}>Upload your SCORM 1.2 or 2004 zip. LearnLens adds a small tracking layer and gives it back. Publish it to your LMS exactly as before; the LMS keeps working normally.</p>
        <label
          className={`dropzone${drag ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); }}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{busy ? `Wrapping ${file && file.name}…` : 'Drop your SCORM .zip here, or browse'}</span>
          <span className="small muted">Up to 500 MB · your course content is not changed</span>
          <input ref={inputRef} type="file" accept=".zip,application/zip" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} style={{ fontSize: 13, marginTop: 8 }} disabled={busy} />
        </label>
        {result && result.error && <div className="error-box" style={{ marginTop: 16 }} role="alert">{result.error}</div>}
        {result && !result.error && (
          <div className="callout info" style={{ marginTop: 16 }}>
            <strong>Ready.</strong> {result.scormVersion} package wrapped ({result.scos.length} SCO{result.scos.length > 1 ? 's' : ''}).
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="btn primary small" onClick={() => download(`/api/packages/${result.id}/download`, 'course-learnlens.zip')}>Download tracked package</button>
              <a className="btn small" href={result.previewUrl} target="_blank" rel="noreferrer">Test it in your browser</a>
            </div>
          </div>
        )}
        <ol style={{ margin: '20px 0 0', padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          {['Upload the zip', 'Download the tracked version', 'Publish it to your LMS as usual'].map((s, i) => (
            <li key={s} className="stat"><div className="label">Step {i + 1}</div><div style={{ marginTop: 4 }}>{s}</div></li>
          ))}
        </ol>
        {versionRow}
        {data.packages.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div className="label" style={{ marginBottom: 8 }}>Wrapped packages</div>
            {data.packages.map((p) => (
              <div key={p.id} className="actions" style={{ justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--line-2)' }}>
                <span className="small">{p.original_name} · {p.scorm_version} · {ago(p.created_at)}</span>
                <span className="actions">
                  <button className="btn small" onClick={() => download(`/api/packages/${p.id}/download`, 'course-learnlens.zip')}>Download</button>
                  <a className="btn small" href={`/preview/${p.id}`} target="_blank" rel="noreferrer">Test</a>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="tiny muted" style={{ marginTop: 16 }}>Tracking sends data to <span className="code">{data.endpoint}</span>. Learners' browsers must be able to reach this address, so use your public server address (PUBLIC_URL) before wrapping packages for real learners.</p>
      </div>
    );
  }

  if (tab === 'xapi') {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <h2 style={{ fontSize: 18 }}>Send xAPI statements</h2>
        <p className="small" style={{ color: 'var(--ink-2)', margin: 0 }}>If your course or LMS publishes xAPI or cmi5, add LearnLens as its LRS (or as an extra LRS / forwarding target). Use these details:</p>
        <label className="field">Endpoint
          <div className="actions"><input className="input code" readOnly value={data.xapi.endpoint} style={{ flex: 1 }} /><Copy text={data.xapi.endpoint} /></div>
        </label>
        <label className="field">Username (key)
          <div className="actions"><input className="input code" readOnly value={data.xapi.username} style={{ flex: 1 }} /><Copy text={data.xapi.username} /></div>
        </label>
        <label className="field">Password (secret)
          <div className="actions">
            <input className="input code" readOnly type={showSecret ? 'text' : 'password'} value={data.xapi.password} style={{ flex: 1 }} />
            <button type="button" className="btn small" onClick={() => setShowSecret((s) => !s)}>{showSecret ? 'Hide' : 'Show'}</button>
            <Copy text={data.xapi.password} />
          </div>
        </label>
        <div className="callout plain">
          LearnLens reads statements for analytics (answered, experienced, completed, passed, failed…) and stores bookmarks so courses can resume. It doesn't replace a full LRS for compliance records. Put the learner's team in <span className="code">context.extensions["…/team"]</span> to fill team reports automatically.
        </div>
        {versionRow}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <h2 style={{ fontSize: 18 }}>JavaScript SDK for custom content</h2>
      <p className="small" style={{ color: 'var(--ink-2)', margin: 0 }}>For HTML5, Three.js, Babylon.js or game-engine builds. Track decisions, errors and hints: data that standard SCORM can't capture.</p>
      <pre className="snippet">{data.sdk.snippet}</pre>
      <div className="actions"><Copy text={data.sdk.snippet} label="Copy snippet" /><a className="btn small" href={data.sdk.scriptUrl} target="_blank" rel="noreferrer">View SDK file</a></div>
      <div className="callout plain">Inside an LMS, take the learner id from the LMS (for SCORM: <span className="code">cmi.core.student_id</span>). Events are queued and retried if the network drops.</div>
      {versionRow}
    </div>
  );
}

function Privacy() {
  const { data, reload } = useApi('/api/settings/privacy');
  const toast = useToast();
  async function save(patch) {
    if (patch.pseudonymise === true && !window.confirm('Turn on pseudonymisation? Stored learner names will be removed; learners will show as "Learner #id".')) return;
    try { await api('/api/settings/privacy', { method: 'PUT', body: { ...data, ...patch } }); toast('Privacy settings saved'); reload(); } catch (e) { toast(e.message); }
  }
  return (
    <div className="card grow-2 stack" style={{ gap: 16 }}>
      <h2>Privacy settings</h2>
      {!data ? <Loading what="settings" /> : (
        <>
          <div className="list-item" style={{ background: 'var(--surface-2)', justifyContent: 'space-between', alignItems: 'center' }}>
            <span><span style={{ display: 'block', fontWeight: 600 }}>Pseudonymise learners</span><span className="tiny muted">Store a keyed hash of the LMS id, never names</span></span>
            <Toggle checked={data.pseudonymise} onChange={(v) => save({ pseudonymise: v })} label="Pseudonymise learners" />
          </div>
          <label className="field">Keep learner activity for
            <select className="select" value={data.retentionMonths} onChange={(e) => save({ retentionMonths: Number(e.target.value) })}>
              <option value={6}>6 months</option><option value={12}>12 months</option><option value={24}>24 months</option><option value={0}>Until deleted</option>
            </select>
          </label>
          <p className="tiny muted" style={{ margin: 0 }}>Re-wrap SCORM packages after changing pseudonymisation, so they send (or stop sending) names.</p>
        </>
      )}
    </div>
  );
}

function ConnectedCourses({ courses, reload, onPick }) {
  const toast = useToast();
  async function remove(c) {
    if (!window.confirm(`Delete "${c.name}" and all of its learner data? This can't be undone.`)) return;
    try { await api(`/api/courses/${c.id}`, { method: 'DELETE' }); toast('Course deleted'); reload(); } catch (e) { toast(e.message); }
  }
  if (!courses.length) return null;
  return (
    <section className="card flush">
      <div className="card-head"><h2>Connected courses</h2></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Course</th><th>Method</th><th>LMS</th><th>Version</th><th>Status</th><th>Last event</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {courses.map((c) => {
              const idleDays = c.last_event ? (Date.now() - new Date(c.last_event).getTime()) / 86400000 : null;
              const status = idleDays === null ? ['No events yet', 'var(--muted)', '#94A3B8'] : idleDays > 3 ? [`No events in ${Math.floor(idleDays)} days`, 'var(--warn-ink)', 'var(--warn)'] : ['Receiving data', 'var(--good-ink)', 'var(--good)'];
              return (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}><button className="btn ghost small" style={{ padding: 0, fontWeight: 600 }} onClick={() => onPick(c)}>{c.name}</button></td>
                  <td>{c.methodLabel}{c.source_tool ? ` · ${c.source_tool}` : ''}</td>
                  <td>{c.lms || '–'}</td>
                  <td>{c.version}</td>
                  <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: status[1] }}><span className="dot" style={{ background: status[2] }} />{status[0]}</span></td>
                  <td className="muted">{ago(c.last_event)}</td>
                  <td><button className="btn ghost small danger" onClick={() => remove(c)}>Delete</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
