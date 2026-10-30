import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import cron from 'node-cron';
import { q, one, getSetting, setSetting } from '../db.js';
import { config, publicBase } from '../config.js';
import { newKey, hashLearnerId } from '../lib/ingest.js';
import { overview, courseInsights, learnersOverview, learnerDetail, methodLabel } from '../lib/analytics.js';
import { evaluateAlerts, RULE_KINDS } from '../lib/alerts.js';
import { generateReport, runSchedule, startScheduler, reportsDir } from '../lib/reports.js';
import { wrapScormPackage } from '../scorm/wrap.js';

export const adminRouter = express.Router();
adminRouter.use(express.json({ limit: '1mb' }));

// ------------------------------------------------------------------ auth
function tokenOk(token) {
  if (!config.adminToken) return true;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requireAdmin(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (tokenOk(token)) return next();
  res.status(401).json({ error: 'Admin token required' });
}

adminRouter.get('/api/session', (req, res) => {
  const header = req.get('Authorization') || '';
  res.json({ authRequired: Boolean(config.adminToken), ok: tokenOk(header.startsWith('Bearer ') ? header.slice(7) : '') });
});

adminRouter.use('/api', requireAdmin);

const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const intParam = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

// -------------------------------------------------------------- overview
adminRouter.get('/api/overview', async (req, res) => {
  const days = Math.min(Math.max(intParam(req.query.days) || 30, 7), 365);
  res.json(await overview({ days, team: req.query.team || null }));
});

// --------------------------------------------------------------- courses
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'course';
}

adminRouter.get('/api/courses', async (req, res) => {
  const rows = await q(`
    SELECT c.*, s.last_event, s.events, s.learners
      FROM courses c
      LEFT JOIN (SELECT course_id, max(ts) AS last_event, count(*)::int AS events, count(DISTINCT learner_id)::int AS learners
                   FROM events GROUP BY course_id) s ON s.course_id = c.id
     ORDER BY c.created_at DESC, c.id DESC`);
  res.json(rows.map(({ ingest_secret, ...c }) => ({ ...c, methodLabel: methodLabel(c.method) })));
});

