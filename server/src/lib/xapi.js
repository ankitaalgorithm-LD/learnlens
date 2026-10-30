import crypto from 'node:crypto';

// Maps xAPI statements (Storyline, Rise, Captivate, cmi5 content...) onto
// LearnLens's common event model. This is a write-only, analytics-focused
// endpoint, not a complete LRS.

export function parseIsoDuration(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  const [, d, h, min, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return Math.round(((d * 24 + h) * 60 + min) * 60000 + s * 1000);
}

const lastSegment = (id) => {
  if (!id) return null;
  const s = String(id).replace(/[/#]+$/, '');
  const parts = s.split(/[/#]/);
  return parts[parts.length - 1] || s;
};

const langString = (map) => {
  if (!map || typeof map !== 'object') return null;
  return map['en-US'] || map['en'] || map['en-GB'] || Object.values(map)[0] || null;
};

function findExtension(ext, suffix) {
  if (!ext || typeof ext !== 'object') return null;
  const key = Object.keys(ext).find((k) => k.toLowerCase().endsWith(suffix));
  return key ? ext[key] : null;
}

function actorId(actor) {
  if (!actor) return null;
  // The account name is the LMS user id, so the same person matches across
  // SCORM, xAPI and SDK courses from the same LMS.
  if (actor.account && actor.account.name) return String(actor.account.name);
  if (actor.mbox) return String(actor.mbox).replace(/^mailto:/i, '');
  return actor.mbox_sha1sum || actor.openid || null;
}

function score(result) {
  const s = result && result.score;
  if (!s) return undefined;
  if (typeof s.scaled === 'number') return s.scaled;
  if (typeof s.raw === 'number' && typeof s.max === 'number' && s.max > (s.min || 0)) {
    return (s.raw - (s.min || 0)) / (s.max - (s.min || 0));
  }
  return undefined;
}

const PAGE_TYPES = ['lesson', 'slide', 'page', 'module', 'section', 'media'];

/** Returns { event } or { skip: reason }. */
export function mapStatement(st) {
  if (!st || typeof st !== 'object') return { skip: 'not an object' };
  const verb = String((st.verb && st.verb.id) || '').toLowerCase();
  const verbName = lastSegment(verb);
  const obj = st.object || {};
  const def = obj.definition || {};
  const typeName = lastSegment(String(def.type || '').toLowerCase()) || '';
  const result = st.result || {};
  const ctx = st.context || {};
  const ext = ctx.extensions || {};

  const learnerId = actorId(st.actor);
  if (!learnerId) return { skip: 'actor has no identifier' };

  const base = {
    learner: { id: learnerId, name: st.actor.name, team: findExtension(ext, '/team') },
    session: ctx.registration,
    objectId: lastSegment(obj.id),
    objectName: langString(def.name),
    ts: st.timestamp,
    version: findExtension(ext, '/version') || undefined,
    durationMs: parseIsoDuration(result.duration)
  };

  let type = null;
  switch (verbName) {
    case 'answered':
    case 'responded':
      type = 'question_answered';
      Object.assign(base, {
        success: result.success,
        response: result.response,
        correctResponse: Array.isArray(def.correctResponsesPattern) ? def.correctResponsesPattern[0] : undefined
      });
      break;
    case 'experienced':
    case 'viewed':
    case 'progressed':
      type = 'page_viewed';
      break;
    case 'initialized':
    case 'launched':
      type = 'session_started';
      break;
    case 'completed':
      type = PAGE_TYPES.includes(typeName) && typeName !== 'module' ? 'page_viewed' : 'course_completed';
      break;
    case 'passed':
      type = 'course_passed';
      base.score = score(result);
      break;
    case 'failed':
      type = 'course_failed';
      base.score = score(result);
      break;
    case 'scored':
      type = 'score_reported';
      base.score = score(result);
      break;
    default:
      return { skip: `verb "${verbName}" is not used for analytics` };
  }
  return { event: { type, ...base } };
}

export function statementId(st) {
  return st && typeof st.id === 'string' ? st.id : crypto.randomUUID();
}
