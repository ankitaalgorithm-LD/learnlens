import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { minutes, pct } from '../format.js';
import { Bar, Empty, ErrorBox, Loading, PageHead, useApi, useToast } from '../ui.jsx';

export default function Content() {
  const [params, setParams] = useSearchParams();
  const courses = useApi('/api/courses');
  const list = courses.data || [];
  const withData = list.filter((c) => c.events).sort((a, b) => b.learners - a.learners);
  const courseId = params.get('course') || (withData[0] || list[0] || {}).id;
  const version = params.get('version') || '';
  const insights = useApi(courseId ? `/api/courses/${courseId}/insights${version ? `?version=${encodeURIComponent(version)}` : ''}` : null);
  const [qid, setQid] = useState(null);

  const d = insights.data;
  useEffect(() => {
    if (!d) return;
    const flagged = d.questions.find((q) => q.flags.some((f) => f.startsWith('Likely confusing'))) || d.questions.find((q) => q.flags.length) || d.questions[0];
    setQid(flagged ? flagged.id : null);
  }, [d]);

  if (courses.error) return <ErrorBox error={courses.error} onRetry={courses.reload} />;
  if (!courses.data) return <Loading what="courses" />;
  if (!list.length) {
    return (
      <>
        <PageHead title="Content insights" />
        <div className="card"><Empty title="No courses yet"><p><Link className="btn primary" to="/connect">Connect a course</Link></p></Empty></div>
      </>
    );
  }

  const set = (k, v) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); if (k === 'course') p.delete('version'); setParams(p); };

  return (
    <>
      <PageHead title="Content insights" sample={d && d.course.name === 'Fire Safety Essentials'} subtitle="Is the course itself working? Where do learners drop off, rush, or get confused?">
        <label className="sr-only" htmlFor="course">Course</label>
        <select id="course" className="select inline" value={courseId} onChange={(e) => set('course', e.target.value)} style={{ fontWeight: 600 }}>
          {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {d && d.versions.length > 1 && (
          <>
            <label className="sr-only" htmlFor="version">Version</label>
            <select id="version" className="select inline" value={d.version} onChange={(e) => set('version', e.target.value)}>
              {d.versions.map((v) => <option key={v}>{v}</option>)}
            </select>
          </>
        )}
      </PageHead>
      {insights.error && <ErrorBox error={insights.error} onRetry={insights.reload} />}
      {!d && !insights.error && <Loading what="insights" />}
      {d && (d.kpis.learners === 0 ? (
        <div className="card"><Empty title="No learner data for this course yet">
          <p>Once learners open the tracked course, drop-off, timing and question analysis appear here.</p>
          <p><Link className="btn" to="/connect">See how to connect it</Link></p>
        </Empty></div>
      ) : <Insights d={d} qid={qid} setQid={setQid} reload={insights.reload} />)}
    </>
  );
}

