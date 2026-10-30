import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// One tiny interface over two engines:
//  - external PostgreSQL when DATABASE_URL is set (production)
//  - embedded PostgreSQL (PGlite, runs inside Node) otherwise (zero setup)
// Both speak the same SQL, so every query below works on either.

let impl = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  method TEXT NOT NULL,              -- scorm | xapi | sdk
  source_tool TEXT,                  -- Storyline, Rise, Captivate, custom...
  lms TEXT,
  version TEXT NOT NULL DEFAULT 'v1',
  designed_minutes DOUBLE PRECISION,
  ingest_key TEXT UNIQUE NOT NULL,
  ingest_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sections/slides and assessment items are registered automatically the
-- first time a course reports them, and can be renamed or tagged later.
CREATE TABLE IF NOT EXISTS sections (
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INT NOT NULL,
  designed_minutes DOUBLE PRECISION,
  PRIMARY KEY (course_id, object_id)
);

CREATE TABLE IF NOT EXISTS items (
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- question | decision
  name TEXT,
  correct_response TEXT,
  PRIMARY KEY (course_id, object_id)
);

CREATE TABLE IF NOT EXISTS competencies (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS item_competencies (
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  competency_id INT NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, object_id)
);

CREATE TABLE IF NOT EXISTS learners (
  id SERIAL PRIMARY KEY,
  external_ref TEXT UNIQUE NOT NULL, -- keyed hash of the LMS learner id
  display_name TEXT,
  team TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The common event model: every tracking path (SCORM wrapper, xAPI, SDK)
-- is normalised into these rows.
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  learner_id INT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  session_id TEXT,
  type TEXT NOT NULL,
  object_id TEXT,
  success BOOLEAN,
  score DOUBLE PRECISION,
  response TEXT,
  duration_ms INT,
  critical BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL,              -- scorm | xapi | sdk
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_course_ts ON events(course_id, ts);
CREATE INDEX IF NOT EXISTS events_learner ON events(learner_id, ts);
CREATE INDEX IF NOT EXISTS events_type ON events(type);

CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- stalled | repeated_failure | rushing | confusing_question | course_quiet | critical_errors
  threshold DOUBLE PRECISION NOT NULL,
  course_id INT REFERENCES courses(id) ON DELETE CASCADE,
  notify TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in-app',
  enabled BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  rule_id INT REFERENCES alert_rules(id) ON DELETE CASCADE,
  dedupe_key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  learner_id INT REFERENCES learners(id) ON DELETE CASCADE,
  course_id INT REFERENCES courses(id) ON DELETE CASCADE,
  notify TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | acted | dismissed
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_schedules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- manager | monthly | course_health
  cron TEXT NOT NULL,
  recipients TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS report_runs (
  id SERIAL PRIMARY KEY,
  schedule_id INT REFERENCES report_schedules(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  learner_id INT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  learner_id INT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Minimal xAPI State API storage, so authoring tools that save bookmarks
-- (resume position) keep working when LearnLens is their LRS.
CREATE TABLE IF NOT EXISTS xapi_state (
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  state_key TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, state_key)
);

-- Results of the connection test package, run from inside an LMS.
CREATE TABLE IF NOT EXISTS diagnostics (
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  origin TEXT,
  user_agent TEXT,
  ok BOOLEAN NOT NULL,
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  original_name TEXT,
  scorm_version TEXT,
  launch TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function initDb() {
  if (config.databaseUrl) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    impl = {
      kind: 'postgres',
      query: async (text, params) => (await pool.query(text, params)).rows,
      exec: (text) => pool.query(text),
      close: () => pool.end()
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.join(config.dataDir, 'pglite');
    fs.mkdirSync(dir, { recursive: true });
    const db = await PGlite.create(dir);
    impl = {
      kind: 'embedded',
      query: async (text, params) => (await db.query(text, params)).rows,
      exec: (text) => db.exec(text),
      close: () => db.close()
    };
  }
  await impl.exec(SCHEMA);
  await seedDefaults();
  return impl.kind;
}

export const q = (text, params = []) => impl.query(text, params);
export const one = async (text, params = []) => (await impl.query(text, params))[0] || null;
export const closeDb = () => impl && impl.close();

export async function getSetting(key, fallback) {
  const row = await one('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

async function seedDefaults() {
  const rules = await one('SELECT count(*)::int AS n FROM alert_rules');
  if (rules.n === 0) {
    const defaults = [
      ['Learner stalled', 'stalled', 7, 'Team manager', 'in-app'],
      ['Repeated failure', 'repeated_failure', 2, 'Evaluator', 'in-app'],
      ['Rushing through', 'rushing', 0.3, 'Evaluator', 'in-app'],
      ['Confusing question', 'confusing_question', 0.5, 'Course developer', 'in-app'],
      ['Critical errors in a simulation', 'critical_errors', 3, 'Evaluator', 'in-app'],
      ['Course went quiet', 'course_quiet', 3, 'Admin', 'in-app']
    ];
    for (const [name, kind, threshold, notify, channel] of defaults) {
      await q(
        `INSERT INTO alert_rules (name, kind, threshold, notify, channel, enabled)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [name, kind, threshold, notify, channel, kind !== 'course_quiet']
      );
    }
  }
  const sched = await one('SELECT count(*)::int AS n FROM report_schedules');
  if (sched.n === 0) {
    await q(`INSERT INTO report_schedules (name, kind, cron, recipients) VALUES
      ('Weekly manager summary', 'manager', '0 9 * * 1', 'Team managers (each sees their own team)'),
      ('Monthly L&D report', 'monthly', '0 8 1 * *', 'Head of L&D'),
      ('Course health digest', 'course_health', '0 17 * * 5', 'Course developers')`);
  }
  const s = await one(`SELECT 1 AS ok FROM settings WHERE key = 'privacy'`);
  if (!s) await setSetting('privacy', { pseudonymise: true, retentionMonths: 12 });
}
