import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { mapStatement, parseIsoDuration } from '../src/lib/xapi.js';
import { wrapScormPackage } from '../src/scorm/wrap.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('parses ISO 8601 durations', () => {
  assert.equal(parseIsoDuration('PT1M30S'), 90000);
  assert.equal(parseIsoDuration('PT1H'), 3600000);
  assert.equal(parseIsoDuration('PT2.5S'), 2500);
  assert.equal(parseIsoDuration('P1DT1S'), 86401000);
  assert.equal(parseIsoDuration('nonsense'), null);
});

test('maps xAPI statements onto the common event model', () => {
  const answered = mapStatement({
    actor: { name: 'Priya Nair', account: { homePage: 'https://lms.example', name: 'u42' } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/answered' },
    object: { id: 'https://example.com/course/q7', definition: { name: { 'en-US': 'Blocked exits' }, correctResponsesPattern: ['B'] } },
    result: { success: false, response: 'C', duration: 'PT12S' },
    context: { registration: 'r1', extensions: { 'https://example.com/team': 'Warehouse' } }
  });
  assert.equal(answered.event.type, 'question_answered');
  assert.equal(answered.event.objectId, 'q7');
  assert.equal(answered.event.learner.id, 'u42');
  assert.equal(answered.event.learner.team, 'Warehouse');
  assert.equal(answered.event.success, false);
  assert.equal(answered.event.durationMs, 12000);

  const passed = mapStatement({ actor: { mbox: 'mailto:a@b.c' }, verb: { id: 'http://adlnet.gov/expapi/verbs/passed' }, object: { id: 'x' }, result: { score: { raw: 8, max: 10 } } });
  assert.equal(passed.event.type, 'course_passed');
  assert.equal(passed.event.score, 0.8);
  assert.equal(passed.event.learner.id, 'a@b.c');

  assert.ok(mapStatement({ actor: { mbox: 'mailto:a@b.c' }, verb: { id: 'http://example.com/verbs/liked' }, object: { id: 'x' } }).skip);
});

function makePackage(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

test('wraps a SCORM 1.2 package without changing the course', () => {
  const sample = new AdmZip();
  sample.addLocalFolder(path.join(here, '..', '..', 'examples', 'sample-scorm-course'));
  const out = wrapScormPackage(sample.toBuffer(), { endpoint: 'https://ll.example', key: 'ck_test', version: 'v2', sendNames: false });
  assert.equal(out.version, 'SCORM 1.2');
  assert.equal(out.launch, 'index.html');
  const zip = new AdmZip(out.buffer);
  const html = zip.getEntry('index.html').getData().toString();
  assert.match(html, /window\.LEARNLENS_CONFIG = \{"endpoint":"https:\/\/ll\.example","key":"ck_test","version":"v2","sendNames":false\}/);
  assert.match(html, /<script src="learnlens\/learnlens-scorm\.js"><\/script>/);
  assert.ok(html.includes('lms(\'LMSInitialize\''), 'original course code is kept');
  assert.ok(zip.getEntry('learnlens/learnlens-scorm.js'));
  assert.match(zip.getEntry('imsmanifest.xml').getData().toString(), /<file href="learnlens\/learnlens-scorm\.js"\/>/);

  // Wrapping twice replaces the config instead of stacking it.
  const again = wrapScormPackage(out.buffer, { endpoint: 'https://new.example', key: 'ck_2', version: 'v3', sendNames: true });
  const html2 = new AdmZip(again.buffer).getEntry('index.html').getData().toString();
  assert.equal((html2.match(/learnlens-scorm\.js/g) || []).length, 1);
  assert.match(html2, /new\.example/);
});

test('wraps a SCORM 2004 package with the SCO in a subfolder', () => {
  const manifest = `<?xml version="1.0"?><manifest identifier="m" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
    <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
    <organizations default="o"><organization identifier="o"><title>T</title><item identifier="i" identifierref="r"><title>T</title></item></organization></organizations>
    <resources><resource identifier="r" type="webcontent" adlcp:scormType="sco" href="content/story.html?x=1"><file href="content/story.html"/></resource></resources></manifest>`;
  const out = wrapScormPackage(makePackage({ 'imsmanifest.xml': manifest, 'content/story.html': '<html><head><title>x</title></head><body></body></html>' }),
    { endpoint: 'https://ll.example', key: 'k', version: 'v1' });
  assert.equal(out.version, 'SCORM 2004');
  const html = new AdmZip(out.buffer).getEntry('content/story.html').getData().toString();
  assert.match(html, /src="\.\.\/learnlens\/learnlens-scorm\.js"/);
});

test('rejects files that are not SCORM packages', () => {
  assert.throws(() => wrapScormPackage(Buffer.from('not a zip'), { endpoint: 'x', key: 'k' }), /valid \.zip/);
  assert.throws(() => wrapScormPackage(makePackage({ 'index.html': '<html></html>' }), { endpoint: 'x', key: 'k' }), /imsmanifest\.xml/);
});
