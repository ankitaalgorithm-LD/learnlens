#!/usr/bin/env node
/**
 * LearnLens bot learners.
 *
 * Creates five demo courses and ~240 synthetic learners, then sends their
 * activity through the REAL tracking endpoints, exactly like live courses do:
 *   - Fire Safety Essentials  → SCORM wrapper payloads   (POST /api/ingest)
 *   - Customer Escalations    → SCORM wrapper payloads   (POST /api/ingest)
 *   - Data Privacy 2026       → xAPI statements          (POST /xapi/statements)
 *   - New Manager Basics      → xAPI statements          (POST /xapi/statements)
 *   - Forklift Operation Sim  → JavaScript SDK payloads  (POST /api/ingest)
 *
 * ALL DATA IS SYNTHETIC. Some course-design problems are planted on purpose
 * (a slide where people drop off, a confusing question, a question about
 * content the course never teaches) so the dashboards have something to find.
 *
 * Usage: node scripts/simulate.js [--url http://localhost:4000] [--token ADMIN_TOKEN] [--learners 240]
 */

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const BASE = String(args.url || process.env.LEARNLENS_URL || 'http://localhost:4000').replace(/\/$/, '');
const TOKEN = args.token || process.env.ADMIN_TOKEN || '';
const TOTAL = Number(args.learners || 240);
const DAY = 86400000;
const NOW = Date.now();

// ---------------------------------------------------------------- random
let seed = 20261031;
function rand() { // mulberry32: reproducible runs
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p) => rand() < p;
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const clamp = (x, a = 0.02, b = 0.98) => Math.max(a, Math.min(b, x));
const jitter = (x, spread = 0.35) => x * Math.exp((rand() - 0.5) * 2 * spread);

// ------------------------------------------------------------------ http
async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// --------------------------------------------------------------- people
const FIRST = ['Aarav', 'Ananya', 'Rohan', 'Isha', 'Kabir', 'Meera', 'Vikram', 'Diya', 'Aditya', 'Kavya', 'Nikhil', 'Pooja', 'Siddharth', 'Riya', 'Karan', 'Neha', 'Arnav', 'Tanvi', 'Manish', 'Shreya', 'Farhan', 'Zoya', 'Daniel', 'Grace', 'Omar', 'Lina', 'Tomás', 'Mei', 'Kofi', 'Sara', 'Ravi', 'Anjali', 'Dev', 'Nisha', 'Imran', 'Leela', 'Joseph', 'Fatima', 'Harsh', 'Priyanka'];
const LAST = ['Sharma', 'Banerjee', 'Gupta', 'Iyer', 'Reddy', 'Mukherjee', 'Khan', 'Fernandes', 'Patel', 'Ghosh', 'Menon', 'Rao', 'Chatterjee', 'Kapoor', 'Joshi', 'Singh', 'Das', 'Pillai', 'Bose', 'Kulkarni', 'Thomas', 'Ali', 'Mehta', 'Sen', 'Nair'];
const TEAMS = [
  { name: 'Warehouse', share: 0.17, mod: { hazard: 0.0, equipment: 0.05, emergency: -0.42, data: -0.1, customer: -0.05 } },
  { name: 'Sales', share: 0.21, mod: { hazard: 0.02, equipment: -0.1, emergency: -0.08, data: -0.05, customer: 0.15 } },
  { name: 'Support', share: 0.19, mod: { hazard: 0.02, equipment: 0, emergency: -0.05, data: 0.06, customer: 0.15 } },
  { name: 'Operations', share: 0.23, mod: { hazard: 0.1, equipment: 0.1, emergency: -0.02, data: 0.04, customer: -0.02 } },
  { name: 'New joiners', share: 0.2, mod: { hazard: -0.12, equipment: -0.15, emergency: -0.18, data: -0.12, customer: -0.1 } }
];
const PERSONAS = [
  { name: 'expert', share: 0.15, ability: 0.93, speed: 0.85, dropout: 0.4 },
  { name: 'careful', share: 0.43, ability: 0.78, speed: 1.1, dropout: 0.7 },
  { name: 'average', share: 0.27, ability: 0.6, speed: 1.0, dropout: 1.0 },
  { name: 'rusher', share: 0.05, ability: 0.5, speed: 0.22, dropout: 0.8 },
  { name: 'struggler', share: 0.1, ability: 0.3, speed: 1.35, dropout: 2.2 }
];
const weighted = (xs) => { let r = rand(); for (const x of xs) { if ((r -= x.share) <= 0) return x; } return xs[xs.length - 1]; };

