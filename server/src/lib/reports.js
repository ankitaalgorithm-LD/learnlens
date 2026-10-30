import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import cron from 'node-cron';
import { q, one } from '../db.js';
import { config } from '../config.js';
import { overview, learnersOverview, courseInsights, findRisks, buildPairs, loadEvents, lookups } from './analytics.js';
import { notifyWebhook } from './alerts.js';

const DAY = 86400000;
const INK = '#0F172A';
const MUTED = '#5B6474';
const ACCENT = '#2563EB';
const WARN = '#C2410C';
const p100 = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);

function pdf(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'LearnLens report', Producer: 'LearnLens' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      build(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function header(doc, title, subtitle) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text('LearnLens', { continued: true })
    .font('Helvetica').fillColor(MUTED).text(`   ${new Date().toISOString().slice(0, 10)}`, { align: 'right' });
  doc.moveDown(1.2);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(title);
  if (subtitle) doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(subtitle);
  doc.moveDown(1);
}

function kpiRow(doc, items) {
  const x0 = doc.page.margins.left;
  const w = (doc.page.width - doc.page.margins.left - doc.page.margins.right - 12 * (items.length - 1)) / items.length;
  const y = doc.y;
  items.forEach(([label, value, warn], i) => {
    const x = x0 + i * (w + 12);
    doc.roundedRect(x, y, w, 58, 6).fill(warn ? '#FFF4EC' : '#F4F6F9');
    doc.fillColor(warn ? WARN : MUTED).font('Helvetica').fontSize(9).text(label, x + 10, y + 10, { width: w - 20 });
    doc.fillColor(warn ? WARN : INK).font('Helvetica-Bold').fontSize(18).text(String(value), x + 10, y + 26, { width: w - 20 });
  });
  doc.x = x0;
  doc.y = y + 74;
}

function sectionTitle(doc, text) {
  doc.moveDown(0.6).fillColor(INK).font('Helvetica-Bold').fontSize(12).text(text).moveDown(0.3);
}

function table(doc, cols, rows) {
  const x0 = doc.page.margins.left;
  const total = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = cols.map((c) => c.w * total);
  const drawRow = (cells, bold) => {
    if (doc.y > doc.page.height - 80) doc.addPage();
    const y = doc.y;
    let x = x0;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? MUTED : INK);
    cells.forEach((c, i) => { doc.text(String(c ?? ''), x + 4, y, { width: widths[i] - 8, lineBreak: false, ellipsis: true }); x += widths[i]; });
    doc.y = y + 16;
    doc.moveTo(x0, doc.y - 3).lineTo(x0 + total, doc.y - 3).lineWidth(0.5).strokeColor('#E2E6EC').stroke();
  };
  drawRow(cols.map((c) => c.label), true);
  rows.forEach((r) => drawRow(r, false));
  doc.x = x0;
}

async function teamRisks(team) {
  const lk = await lookups();
  const events = await loadEvents({ since: Date.now() - 60 * DAY });
  const ids = new Set(lk.learners.filter((l) => !team || l.team === team).map((l) => l.id));
  const pairs = buildPairs(events.filter((e) => ids.has(e.learner_id)));
  return findRisks(pairs, lk);
}

export async function managerReport(team) {
  const lo = await learnersOverview();
  const teams = team ? lo.progress.filter((t) => t.team === team) : lo.progress;
  const perTeam = [];
  for (const t of teams) {
    const risks = await teamRisks(t.team);
    const row = lo.heatmap.teams.find((x) => x.team === t.team);
    let gap = null;
    if (row) {
      row.cells.forEach((v, i) => {
        if (v !== null && (!gap || v < gap.v)) gap = { v, name: lo.heatmap.competencies[i].name };
      });
    }
    perTeam.push({ t, risks, gap });
  }
  return pdf((doc) => {
    if (!perTeam.length) {
      header(doc, 'Weekly manager summary', 'No learner activity yet.');
      return;
    }
    perTeam.forEach(({ t, risks, gap }, i) => {
      if (i) doc.addPage();
      header(doc, `Your team this week: ${t.team}`, `${t.learners} learners with activity in the last 90 days`);
      const people = new Set(risks.map((r) => r.learnerId));
      kpiRow(doc, [['Completed', p100(t.mastered + t.completed)], ['Mastered', p100(t.mastered)], ['Need help', people.size, people.size > 0]]);
      sectionTitle(doc, 'Please follow up with');
      if (!risks.length) doc.font('Helvetica').fontSize(10).fillColor(INK).text('Nobody needs follow-up this week.');
      const seen = new Set();
      for (const r of risks) {
        if (seen.has(r.learnerId)) continue;
        seen.add(r.learnerId);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(r.learner, { continued: true })
          .font('Helvetica').fillColor(MUTED).text(`  ${r.course}: ${r.reason}`).moveDown(0.25);
        if (seen.size >= 12) break;
      }
      if (gap) {
        sectionTitle(doc, 'Team skill gap');
        doc.font('Helvetica').fontSize(10).fillColor(gap.v < 0.5 ? WARN : INK)
          .text(`${gap.name}: ${p100(gap.v)} first-attempt accuracy${gap.v < 0.5 ? '. Consider a refresher for the team.' : '.'}`);
      }
      doc.moveDown(2).fontSize(8).fillColor(MUTED).text('Generated by LearnLens. Rates cover learners who started a course in the last 90 days.');
    });
  });
}

