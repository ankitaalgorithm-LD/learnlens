import path from 'node:path';

// All settings come from environment variables so the same build runs
// locally (zero setup) and on a server (Docker, Render, a VPS...).
export const config = {
  port: Number(process.env.PORT) || 4000,
  // The public address learners' browsers use to reach this server.
  // Wrapped SCORM packages and SDK snippets point here. If empty, the
  // address of the incoming request is used (fine for local testing).
  // On Render, RENDER_EXTERNAL_URL is set automatically to the service's https address.
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  onRender: Boolean(process.env.RENDER),
  // Protects the dashboard and admin API. Leave empty only on your own machine.
  adminToken: process.env.ADMIN_TOKEN || '',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  // Set to use an external PostgreSQL. Empty = embedded PostgreSQL (PGlite) in DATA_DIR.
  databaseUrl: process.env.DATABASE_URL || '',
  // Used to pseudonymise learner IDs coming from LMSs. Change it in production.
  hashSecret: process.env.HASH_SECRET || 'learnlens-dev-secret-change-me',
  // Optional: alerts are POSTed here as JSON (Slack/Teams/Zapier/Make webhook).
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || ''
};

export function publicBase(req) {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol}://${req.get('host')}`;
}