function makeLearners() {
  const people = [];
  const used = new Set();
  // A few named characters, consistent with the design mockups.
  const fixed = [
    { name: 'Priya Nair', team: 'Warehouse', persona: 'struggler', forklift: 'critical' },
    { name: 'Arjun Das', team: 'Warehouse', persona: 'average', stallFire: true },
    { name: 'Sneha Iyer', team: 'Support', persona: 'rusher' },
    { name: 'Rahul Verma', team: 'Sales', persona: 'struggler', failPrivacy: true }
  ];
  for (const f of fixed) {
    used.add(f.name);
    people.push({ ...f, id: `demo-${people.length + 1}`, teamObj: TEAMS.find((t) => t.name === f.team), personaObj: PERSONAS.find((p) => p.name === f.persona) });
  }
  while (people.length < TOTAL) {
    let name;
    do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(name));
    used.add(name);
    const team = weighted(TEAMS);
    people.push({ id: `demo-${people.length + 1}`, name, team: team.name, teamObj: team, personaObj: weighted(PERSONAS) });
  }
  return people;
}

// ------------------------------------------------------------- courses
const FIRE = {
  name: 'Fire Safety Essentials', method: 'scorm', sourceTool: 'Storyline', lms: 'Moodle', designedMinutes: 20,
  sections: [
    ['slide-01', 'Introduction', 2], ['slide-04', 'Types of fire hazards', 3], ['slide-08', 'Using an extinguisher', 4],
    ['slide-12', 'Exits & signage', 3], ['slide-14', 'Evacuation routes', 3], ['slide-18', 'Final quiz', 5]
  ],
  questions: [
    { id: 'Q1', name: 'Q1 · Which class of fire involves electrical equipment?', comp: 'hazard', ease: 0.3, correct: 'C', options: ['A', 'B', 'C', 'D'] },
    { id: 'Q3', name: 'Q3 · Which extinguisher is safe on an oil fire?', comp: 'equipment', ease: 0.05, correct: 'B', options: ['A', 'B', 'C', 'D'] },
    { id: 'Q5', name: 'Q5 · What do you do first when the alarm sounds?', comp: 'emergency', ease: 0.08, correct: 'A', options: ['A', 'B', 'C', 'D'] },
    { id: 'Q7', name: 'Q7 · Which exit should you use if the corridor is blocked?', comp: 'emergency', confusing: true, correct: 'B', trap: 'C', options: ['A', 'B', 'C', 'D'] },
    { id: 'Q8', name: 'Q8 · Where is your assembly point?', comp: 'emergency', ease: 0.0, correct: 'D', options: ['A', 'B', 'C', 'D'] },
    { id: 'Q10', name: 'Q10 · How do you report a near miss?', comp: 'hazard', uncovered: true, correct: 'A', options: ['A', 'B', 'C', 'D'] }
  ],
  teams: ['Warehouse', 'Sales', 'Support', 'Operations', 'New joiners'], take: 0.95, passMark: 0.5,
  versions: [{ v: 'v2', until: 6 * 7, slowSlide: 'slide-14', slowFactor: 2.7, slideDrop: 0.34 }, { v: 'v3', slowSlide: 'slide-14', slowFactor: 2.2, slideDrop: 0.13 }]
};
const PRIVACY = {
  name: 'Data Privacy 2026', method: 'xapi', sourceTool: 'Rise', lms: 'TalentLMS', designedMinutes: 18,
  sections: [['lesson-1', 'Why privacy matters', 3], ['lesson-2', 'Personal data at work', 4], ['lesson-3', 'Sharing and storing data', 5], ['lesson-4', 'Spotting a breach', 3], ['assessment', 'Knowledge check', 3]],
  questions: [
    { id: 'dp-q1', name: 'What counts as personal data?', comp: 'data', ease: 0.15, correct: 'A', options: ['A', 'B', 'C', 'D'] },
    { id: 'dp-q2', name: 'Can you email a customer list to your personal address?', comp: 'data', ease: 0.25, correct: 'B', options: ['A', 'B'] },
    { id: 'dp-q3', name: 'How long can recruitment data be kept?', comp: 'data', ease: -0.15, correct: 'C', options: ['A', 'B', 'C', 'D'] },
    { id: 'dp-q4', name: 'First step after a suspected breach?', comp: 'data', ease: 0.0, correct: 'D', options: ['A', 'B', 'C', 'D'] },
    { id: 'dp-q5', name: 'Which file share is approved?', comp: 'data', ease: 0.05, correct: 'A', options: ['A', 'B', 'C'] }
  ],
  teams: ['Warehouse', 'Sales', 'Support', 'Operations', 'New joiners'], take: 0.9, passMark: 0.6,
  versions: [{ v: 'v1' }]
};
const ESCALATIONS = {
  name: 'Customer Escalations', method: 'scorm', sourceTool: 'iSpring', lms: 'Moodle', designedMinutes: 22,
  sections: [['s1', 'Recognising an escalation', 4], ['s2', 'Listening and acknowledging', 5], ['s3', 'Options and promises', 5], ['s4', 'Handing over', 4], ['s5', 'Assessment', 4]],
  questions: [
    { id: 'ce-1', name: 'Customer says "this is the third time I call"', comp: 'customer', ease: 0.1, correct: 'B', options: ['A', 'B', 'C', 'D'] },
    { id: 'ce-2', name: 'What can you promise on a refund?', comp: 'customer', ease: -0.05, correct: 'C', options: ['A', 'B', 'C', 'D'] },
    { id: 'ce-3', name: 'When to hand over to a supervisor', comp: 'customer', ease: 0.05, correct: 'A', options: ['A', 'B', 'C'] },
    { id: 'ce-4', name: 'Best opening line after a complaint', comp: 'customer', ease: 0.12, correct: 'D', options: ['A', 'B', 'C', 'D'] }
  ],
  teams: ['Sales', 'Support'], take: 0.9, passMark: 0.75, versions: [{ v: 'v1' }]
};
const MANAGER = {
  name: 'New Manager Basics', method: 'xapi', sourceTool: 'Captivate', lms: 'Docebo', designedMinutes: 25,
  sections: [['m1', 'Your first 90 days', 6], ['m2', 'Running one-to-ones', 7], ['m3', 'Giving feedback', 7], ['m4', 'Final check', 5]],
  questions: [
    { id: 'nm-1', name: 'Purpose of a one-to-one', comp: 'customer', ease: 0.0, correct: 'A', options: ['A', 'B', 'C'] },
    { id: 'nm-2', name: 'Feedback model: situation, behaviour, …?', comp: 'customer', ease: -0.1, correct: 'C', options: ['A', 'B', 'C', 'D'] },
    { id: 'nm-3', name: 'Handling an underperformer', comp: 'customer', ease: -0.2, correct: 'B', options: ['A', 'B', 'C', 'D'] }
  ],
  teams: ['Sales', 'Support', 'Operations'], take: 0.18, passMark: 0.67, extraDrop: 0.09, versions: [{ v: 'v1' }]
};
const FORKLIFT = {
  name: 'Forklift Operation Sim', method: 'sdk', sourceTool: 'Custom 3D', lms: 'Moodle', designedMinutes: 30,
  scenes: [
    ['pre-check', 'Pre-use inspection', 7, [['check_tyres', 'hazard', false], ['check_forks', 'equipment', false], ['check_horn', 'equipment', false]]],
    ['route', 'Driving the route', 8, [['mirror_check', 'hazard', false], ['speed_control', 'equipment', false], ['pedestrian_zone', 'hazard', true]]],
    ['loading', 'Loading the pallet', 8, [['pallet_hazard', 'hazard', true], ['load_balance', 'equipment', false], ['mast_tilt', 'equipment', false]]],
    ['emergency', 'Emergency stop drill', 7, [['emergency_stop', 'emergency', true], ['evacuate_area', 'emergency', false], ['report_incident', 'emergency', false]]]
  ],
  teams: ['Warehouse', 'Operations', 'New joiners'], take: 0.85, versions: [{ v: 'v1' }]
};

