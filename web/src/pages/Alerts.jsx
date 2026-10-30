import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, withToken } from '../api.js';
import { ago, CRON_PRESETS, cronLabel } from '../format.js';
import { ErrorBox, Loading, PageHead, Toggle, useApi, useToast } from '../ui.jsx';

const NOTIFY = ['Evaluator', 'Team manager', 'Course developer', 'Admin'];
const REPORT_KINDS = { manager: 'Manager summary (PDF, one page per team)', monthly: 'L&D overview (PDF)', course_health: 'Course health (CSV of every question)' };

export default function Alerts() {
  const rules = useApi('/api/alerts/rules');
  const alerts = useApi('/api/alerts');
  const schedules = useApi('/api/reports/schedules');
  const courses = useApi('/api/courses');
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [showAll, setShowAll] = useState(false);

  async function runNow() {
    setChecking(true);
    try { const r = await api('/api/alerts/run', { method: 'POST' }); toast(r.created ? `${r.created} new alert${r.created > 1 ? 's' : ''}` : 'No new alerts'); alerts.reload(); } catch (e) { toast(e.message); }
    setChecking(false);
  }

  if (rules.error) return <ErrorBox error={rules.error} onRetry={rules.reload} />;
  if (!rules.data || !courses.data) return <Loading what="alerts" />;
  const active = rules.data.rules.filter((r) => r.enabled).length;

  return (
    <>
      <PageHead title="Alerts & reports" subtitle="Turn insights into action: notify the right person, and send summaries to people who never open a dashboard.">
        <button className="btn" onClick={runNow} disabled={checking}>{checking ? 'Checking…' : 'Check for alerts now'}</button>
      </PageHead>

      <section className="row">
        <div className="card flush grow-3">
          <div className="card-head"><h2>Alert rules</h2><span className="small muted">{active} active · checked every 10 minutes</span></div>
          {rules.data.rules.map((r) => <RuleRow key={r.id} rule={r} kinds={rules.data.kinds} courses={courses.data} reload={rules.reload} />)}
        </div>
        <NewRule kinds={rules.data.kinds} courses={courses.data} onCreated={rules.reload} />
      </section>

      <section className="row">
        <Schedules schedules={schedules} />
        <div className="card grow-2" style={{ background: '#EEF1F5' }}>
          <div className="card-head"><div className="label">Preview · Manager summary</div><a className="small" href={withToken('/api/reports/preview/manager')} target="_blank" rel="noreferrer">Open full PDF</a></div>
          <iframe title="Manager summary preview" src={`${withToken('/api/reports/preview/manager')}#toolbar=0&view=FitH`} style={{ width: '100%', height: 520, border: 0, borderRadius: 6, background: '#fff', marginTop: 8 }} />
        </div>
      </section>

      <section className="card flush">
        <div className="card-head"><h2>Recent alerts</h2></div>
        {alerts.error && <div style={{ padding: 20 }}><ErrorBox error={alerts.error} onRetry={alerts.reload} /></div>}
        {alerts.data && !alerts.data.length && <p className="muted small" style={{ padding: '0 20px 20px' }}>No alerts yet.</p>}
        {alerts.data && alerts.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Alert</th><th>Sent to</th><th>Outcome</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {alerts.data.slice(0, showAll ? 100 : 12).map((a) => <AlertRow key={a.id} a={a} reload={alerts.reload} />)}
              </tbody>
            </table>
            {alerts.data.length > 12 && (
              <div style={{ padding: 16, textAlign: 'center' }}>
                <button className="btn small" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${alerts.data.length}`}</button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function RuleRow({ rule, kinds, courses, reload }) {
  const toast = useToast();
  const [on, setOn] = useState(rule.enabled);
  const course = courses.find((c) => c.id === rule.course_id);
  const unit = kinds[rule.kind] ? kinds[rule.kind].unit : '';
  async function toggle(v) {
    setOn(v);
    try { await api(`/api/alerts/rules/${rule.id}`, { method: 'PATCH', body: { enabled: v } }); } catch (e) { setOn(!v); toast(e.message); }
  }
  async function remove() {
    if (!window.confirm(`Delete the rule "${rule.name}"?`)) return;
    try { await api(`/api/alerts/rules/${rule.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message); }
  }
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '14px 20px', borderTop: '1px solid var(--line-2)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{rule.name}</div>
        <div className="small" style={{ color: 'var(--ink-2)', marginTop: 2 }}>{kinds[rule.kind] ? kinds[rule.kind].label : rule.kind}: {rule.threshold} {unit} · {course ? course.name : 'All courses'}</div>
        <div className="tiny muted" style={{ marginTop: 4 }}>Notify: {rule.notify} · {rule.channel === 'webhook' ? 'webhook (Slack/Teams/email automation)' : 'in-app'}</div>
      </div>
      <button className="btn ghost small danger" onClick={remove}>Delete</button>
      <Toggle checked={on} onChange={toggle} label={`Turn ${rule.name} on or off`} />
    </div>
  );
}

function NewRule({ kinds, courses, onCreated }) {
  const kindKeys = Object.keys(kinds);
  const defaults = { stalled: 7, repeated_failure: 2, rushing: 0.3, critical_errors: 3, confusing_question: 0.5, course_quiet: 3 };
  const [form, setForm] = useState({ kind: kindKeys[0], threshold: defaults[kindKeys[0]], courseId: '', notify: 'Evaluator', channel: 'in-app', name: '' });
  const toast = useToast();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value, ...(k === 'kind' ? { threshold: defaults[e.target.value] } : {}) }));
  async function submit(e) {
    e.preventDefault();
    try {
      await api('/api/alerts/rules', { method: 'POST', body: { ...form, name: form.name || kinds[form.kind].label } });
      toast('Rule saved'); onCreated();
      setForm((f) => ({ ...f, name: '' }));
    } catch (err) { toast(err.message); }
  }
  return (
    <form className="card grow-2 stack" style={{ gap: 14 }} onSubmit={submit}>
      <h2>New alert rule</h2>
      <label className="field">When
        <select className="select" value={form.kind} onChange={set('kind')}>
          {kindKeys.map((k) => <option key={k} value={k}>{kinds[k].label}</option>)}
        </select>
      </label>
      <label className="field">Threshold ({kinds[form.kind].unit})
        <input className="input" type="number" min="0" step="any" value={form.threshold} onChange={set('threshold')} required />
      </label>
      <label className="field">In course
        <select className="select" value={form.courseId} onChange={set('courseId')}>
          <option value="">All courses</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="field-grid">
        <label className="field">Notify
          <select className="select" value={form.notify} onChange={set('notify')}>{NOTIFY.map((n) => <option key={n}>{n}</option>)}</select>
        </label>
        <label className="field">Via
          <select className="select" value={form.channel} onChange={set('channel')}>
            <option value="in-app">In-app</option>
            <option value="webhook">Webhook (Slack, Teams, email)</option>
          </select>
        </label>
      </div>
      <label className="field">Name (optional)<input className="input" value={form.name} onChange={set('name')} placeholder={kinds[form.kind].label} /></label>
      {form.channel === 'webhook' && <p className="tiny muted" style={{ margin: 0 }}>Webhook alerts are posted to the ALERT_WEBHOOK_URL set on the server. Point it at a Slack or Teams incoming webhook, or a Zapier/Make flow that emails people.</p>}
      <button className="btn primary" type="submit">Save rule</button>
    </form>
  );
}

