import crypto from 'node:crypto';
import { q, one, getSetting } from '../db.js';
import { config } from '../config.js';

// The common event model. Every tracking path is normalised into these types.
export const EVENT_TYPES = new Set([
  'session_started',   // learner opened the course
  'page_viewed',       // learner left a slide/section; duration_ms = time spent on it
  'question_answered', // assessment item; response + success
  'decision_made',     // simulation/scenario decision; success + critical
  'hint_used',
  'error_made',        // simulation error; critical = safety/quality critical
  'score_reported',    // score 0..1
  'course_completed',
  'course_passed',
  'course_failed'
]);

export const MAX_BATCH = 500;
const DAY = 86400000;

const str = (v, max = 200) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
const bool = (v) => (v === undefined || v === null ? null : Boolean(v));
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function hashLearnerId(rawId) {
  return crypto.createHmac('sha256', config.hashSecret).update(String(rawId)).digest('hex').slice(0, 32);
}

export function newKey(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export async function courseByKey(key) {
  if (!key || typeof key !== 'string') return null;
  return one('SELECT * FROM courses WHERE ingest_key = $1', [key]);
}

/**
 * Validate, normalise and store a batch of events for one course.
 * Input event shape (what the SCORM wrapper, SDK and xAPI mapper produce):
 * { type, learner: {id, name?, team?}, session?, objectId?, objectName?, position?,
 *   success?, score?, response?, durationMs?, critical?, correctResponse?, version?, ts? }
 */
export async function ingestEvents(course, events, source) {
  if (!Array.isArray(events)) throw httpError(400, 'Body must contain an "events" array');
  if (events.length > MAX_BATCH) throw httpError(413, `At most ${MAX_BATCH} events per request`);

  const privacy = await getSetting('privacy', { pseudonymise: true });
  const learnerIds = new Map();
  const knownSections = new Set(
    (await q('SELECT object_id FROM sections WHERE course_id = $1', [course.id])).map((r) => r.object_id)
  );
  const knownItems = new Set(
    (await q('SELECT object_id FROM items WHERE course_id = $1', [course.id])).map((r) => r.object_id)
  );

  const rows = [];
  const rejected = [];
  const now = Date.now();

  for (let i = 0; i < events.length; i++) {
    const e = events[i] || {};
    try {
      if (!EVENT_TYPES.has(e.type)) throw new Error(`unknown type "${e.type}"`);
      const rawLearner = str(e.learner && e.learner.id, 200);
      if (!rawLearner) throw new Error('learner.id is required');

      let ts = now;
      if (e.ts !== undefined) {
        ts = new Date(e.ts).getTime();
        if (!Number.isFinite(ts)) throw new Error('invalid ts');
        if (ts > now + 5 * 60000) throw new Error('ts is in the future');
        if (ts < now - 400 * DAY) throw new Error('ts is older than 400 days');
      }

      let learnerId = learnerIds.get(rawLearner);
      if (!learnerId) {
        learnerId = await upsertLearner(rawLearner, e.learner, privacy);
        learnerIds.set(rawLearner, learnerId);
      }

      const objectId = str(e.objectId, 160);
      if (e.type === 'page_viewed' && objectId && !knownSections.has(objectId)) {
        await registerSection(course.id, objectId, str(e.objectName, 160), num(e.position));
        knownSections.add(objectId);
      }
      if ((e.type === 'question_answered' || e.type === 'decision_made') && objectId && !knownItems.has(objectId)) {
        await q(
          `INSERT INTO items (course_id, object_id, kind, name, correct_response)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [course.id, objectId, e.type === 'question_answered' ? 'question' : 'decision',
            str(e.objectName, 300) || objectId, str(e.correctResponse, 300)]
        );
        knownItems.add(objectId);
      }

      let duration = num(e.durationMs);
      if (duration !== null) duration = Math.max(0, Math.min(Math.round(duration), DAY));
      let score = num(e.score);
      if (score !== null) score = Math.max(0, Math.min(score, 1));

      rows.push([
        course.id, str(e.version, 40) || course.version, learnerId, str(e.session, 80), e.type, objectId,
        bool(e.success), score, str(e.response, 300), duration, Boolean(e.critical), source,
        new Date(ts).toISOString()
      ]);
    } catch (err) {
      rejected.push({ index: i, reason: err.message });
    }
  }

  // Multi-row insert in chunks.
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200);
    const params = [];
    const values = chunk.map((r, j) => {
      params.push(...r);
      const b = j * 13;
      return `(${Array.from({ length: 13 }, (_, k) => `$${b + k + 1}`).join(',')})`;
    });
    await q(
      `INSERT INTO events (course_id, version, learner_id, session_id, type, object_id, success, score,
         response, duration_ms, critical, source, ts) VALUES ${values.join(',')}`,
      params
    );
  }
  return { accepted: rows.length, rejected };
}

async function upsertLearner(rawId, learner, privacy) {
  const ref = hashLearnerId(rawId);
  const name = privacy.pseudonymise ? null : str(learner.name, 120);
  const team = str(learner.team, 80);
  const row = await one(
    `INSERT INTO learners (external_ref, display_name, team) VALUES ($1,$2,$3)
     ON CONFLICT (external_ref) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, learners.display_name),
       team = COALESCE(EXCLUDED.team, learners.team)
     RETURNING id`,
    [ref, name, team]
  );
  return row.id;
}

async function registerSection(courseId, objectId, name, position) {
  let pos = position;
  if (pos === null) {
    const r = await one('SELECT COALESCE(max(position), 0)::int AS p FROM sections WHERE course_id = $1', [courseId]);
    pos = r.p + 1;
  }
  await q(
    `INSERT INTO sections (course_id, object_id, name, position) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [courseId, objectId, name || objectId, pos]
  );
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