const COMPETENCIES = { hazard: 'Hazard identification', equipment: 'Equipment use', emergency: 'Emergency response', data: 'Data handling', customer: 'Customer communication' };

// ------------------------------------------------------- learner journeys
function startTime() {
  // More starts in recent weeks (courses were rolled out gradually).
  const daysAgo = 84 * Math.pow(rand(), 1.25);
  return NOW - daysAgo * DAY + rand() * 8 * 3600000;
}

function answer(q, person, attempt, version) {
  const ab = person.personaObj.ability + (person.teamObj.mod[q.comp] || 0) + attempt * 0.12;
  let p;
  if (q.uncovered) p = 0.42; // not taught: close to guessing, unrelated to ability
  else if (q.confusing) p = clamp(0.12 + 0.3 * ab);
  else p = clamp(ab + (q.ease || 0));
  if (chance(p)) return { response: q.correct, success: true };
  const wrong = q.options.filter((o) => o !== q.correct);
  const response = q.trap && chance(0.82) ? q.trap : pick(wrong);
  return { response, success: false };
}

/** A linear course (slides + quiz). Returns normalised LearnLens events. */
function linearJourney(course, person, extra = {}) {
  const events = [];
  let t = startTime();
  const versionFor = (time) => {
    if (course.versions.length === 1) return course.versions[0];
    return NOW - time > course.versions[0].until * DAY ? course.versions[0] : course.versions[1];
  };
  const ver = versionFor(t);
  const persona = person.personaObj;
  const learner = { id: person.id, name: person.name, team: person.team };
  let attempt = 0;
  let passed = false;
  while (attempt < 3 && !passed) {
    const session = `${person.id}-${course.method}-${attempt}-${Math.floor(rand() * 1e6)}`;
    const push = (e) => { if (t <= NOW) events.push({ ...e, learner, session, version: ver.v, ts: new Date(t).toISOString() }); };
    push({ type: 'session_started' });
    const sections = attempt === 0 ? course.sections : course.sections.slice(-1); // retakes go straight to the quiz
    let quit = false;
    for (const [id, name, minutes] of sections) {
      let dur = jitter(minutes * persona.speed) * 60000;
      if (ver.slowSlide === id) dur *= ver.slowFactor * (persona.name === 'rusher' ? 0.5 : 1);
      t += dur;
      push({ type: 'page_viewed', objectId: id, objectName: name, durationMs: Math.round(dur), position: course.sections.findIndex((s) => s[0] === id) + 1 });
      let drop = 0.015 * persona.dropout + (course.extraDrop || 0);
      if (ver.slowSlide === id) drop = ver.slideDrop * persona.dropout * 0.8;
      if (extra.stallAt === id || (attempt === 0 && chance(drop))) { quit = true; break; }
      if (t > NOW) { quit = true; break; }
    }
    if (quit) break;
    let right = 0;
    for (const q of course.questions) {
      const a = answer(q, person, attempt, ver.v);
      if (extra.forceFail && attempt < 2) a.success = false, a.response = q.options.find((o) => o !== q.correct);
      if (a.success) right++;
      const dur = jitter(35 * persona.speed + 10) * 1000;
      t += dur;
      push({ type: 'question_answered', objectId: q.id, objectName: q.name, response: a.response, success: a.success, durationMs: Math.round(dur), correctResponse: q.correct });
    }
    const score = right / course.questions.length;
    passed = score >= course.passMark;
    push({ type: 'score_reported', score });
    push({ type: passed ? 'course_passed' : 'course_failed', score });
    if (passed) push({ type: 'course_completed' });
    attempt++;
    if (!passed) {
      if (chance(0.25 * persona.dropout)) break; // gives up
      t += (1 + rand() * 4) * DAY;
      if (t > NOW) break;
    }
  }
  return events;
}