function Insights({ d, qid, setQid, reload }) {
  const q = d.questions.find((x) => x.id === qid);
  const funnelMax = 1;
  const maxMinutes = Math.max(1, ...d.times.map((t) => Math.max(t.minutes || 0, t.designed || 0))) * 1.1;
  return (
    <>
      <section className="kpis" aria-label="Course metrics">
        <div className="card"><div className="label">Typical completion time</div><div className="num kpi-value" style={{ fontSize: 28 }}>{minutes(d.kpis.avgMinutes)}</div><div className="kpi-note">{d.course.designedMinutes ? `Designed for ${d.course.designedMinutes} min` : 'First attempt, median'}</div></div>
        <div className="card"><div className="label">Drop-off</div><div className="num kpi-value" style={{ fontSize: 28 }}>{pct(d.kpis.dropOff)}</div><div className="kpi-note">Started but never finished · {d.kpis.learners} learners</div></div>
        <div className="card"><div className="label">Average score</div><div className="num kpi-value" style={{ fontSize: 28 }}>{pct(d.kpis.avgScore)}</div><div className="kpi-note">First attempt</div></div>
        <div className="card"><div className="label">Questions flagged</div><div className="num kpi-value" style={{ fontSize: 28 }}>{d.kpis.flagged} of {d.kpis.questions}</div><div className="kpi-note">Too easy, unclear or not separating</div></div>
      </section>

      <section className="row">
        <div className="card grow-3">
          <h2>Drop-off by section</h2>
          <p className="sub">Share of learners who reached each section ({d.version})</p>
          <div className="stack" style={{ gap: 10 }}>
            {d.funnel.map((f) => {
              const hot = d.biggestDrop && d.biggestDrop.sectionId === f.id;
              return (
                <div className="funnel-row" key={f.id}>
                  <div className="small" style={{ fontWeight: hot ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</div>
                  <Bar value={(f.reached || 0) / funnelMax} color={hot ? 'var(--warn-bar)' : 'var(--accent)'} label={`${f.name}: ${pct(f.reached)}`} />
                  <div className="num small" style={{ textAlign: 'right' }}>{pct(f.reached)}</div>
                </div>
              );
            })}
          </div>
          {d.biggestDrop && d.biggestDrop.drop >= 0.05 && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              <strong>Biggest drop:</strong> {pct(d.biggestDrop.drop)} of learners leave on <strong>{d.biggestDrop.section}</strong>.
              {d.biggestDrop.time && d.biggestDrop.time.minutes ? ` Average time there is ${minutes(d.biggestDrop.time.minutes)}` : ''}
              {d.biggestDrop.time && d.biggestDrop.time.ratio > 1.5 ? `, ${d.biggestDrop.time.ratio.toFixed(1)}× the planned time. Consider splitting it or adding an interaction.` : '.'}
            </div>
          )}
        </div>
        <div className="card grow-2">
          <h2>{q ? 'Answer breakdown' : 'Questions'}</h2>
          {!q && <p className="muted small">This course hasn't reported any questions yet.</p>}
          {q && (
            <>
              <label className="sr-only" htmlFor="qpick">Question</label>
              <select id="qpick" className="select" style={{ margin: '8px 0 4px' }} value={q.id} onChange={(e) => setQid(e.target.value)}>
                {d.questions.map((x) => <option key={x.id} value={x.id}>{x.name || x.id}{x.flags.length ? ' ⚑' : ''}</option>)}
              </select>
              <p className="tiny muted" style={{ margin: '0 0 16px' }}>{q.n} first-attempt responses</p>
              <div className="stack">
                {q.responses.slice(0, 8).map((r) => (
                  <div key={r.response}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                      <span style={{ fontWeight: r.correct ? 700 : 500 }}>{r.response}{r.correct ? ' ✓' : ''}</span><span className="num">{pct(r.share)}</span>
                    </div>
                    <Bar height={10} value={r.share} color={r.correct ? 'var(--good)' : r === q.responses.find((x) => !x.correct) && r.share >= 0.25 ? 'var(--warn-bar)' : '#94A3B8'} />
                  </div>
                ))}
              </div>
              <div className="legend" style={{ marginTop: 16 }}>
                <span><span className="swatch" style={{ background: 'var(--good)' }} />Correct</span>
                <span><span className="swatch" style={{ background: 'var(--warn-bar)' }} />Common wrong answer</span>
              </div>
              {q.flags.length > 0 && <div className="callout info" style={{ marginTop: 16 }}>{q.flags.join('. ')}. Check the wording, or how the course teaches it.</div>}
            </>
          )}
        </div>
      </section>

      <section className="row">
        <SectionTimes d={d} maxMinutes={maxMinutes} reload={reload} />
        <VersionCard d={d} />
      </section>

      <QuestionHealth d={d} reload={reload} />
    </>
  );
}

function SectionTimes({ d, maxMinutes, reload }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const toast = useToast();
  async function save() {
    try {
      for (const t of d.times) {
        const v = draft[t.id] || {};
        if (v.name !== undefined || v.designed !== undefined) {
          await api(`/api/courses/${d.course.id}/sections/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { name: v.name, designedMinutes: v.designed } });
        }
      }
      setEditing(false); setDraft({}); toast('Sections saved'); reload();
    } catch (e) { toast(e.message); }
  }
  return (
    <div className="card grow-3">
      <div className="card-head">
        <h2>Time per section</h2>
        <div className="actions">
          <div className="legend">
            <span><span className="swatch" style={{ background: 'var(--accent)' }} />Actual average</span>
            <span><span className="swatch" style={{ width: 2, height: 14, background: 'var(--ink)' }} />Designed time</span>
          </div>
          <button className="btn small" onClick={() => (editing ? save() : setEditing(true))}>{editing ? 'Save' : 'Edit sections'}</button>
        </div>
      </div>
      <p className="sub">Where learners rush and where they get stuck (minutes, first attempt)</p>
      {editing && <p className="callout plain" style={{ marginTop: 0 }}>Name each section and set how long it was designed to take. SCORM courses only report section IDs, so this makes reports readable.</p>}
      <div className="stack">
        {d.times.map((t) => editing ? (
          <div key={t.id} className="field-grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
            <label className="field">Section “{t.id}”
              <input className="input" defaultValue={t.name} onChange={(e) => setDraft((s) => ({ ...s, [t.id]: { ...s[t.id], name: e.target.value } }))} />
            </label>
            <label className="field">Designed minutes
              <input className="input" type="number" min="0" step="0.5" defaultValue={t.designed || ''} onChange={(e) => setDraft((s) => ({ ...s, [t.id]: { ...s[t.id], designed: e.target.value } }))} />
            </label>
          </div>
        ) : (
          <div className="time-row" key={t.id}>
            <div className="small" style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>{t.name}</div>
            <Bar height={22} value={(t.minutes || 0) / maxMinutes} marker={t.designed ? t.designed / maxMinutes : null} color={t.flag === 'stuck' ? 'var(--warn-bar)' : 'var(--accent)'} label={`${t.name}: ${minutes(t.minutes)}`} />
            <div className="small"><span className="num">{minutes(t.minutes)}</span>{' '}
              {t.flag === 'stuck' && <span style={{ color: 'var(--warn-ink)', fontWeight: 600 }} className="tiny">Stuck · {t.ratio.toFixed(1)}× planned</span>}
              {t.flag === 'rushed' && <span className="tiny muted" style={{ fontWeight: 600 }}>Rushed</span>}
            </div>
          </div>
        ))}
        {!d.times.length && <p className="muted small">No sections reported yet.</p>}
      </div>
    </div>
  );
}

function VersionCard({ d }) {
  const c = d.comparison;
  if (!c) {
    return (
      <div className="card grow-2">
        <h2>Version comparison</h2>
        <p className="sub">Publish a new version to compare it with the old one.</p>
        <p className="small muted">Change the course version on the Connect page (for example v1 → v2) before uploading an updated package. LearnLens then compares completion, scores, drop-off and time between versions.</p>
      </div>
    );
  }
  const rows = [
    ['Completion', pct(c.a.completion), pct(c.b.completion), c.b.completion - c.a.completion, true, 'pts'],
    ['Average score', pct(c.a.avgScore), pct(c.b.avgScore), (c.b.avgScore ?? 0) - (c.a.avgScore ?? 0), true, 'pts'],
    [`Biggest drop-off${c.b.biggestDrop ? ` (${c.b.biggestDrop.section})` : ''}`, pct(c.a.biggestDrop && c.a.biggestDrop.drop), pct(c.b.biggestDrop && c.b.biggestDrop.drop), ((c.b.biggestDrop && c.b.biggestDrop.drop) || 0) - ((c.a.biggestDrop && c.a.biggestDrop.drop) || 0), false, 'pts'],
    ['Typical time', minutes(c.a.avgMinutes), minutes(c.b.avgMinutes), (c.b.avgMinutes ?? 0) - (c.a.avgMinutes ?? 0), false, 'min']
  ];
  return (
    <div className="card grow-2">
      <div className="card-head"><h2>Version comparison</h2><span className="tiny muted">{c.a.version} ({c.a.learners}) vs {c.b.version} ({c.b.learners})</span></div>
      <p className="sub">Learners who started at least 7 days ago</p>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 64px 64px 84px', gap: 8, fontSize: 12, color: 'var(--muted)', fontWeight: 600, paddingBottom: 6 }}>
          <span>Metric</span><span style={{ textAlign: 'right' }}>{c.a.version}</span><span style={{ textAlign: 'right' }}>{c.b.version}</span><span style={{ textAlign: 'right' }}>Change</span>
        </div>
        {rows.map(([label, a, b, diff, higherBetter, unit]) => {
          const shown = unit === 'pts' ? Math.round(diff * 100) : Math.round(diff);
          const better = shown === 0 ? null : (shown > 0) === higherBetter;
          return (
            <div key={label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 64px 64px 84px', gap: 8, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--line-2)', fontSize: 13 }}>
              <span>{label}</span>
              <span className="num muted" style={{ textAlign: 'right' }}>{a}</span>
              <span className="num" style={{ textAlign: 'right' }}>{b}</span>
              <span style={{ textAlign: 'right', fontWeight: 600, color: better === null ? 'var(--muted)' : better ? 'var(--good)' : 'var(--warn)' }}>
                {shown === 0 ? 'No change' : `${shown > 0 ? '▲' : '▼'} ${Math.abs(shown)} ${unit}`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="callout plain" style={{ marginTop: 16 }}>The two versions were taken by different learners at different times, so this isn't a controlled test. To be sure, split learners between versions at random (an A/B test).</div>
    </div>
  );
}

function QuestionHealth({ d, reload }) {
  const toast = useToast();
  const [comps, setComps] = useState(d.competencies);
  async function setCompetency(q, value) {
    try {
      let id = value;
      if (value === '__new') {
        const name = window.prompt('Name of the new skill (competency):');
        if (!name) return;
        const c = await api('/api/competencies', { method: 'POST', body: { name } });
        setComps((cs) => [...cs.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name)));
        id = c.id;
      }
      await api(`/api/courses/${d.course.id}/items/${encodeURIComponent(q.id)}/competency`, { method: 'PUT', body: { competencyId: id ? Number(id) : null } });
      toast('Skill saved'); reload();
    } catch (e) { toast(e.message); }
  }
  const sorted = useMemo(() => d.questions, [d]);
  return (
    <section className="card flush">
      <div className="card-head"><h2>Question health</h2><span className="small muted">Discrimination: do learners who do well overall also get this one right?</span></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Question</th><th>Responses</th><th>Correct</th><th>Difficulty</th><th>Discrimination</th><th>Avg. time</th><th>Skill</th><th>Flag</th></tr></thead>
          <tbody>
            {sorted.map((q) => {
              const label = q.discriminationLabel;
              const cls = label === 'Good' ? 'good' : label === 'Poor' ? 'warn' : 'neutral';
              return (
                <tr key={q.id}>
                  <td className="wrap" style={{ maxWidth: 340 }}>{q.name || q.id}</td>
                  <td className="num">{q.n}</td>
                  <td className="num">{pct(q.correct)}</td>
                  <td>{q.difficulty || '–'}</td>
                  <td><span className={`pill ${cls}`} title={q.discrimination !== null ? `r = ${q.discrimination.toFixed(2)}` : ''}>{label}</span></td>
                  <td className="num">{q.avgSeconds ? `${Math.round(q.avgSeconds)}s` : '–'}</td>
                  <td>
                    <label className="sr-only" htmlFor={`comp-${q.id}`}>Skill for {q.id}</label>
                    <select id={`comp-${q.id}`} className="select inline" style={{ minHeight: 36, maxWidth: 200 }} value={q.competencyId || ''} onChange={(e) => setCompetency(q, e.target.value)}>
                      <option value="">Not tagged</option>
                      {comps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      <option value="__new">+ New skill…</option>
                    </select>
                  </td>
                  <td className="wrap" style={{ color: q.flags.length ? 'var(--warn-ink)' : 'var(--muted)', fontWeight: q.flags.length ? 500 : 400 }}>{q.flags.join('; ') || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
