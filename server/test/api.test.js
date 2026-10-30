import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated server with an embedded database and an admin token.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnlens-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_TOKEN = 'test-token';
process.env.DATABASE_URL = '';
const { initDb, closeDb } = await import('../src/db.js');
const { createApp } = await import('../src/index.js');

let server;
let base;
const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
const call = async (method, url, body, headers = auth) => {
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json ?? text };
};

before(async () => {
  await initDb();
  const app = await createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('admin API requires the token', async () => {
  assert.equal((await call('GET', '/api/courses', undefined, {})).status, 401);
  assert.equal((await call('GET', '/api/courses', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call('GET', '/api/courses')).status, 200);
});

test('ingests events, then analyses them', async () => {
  const { body: created } = await call('POST', '/api/courses', { name: 'Test Course', method: 'sdk', designedMinutes: 10 });
  const { body: connect } = await call('GET', `/api/courses/${created.id}/connect`);
  assert.match(connect.key, /^ck_/);

  const bad = await call('POST', '/api/ingest?key=nope', { events: [] }, { 'Content-Type': 'application/json' });
  assert.equal(bad.status, 401);

  const events = [];
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    const learner = { id: `u${i}`, name: `Learner ${i}`, team: i % 2 ? 'A' : 'B' };
    const t = (m) => new Date(now - 3 * 86400000 + i * 60000 + m * 1000).toISOString();
    events.push({ type: 'session_started', learner, session: `s${i}`, ts: t(0) });
    events.push({ type: 'page_viewed', learner, session: `s${i}`, objectId: 'intro', objectName: 'Intro', durationMs: 60000, ts: t(1) });
    if (i < 20) {
      events.push({ type: 'page_viewed', learner, session: `s${i}`, objectId: 'quiz', objectName: 'Quiz', durationMs: 90000, ts: t(2) });
      events.push({ type: 'question_answered', learner, session: `s${i}`, objectId: 'q1', response: i < 14 ? 'C' : 'B', success: i >= 14, ts: t(3) });
      events.push({ type: i >= 14 ? 'course_passed' : 'course_failed', learner, session: `s${i}`, score: i >= 14 ? 1 : 0, ts: t(4) });
    }
  }
  // text/plain body, like navigator.sendBeacon
  const res = await call('POST', `/api/ingest?key=${connect.key}`, JSON.stringify({ events: [...events, { type: 'bogus', learner: { id: 'x' } }] }), { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, events.length);
  assert.equal(res.body.rejected.length, 1);

  const { body: ins } = await call('GET', `/api/courses/${created.id}/insights`);
  assert.equal(ins.kpis.learners, 30);
  const intro = ins.funnel.find((f) => f.id === 'intro');
  const quiz = ins.funnel.find((f) => f.id === 'quiz');
  assert.equal(intro.reached, 1);
  assert.ok(Math.abs(quiz.reached - 20 / 30) < 1e-9);
  assert.equal(ins.biggestDrop.section, 'Quiz'); // 20 reach the quiz, only 6 pass
  const q1 = ins.questions.find((q) => q.id === 'q1');
  assert.equal(q1.n, 20);
  assert.ok(q1.flags.some((f) => f.startsWith('Likely confusing')), 'a wrong answer chosen by most learners is flagged');

  const { body: ov } = await call('GET', '/api/overview?days=30');
  assert.equal(ov.kpis.activeLearners.value, 30);
  assert.equal(ov.courses[0].learners, 30);

  const { body: alerts } = await call('POST', '/api/alerts/run');
  assert.ok(alerts.created >= 0);
});

test('accepts xAPI statements and stores bookmarks', async () => {
  const { body: created } = await call('POST', '/api/courses', { name: 'xAPI Course', method: 'xapi' });
  const { body: connect } = await call('GET', `/api/courses/${created.id}/connect`);
  const basic = { Authorization: 'Basic ' + Buffer.from(`${connect.xapi.username}:${connect.xapi.password}`).toString('base64'), 'Content-Type': 'application/json', 'X-Experience-API-Version': '1.0.3' };

  const denied = await call('POST', '/xapi/statements', [], { ...basic, Authorization: 'Basic ' + Buffer.from(`${connect.xapi.username}:wrong`).toString('base64') });
  assert.equal(denied.status, 401);

  const res = await call('POST', '/xapi/statements', [
    { actor: { mbox: 'mailto:sam@example.com', name: 'Sam' }, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { id: 'https://x/lesson-1', definition: { name: { 'en-US': 'Lesson 1' } } }, result: { duration: 'PT2M' } },
    { actor: { mbox: 'mailto:sam@example.com', name: 'Sam' }, verb: { id: 'http://adlnet.gov/expapi/verbs/passed' }, object: { id: 'https://x' }, result: { score: { scaled: 0.9 } } }
  ], basic);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);

  const { body: ins } = await call('GET', `/api/courses/${created.id}/insights`);
  assert.equal(ins.kpis.learners, 1);
  assert.equal(ins.times[0].minutes, 2);

  const q = '?activityId=https%3A%2F%2Fx&agent=%7B%7D&stateId=bookmark';
  assert.equal((await call('PUT', `/xapi/activities/state${q}`, 'slide-7', { ...basic, 'Content-Type': 'text/plain' })).status, 204);
  const state = await call('GET', `/xapi/activities/state${q}`, undefined, basic);
  assert.equal(state.body, 'slide-7');
});

test('pseudonymisation keeps names out of the database', async () => {
  await call('PUT', '/api/settings/privacy', { pseudonymise: true });
  const { body: created } = await call('POST', '/api/courses', { name: 'Private Course', method: 'sdk' });
  const { body: connect } = await call('GET', `/api/courses/${created.id}/connect`);
  await call('POST', `/api/ingest?key=${connect.key}`, { events: [{ type: 'session_started', learner: { id: 'secret-id', name: 'Real Name' } }] }, { 'Content-Type': 'application/json' });
  const { body: learners } = await call('GET', '/api/learners');
  assert.ok(!JSON.stringify(learners).includes('Real Name'));
  assert.ok(!JSON.stringify(learners).includes('secret-id'));
});

test('generates reports', async () => {
  const res = await fetch(`${base}/api/reports/preview/monthly`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal((await res.arrayBuffer()).byteLength > 1000, true);
});

test('connection check: health CORS, test package, diagnostics and live feed', async () => {
  const health = await fetch(`${base}/health`, { headers: { Origin: 'https://lms.example' } });
  assert.equal(health.headers.get('access-control-allow-origin'), '*');

  const { body: created } = await call('POST', '/api/courses', { name: 'Diag Course', method: 'scorm' });
  const pkg = await fetch(`${base}/api/courses/${created.id}/test-package`, { headers: auth });
  assert.equal(pkg.status, 200);
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(Buffer.from(await pkg.arrayBuffer()));
  const { body: connect } = await call('GET', `/api/courses/${created.id}/connect`);
  assert.ok(zip.getEntry('imsmanifest.xml'));
  assert.ok(zip.getEntry('index.html').getData().toString().includes(connect.key));

  const bad = await call('POST', '/api/diagnostics?key=nope', { checks: [] }, { 'Content-Type': 'application/json' });
  assert.equal(bad.status, 401);
  const sent = await call('POST', `/api/diagnostics?key=${connect.key}`,
    JSON.stringify({ origin: 'https://lms.example', checks: [{ id: 'scorm', label: 'SCORM API', ok: true }, { id: 'https', label: 'HTTPS', ok: false }] }),
    { 'Content-Type': 'text/plain' });
  assert.equal(sent.status, 200);
  const { body: runs } = await call('GET', `/api/courses/${created.id}/diagnostics`);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].ok, false);
  assert.equal(runs[0].origin, 'https://lms.example');

  const { body: live } = await call('GET', `/api/courses/${created.id}/live`);
  assert.equal(live.total, 0);

  const { body: setup } = await call('GET', '/api/setup-check');
  assert.ok(setup.items.find((i) => i.id === 'admin_token' && i.status === 'ok'));
  assert.ok(setup.items.find((i) => i.id === 'hash_secret' && i.status !== 'ok'), 'default HASH_SECRET is flagged');
});