adminRouter.post('/api/courses', async (req, res) => {
  const { name, method, sourceTool, lms, version, designedMinutes } = req.body || {};
  if (!name || !String(name).trim()) return bad(res, 'Course name is required');
  if (!['scorm', 'xapi', 'sdk'].includes(method)) return bad(res, 'method must be scorm, xapi or sdk');
  let slug = slugify(name);
  if (await one('SELECT 1 FROM courses WHERE slug = $1', [slug])) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  const row = await one(
    `INSERT INTO courses (slug, name, method, source_tool, lms, version, designed_minutes, ingest_key, ingest_secret)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [slug, String(name).trim().slice(0, 160), method, sourceTool || null, lms || null, version || 'v1',
      designedMinutes ? Number(designedMinutes) : null, newKey('ck'), newKey('cs')]
  );
  res.status(201).json({ id: row.id });
});

adminRouter.patch('/api/courses/:id', async (req, res) => {
  const fields = { name: 'name', version: 'version', lms: 'lms', sourceTool: 'source_tool', designedMinutes: 'designed_minutes' };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(fields)) {
    if (req.body && k in req.body) { params.push(req.body[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (!sets.length) return bad(res, 'Nothing to update');
  params.push(intParam(req.params.id));
  await q(`UPDATE courses SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  res.json({ ok: true });
});

adminRouter.delete('/api/courses/:id', async (req, res) => {
  await q('DELETE FROM courses WHERE id = $1', [intParam(req.params.id)]);
  res.json({ ok: true });
});

adminRouter.get('/api/courses/:id/connect', async (req, res) => {
  const c = await one('SELECT * FROM courses WHERE id = $1', [intParam(req.params.id)]);
  if (!c) return bad(res, 'Course not found', 404);
  const base = publicBase(req);
  res.json({
    endpoint: base,
    key: c.ingest_key,
    xapi: { endpoint: `${base}/xapi/`, username: c.ingest_key, password: c.ingest_secret },
    sdk: {
      scriptUrl: `${base}/sdk/learnlens.js`,
      snippet: `<script src="${base}/sdk/learnlens.js"></script>\n<script>\n  const track = LearnLens.init({\n    endpoint: '${base}',\n    key: '${c.ingest_key}',\n    version: '${c.version}',\n    learner: { id: LEARNER_ID_FROM_YOUR_LMS, name: LEARNER_NAME, team: TEAM }\n  });\n\n  track.page('intro', 'Introduction');\n  track.decision('check_mirrors', { correct: true });\n  track.error('missed_hazard', { critical: true });\n  track.complete({ passed: true, score: 0.82 });\n</script>`
    },
    packages: await q('SELECT id, original_name, scorm_version, launch, created_at FROM packages WHERE course_id = $1 ORDER BY created_at DESC', [c.id])
  });
});

// Sections: rename and set the designed time.
adminRouter.patch('/api/courses/:id/sections/:objectId', async (req, res) => {
  const { name, designedMinutes } = req.body || {};
  await q(
    `UPDATE sections SET name = COALESCE($3, name), designed_minutes = COALESCE($4, designed_minutes)
      WHERE course_id = $1 AND object_id = $2`,
    [intParam(req.params.id), req.params.objectId, name || null, designedMinutes ? Number(designedMinutes) : null]
  );
  res.json({ ok: true });
});

// -------------------------------------------------------- SCORM wrapping
const packagesDir = () => path.join(config.dataDir, 'packages');
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

adminRouter.post('/api/courses/:id/scorm', upload.single('package'), async (req, res) => {
  const c = await one('SELECT * FROM courses WHERE id = $1', [intParam(req.params.id)]);
  if (!req.file) return bad(res, 'Attach the SCORM .zip as "package"');
  try {
    if (!c) return bad(res, 'Course not found', 404);
    const privacy = await getSetting('privacy', { pseudonymise: true });
    const result = wrapScormPackage(fs.readFileSync(req.file.path), {
      endpoint: publicBase(req), key: c.ingest_key, version: c.version, sendNames: !privacy.pseudonymise
    });
    const id = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(packagesDir(), { recursive: true });
    fs.writeFileSync(path.join(packagesDir(), `${id}.zip`), result.buffer);
    new AdmZip(result.buffer).extractAllTo(path.join(packagesDir(), id), true);
    await q('INSERT INTO packages (id, course_id, original_name, scorm_version, launch) VALUES ($1,$2,$3,$4,$5)',
      [id, c.id, req.file.originalname, result.version, result.launch]);
    if (c.method !== 'scorm') await q(`UPDATE courses SET method = 'scorm' WHERE id = $1`, [c.id]);
    res.status(201).json({ id, scormVersion: result.version, launch: result.launch, scos: result.scos, previewUrl: `/preview/${id}` });
  } catch (err) {
    bad(res, err.message);
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

adminRouter.get('/api/packages/:id/download', async (req, res) => {
  const p = await one('SELECT p.*, c.slug FROM packages p JOIN courses c ON c.id = p.course_id WHERE p.id = $1', [req.params.id]);
  if (!p) return bad(res, 'Package not found', 404);
  const file = path.join(packagesDir(), `${p.id}.zip`);
  if (!fs.existsSync(file)) return bad(res, 'This package file is no longer on the server (hosting without a persistent disk clears files on restart). Upload the original zip again.', 410);
  res.download(file, `${p.slug}-learnlens.zip`);
});

// ------------------------------------------------------ connection check
adminRouter.get('/api/setup-check', async (req, res) => {
  const base = publicBase(req);
  const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(base);
  const items = [];
  const add = (id, status, label, detail, fix) => items.push({ id, status, label, detail, fix });

  if (!config.publicUrl) {
    add('public_url', local ? 'warn' : 'warn', 'Public address (PUBLIC_URL)', `Not set. Using the address you opened the dashboard on: ${base}`,
      local ? 'Fine for trying it on this computer. Learners in an LMS cannot reach "localhost": put LearnLens online and set PUBLIC_URL before wrapping real courses.'
        : 'Set PUBLIC_URL to this server\'s public HTTPS address so wrapped packages always point to the right place.');
  } else {
    add('public_url', 'ok', 'Public address (PUBLIC_URL)', config.publicUrl);
  }
  if (/^https:/i.test(base)) add('https', 'ok', 'HTTPS', 'Learners\' browsers can send data from HTTPS LMSs.');
  else add('https', local ? 'warn' : 'error', 'HTTPS', `${base} is not HTTPS.`,
    'Almost every LMS runs on HTTPS, and browsers block HTTPS courses from sending data to HTTP addresses. Put LearnLens behind HTTPS (Render, a reverse proxy, or a tunnel for testing).');

  if (config.adminToken) add('admin_token', 'ok', 'Dashboard password (ADMIN_TOKEN)', 'Set.');
  else add('admin_token', local ? 'warn' : 'error', 'Dashboard password (ADMIN_TOKEN)', 'Not set: anyone who can reach this server can open the dashboard.', 'Set ADMIN_TOKEN to a long random string and restart.');

  if (config.hashSecret === 'learnlens-dev-secret-change-me') add('hash_secret', local ? 'warn' : 'error', 'Pseudonymisation secret (HASH_SECRET)', 'Using the default development value.', 'Set HASH_SECRET to a long random string before tracking real learners, and never change it afterwards.');
  else add('hash_secret', 'ok', 'Pseudonymisation secret (HASH_SECRET)', 'Set.');

  if (config.databaseUrl) add('database', 'ok', 'Database', 'PostgreSQL (DATABASE_URL).');
  else add('database', config.onRender ? 'error' : 'ok', 'Database', `Embedded database in ${config.dataDir}.`,
    config.onRender ? 'This host has no persistent disk, so the embedded database is wiped on every restart. Set DATABASE_URL to a PostgreSQL database.' : undefined);

  add('webhook', config.alertWebhookUrl ? 'ok' : 'info', 'Alert webhook (optional)', config.alertWebhookUrl ? 'Set: alerts and report links are posted to it.' : 'Not set: alerts appear in the dashboard only.');
  res.json({ endpoint: base, items });
});

adminRouter.get('/api/courses/:id/test-package', async (req, res) => {
  const c = await one('SELECT * FROM courses WHERE id = $1', [intParam(req.params.id)]);
  if (!c) return bad(res, 'Course not found', 404);
  const { buildDiagnosticPackage } = await import('../scorm/diagnostic.js');
  const buf = buildDiagnosticPackage({ endpoint: publicBase(req), key: c.ingest_key, courseName: c.name });
  res.set('Content-Disposition', `attachment; filename="learnlens-connection-test-${c.slug}.zip"`).type('application/zip').send(buf);
});

adminRouter.get('/api/courses/:id/diagnostics', async (req, res) => {
  res.json(await q('SELECT id, origin, user_agent, ok, results, created_at FROM diagnostics WHERE course_id = $1 ORDER BY id DESC LIMIT 10', [intParam(req.params.id)]));
});

// Latest events for one course, so you can watch data arrive while testing.
adminRouter.get('/api/courses/:id/live', async (req, res) => {
  const id = intParam(req.params.id);
  const [events, counts] = await Promise.all([
    q(`SELECT e.id, e.type, e.object_id, e.success, e.score, e.source, e.ts, e.learner_id, l.display_name
         FROM events e JOIN learners l ON l.id = e.learner_id
        WHERE e.course_id = $1 ORDER BY e.id DESC LIMIT 15`, [id]),
    one(`SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ts > now() - interval '24 hours')::int AS day,
                max(ts) AS last
           FROM events WHERE course_id = $1`, [id])
  ]);
  res.json({ ...counts, events: events.map((e) => ({ ...e, learner: e.display_name || `Learner #${e.learner_id}` })) });
});

// --------------------------------------------------- insights & tagging
adminRouter.get('/api/courses/:id/insights', async (req, res) => {
  const data = await courseInsights(intParam(req.params.id), { version: req.query.version || null });
  if (!data) return bad(res, 'Course not found', 404);
  res.json(data);
});

adminRouter.get('/api/competencies', async (req, res) => {
  res.json(await q('SELECT * FROM competencies ORDER BY name'));
});

adminRouter.post('/api/competencies', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return bad(res, 'Name is required');
  res.status(201).json(await one(
    'INSERT INTO competencies (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *', [name]));
});

adminRouter.put('/api/courses/:id/items/:objectId/competency', async (req, res) => {
  const courseId = intParam(req.params.id);
  const compId = req.body && req.body.competencyId ? intParam(req.body.competencyId) : null;
  await q('DELETE FROM item_competencies WHERE course_id = $1 AND object_id = $2', [courseId, req.params.objectId]);
  if (compId) {
    await q('INSERT INTO item_competencies (course_id, object_id, competency_id) VALUES ($1,$2,$3)', [courseId, req.params.objectId, compId]);
  }
  res.json({ ok: true });
});

// -------------------------------------------------------------- learners
adminRouter.get('/api/learners', async (req, res) => {
  const data = await learnersOverview();
  const term = String(req.query.q || '').toLowerCase().trim();
  if (term) data.learners = data.learners.filter((l) => l.name.toLowerCase().includes(term) || (l.team || '').toLowerCase().includes(term));
  res.json(data);
});

adminRouter.get('/api/learners/:id', async (req, res) => {
  const data = await learnerDetail(intParam(req.params.id));
  if (!data) return bad(res, 'Learner not found', 404);
  res.json(data);
});

adminRouter.post('/api/learners/:id/notes', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return bad(res, 'Note text is required');
  res.status(201).json(await one('INSERT INTO notes (learner_id, text) VALUES ($1,$2) RETURNING *', [intParam(req.params.id), text]));
});

adminRouter.post('/api/learners/:id/assignments', async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim().slice(0, 200);
  if (!title) return bad(res, 'Title is required');
  const id = intParam(req.params.id);
  const row = await one('INSERT INTO assignments (learner_id, title) VALUES ($1,$2) RETURNING *', [id, title]);
  await q(`UPDATE alerts SET status = 'acted', outcome = $2 WHERE learner_id = $1 AND status = 'open'`, [id, `Assigned: ${title}`]);
  res.status(201).json(row);
});

// Map LMS learner IDs to names and teams (CSV "id,name,team" or JSON rows).
adminRouter.post('/api/learners/import', express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }), async (req, res) => {
  let rows = [];
  if (typeof req.body === 'string') {
    rows = req.body.split(/\r?\n/).map((line) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
      .filter((c) => c[0] && c[0].toLowerCase() !== 'id').map(([id, name, team]) => ({ id, name, team }));
  } else if (Array.isArray(req.body)) rows = req.body;
  let n = 0;
  for (const r of rows) {
    if (!r.id) continue;
    await q(
      `INSERT INTO learners (external_ref, display_name, team) VALUES ($1,$2,$3)
       ON CONFLICT (external_ref) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, learners.display_name),
         team = COALESCE(EXCLUDED.team, learners.team)`,
      [hashLearnerId(r.id), r.name || null, r.team || null]
    );
    n++;
  }
  res.json({ imported: n });
});