export async function monthlyReport() {
  const ov = await overview({ days: 30 });
  const open = await q(`SELECT title, detail FROM alerts WHERE status = 'open' ORDER BY created_at DESC LIMIT 10`);
  return pdf((doc) => {
    header(doc, 'Monthly learning report', 'All courses · last 30 days');
    kpiRow(doc, [
      ['Active learners', ov.kpis.activeLearners.value],
      ['Completion', p100(ov.kpis.completion.value)],
      ['Mastery', p100(ov.kpis.mastery.value)],
      ['At risk', ov.kpis.atRisk.value, ov.kpis.atRisk.value > 0]
    ]);
    sectionTitle(doc, 'Courses');
    table(doc,
      [{ label: 'Course', w: 0.34 }, { label: 'Learners', w: 0.12 }, { label: 'Completion', w: 0.14 }, { label: 'Mastery', w: 0.12 }, { label: 'Status', w: 0.28 }],
      ov.courses.map((c) => [c.name, c.learners, p100(c.completion), p100(c.mastery), c.status]));
    sectionTitle(doc, 'Open alerts');
    if (!open.length) doc.font('Helvetica').fontSize(10).text('No open alerts.');
    open.forEach((a) => doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(a.title).font('Helvetica').fillColor(MUTED).text(a.detail || '').moveDown(0.3));
  });
}

export async function courseHealthCsv() {
  const courses = await q('SELECT id FROM courses ORDER BY id');
  const lines = [['course', 'version', 'question', 'responses', 'correct', 'difficulty', 'discrimination', 'flags'].join(',')];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  for (const c of courses) {
    const ins = await courseInsights(c.id);
    if (!ins) continue;
    for (const item of ins.questions) {
      lines.push([ins.course.name, ins.version, item.name || item.id, item.n, item.correct === null ? '' : item.correct.toFixed(2),
        item.difficulty || '', item.discrimination === null ? '' : item.discrimination.toFixed(2), item.flags.join(' | ')].map(esc).join(','));
    }
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

export async function generateReport(kind, { team } = {}) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'manager') return { buffer: await managerReport(team), filename: `manager-summary-${stamp}.pdf`, type: 'application/pdf' };
  if (kind === 'monthly') return { buffer: await monthlyReport(), filename: `monthly-report-${stamp}.pdf`, type: 'application/pdf' };
  if (kind === 'course_health') return { buffer: await courseHealthCsv(), filename: `course-health-${stamp}.csv`, type: 'text/csv' };
  throw new Error(`Unknown report kind "${kind}"`);
}

// ------------------------------------------------------------ scheduling

const jobs = new Map();
export const reportsDir = () => path.join(config.dataDir, 'reports');

export async function runSchedule(id) {
  const s = await one('SELECT * FROM report_schedules WHERE id = $1', [id]);
  if (!s) return null;
  const r = await generateReport(s.kind);
  fs.mkdirSync(reportsDir(), { recursive: true });
  const file = `${s.id}-${Date.now()}-${r.filename}`;
  fs.writeFileSync(path.join(reportsDir(), file), r.buffer);
  await q('INSERT INTO report_runs (schedule_id, file) VALUES ($1, $2)', [s.id, file]);
  await q('UPDATE report_schedules SET last_run = now() WHERE id = $1', [s.id]);
  const base = config.publicUrl || `http://localhost:${config.port}`;
  await notifyWebhook({ type: 'report', title: `${s.name} is ready`, detail: `${base}/api/reports/files/${encodeURIComponent(file)}`, notify: s.recipients });
  return file;
}

export async function startScheduler() {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  const schedules = await q('SELECT * FROM report_schedules WHERE enabled = true');
  for (const s of schedules) {
    if (!cron.validate(s.cron)) {
      console.warn(`[reports] invalid cron "${s.cron}" for schedule ${s.id}`);
      continue;
    }
    jobs.set(s.id, cron.schedule(s.cron, () => runSchedule(s.id).catch((e) => console.error('[reports]', e))));
  }
}
