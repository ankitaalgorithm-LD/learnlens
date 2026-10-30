import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { q, one } from '../db.js';
import { courseByKey, ingestEvents, MAX_BATCH } from '../lib/ingest.js';
import { mapStatement, statementId } from '../lib/xapi.js';

// Public endpoints that courses call from learners' browsers, on any LMS domain.
export const ingestRouter = express.Router();

ingestRouter.use(['/api/ingest', '/xapi'], cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-LearnLens-Key', 'X-Experience-API-Version'],
  exposedHeaders: ['X-Experience-API-Version']
}));

// Small in-memory rate limit per course key / IP, to protect a self-hosted server.
const buckets = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const id = `${req.query.key || req.get('Authorization') || ''}|${req.ip}`;
    const now = Date.now();
    const b = buckets.get(id) || { n: 0, reset: now + windowMs };
    if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
    b.n++;
    buckets.set(id, b);
    if (buckets.size > 50000) buckets.clear();
    if (b.n > limit) return res.status(429).json({ error: 'Too many requests, slow down' });
    next();
  };
}

const bodyParsers = [
  express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }),
  express.text({ limit: '2mb', type: ['text/plain'] })
];

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return undefined; }
  }
  return req.body;
}

// ---- LearnLens native ingestion (SCORM wrapper + JavaScript SDK) ----
ingestRouter.post('/api/ingest', rateLimit(240, 60000), ...bodyParsers, async (req, res) => {
  const course = await courseByKey(req.get('X-LearnLens-Key') || req.query.key);
  if (!course) return res.status(401).json({ error: 'Unknown course key' });
  const body = parseBody(req);
  if (!body || !Array.isArray(body.events)) return res.status(400).json({ error: 'Expected JSON: { "events": [...] }' });
  const source = course.method === 'scorm' ? 'scorm' : 'sdk';
  const result = await ingestEvents(course, body.events, source);
  res.json(result);
});

// ---- Connection test results (from the test package running inside an LMS) ----
ingestRouter.use('/api/diagnostics', cors({ origin: true, methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
ingestRouter.post('/api/diagnostics', rateLimit(30, 60000), ...bodyParsers, async (req, res) => {
  const course = await courseByKey(req.query.key);
  if (!course) return res.status(401).json({ error: 'Unknown course key' });
  const body = parseBody(req);
  if (!body || !Array.isArray(body.checks)) return res.status(400).json({ error: 'Expected { checks: [...] }' });
  const clip = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));
  const checks = body.checks.slice(0, 20).map((c) => ({
    id: clip(c.id, 40), label: clip(c.label, 120), detail: clip(c.detail, 400),
    ok: c.ok === true ? true : c.ok === false ? false : 'info'
  }));
  const ok = !checks.some((c) => c.ok === false);
  await q(
    `INSERT INTO diagnostics (course_id, origin, user_agent, ok, results) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [course.id, clip(body.origin || req.get('Origin'), 200), clip(req.get('User-Agent'), 300), ok, JSON.stringify(checks)]
  );
  await q(`DELETE FROM diagnostics WHERE course_id = $1 AND id NOT IN
             (SELECT id FROM diagnostics WHERE course_id = $1 ORDER BY id DESC LIMIT 50)`, [course.id]);
  res.json({ ok: true });
});

// ---- xAPI (write-only statements + State API) ----
const xapiJson = express.json({ limit: '2mb', type: ['application/json', 'application/*+json', 'text/plain'] });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function xapiCourse(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return null;
  const [key, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const course = await courseByKey(key);
  return course && safeEqual(secret || '', course.ingest_secret) ? course : null;
}

ingestRouter.use('/xapi', (req, res, next) => {
  res.set('X-Experience-API-Version', '1.0.3');
  next();
});

ingestRouter.get('/xapi/about', (req, res) => res.json({ version: ['1.0.3', '1.0.0'] }));

ingestRouter.use('/xapi', rateLimit(600, 60000), async (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const course = await xapiCourse(req);
  if (!course) return res.status(401).json({ error: 'Invalid xAPI credentials (use the course key and secret)' });
  req.course = course;
  next();
});

async function storeStatements(course, statements) {
  if (statements.length > MAX_BATCH) {
    const err = new Error(`At most ${MAX_BATCH} statements per request`);
    err.status = 413;
    throw err;
  }
  const events = [];
  let skipped = 0;
  for (const st of statements) {
    const m = mapStatement(st);
    if (m.event) events.push(m.event); else skipped++;
  }
  const result = events.length ? await ingestEvents(course, events, 'xapi') : { accepted: 0, rejected: [] };
  return { ...result, skipped };
}

ingestRouter.post('/xapi/statements', xapiJson, async (req, res) => {
  const statements = Array.isArray(req.body) ? req.body : [req.body];
  const ids = statements.map(statementId);
  await storeStatements(req.course, statements);
  res.json(ids);
});

ingestRouter.put('/xapi/statements', xapiJson, async (req, res) => {
  await storeStatements(req.course, [{ ...req.body, id: req.query.statementId || req.body.id }]);
  res.status(204).end();
});

ingestRouter.get('/xapi/statements', (req, res) => {
  res.status(501).json({ error: 'LearnLens stores statements for analytics only; querying statements is not supported.' });
});

// State API: lets Storyline/Rise/Captivate save and restore bookmarks.
const stateKey = (qs) => JSON.stringify([qs.activityId || '', qs.agent || '', qs.registration || '', qs.stateId || '']);

ingestRouter.get('/xapi/activities/state', async (req, res) => {
  if (!req.query.stateId) {
    const prefix = JSON.stringify([req.query.activityId || '', req.query.agent || '', req.query.registration || '']).slice(0, -1);
    const rows = await q('SELECT state_key FROM xapi_state WHERE course_id = $1 AND starts_with(state_key, $2)', [req.course.id, prefix]);
    return res.json(rows.map((r) => JSON.parse(r.state_key)[3]));
  }
  const row = await one('SELECT content, content_type FROM xapi_state WHERE course_id = $1 AND state_key = $2', [req.course.id, stateKey(req.query)]);
  if (!row) return res.status(404).end();
  res.type(row.content_type || 'application/octet-stream').send(row.content);
});

const rawState = express.text({ limit: '1mb', type: () => true });
async function saveState(req, res) {
  let content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
  if (req.method === 'POST' && (req.get('Content-Type') || '').includes('json')) {
    const existing = await one('SELECT content FROM xapi_state WHERE course_id = $1 AND state_key = $2', [req.course.id, stateKey(req.query)]);
    if (existing) {
      try { content = JSON.stringify({ ...JSON.parse(existing.content), ...JSON.parse(content) }); } catch { /* keep new */ }
    }
  }
  await q(
    `INSERT INTO xapi_state (course_id, state_key, content, content_type) VALUES ($1,$2,$3,$4)
     ON CONFLICT (course_id, state_key) DO UPDATE SET content = EXCLUDED.content, content_type = EXCLUDED.content_type, updated_at = now()`,
    [req.course.id, stateKey(req.query), content, req.get('Content-Type') || null]
  );
  res.status(204).end();
}
ingestRouter.put('/xapi/activities/state', rawState, saveState);
ingestRouter.post('/xapi/activities/state', rawState, saveState);
ingestRouter.delete('/xapi/activities/state', async (req, res) => {
  await q('DELETE FROM xapi_state WHERE course_id = $1 AND state_key = $2', [req.course.id, stateKey(req.query)]);
  res.status(204).end();
});

ingestRouter.all('/xapi/{*rest}', (req, res) => res.status(404).json({ error: 'Not supported by LearnLens' }));
