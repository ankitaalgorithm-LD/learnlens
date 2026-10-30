import { q, one } from '../db.js';

// Analytics are computed from the common event model. Events are loaded
// once per request and aggregated in JavaScript: easy to read, easy to
// extend, and fast enough for tens of thousands of learners. Heavier
// installations can move individual metrics into SQL views later.

const DAY = 86400000;
export const MASTERY_MAX_ATTEMPTS = 2;   // "mastered" = passed within 2 attempts
export const MASTERY_SCORE = 0.8;        // for courses that report no pass/fail
const pct = (n, d) => (d ? n / d : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function learnerLabel(l) {
  return l.display_name || `Learner #${l.id}`;
}

async function loadEvents({ courseId = null, since = null, learnerId = null, version = null } = {}) {
  const where = [];
  const params = [];
  if (courseId) { params.push(courseId); where.push(`e.course_id = $${params.length}`); }
  if (since) { params.push(new Date(since).toISOString()); where.push(`e.ts >= $${params.length}`); }
  if (learnerId) { params.push(learnerId); where.push(`e.learner_id = $${params.length}`); }
  if (version) { params.push(version); where.push(`e.version = $${params.length}`); }
  const rows = await q(
    `SELECT e.course_id, e.version, e.learner_id, e.session_id, e.type, e.object_id, e.success,
            e.score, e.response, e.duration_ms, e.critical, e.ts
       FROM events e ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.ts ASC, e.id ASC`,
    params
  );
  for (const r of rows) r.t = new Date(r.ts).getTime();
  return rows;
}

async function lookups() {
  const [courses, learners, sections, items, comps] = await Promise.all([
    q('SELECT * FROM courses ORDER BY id'),
    q('SELECT id, display_name, team FROM learners'),
    q('SELECT * FROM sections ORDER BY course_id, position'),
    q(`SELECT i.*, c.name AS competency, ic.competency_id
         FROM items i
         LEFT JOIN item_competencies ic ON ic.course_id = i.course_id AND ic.object_id = i.object_id
         LEFT JOIN competencies c ON c.id = ic.competency_id`),
    q('SELECT * FROM competencies ORDER BY name')
  ]);
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const sectionName = new Map(sections.map((s) => [`${s.course_id}:${s.object_id}`, s.name]));
  const itemInfo = new Map(items.map((i) => [`${i.course_id}:${i.object_id}`, i]));
  return { courses, courseById: byId(courses), learners, learnerById: byId(learners), sections, sectionName, items, itemInfo, comps };
}

/** One record per (course, learner): progress, attempts, time, errors... */
function buildPairs(events) {
  const pairs = new Map();
  for (const e of events) {
    const key = `${e.course_id}:${e.learner_id}`;
    let p = pairs.get(key);
    if (!p) {
      p = {
        courseId: e.course_id, learnerId: e.learner_id, version: e.version, first: e.t, last: e.t,
        completed: false, passed: false, fails: 0, attemptsToPass: null, durationMs: 0, criticalErrors: 0,
        errors: 0, hints: 0, sessions: new Set(), firstScore: null, lastScore: null, lastSection: null,
        completedAt: null, answers: new Map(), decisions: []
      };
      pairs.set(key, p);
    }
    p.last = e.t;
    if (e.session_id) p.sessions.add(e.session_id);
    switch (e.type) {
      case 'page_viewed':
        // Time on the first attempt only, so retakes don't inflate it.
        if (!p.firstSession) p.firstSession = e.session_id || 'none';
        if ((e.session_id || 'none') === p.firstSession) p.durationMs += e.duration_ms || 0;
        p.totalDurationMs = (p.totalDurationMs || 0) + (e.duration_ms || 0);
        p.lastSection = e.object_id;
        break;
      case 'question_answered':
        if (e.object_id && !p.answers.has(e.object_id)) p.answers.set(e.object_id, e);
        break;
      case 'decision_made':
        p.decisions.push(e);
        break;
      case 'hint_used': p.hints++; break;
      case 'error_made':
        p.errors++;
        if (e.critical) p.criticalErrors++;
        break;
      case 'score_reported':
        if (p.firstScore === null && e.score !== null) p.firstScore = e.score;
        if (e.score !== null) p.lastScore = e.score;
        break;
      case 'course_completed':
        if (!p.completed) p.completedAt = e.t;
        p.completed = true;
        break;
      case 'course_passed':
        if (!p.passed) { p.attemptsToPass = p.fails + 1; p.passed = true; }
        if (!p.completed) p.completedAt = e.t;
        p.completed = true;
        if (e.score !== null && p.firstScore === null) p.firstScore = e.score;
        break;
      case 'course_failed':
        if (!p.passed) p.fails++;
        if (e.score !== null && p.firstScore === null) p.firstScore = e.score;
        break;
    }
  }
  // Courses that never report pass/fail fall back to the first score.
  const passFailCourses = new Set();
  for (const p of pairs.values()) if (p.passed || p.fails) passFailCourses.add(p.courseId);
  for (const p of pairs.values()) {
    if (passFailCourses.has(p.courseId)) p.mastered = p.passed && p.attemptsToPass <= MASTERY_MAX_ATTEMPTS;
    else {
      const answers = [...p.answers.values()];
      const correct = answers.length ? answers.filter((a) => a.success).length / answers.length : null;
      const score = p.firstScore !== null ? p.firstScore : correct;
      p.mastered = p.completed && score !== null && score >= MASTERY_SCORE;
    }
  }
  return [...pairs.values()];
}

function courseMedians(pairs) {
  const byCourse = new Map();
  for (const p of pairs) {
    if (!p.completed || !p.durationMs) continue;
    if (!byCourse.has(p.courseId)) byCourse.set(p.courseId, []);
    byCourse.get(p.courseId).push(p.durationMs);
  }
  const out = new Map();
  for (const [k, v] of byCourse) out.set(k, median(v));
  return out;
}

const fmtMin = (ms) => `${Math.round(ms / 60000)} min`;
const daysAgo = (t, now) => Math.floor((now - t) / DAY);

/** Learners who need help. Shared by the dashboard and the alerts engine. */
export function findRisks(pairs, lk, { stalledDays = 7, failCount = 2, rushRatio = 0.3, criticalCount = 3, now = Date.now() } = {}) {
  const medians = courseMedians(pairs);
  const risks = [];
  for (const p of pairs) {
    const course = lk.courseById.get(p.courseId);
    const learner = lk.learnerById.get(p.learnerId);
    if (!course || !learner) continue;
    const base = { courseId: p.courseId, course: course.name, learnerId: p.learnerId, learner: learnerLabel(learner), team: learner.team, last: p.last };
    const idle = daysAgo(p.last, now);
    if (!p.completed && idle >= stalledDays && idle <= 30) {
      const where = p.lastSection ? ` on ${lk.sectionName.get(`${p.courseId}:${p.lastSection}`) || p.lastSection}` : '';
      risks.push({ ...base, kind: 'stalled', reason: `Stalled ${idle} days${where}`, severity: 2 });
    }
    if (!p.passed && p.fails >= failCount) {
      risks.push({ ...base, kind: 'repeated_failure', reason: `Failed the final assessment ${p.fails} times`, severity: 3 });
    }
    const med = medians.get(p.courseId);
    if (p.completed && med && p.durationMs > 0 && p.durationMs < rushRatio * med) {
      risks.push({ ...base, kind: 'rushing', reason: `Finished in ${fmtMin(p.durationMs)} (typical ${fmtMin(med)})`, severity: 1 });
    }
    if (p.criticalErrors >= criticalCount) {
      risks.push({ ...base, kind: 'critical_errors', reason: `${p.criticalErrors} critical errors in ${Math.max(1, p.sessions.size)} attempts`, severity: 3 });
    }
  }
  return risks.sort((a, b) => b.severity - a.severity || b.last - a.last);
}

// ---------------------------------------------------------------- overview

export async function overview({ days = 30, team = null, now = Date.now() } = {}) {
  const lk = await lookups();
  const since = now - 2 * days * DAY;
  let events = await loadEvents({ since: Math.min(since, now - 84 * DAY) });
  if (team) {
    const ids = new Set(lk.learners.filter((l) => l.team === team).map((l) => l.id));
    events = events.filter((e) => ids.has(e.learner_id));
  }
  const allPairs = buildPairs(events);
  const start = now - days * DAY;
  const prevStart = now - 2 * days * DAY;
  const cur = allPairs.filter((p) => p.first >= start);
  const prev = allPairs.filter((p) => p.first >= prevStart && p.first < start);

  const activeNow = new Set(events.filter((e) => e.t >= start).map((e) => e.learner_id)).size;
  const activePrev = new Set(events.filter((e) => e.t >= prevStart && e.t < start).map((e) => e.learner_id)).size;
  const rate = (ps, f) => pct(ps.filter(f).length, ps.length);
  const recentPairs = allPairs.filter((p) => p.last >= start);
  const risks = findRisks(recentPairs, lk, { now });
  const riskLearners = new Set(risks.map((r) => r.learnerId));

  // Weekly trend by start week (12 weeks).
  const trend = [];
  for (let w = 11; w >= 0; w--) {
    const ws = now - (w + 1) * 7 * DAY;
    const we = now - w * 7 * DAY;
    const ps = allPairs.filter((p) => p.first >= ws && p.first < we);
    trend.push({ week: `W${12 - w}`, starts: ps.length, completion: rate(ps, (p) => p.completed), mastery: rate(ps, (p) => p.mastered) });
  }

  const medians = courseMedians(allPairs);
  const courses = [];
  for (const c of lk.courses) {
    const ps = cur.filter((p) => p.courseId === c.id);
    const insights = ps.length ? await courseFlags(c, events.filter((e) => e.course_id === c.id && e.t >= start), lk) : [];
    const mastery = rate(ps, (p) => p.mastered);
    let status = 'Healthy';
    if (!ps.length) status = 'No data yet';
    else if (insights.length) status = insights[0];
    else if (mastery !== null && mastery < 0.5) status = 'Low mastery';
    courses.push({
      id: c.id, name: c.name, source: `${methodLabel(c.method)}${c.source_tool ? ' · ' + c.source_tool : ''}`,
      learners: ps.length, completion: rate(ps, (p) => p.completed), mastery,
      avgMinutes: medians.get(c.id) ? medians.get(c.id) / 60000 : null, status, healthy: status === 'Healthy'
    });
  }

  // Latest open alerts, one per kind, so the panel shows a mix.
  const openAlerts = await q(
    `SELECT a.id, a.title, a.detail, a.course_id, a.learner_id, r.kind
       FROM alerts a LEFT JOIN alert_rules r ON r.id = a.rule_id
      WHERE a.status = 'open' ORDER BY a.created_at DESC, a.id DESC LIMIT 200`
  );
  const priority = ['confusing_question', 'critical_errors', 'stalled', 'repeated_failure', 'rushing', 'course_quiet'];
  const alerts = [];
  for (const kind of priority) {
    const a = openAlerts.find((x) => x.kind === kind);
    if (a) alerts.push(a);
    if (alerts.length === 3) break;
  }

  return {
    kpis: {
      activeLearners: { value: activeNow, prev: activePrev },
      completion: { value: rate(cur, (p) => p.completed), prev: rate(prev, (p) => p.completed) },
      mastery: { value: rate(cur, (p) => p.mastered), prev: rate(prev, (p) => p.mastered) },
      atRisk: { value: riskLearners.size }
    },
    trend,
    courses,
    alerts,
    risks: mixKinds(dedupeByLearner(risks)).slice(0, 8).map(stripRisk),
    teams: [...new Set(lk.learners.map((l) => l.team).filter(Boolean))].sort(),
    courseCount: lk.courses.length,
    tools: [...new Set(lk.courses.map((c) => c.source_tool).filter(Boolean))].length
  };
}

/** Round-robin across risk kinds so one kind doesn't fill the list. */
function mixKinds(risks) {
  const groups = new Map();
  for (const r of risks) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind).push(r);
  }
  const out = [];
  const lists = [...groups.values()];
  for (let i = 0; out.length < risks.length; i++) {
    for (const g of lists) if (g[i]) out.push(g[i]);
  }
  return out;
}

