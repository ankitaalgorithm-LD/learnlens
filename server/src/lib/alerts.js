import { q } from '../db.js';
import { config } from '../config.js';
import { buildPairs, findRisks, loadEvents, lookups, questionStats } from './analytics.js';

const DAY = 86400000;
export const RULE_KINDS = {
  stalled: { label: 'A learner stalls', unit: 'days without progress' },
  repeated_failure: { label: 'A learner keeps failing', unit: 'failed attempts' },
  rushing: { label: 'A learner rushes through', unit: 'share of typical time (0–1)' },
  critical_errors: { label: 'Critical errors in a simulation', unit: 'critical errors' },
  confusing_question: { label: 'A question looks confusing', unit: 'share choosing one wrong answer (0–1)' },
  course_quiet: { label: 'A course stops sending data', unit: 'days without events' }
};

/** Checks every enabled rule and records new alerts. Safe to run often: alerts are de-duplicated. */
export async function evaluateAlerts({ now = Date.now() } = {}) {
  const rules = await q('SELECT * FROM alert_rules WHERE enabled = true');
  if (!rules.length) return { created: 0 };
  const lk = await lookups();
  const events = await loadEvents({ since: now - 90 * DAY });
  const pairs = buildPairs(events);
  const created = [];

  for (const rule of rules) {
    const scoped = rule.course_id ? pairs.filter((p) => p.courseId === rule.course_id) : pairs;
    const t = Number(rule.threshold);
    if (['stalled', 'repeated_failure', 'rushing', 'critical_errors'].includes(rule.kind)) {
      const opts = { now, stalledDays: Infinity, failCount: Infinity, rushRatio: -1, criticalCount: Infinity };
      if (rule.kind === 'stalled') opts.stalledDays = t;
      if (rule.kind === 'repeated_failure') opts.failCount = t;
      if (rule.kind === 'rushing') opts.rushRatio = t;
      if (rule.kind === 'critical_errors') opts.criticalCount = t;
      // Only recent activity raises a new alert (stalling is about inactivity itself).
      const recent = rule.kind === 'stalled' ? scoped : scoped.filter((p) => now - p.last <= 14 * DAY);
      for (const r of findRisks(recent, lk, opts)) {
        if (r.kind !== rule.kind) continue;
        const a = await record(rule, `${rule.id}:${r.learnerId}:${r.courseId}`,
          `${rule.name} · ${r.learner}`, `${r.course}: ${r.reason}`, r.learnerId, r.courseId);
        if (a) created.push(a);
      }
    }
    if (rule.kind === 'confusing_question') {
      for (const course of lk.courses) {
        if (rule.course_id && rule.course_id !== course.id) continue;
        const latest = events.filter((e) => e.course_id === course.id);
        if (!latest.length) continue;
        const version = latest[latest.length - 1].version;
        const ev = latest.filter((e) => e.version === version);
        const ps = buildPairs(ev);
        for (const item of questionStats(course, ev, ps, lk)) {
          if (item.n < 30) continue;
          const wrong = item.responses.find((x) => !x.correct);
          if (!wrong || wrong.share < t || wrong.share <= (item.correct || 0)) continue;
          const a = await record(rule, `${rule.id}:${course.id}:${version}:${item.id}`,
            `${rule.name} · ${item.name || item.id}`,
            `${course.name} ${version}: ${Math.round(wrong.share * 100)}% choose "${wrong.response}"`, null, course.id);
          if (a) created.push(a);
        }
      }
    }
    if (rule.kind === 'course_quiet') {
      const last = await q('SELECT course_id, max(ts) AS last FROM events GROUP BY course_id');
      for (const row of last) {
        if (rule.course_id && rule.course_id !== row.course_id) continue;
        const idle = Math.floor((now - new Date(row.last).getTime()) / DAY);
        if (idle < t) continue;
        const course = lk.courseById.get(row.course_id);
        const a = await record(rule, `${rule.id}:${row.course_id}:${new Date(row.last).toISOString().slice(0, 10)}`,
          `${rule.name} · ${course ? course.name : row.course_id}`, `No learner events for ${idle} days`, null, row.course_id);
        if (a) created.push(a);
      }
    }
  }
  return { created: created.length };
}

async function record(rule, dedupeKey, title, detail, learnerId, courseId) {
  const rows = await q(
    `INSERT INTO alerts (rule_id, dedupe_key, title, detail, learner_id, course_id, notify)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [rule.id, dedupeKey, title, detail, learnerId, courseId, rule.notify]
  );
  const alert = rows[0];
  if (alert && rule.channel === 'webhook') await notifyWebhook({ type: 'alert', title, detail, notify: rule.notify });
  return alert;
}

export async function notifyWebhook(payload) {
  if (!config.alertWebhookUrl) return false;
  try {
    // Slack/Teams/Zapier/Make all accept a JSON body with a "text" field.
    await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `LearnLens: ${payload.title}\n${payload.detail || ''}`, ...payload })
    });
    return true;
  } catch (err) {
    console.warn('[alerts] webhook failed:', err.message);
    return false;
  }
}