function forkliftJourney(person) {
  const events = [];
  let t = startTime();
  const persona = person.personaObj;
  const learner = { id: person.id, name: person.name, team: person.team };
  let attempt = 0;
  let passed = false;
  while (attempt < 3 && !passed) {
    const session = `${person.id}-sim-${attempt}`;
    const push = (e) => { if (t <= NOW) events.push({ ...e, learner, session, version: 'v1', ts: new Date(t).toISOString() }); };
    push({ type: 'session_started' });
    let critical = 0;
    let right = 0;
    let total = 0;
    let quit = false;
    FORKLIFT.scenes.forEach(([id, name, minutes, decisions], i) => {
      if (quit) return;
      const dur = jitter(minutes * persona.speed) * 60000;
      for (const [did, comp, isCritical] of decisions) {
        let p = clamp(persona.ability + (person.teamObj.mod[comp] || 0) + attempt * 0.12 + (isCritical ? 0.14 : 0.05));
        if (person.forklift === 'critical' && attempt < 2 && isCritical) p = 0.25;
        const hint = !chance(clamp(p + 0.15));
        if (hint) { push({ type: 'hint_used', objectId: did }); p = clamp(p + 0.15); }
        const ok = chance(p);
        total++;
        if (ok) right++;
        push({ type: 'decision_made', objectId: did, objectName: did.replace(/_/g, ' '), success: ok, critical: isCritical });
        if (!ok) {
          push({ type: 'error_made', objectId: did, critical: isCritical });
          if (isCritical) critical++;
        }
      }
      t += dur;
      push({ type: 'page_viewed', objectId: id, objectName: name, durationMs: Math.round(dur), position: i + 1 });
      if (attempt === 0 && chance(0.02 * persona.dropout)) quit = true;
      if (t > NOW) quit = true;
    });
    if (quit) break;
    const score = right / total;
    passed = critical === 0 && score >= 0.7;
    push({ type: 'score_reported', score });
    push({ type: 'course_completed' });
    push({ type: passed ? 'course_passed' : 'course_failed', score });
    attempt++;
    t += (0.5 + rand() * 3) * DAY;
    if (t > NOW) break;
  }
  return events;
}