// ---------------------------------------------------------------- alerts
adminRouter.get('/api/alerts/rules', async (req, res) => {
  res.json({ kinds: RULE_KINDS, rules: await q('SELECT * FROM alert_rules ORDER BY id') });
});

function ruleBody(b) {
  if (!b || !RULE_KINDS[b.kind]) throw new Error('Unknown rule kind');
  const threshold = Number(b.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('Threshold must be a positive number');
  return [String(b.name || RULE_KINDS[b.kind].label).slice(0, 120), b.kind, threshold, b.courseId ? intParam(b.courseId) : null,
    String(b.notify || 'Evaluator').slice(0, 80), b.channel === 'webhook' ? 'webhook' : 'in-app'];
}

adminRouter.post('/api/alerts/rules', async (req, res) => {
  try {
    const row = await one(`INSERT INTO alert_rules (name, kind, threshold, course_id, notify, channel) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, ruleBody(req.body));
    res.status(201).json(row);
  } catch (err) { bad(res, err.message); }
});

adminRouter.patch('/api/alerts/rules/:id', async (req, res) => {
  if (req.body && typeof req.body.enabled === 'boolean' && Object.keys(req.body).length === 1) {
    await q('UPDATE alert_rules SET enabled = $2 WHERE id = $1', [intParam(req.params.id), req.body.enabled]);
    return res.json({ ok: true });
  }
  try {
    await q(`UPDATE alert_rules SET name=$2, kind=$3, threshold=$4, course_id=$5, notify=$6, channel=$7 WHERE id=$1`,
      [intParam(req.params.id), ...ruleBody(req.body)]);
    res.json({ ok: true });
  } catch (err) { bad(res, err.message); }
});

adminRouter.delete('/api/alerts/rules/:id', async (req, res) => {
  await q('DELETE FROM alert_rules WHERE id = $1', [intParam(req.params.id)]);
  res.json({ ok: true });
});

adminRouter.get('/api/alerts', async (req, res) => {
  res.json(await q(
    `SELECT a.*, l.display_name, c.name AS course_name FROM alerts a
       LEFT JOIN learners l ON l.id = a.learner_id LEFT JOIN courses c ON c.id = a.course_id
      ORDER BY a.created_at DESC LIMIT 100`));
});

adminRouter.patch('/api/alerts/:id', async (req, res) => {
  const status = ['open', 'acted', 'dismissed'].includes(req.body && req.body.status) ? req.body.status : null;
  if (!status) return bad(res, 'status must be open, acted or dismissed');
  await q('UPDATE alerts SET status = $2, outcome = COALESCE($3, outcome) WHERE id = $1',
    [intParam(req.params.id), status, (req.body.outcome || null)]);
  res.json({ ok: true });
});

adminRouter.post('/api/alerts/run', async (req, res) => res.json(await evaluateAlerts()));

// --------------------------------------------------------------- reports
adminRouter.get('/api/reports/schedules', async (req, res) => {
  res.json(await q(`SELECT s.*, (SELECT file FROM report_runs r WHERE r.schedule_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_file
                      FROM report_schedules s ORDER BY id`));
});

adminRouter.post('/api/reports/schedules', async (req, res) => {
  const { name, kind, cron: expr, recipients } = req.body || {};
  if (!['manager', 'monthly', 'course_health'].includes(kind)) return bad(res, 'Unknown report kind');
  if (!cron.validate(expr || '')) return bad(res, 'Invalid schedule (cron expression)');
  const row = await one('INSERT INTO report_schedules (name, kind, cron, recipients) VALUES ($1,$2,$3,$4) RETURNING *',
    [String(name || 'Report').slice(0, 120), kind, expr, recipients || null]);
  await startScheduler();
  res.status(201).json(row);
});

adminRouter.patch('/api/reports/schedules/:id', async (req, res) => {
  const { name, cron: expr, recipients, enabled } = req.body || {};
  if (expr && !cron.validate(expr)) return bad(res, 'Invalid schedule (cron expression)');
  await q(`UPDATE report_schedules SET name = COALESCE($2, name), cron = COALESCE($3, cron),
             recipients = COALESCE($4, recipients), enabled = COALESCE($5, enabled) WHERE id = $1`,
  [intParam(req.params.id), name || null, expr || null, recipients || null, typeof enabled === 'boolean' ? enabled : null]);
  await startScheduler();
  res.json({ ok: true });
});

adminRouter.delete('/api/reports/schedules/:id', async (req, res) => {
  await q('DELETE FROM report_schedules WHERE id = $1', [intParam(req.params.id)]);
  await startScheduler();
  res.json({ ok: true });
});

adminRouter.post('/api/reports/schedules/:id/run', async (req, res) => {
  const file = await runSchedule(intParam(req.params.id));
  if (!file) return bad(res, 'Schedule not found', 404);
  res.json({ file });
});

adminRouter.get('/api/reports/preview/:kind', async (req, res) => {
  try {
    const r = await generateReport(req.params.kind, { team: req.query.team || undefined });
    res.type(r.type).set('Content-Disposition', `inline; filename="${r.filename}"`).send(r.buffer);
  } catch (err) { bad(res, err.message); }
});

adminRouter.get('/api/reports/files/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(reportsDir(), file);
  if (!fs.existsSync(full)) return bad(res, 'File not found', 404);
  res.sendFile(full);
});

// -------------------------------------------------------------- settings
adminRouter.get('/api/settings/privacy', async (req, res) => {
  res.json(await getSetting('privacy', { pseudonymise: true, retentionMonths: 12 }));
});

adminRouter.put('/api/settings/privacy', async (req, res) => {
  const cur = await getSetting('privacy', { pseudonymise: true, retentionMonths: 12 });
  const b = req.body || {};
  const next = {
    pseudonymise: typeof b.pseudonymise === 'boolean' ? b.pseudonymise : cur.pseudonymise,
    retentionMonths: [6, 12, 24, 0].includes(Number(b.retentionMonths)) ? Number(b.retentionMonths) : cur.retentionMonths
  };
  await setSetting('privacy', next);
  if (next.pseudonymise && !cur.pseudonymise) await q('UPDATE learners SET display_name = NULL');
  res.json(next);
});