function Schedules({ schedules }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  async function patch(s, body) {
    try { await api(`/api/reports/schedules/${s.id}`, { method: 'PATCH', body }); schedules.reload(); } catch (e) { toast(e.message); }
  }
  async function run(s) {
    try { await api(`/api/reports/schedules/${s.id}/run`, { method: 'POST' }); toast(`${s.name} generated`); schedules.reload(); } catch (e) { toast(e.message); }
  }
  async function create(e) {
    e.preventDefault();
    try { await api('/api/reports/schedules', { method: 'POST', body: form }); setForm(null); toast('Schedule saved'); schedules.reload(); } catch (err) { toast(err.message); }
  }
  return (
    <div className="card grow-3 stack">
      <div className="card-head">
        <h2>Scheduled reports</h2>
        <button className="btn small" onClick={() => setForm(form ? null : { name: '', kind: 'manager', cron: CRON_PRESETS[0].cron, recipients: '' })}>{form ? 'Cancel' : '+ New schedule'}</button>
      </div>
      {form && (
        <form className="stack callout plain" onSubmit={create} style={{ gap: 12 }}>
          <label className="field">Name<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Weekly warehouse summary" /></label>
          <div className="field-grid">
            <label className="field">Report
              <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(REPORT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="field">When
              <select className="select" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })}>
                {CRON_PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
              </select>
            </label>
          </div>
          <label className="field">Who it's for<input className="input" value={form.recipients} onChange={(e) => setForm({ ...form, recipients: e.target.value })} placeholder="e.g. Warehouse managers" /></label>
          <div><button className="btn primary small" type="submit">Save schedule</button></div>
        </form>
      )}
      {!schedules.data ? <Loading what="schedules" /> : schedules.data.map((s) => (
        <div key={s.id} className="list-item" style={{ background: 'var(--surface-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ width: 40, height: 48, borderRadius: 6, background: '#fff', border: '1px solid var(--control)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 6, fontSize: 10, fontWeight: 700, color: 'var(--warn)', flex: 'none' }}>{s.kind === 'course_health' ? 'CSV' : 'PDF'}</div>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{s.name}</div>
            <div className="small" style={{ color: 'var(--ink-2)', marginTop: 2 }}>{cronLabel(s.cron)}{s.last_run ? ` · last run ${ago(s.last_run)}` : ''}</div>
            <div className="tiny muted" style={{ marginTop: 2 }}>{s.recipients || REPORT_KINDS[s.kind]}</div>
          </div>
          <div className="actions">
            <a className="btn small" href={withToken(`/api/reports/preview/${s.kind}`)} target="_blank" rel="noreferrer">Preview</a>
            <button className="btn small" onClick={() => run(s)}>Run now</button>
            {s.last_file && <a className="btn small" href={withToken(`/api/reports/files/${encodeURIComponent(s.last_file)}`)} target="_blank" rel="noreferrer">Latest</a>}
            <Toggle checked={s.enabled} onChange={(v) => patch(s, { enabled: v })} label={`Turn ${s.name} on or off`} />
          </div>
        </div>
      ))}
      <p className="tiny muted" style={{ margin: 0 }}>Reports are saved on the server. With ALERT_WEBHOOK_URL set, each run also posts a download link to your Slack, Teams or email automation.</p>
    </div>
  );
}

function AlertRow({ a, reload }) {
  const toast = useToast();
  async function set(status, outcome) {
    try { await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: { status, outcome } }); reload(); } catch (e) { toast(e.message); }
  }
  const pill = a.status === 'open' ? 'warn' : a.status === 'acted' ? 'good' : 'neutral';
  const label = a.outcome || (a.status === 'open' ? 'Open' : a.status === 'acted' ? 'Acted on' : 'Dismissed');
  return (
    <tr>
      <td className="muted">{ago(a.created_at)}</td>
      <td className="wrap">
        <div style={{ fontWeight: 600 }}>{a.learner_id ? <Link to={`/learners?learner=${a.learner_id}`} style={{ color: 'var(--ink)' }}>{a.title}</Link> : a.title}</div>
        <div className="small muted">{a.detail}</div>
      </td>
      <td>{a.notify}</td>
      <td><span className={`pill ${pill}`}>{label}</span></td>
      <td>
        {a.status === 'open' && (
          <span className="actions">
            <button className="btn small" onClick={() => set('acted', 'Followed up')}>Mark followed up</button>
            <button className="btn ghost small" onClick={() => set('dismissed')}>Dismiss</button>
          </span>
        )}
      </td>
    </tr>
  );
}