// ------------------------------------------------------------ xAPI form
function toStatement(e, course) {
  const base = `https://example.com/courses/${course.slug}`;
  const verbs = {
    session_started: 'http://adlnet.gov/expapi/verbs/initialized',
    page_viewed: 'http://adlnet.gov/expapi/verbs/experienced',
    question_answered: 'http://adlnet.gov/expapi/verbs/answered',
    course_passed: 'http://adlnet.gov/expapi/verbs/passed',
    course_failed: 'http://adlnet.gov/expapi/verbs/failed',
    course_completed: 'http://adlnet.gov/expapi/verbs/completed',
    score_reported: null
  };
  if (!verbs[e.type]) return null;
  const objectId = e.objectId ? `${base}/${e.objectId}` : base;
  const st = {
    actor: { objectType: 'Agent', name: e.learner.name, account: { homePage: 'https://lms.example.com', name: e.learner.id } },
    verb: { id: verbs[e.type] },
    object: {
      id: objectId,
      definition: {
        name: { 'en-US': e.objectName || course.name },
        type: e.type === 'page_viewed' ? 'http://adlnet.gov/expapi/activities/lesson'
          : e.type === 'question_answered' ? 'http://adlnet.gov/expapi/activities/cmi.interaction'
            : 'http://adlnet.gov/expapi/activities/course'
      }
    },
    timestamp: e.ts,
    context: { registration: e.session, extensions: { 'https://learnlens.dev/xapi/team': e.learner.team, 'https://learnlens.dev/xapi/version': e.version } }
  };
  if (e.type === 'question_answered') {
    st.object.definition.correctResponsesPattern = [e.correctResponse];
    st.result = { success: e.success, response: e.response, duration: `PT${(e.durationMs / 1000).toFixed(1)}S` };
  }
  if (e.type === 'page_viewed') st.result = { duration: `PT${(e.durationMs / 1000).toFixed(1)}S` };
  if (e.type === 'course_passed' || e.type === 'course_failed') st.result = { success: e.type === 'course_passed', score: { scaled: e.score } };
  return st;
}

