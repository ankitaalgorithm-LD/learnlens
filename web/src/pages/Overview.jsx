import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, withToken } from '../api.js';
import { ago, delta, minutes, pct } from '../format.js';
import { Empty, ErrorBox, Kpi, LineChart, Loading, PageHead, useApi, useToast } from '../ui.jsx';

function alertLink(a) {
  if (a.kind === 'confusing_question' || a.kind === 'course_quiet') return `/content?course=${a.course_id}`;
  if (a.learner_id) return `/learners?learner=${a.learner_id}`;
  return '/alerts';
}

export default function Overview() {
  const [days, setDays] = useState(30);
  const [team, setTeam] = useState('');
  const { data, error, loading, reload } = useApi(`/api/overview?days=${days}${team ? `&team=${encodeURIComponent(team)}` : ''}`);
  const navigate = useNavigate();
  const toast = useToast();
  const [assigned, setAssigned] = useState({});

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading what="overview" />;

  if (!data.courseCount) {
    return (
      <>
        <PageHead title="Overview" subtitle="Learning analytics for any course, in any LMS." />
        <div className="card">
          <Empty title="Connect your first course">
            <p>Add a course, wrap its SCORM package (or use xAPI or the SDK), and learner data will appear here.</p>
            <p><Link className="btn primary" to="/connect">Connect a course</Link></p>
            <p className="small">Just exploring? Load realistic demo data with <code className="code">npm run simulate</code> in the server folder.</p>
          </Empty>
        </div>
      </>
    );
  }

  const k = data.kpis;
  const sample = data.courses.some((c) => c.name === 'Fire Safety Essentials');

  async function assign(r) {
    try {
      await api(`/api/learners/${r.learnerId}/assignments`, { method: 'POST', body: { title: `Review: ${r.course}` } });
      setAssigned((a) => ({ ...a, [`${r.learnerId}:${r.courseId}`]: true }));
      toast(`Review assigned to ${r.learner}`);
    } catch (e) { toast(e.message); }
  }

  return (
    <>
      <PageHead
        title="Overview"
        sample={sample}
        subtitle={`${team || 'All teams'} · last ${days} days · ${data.courseCount} course${data.courseCount === 1 ? '' : 's'} from ${data.tools || 1} authoring tool${data.tools === 1 ? '' : 's'}`}
      >
        <label className="sr-only" htmlFor="team">Team</label>
        <select id="team" className="select inline" value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">All teams</option>
          {data.teams.map((t) => <option key={t}>{t}</option>)}
        </select>
        <label className="sr-only" htmlFor="days">Period</label>
        <select id="days" className="select inline" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <a className="btn primary" href={withToken('/api/reports/preview/monthly')} target="_blank" rel="noreferrer">Export report</a>
      </PageHead>

      <section className="kpis" aria-label="Key metrics" style={{ opacity: loading ? 0.6 : 1 }}>
        <Kpi label="Active learners" value={k.activeLearners.value.toLocaleString()} trend={delta(k.activeLearners.value, k.activeLearners.prev, { points: false })} trendGood note="Did anything in a course" />
        <Kpi label="Completion rate" value={pct(k.completion.value)} trend={delta(k.completion.value, k.completion.prev)} trendGood note="Of learners who started in this period" />
        <Kpi label="Mastery rate" value={pct(k.mastery.value)} trend={delta(k.mastery.value, k.mastery.prev)} trendGood note="Passed within 2 attempts" />
        <Kpi label="At-risk learners" value={k.atRisk.value} note="Stalled, failing, rushing or critical errors" />
      </section>

      <section className="row">
        <div className="card grow-3">
          <div className="card-head">
            <h2>Completion vs. mastery</h2>
            <div className="legend">
              <span><span className="swatch" style={{ height: 3, background: 'var(--accent)' }} />Completed</span>
              <span><span className="swatch" style={{ height: 3, background: 'var(--warn-bar)' }} />Mastered (≤2 attempts)</span>
            </div>
          </div>
          <p className="sub">By the week learners started. The gap is people who finished but didn't really master it.</p>
          <LineChart
            labels={data.trend.map((t) => t.week)}
            series={[
              { name: 'Completed', color: 'var(--accent)', values: data.trend.map((t) => t.completion) },
              { name: 'Mastered', color: 'var(--warn-bar)', dashed: true, values: data.trend.map((t) => t.mastery) }
            ]}
            ariaLabel="Weekly completion and mastery rates over 12 weeks"
          />
          <p className="tiny muted" style={{ margin: '8px 0 0' }}>Recent weeks look lower while learners are still working through courses.</p>
        </div>
        <div className="card grow-1 stack">
          <div className="card-head"><h2>Needs attention</h2><Link className="small" to="/alerts">All alerts</Link></div>
          {data.alerts.length === 0 && <p className="muted small">Nothing needs attention right now.</p>}
          {data.alerts.map((a) => (
            <div key={a.id} className="list-item" style={{ background: a.kind === 'confusing_question' || a.kind === 'critical_errors' ? 'var(--warn-soft)' : 'var(--accent-soft)' }}>
              <span className="dot" style={{ background: a.kind === 'confusing_question' || a.kind === 'critical_errors' ? 'var(--warn)' : 'var(--accent)', marginTop: 6 }} />
              <div>
                <div style={{ fontWeight: 600 }}>{a.title}</div>
                <div className="small" style={{ color: 'var(--ink-2)', marginTop: 2 }}>{a.detail}</div>
                <Link to={alertLink(a)} className="small" style={{ fontWeight: 600, display: 'inline-block', marginTop: 6 }}>Open →</Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card flush">
        <div className="card-head"><h2>Courses</h2><span className="small muted">Click a course for content insights</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Course</th><th>Source</th><th>Learners</th><th>Completion</th><th>Mastery</th><th>Typical time</th><th>Status</th></tr></thead>
            <tbody>
              {data.courses.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/content?course=${c.id}`)}>
                  <td style={{ fontWeight: 600 }}><Link to={`/content?course=${c.id}`} style={{ color: 'var(--ink)', textDecoration: 'none' }}>{c.name}</Link></td>
                  <td><span className="tag">{c.source}</span></td>
                  <td className="num">{c.learners}</td>
                  <td className="num">{pct(c.completion)}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="mini-bar"><div style={{ width: `${(c.mastery || 0) * 100}%`, background: c.mastery !== null && c.mastery < 0.5 ? 'var(--warn-bar)' : 'var(--accent)' }} /></div>
                      <span className="num small">{pct(c.mastery)}</span>
                    </div>
                  </td>
                  <td className="num">{minutes(c.avgMinutes)}</td>
                  <td><span className={`pill ${c.healthy ? 'good' : c.learners ? 'warn' : 'neutral'}`}>{c.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card flush">
        <div className="card-head"><h2>At-risk learners</h2><Link className="small" to="/learners">All learners</Link></div>
        {data.risks.length === 0 ? <p className="muted small" style={{ padding: '0 20px 20px' }}>No learners at risk in this period.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Learner</th><th>Team</th><th>Course</th><th>Why flagged</th><th>Last active</th><th>Action</th></tr></thead>
              <tbody>
                {data.risks.map((r) => {
                  const done = assigned[`${r.learnerId}:${r.courseId}`];
                  return (
                    <tr key={`${r.learnerId}:${r.courseId}`}>
                      <td style={{ fontWeight: 600 }}><Link to={`/learners?learner=${r.learnerId}`} style={{ color: 'var(--ink)' }}>{r.learner}</Link></td>
                      <td>{r.team || '–'}</td>
                      <td>{r.course}</td>
                      <td style={{ color: 'var(--warn-ink)', fontWeight: 500 }}>{r.reason}</td>
                      <td className="muted">{ago(r.last)}</td>
                      <td><button className="btn small" disabled={done} onClick={() => assign(r)}>{done ? 'Assigned ✓' : 'Assign review'}</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
