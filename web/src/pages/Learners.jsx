import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { ago, heatColor, initials, minutes, pct } from '../format.js';
import { Empty, ErrorBox, Loading, PageHead, useApi, useToast } from '../ui.jsx';

export default function Learners() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const { data, error, reload } = useApi(`/api/learners${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  const selected = params.get('learner') || (data && data.learners[0] && String(data.learners[0].id));
  const toast = useToast();
  const fileRef = useRef(null);

  async function importRoster(file) {
    try {
      const r = await api('/api/learners/import', { method: 'POST', body: await file.text() });
      toast(`Updated ${r.imported} learners`); reload();
    } catch (e) { toast(e.message); }
  }

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading what="learners" />;

  return (
    <>
      <PageHead title="Learners & competencies" sample={data.progress.some((p) => p.team === 'Warehouse')} subtitle="Tag questions to skills once, and every course rolls up into one competency view.">
        <label className="field" style={{ minWidth: 240 }}>Find a learner
          <input type="search" className="input" placeholder="Name or team" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="field">
          <span>Names &amp; teams</span>
          <button className="btn" onClick={() => fileRef.current.click()} title="CSV with columns: id,name,team (id = the learner id in your LMS)">Import CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files[0] && importRoster(e.target.files[0])} />
        </div>
      </PageHead>

      {!data.learners.length && !search ? (
        <div className="card"><Empty title="No learner activity yet"><p>Learners appear here as soon as a tracked course sends data.</p></Empty></div>
      ) : (
        <>
          <Progress progress={data.progress} />
          <Heatmap heatmap={data.heatmap} />
          <section className="row" style={{ alignItems: 'flex-start' }}>
            <div className="card grow-1" style={{ padding: 12, maxHeight: 760, overflow: 'auto' }}>
              <h2 style={{ padding: '8px 12px' }}>Learners <span className="muted small" style={{ fontWeight: 400 }}>({data.learners.length})</span></h2>
              {data.learners.map((l) => (
                <button key={l.id} className="learner-btn" aria-current={String(l.id) === String(selected)} onClick={() => { const p = new URLSearchParams(params); p.set('learner', l.id); setParams(p); }}>
                  <span>
                    <span style={{ fontWeight: 600, display: 'block' }}>{l.name}</span>
                    <span className="tiny muted">{l.team || 'No team'} · {l.courses} course{l.courses === 1 ? '' : 's'} · {ago(l.lastActive)}</span>
                  </span>
                  {l.atRisk && <span className="pill warn">At risk</span>}
                </button>
              ))}
              {!data.learners.length && <p className="muted small" style={{ padding: 12 }}>No learners match “{search}”.</p>}
            </div>
            {selected && <Profile id={selected} key={selected} />}
          </section>
        </>
      )}
    </>
  );
}

function Progress({ progress }) {
  return (
    <section className="card">
      <div className="card-head" style={{ marginBottom: 16 }}>
        <h2>Progress by team</h2>
        <div className="legend">
          <span><span className="swatch" style={{ background: 'var(--heat-4)' }} />Mastered</span>
          <span><span className="swatch" style={{ background: 'var(--heat-3)' }} />Completed, not mastered</span>
          <span><span className="swatch" style={{ background: '#CBD5E1' }} />In progress or stopped</span>
        </div>
      </div>
      <div className="stack">
        {progress.map((p) => (
          <div className="progress-row" key={p.team}>
            <div style={{ fontWeight: 600 }}>{p.team}</div>
            <div className="stacked" role="img" aria-label={`${p.team}: ${pct(p.mastered)} mastered, ${pct(p.completed)} completed not mastered, ${pct(p.inProgress)} in progress`}>
              <div style={{ width: `${p.mastered * 100}%`, background: 'var(--heat-4)' }} />
              <div style={{ width: `${p.completed * 100}%`, background: 'var(--heat-3)' }} />
              <div style={{ width: `${p.inProgress * 100}%`, background: '#CBD5E1' }} />
            </div>
            <div className="small" style={{ color: 'var(--ink-2)' }}><span className="num">{pct(p.mastered + p.completed)}</span> done · {p.learners} learners</div>
          </div>
        ))}
      </div>
      <p className="tiny muted" style={{ margin: '12px 0 0' }}>Course enrolments started in the last 90 days.</p>
    </section>
  );
}

function Heatmap({ heatmap }) {
  if (!heatmap.competencies.length) {
    return (
      <section className="card">
        <h2>Team competency heatmap</h2>
        <p className="sub">Tag questions to skills on the Content insights page to see strengths and gaps by team.</p>
      </section>
    );
  }
  const cols = heatmap.competencies.length;
  // Weakest skill across teams, for the insight line.
  const avg = heatmap.competencies.map((c, i) => {
    const vals = heatmap.teams.map((t) => t.cells[i]).filter((v) => v !== null);
    return { name: c.name, low: heatmap.teams.filter((t) => t.cells[i] !== null && t.cells[i] < 0.5).length, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
  }).sort((a, b) => (a.avg ?? 1) - (b.avg ?? 1));
  return (
    <section className="card">
      <div className="card-head" style={{ marginBottom: 16 }}>
        <h2>Team competency heatmap</h2>
        <div className="legend">
          <span><span className="swatch" style={{ background: 'var(--heat-4)' }} />80%+ strong</span>
          <span><span className="swatch" style={{ background: 'var(--heat-3)' }} />65–79%</span>
          <span><span className="swatch" style={{ background: 'var(--heat-2)' }} />50–64%</span>
          <span><span className="swatch" style={{ background: 'var(--heat-1)' }} />Below 50% gap</span>
        </div>
      </div>
      <div className="table-wrap">
        <div className="heat" style={{ gridTemplateColumns: `140px repeat(${cols}, minmax(0, 1fr))` }} role="table" aria-label="First-attempt accuracy by team and skill">
          <div role="columnheader" />
          {heatmap.competencies.map((c) => <div key={c.id} role="columnheader" className="tiny muted" style={{ fontWeight: 600, textAlign: 'center', padding: 4 }}>{c.name}</div>)}
          {heatmap.teams.map((t) => (
            <div key={t.team} role="row" style={{ display: 'contents' }}>
              <div role="rowheader" style={{ fontWeight: 600, display: 'flex', alignItems: 'center' }}>{t.team}</div>
              {t.cells.map((v, i) => {
                const c = heatColor(v);
                return <div key={i} role="cell" className="heat-cell" style={{ background: c.bg, color: c.fg }}>{v === null ? '–' : pct(v)}</div>;
              })}
            </div>
          ))}
        </div>
      </div>
      {avg[0] && avg[0].avg !== null && (
        <p className="small" style={{ margin: '14px 0 0', color: 'var(--ink-2)' }}>
          <strong>Insight:</strong> {avg[0].name} is the weakest skill overall ({pct(avg[0].avg)})
          {avg[0].low ? `, below 50% in ${avg[0].low} team${avg[0].low === 1 ? '' : 's'}` : ''}.
        </p>
      )}
    </section>
  );
}

function Profile({ id }) {
  const { data, error, reload } = useApi(`/api/learners/${id}`);
  const [note, setNote] = useState('');
  const toast = useToast();
  if (error) return <div className="grow-2"><ErrorBox error={error} onRetry={reload} /></div>;
  if (!data) return <div className="card grow-2"><Loading what="learner" /></div>;
  const l = data.learner;

  async function addNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    try { await api(`/api/learners/${id}/notes`, { method: 'POST', body: { text: note } }); setNote(''); toast('Note added'); reload(); } catch (err) { toast(err.message); }
  }
  async function assign() {
    const title = data.weakestCompetency ? `${data.weakestCompetency} refresher` : window.prompt('What should this learner do next?', 'Review the course');
    if (!title) return;
    try { await api(`/api/learners/${id}/assignments`, { method: 'POST', body: { title } }); toast(`Assigned: ${title}`); reload(); } catch (err) { toast(err.message); }
  }

  return (
    <>
      <div className="card grow-1 stack" style={{ gap: 16 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <div className="avatar" aria-hidden="true">{initials(l.name)}</div>
          <div>
            <h2 style={{ fontSize: 18 }}>{l.name}</h2>
            <div className="small muted">{l.team || 'No team'}{l.firstSeen ? ` · since ${new Date(l.firstSeen).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : ''}</div>
          </div>
        </div>
        <div className="stat-grid">
          <div className="stat"><div className="label" style={{ fontSize: 11 }}>Courses</div><div className="num" style={{ fontSize: 20, marginTop: 4 }}>{data.stats.courses}</div></div>
          <div className="stat"><div className="label" style={{ fontSize: 11 }}>Completed</div><div className="num" style={{ fontSize: 20, marginTop: 4 }}>{data.stats.completed}</div></div>
          <div className="stat"><div className="label" style={{ fontSize: 11 }}>Avg. score</div><div className="num" style={{ fontSize: 20, marginTop: 4 }}>{pct(data.stats.avgScore)}</div></div>
          <div className="stat"><div className="label" style={{ fontSize: 11 }}>Time spent</div><div className="num" style={{ fontSize: 20, marginTop: 4 }}>{minutes(data.stats.minutes)}</div></div>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 10 }}>Competencies</div>
          {!data.competencies.length && <p className="small muted">No tagged questions answered yet.</p>}
          <div className="stack" style={{ gap: 10 }}>
            {data.competencies.map((c) => (
              <div key={c.name}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}><span>{c.name}</span><span className="num">{pct(c.value)}</span></div>
                <div style={{ height: 8, background: 'var(--line-2)', borderRadius: 4 }}><div style={{ height: 8, borderRadius: 4, width: `${c.value * 100}%`, background: c.value < 0.5 ? 'var(--warn-bar)' : 'var(--accent)' }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card grow-2 stack" style={{ gap: 16 }}>
        <h2>Learning history</h2>
        <ol className="timeline">
          {data.history.map((h, i) => (
            <li key={i}>
              <div className="tiny muted" style={{ paddingTop: 2 }}>{ago(h.when)}</div>
              <div className="rail"><span className="dot" style={{ width: 12, height: 12, background: h.good ? 'var(--good)' : h.outcome === 'in progress' ? '#94A3B8' : 'var(--warn-bar)' }} /></div>
              <div><div style={{ fontWeight: 600 }}>{h.course}</div><div className="small" style={{ color: 'var(--ink-2)', marginTop: 2 }}>{h.detail}</div></div>
            </li>
          ))}
        </ol>
        {(data.recommendation || data.risks.length > 0) && (
          <div className="callout info" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ flex: '1 1 260px' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Recommended next step</div>
              <div style={{ marginTop: 2 }}>{data.recommendation || 'Check in with this learner.'}</div>
            </div>
            <button className="btn primary small" onClick={assign}>Assign {data.weakestCompetency ? 'refresher' : 'follow-up'}</button>
          </div>
        )}
        {data.assignments.length > 0 && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Assigned</div>
            {data.assignments.map((a) => <div key={a.id} className="small" style={{ padding: '4px 0' }}>✓ {a.title} <span className="muted tiny">· {ago(a.created_at)}</span></div>)}
          </div>
        )}
        <form onSubmit={addNote} className="stack" style={{ gap: 8 }}>
          <label className="field">Notes
            <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Spoke with Priya, practical check booked for Friday" />
          </label>
          <div><button className="btn small" type="submit">Add note</button></div>
          {data.notes.map((n) => <div key={n.id} className="callout plain">{n.text}<div className="tiny muted" style={{ marginTop: 4 }}>{ago(n.created_at)}</div></div>)}
        </form>
      </div>
    </>
  );
}