function dedupeByLearner(risks) {
  const seen = new Set();
  return risks.filter((r) => {
    const k = `${r.learnerId}:${r.courseId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
const stripRisk = (r) => ({ ...r, last: new Date(r.last).toISOString() });

export function methodLabel(m) {
  return { scorm: 'SCORM', xapi: 'xAPI', sdk: 'SDK' }[m] || m;
}

// ------------------------------------------------------- content insights

function sectionStats(course, events, pairs, lk) {
  const sections = lk.sections.filter((s) => s.course_id === course.id);
  const started = pairs.length;
  const reached = new Map();
  const time = new Map();
  for (const e of events) {
    if (e.type !== 'page_viewed' || !e.object_id) continue;
    if (!reached.has(e.object_id)) reached.set(e.object_id, new Set());
    reached.get(e.object_id).add(e.learner_id);
    const k = `${e.object_id}:${e.learner_id}`;
    time.set(k, (time.get(k) || 0) + (e.duration_ms || 0));
  }
  const funnel = sections.map((s) => ({
    id: s.object_id, name: s.name, reached: pct((reached.get(s.object_id) || new Set()).size, started)
  }));
  funnel.push({ id: '__completed', name: 'Completed', reached: pct(pairs.filter((p) => p.completed).length, started) });

  let biggest = null;
  for (let i = 1; i < funnel.length; i++) {
    const drop = (funnel[i - 1].reached || 0) - (funnel[i].reached || 0);
    if (!biggest || drop > biggest.drop) biggest = { drop, from: funnel[i - 1], to: funnel[i], index: i - 1 };
  }

  const times = sections.map((s) => {
    const per = [];
    for (const [k, v] of time) if (k.startsWith(`${s.object_id}:`)) per.push(v);
    const actual = mean(per);
    const designed = s.designed_minutes;
    const minutes = actual === null ? null : actual / 60000;
    let flag = null;
    if (minutes !== null && designed) {
      if (minutes > designed * 1.5) flag = 'stuck';
      else if (minutes < designed * 0.75) flag = 'rushed';
    }
    return { id: s.object_id, name: s.name, minutes, designed, flag, ratio: minutes && designed ? minutes / designed : null };
  });
  return { funnel, biggestDrop: biggest && biggest.drop > 0 ? biggest : null, times };
}

function correlation(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function questionStats(course, events, pairs, lk) {
  const questions = lk.items.filter((i) => i.course_id === course.id && i.kind === 'question')
    .sort((a, b) => naturalCompare(a.object_id, b.object_id));
  return questions.map((item) => {
    const answers = pairs.map((p) => p.answers.get(item.object_id)).filter(Boolean);
    const n = answers.length;
    const correct = pct(answers.filter((a) => a.success).length, n);
    // Discrimination = corrected item–rest correlation (point-biserial): do
    // learners who do well on the OTHER questions also get this one right?
    const xs = [];
    const ys = [];
    for (const p of pairs) {
      const a = p.answers.get(item.object_id);
      if (!a || a.success === null) continue;
      const rest = [...p.answers.values()].filter((o) => o.object_id !== item.object_id && o.success !== null);
      if (!rest.length) continue;
      xs.push(a.success ? 1 : 0);
      ys.push(rest.filter((o) => o.success).length / rest.length);
    }
    const discrimination = xs.length >= 20 ? correlation(xs, ys) : null;
    const counts = new Map();
    for (const a of answers) {
      const r = a.response === null ? '(no response)' : a.response;
      counts.set(r, (counts.get(r) || 0) + 1);
    }
    const responses = [...counts.entries()]
      .map(([response, c]) => ({ response, share: c / n, correct: answers.some((a) => a.response === response && a.success) }))
      .sort((a, b) => b.share - a.share);
    const topWrong = responses.find((r) => !r.correct);
    const flags = [];
    if (n >= 10) {
      if (topWrong && topWrong.share >= 0.4 && topWrong.share > (correct || 0)) flags.push(`Likely confusing: ${Math.round(topWrong.share * 100)}% choose "${topWrong.response}"`);
      else if (correct !== null && correct >= 0.9) flags.push('Too easy: consider removing or rewriting');
      if (discrimination !== null && discrimination < 0.15 && !(correct >= 0.9)) flags.push("Doesn't separate strong and weak learners");
    }
    const times = answers.map((a) => a.duration_ms).filter((x) => x);
    return {
      id: item.object_id, name: item.name, n, correct,
      difficulty: correct === null ? null : correct >= 0.8 ? 'Easy' : correct >= 0.5 ? 'Medium' : 'Hard',
      discrimination,
      discriminationLabel: discrimination === null ? 'Not enough data' : discrimination >= 0.25 ? 'Good' : discrimination >= 0.15 ? 'Fair' : 'Poor',
      avgSeconds: times.length ? mean(times) / 1000 : null,
      responses, flags, competencyId: item.competency_id || null, competency: item.competency || null
    };
  });
}

async function courseFlags(course, events, lk) {
  const pairs = buildPairs(events);
  if (pairs.length < 10) return [];
  const flags = [];
  const s = sectionStats(course, events, pairs, lk);
  if (s.biggestDrop && s.biggestDrop.drop >= 0.12) {
    // Losing people between the last section and "Completed" means they failed it.
    flags.push(s.biggestDrop.to.id === '__completed' ? `Low pass rate at ${s.biggestDrop.from.name}` : `Drop-off at ${s.biggestDrop.from.name}`);
  }
  const qs = questionStats(course, events, pairs, lk);
  if (qs.some((x) => x.flags.some((f) => f.startsWith('Likely confusing')))) flags.push('Confusing question');
  return flags;
}

export async function courseInsights(courseId, { version = null, days = 365, now = Date.now() } = {}) {
  const lk = await lookups();
  const course = lk.courseById.get(Number(courseId));
  if (!course) return null;
  const all = await loadEvents({ courseId: course.id, since: now - days * DAY });
  const versions = [...new Set(all.map((e) => e.version))].sort(naturalCompare);
  const selected = version && versions.includes(version) ? version : versions[versions.length - 1] || course.version;
  const events = all.filter((e) => e.version === selected);
  const pairs = buildPairs(events);

  const sections = sectionStats(course, events, pairs, lk);
  const questions = questionStats(course, events, pairs, lk);
  const completers = pairs.filter((p) => p.completed && p.durationMs);
  const scores = pairs.map((p) => p.firstScore).filter((x) => x !== null);

  // Version comparison only counts learners who started 7+ days ago, so a new
  // version isn't penalised for learners who are still working through it.
  const summarize = (ver) => {
    const ev = all.filter((e) => e.version === ver);
    const ps = buildPairs(ev).filter((p) => p.first <= now - 7 * DAY);
    const keep = new Set(ps.map((p) => p.learnerId));
    const evKept = ev.filter((e) => keep.has(e.learner_id));
    const st = sectionStats(course, evKept, ps, lk);
    const sc = ps.map((p) => p.firstScore).filter((x) => x !== null);
    const done = ps.filter((p) => p.completed && p.durationMs);
    return {
      version: ver, learners: ps.length,
      completion: pct(ps.filter((p) => p.completed).length, ps.length),
      avgScore: mean(sc),
      biggestDrop: st.biggestDrop ? { section: st.biggestDrop.from.name, drop: st.biggestDrop.drop } : null,
      avgMinutes: done.length ? median(done.map((p) => p.durationMs)) / 60000 : null,
      firstQuestionCorrect: Object.fromEntries(questionStats(course, evKept, ps, lk).map((x) => [x.id, x.correct]))
    };
  };
  const prevVersion = versions[versions.indexOf(selected) - 1];

  return {
    course: { id: course.id, name: course.name, method: course.method, sourceTool: course.source_tool, designedMinutes: course.designed_minutes },
    versions, version: selected,
    kpis: {
      avgMinutes: completers.length ? median(completers.map((p) => p.durationMs)) / 60000 : null,
      dropOff: pairs.length ? 1 - pairs.filter((p) => p.completed).length / pairs.length : null,
      avgScore: mean(scores),
      flagged: questions.filter((x) => x.flags.length).length,
      questions: questions.length,
      learners: pairs.length
    },
    funnel: sections.funnel,
    // Learners leave ON the "from" section: they viewed it, then never reached the next one.
    biggestDrop: sections.biggestDrop && {
      section: sections.biggestDrop.from.name, sectionId: sections.biggestDrop.from.id, drop: sections.biggestDrop.drop,
      time: sections.times.find((t) => t.id === sections.biggestDrop.from.id) || null
    },
    times: sections.times,
    questions,
    comparison: prevVersion ? { a: summarize(prevVersion), b: summarize(selected) } : null,
    competencies: lk.comps
  };
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// --------------------------------------------------------------- learners

export async function learnersOverview({ now = Date.now(), days = 90 } = {}) {
  const lk = await lookups();
  const events = await loadEvents({ since: now - days * DAY });
  const pairs = buildPairs(events);

  const teams = new Map();
  for (const p of pairs) {
    const l = lk.learnerById.get(p.learnerId);
    const team = (l && l.team) || 'No team';
    if (!teams.has(team)) teams.set(team, { team, pairs: 0, mastered: 0, completed: 0, inProgress: 0, learners: new Set() });
    const t = teams.get(team);
    t.pairs++;
    t.learners.add(p.learnerId);
    if (p.mastered) t.mastered++;
    else if (p.completed) t.completed++;
    else t.inProgress++;
  }
  const progress = [...teams.values()]
    .map((t) => ({ team: t.team, learners: t.learners.size, mastered: t.mastered / t.pairs, completed: t.completed / t.pairs, inProgress: t.inProgress / t.pairs }))
    .sort((a, b) => a.team.localeCompare(b.team));

  // Competency heatmap: first-attempt correctness on tagged items.
  const cell = new Map();
  for (const p of pairs) {
    const l = lk.learnerById.get(p.learnerId);
    const team = (l && l.team) || 'No team';
    const results = [...p.answers.values()].map((a) => [a.object_id, a.success]);
    for (const d of p.decisions) results.push([d.object_id, d.success]);
    for (const [obj, ok] of results) {
      const info = lk.itemInfo.get(`${p.courseId}:${obj}`);
      if (!info || !info.competency_id || ok === null) continue;
      const k = `${team}|${info.competency_id}`;
      const c = cell.get(k) || { n: 0, ok: 0 };
      c.n++; if (ok) c.ok++;
      cell.set(k, c);
    }
  }
  const usedComps = lk.comps.filter((c) => [...cell.keys()].some((k) => k.endsWith(`|${c.id}`)));
  const heatmap = {
    competencies: usedComps.map((c) => ({ id: c.id, name: c.name })),
    teams: progress.map((t) => ({
      team: t.team,
      cells: usedComps.map((c) => {
        const v = cell.get(`${t.team}|${c.id}`);
        return v && v.n >= 3 ? v.ok / v.n : null;
      })
    })).filter((t) => t.cells.some((v) => v !== null))
  };

  const lastActive = new Map();
  const courseCount = new Map();
  for (const p of pairs) {
    lastActive.set(p.learnerId, Math.max(lastActive.get(p.learnerId) || 0, p.last));
    courseCount.set(p.learnerId, (courseCount.get(p.learnerId) || 0) + 1);
  }
  const riskSet = new Set(findRisks(pairs.filter((p) => p.last >= now - 30 * DAY), lk, { now }).map((r) => r.learnerId));
  const learners = lk.learners
    .filter((l) => lastActive.has(l.id))
    .map((l) => ({ id: l.id, name: learnerLabel(l), team: l.team, courses: courseCount.get(l.id), lastActive: new Date(lastActive.get(l.id)).toISOString(), atRisk: riskSet.has(l.id) }))
    .sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || a.name.localeCompare(b.name));

  return { progress, heatmap, learners };
}

export async function learnerDetail(learnerId, { now = Date.now() } = {}) {
  const lk = await lookups();
  const learner = lk.learnerById.get(Number(learnerId));
  if (!learner) return null;
  const events = await loadEvents({ learnerId: learner.id });
  const pairs = buildPairs(events);

  // Competencies across all courses.
  const comp = new Map();
  for (const p of pairs) {
    const results = [...p.answers.values()].map((a) => [a.object_id, a.success]);
    for (const d of p.decisions) results.push([d.object_id, d.success]);
    for (const [obj, ok] of results) {
      const info = lk.itemInfo.get(`${p.courseId}:${obj}`);
      if (!info || !info.competency_id || ok === null) continue;
      const c = comp.get(info.competency) || { n: 0, ok: 0 };
      c.n++; if (ok) c.ok++;
      comp.set(info.competency, c);
    }
  }
  const competencies = [...comp.entries()].map(([name, c]) => ({ name, value: c.ok / c.n, n: c.n })).sort((a, b) => b.value - a.value);

  // History: one line per session.
  const sessions = new Map();
  for (const e of events) {
    const k = `${e.course_id}:${e.session_id || 'none'}`;
    if (!sessions.has(k)) sessions.set(k, { courseId: e.course_id, start: e.t, end: e.t, events: [] });
    const s = sessions.get(k);
    s.end = e.t;
    s.events.push(e);
  }
  const history = [...sessions.values()].sort((a, b) => b.end - a.end).slice(0, 12).map((s) => describeSession(s, lk));

  const scores = pairs.map((p) => p.firstScore).filter((x) => x !== null);
  // Only recommend from skills with enough answers to mean something.
  const reliable = competencies.filter((c) => c.n >= 3);
  const weakest = reliable.length ? reliable[reliable.length - 1] : null;
  const risks = findRisks(pairs, lk, { now });
  let recommendation = null;
  if (weakest && weakest.value < 0.5) recommendation = `Assign a ${weakest.name} refresher, then a supervised practical check before the next attempt.`;
  else if (risks.length) recommendation = `Follow up: ${risks[0].reason.toLowerCase()} (${risks[0].course}).`;

  const [notes, assignments] = await Promise.all([
    q('SELECT id, text, created_at FROM notes WHERE learner_id = $1 ORDER BY created_at DESC', [learner.id]),
    q('SELECT id, title, created_at FROM assignments WHERE learner_id = $1 ORDER BY created_at DESC', [learner.id])
  ]);

  return {
    learner: { id: learner.id, name: learnerLabel(learner), team: learner.team, firstSeen: events[0] ? new Date(events[0].t).toISOString() : null },
    stats: {
      courses: pairs.length,
      completed: pairs.filter((p) => p.completed).length,
      avgScore: mean(scores),
      minutes: pairs.reduce((a, p) => a + (p.totalDurationMs || 0), 0) / 60000
    },
    competencies, history, risks: risks.map(stripRisk), recommendation,
    weakestCompetency: weakest && weakest.value < 0.5 ? weakest.name : null,
    notes, assignments
  };
}

function describeSession(s, lk) {
  const course = lk.courseById.get(s.courseId);
  const ev = s.events;
  const count = (t, f = () => true) => ev.filter((e) => e.type === t && f(e)).length;
  const parts = [];
  const crit = count('error_made', (e) => e.critical);
  const hints = count('hint_used');
  const answers = ev.filter((e) => e.type === 'question_answered');
  const score = [...ev].reverse().find((e) => e.score !== null && e.score !== undefined);
  let outcome = 'in progress';
  if (count('course_passed')) outcome = 'passed';
  else if (count('course_failed')) outcome = 'not passed';
  else if (count('course_completed')) outcome = 'completed';
  if (score) parts.push(`${Math.round(score.score * 100)}%`);
  if (answers.length) parts.push(`${answers.filter((a) => a.success).length}/${answers.length} questions correct`);
  if (crit) parts.push(`${crit} critical error${crit > 1 ? 's' : ''}`);
  if (hints) parts.push(`${hints} hint${hints > 1 ? 's' : ''} used`);
  return {
    course: course ? course.name : 'Unknown course', when: new Date(s.end).toISOString(), outcome,
    detail: [outcome[0].toUpperCase() + outcome.slice(1), ...parts].join(' · '),
    good: outcome === 'passed' || (outcome === 'completed' && !crit)
  };
}

// Exposed for the alerts engine and reports.
export { buildPairs, loadEvents, lookups, questionStats, sectionStats, mean, median, pct };
export async function courseCount() {
  return (await one('SELECT count(*)::int AS n FROM courses')).n;
}
