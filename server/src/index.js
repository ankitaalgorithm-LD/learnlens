import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { initDb, one, q, getSetting } from './db.js';
import { ingestRouter } from './routes/ingest.js';
import { adminRouter } from './routes/admin.js';
import { evaluateAlerts } from './lib/alerts.js';
import { startScheduler } from './lib/reports.js';
import { previewPage } from './preview.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export async function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // Called from courses running inside LMSs (connection test), so allow any origin.
  app.get('/health', (req, res) => res.set('Access-Control-Allow-Origin', '*').json({ ok: true }));

  // Public: SDK file and tracking endpoints (called from learners' browsers).
  app.get('/sdk/learnlens.js', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=300');
    res.type('application/javascript').sendFile(path.join(root, 'sdk', 'learnlens.js'));
  });
  app.use(ingestRouter);

  // Public but unguessable: test a wrapped SCORM package in the mock LMS.
  const packagesDir = path.join(config.dataDir, 'packages');
  app.get('/preview/:id', async (req, res) => {
    const p = await one('SELECT p.*, c.name FROM packages p JOIN courses c ON c.id = p.course_id WHERE p.id = $1', [req.params.id]);
    if (!p) return res.status(404).send('Package not found');
    if (!fs.existsSync(path.join(packagesDir, p.id))) {
      return res.status(410).send('This package is no longer on the server (hosting without a persistent disk clears files on restart). Upload the original zip again to test it.');
    }
    res.type('html').send(previewPage({ packageId: p.id, launch: p.launch, courseName: p.name }));
  });
  app.use('/packages/:id', (req, res, next) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) return res.status(404).end();
    express.static(path.join(packagesDir, req.params.id))(req, res, next);
  });

  // Admin API (protected by ADMIN_TOKEN when set).
  app.use(adminRouter);

  // The dashboard (built React app).
  const web = path.join(root, 'web', 'dist');
  if (fs.existsSync(web)) {
    app.use(express.static(web));
    app.get('/{*path}', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/xapi')) return next();
      res.sendFile(path.join(web, 'index.html'));
    });
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
  });
  return app;
}

async function retentionCleanup() {
  const p = await getSetting('privacy', { retentionMonths: 12 });
  if (!p.retentionMonths) return;
  await q(`DELETE FROM events WHERE ts < now() - make_interval(months => $1)`, [p.retentionMonths]);
}

export async function start() {
  const kind = await initDb();
  const app = await createApp();
  const server = app.listen(config.port, () => {
    console.log(`\n  LearnLens is running on http://localhost:${config.port}`);
    console.log(`  Database: ${kind === 'embedded' ? `embedded PostgreSQL in ${config.dataDir}` : 'PostgreSQL (DATABASE_URL)'}`);
    if (!config.adminToken) console.log('  ⚠  ADMIN_TOKEN is not set: the dashboard is open to anyone who can reach this server.');
    if (!config.publicUrl) console.log('  ℹ  PUBLIC_URL is not set: tracking links will use the address you open the dashboard on.\n');
  });

  const safe = (fn, label) => () => fn().catch((e) => console.error(`[${label}]`, e.message));
  setTimeout(safe(evaluateAlerts, 'alerts'), 5000);
  setInterval(safe(evaluateAlerts, 'alerts'), 10 * 60 * 1000);
  setInterval(safe(retentionCleanup, 'retention'), 24 * 60 * 60 * 1000);
  await startScheduler();
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