// ------------------------------------------------------------------ main
async function ensureCourse(def) {
  const existing = (await api('GET', '/api/courses')).find((c) => c.name === def.name);
  const id = existing ? existing.id : (await api('POST', '/api/courses', {
    name: def.name, method: def.method, sourceTool: def.sourceTool, lms: def.lms, designedMinutes: def.designedMinutes,
    version: def.versions[def.versions.length - 1].v
  })).id;
  const connect = await api('GET', `/api/courses/${id}/connect`);
  const course = (await api('GET', '/api/courses')).find((c) => c.id === id);
  return { id, slug: course.slug, ...connect };
}

async function sendNative(course, events) {
  for (let i = 0; i < events.length; i += 400) {
    const r = await api('POST', `/api/ingest?key=${encodeURIComponent(course.key)}`, { events: events.slice(i, i + 400) });
    if (r.rejected.length) console.warn(`  ${r.rejected.length} rejected, e.g. ${r.rejected[0].reason}`);
  }
}

async function sendXapi(course, events) {
  const statements = events.map((e) => toStatement(e, course)).filter(Boolean);
  const auth = 'Basic ' + Buffer.from(`${course.xapi.username}:${course.xapi.password}`).toString('base64');
  for (let i = 0; i < statements.length; i += 400) {
    const res = await fetch(`${BASE}/xapi/statements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, 'X-Experience-API-Version': '1.0.3' },
      body: JSON.stringify(statements.slice(i, i + 400))
    });
    if (!res.ok) throw new Error(`xAPI ${res.status} ${await res.text()}`);
  }
  return statements.length;
}

async function tag(courseId, def, compIds) {
  const items = def.questions || def.scenes.flatMap((s) => s[3].map(([id, comp]) => ({ id, comp })));
  for (const item of items) {
    await api('PUT', `/api/courses/${courseId}/items/${encodeURIComponent(item.id)}/competency`, { competencyId: compIds[item.comp] });
  }
  const sections = def.sections || def.scenes.map((s) => [s[0], s[1], s[2]]);
  for (const [id, name, minutes] of sections) {
    await api('PATCH', `/api/courses/${courseId}/sections/${encodeURIComponent(id)}`, { name, designedMinutes: minutes });
  }
}

async function main() {
  console.log(`LearnLens bot learners → ${BASE}`);
  await api('GET', '/api/session');
  console.log('Using synthetic names: turning off pseudonymisation for this demo dataset.');
  await api('PUT', '/api/settings/privacy', { pseudonymise: false });

  const compIds = {};
  for (const [k, name] of Object.entries(COMPETENCIES)) compIds[k] = (await api('POST', '/api/competencies', { name })).id;

  const people = makeLearners();
  console.log(`Generated ${people.length} synthetic learners in ${TEAMS.length} teams`);

  const plan = [
    [FIRE, (p) => linearJourney(FIRE, p, p.stallFire ? { stallAt: 'slide-14' } : {}), sendNative],
    [ESCALATIONS, (p) => linearJourney(ESCALATIONS, p), sendNative],
    [PRIVACY, (p) => linearJourney(PRIVACY, p, p.failPrivacy ? { forceFail: true } : {}), sendXapi],
    [MANAGER, (p) => linearJourney(MANAGER, p), sendXapi],
    [FORKLIFT, (p) => forkliftJourney(p), sendNative]
  ];

  for (const [def, journey, send] of plan) {
    const course = await ensureCourse(def);
    let events = [];
    for (const p of people) {
      const fixed = p.forklift || p.stallFire || p.failPrivacy;
      if (!def.teams.includes(p.team)) continue;
      if (!fixed && !chance(def.take)) continue;
      events = events.concat(journey(p));
    }
    // Make the named characters' stories recent, like in the mockups.
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    const sent = await send(course, events);
    console.log(`  ${def.name}: ${typeof sent === 'number' ? sent + ' xAPI statements' : events.length + ' events'} via ${def.method.toUpperCase()}`);
    await tag(course.id, def, compIds);
  }

  const alerts = await api('POST', '/api/alerts/run');
  console.log(`Alerts engine created ${alerts.created} alerts.`);
  console.log('\nDone. Open the dashboard to explore the data. (All data is synthetic.)');
}

main().catch((err) => {
  console.error('\nSimulation failed:', err.message);
  if (/ECONNREFUSED|fetch failed/.test(err.message)) console.error(`Is the server running at ${BASE}? Start it with "npm start".`);
  process.exit(1);
});
