import AdmZip from 'adm-zip';

// Builds a tiny SCORM 1.2 "connection test" package. Upload it to your LMS
// like any course and open it as a learner: it checks, from inside the LMS,
// everything tracking needs (SCORM API, HTTPS, network/CSP, server reachable)
// and reports the results both on screen and to the LearnLens dashboard.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function manifest(courseName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="learnlens-connection-test" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org">
    <organization identifier="org">
      <title>LearnLens connection test (${esc(courseName)})</title>
      <item identifier="item" identifierref="res"><title>LearnLens connection test</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource>
  </resources>
</manifest>
`;
}

function page({ endpoint, key, courseName }) {
  const cfg = JSON.stringify({ endpoint, key }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LearnLens connection test</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #F4F6F9; color: #0F172A; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 28px 18px; }
  .card { background: #fff; border: 1px solid #E2E6EC; border-radius: 12px; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .muted { color: #5B6474; font-size: 14px; }
  .banner { margin: 18px 0; padding: 14px 16px; border-radius: 10px; font-weight: 600; }
  .banner.ok { background: #E6F4F1; color: #0F5D57; } .banner.bad { background: #FFF4EC; color: #7C2D12; } .banner.wait { background: #EEF3FE; color: #1E3A8A; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 12px 0; border-top: 1px solid #EEF1F4; }
  .icon { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: #fff; }
  .i-ok { background: #0F766E; } .i-bad { background: #C2410C; } .i-info { background: #64748B; } .i-wait { background: #94A3B8; }
  .label { font-weight: 600; } .detail { font-size: 14px; color: #3A4352; margin-top: 2px; word-break: break-word; }
  .fix { font-size: 14px; margin-top: 6px; background: #FFF4EC; color: #7C2D12; padding: 8px 10px; border-radius: 8px; }
  code { font-size: 13px; background: #F1F4F8; padding: 1px 4px; border-radius: 4px; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1>LearnLens connection test</h1>
  <div class="muted">For: ${esc(courseName)} · Sends to: <code>${esc(endpoint)}</code></div>
  <div id="banner" class="banner wait">Running checks…</div>
  <ul id="list"></ul>
  <p class="muted" style="margin-bottom:0">This test sends no learner activity, only these check results, which also appear on the LearnLens <strong>Connect a course</strong> page.</p>
</div></div>
<script>
(function () {
  var cfg = ${cfg};
  var checks = [];
  var cspBlocked = [];
  document.addEventListener('securitypolicyviolation', function (e) { cspBlocked.push((e.violatedDirective || '') + ' blocked ' + (e.blockedURI || '')); });

  function render() {
    var list = document.getElementById('list');
    list.innerHTML = '';
    checks.forEach(function (c) {
      var li = document.createElement('li');
      var cls = c.ok === true ? 'i-ok' : c.ok === false ? 'i-bad' : c.ok === 'info' ? 'i-info' : 'i-wait';
      var sym = c.ok === true ? '✓' : c.ok === false ? '!' : c.ok === 'info' ? 'i' : '…';
      li.innerHTML = '<div class="icon ' + cls + '" aria-hidden="true">' + sym + '</div><div><div class="label"></div><div class="detail"></div>' + (c.fix && c.ok === false ? '<div class="fix"></div>' : '') + '</div>';
      li.querySelector('.label').textContent = c.label;
      li.querySelector('.detail').textContent = c.detail || '';
      if (c.fix && c.ok === false) li.querySelector('.fix').textContent = c.fix;
      list.appendChild(li);
    });
  }
  function add(id, label, ok, detail, fix) { var c = { id: id, label: label, ok: ok, detail: detail, fix: fix }; checks.push(c); render(); return c; }
  function finish() {
    var failed = checks.filter(function (c) { return c.ok === false; }).length;
    var b = document.getElementById('banner');
    b.className = 'banner ' + (failed ? 'bad' : 'ok');
    b.textContent = failed ? failed + ' problem' + (failed > 1 ? 's' : '') + ' found. Fix the items marked "!" and run the test again.'
      : 'All checks passed. Courses in this LMS can send learner data to LearnLens.';
    render();
  }

  // 1. Where are we running?
  var framed = false;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  add('page', 'Course page', 'info', location.protocol.replace(':', '').toUpperCase() + ' · ' + location.host + (framed ? ' · inside a frame' : ' · in its own window'));

  // 2. SCORM API provided by the LMS
  function findApi(name) {
    var win = window, level = 0;
    while (win && level < 12) {
      try { if (win[name]) return { api: win[name], where: level === 0 ? 'this window' : 'parent window, ' + level + ' level' + (level > 1 ? 's' : '') + ' up' }; } catch (e) { /* cross-origin */ }
      if (win.parent === win) break;
      win = win.parent; level++;
    }
    try {
      var op = window.top.opener; level = 0;
      while (op && level < 12) {
        try { if (op[name]) return { api: op[name], where: 'the window that opened this one' }; } catch (e2) { break; }
        if (op.parent === op) break; op = op.parent; level++;
      }
    } catch (e3) { /* ignore */ }
    return null;
  }
  var a12 = findApi('API'), a04 = findApi('API_1484_11');
  var api = a12 || a04;
  if (api) {
    var init = 'false', learnerId = '';
    try {
      init = a12 ? a12.api.LMSInitialize('') : a04.api.Initialize('');
      learnerId = a12 ? a12.api.LMSGetValue('cmi.core.student_id') : a04.api.GetValue('cmi.learner_id');
    } catch (e) { /* reported below */ }
    add('scorm', 'SCORM API from the LMS', String(init) === 'true',
      (a12 ? 'SCORM 1.2' : 'SCORM 2004') + ' API found in ' + api.where + '. Initialise: ' + init + (learnerId ? '. Learner id received.' : '. No learner id received.'),
      'The LMS found no session to start. Make sure the package was added as a SCORM activity and opened as a learner, not previewed as a file.');
  } else {
    add('scorm', 'SCORM API from the LMS', false, 'No SCORM API was found around this page.',
      'Upload this zip as a SCORM package (SCORM activity / SCORM course), not as a file or web page. If the LMS opens courses in a new window, allow pop-ups.');
  }

  // 3. HTTPS
  var mixed = location.protocol === 'https:' && /^http:/i.test(cfg.endpoint);
  add('https', 'Secure connection', !mixed,
    mixed ? 'Your LMS uses HTTPS but LearnLens is at an HTTP address.' : (/^https:/i.test(cfg.endpoint) ? 'LearnLens uses HTTPS.' : 'LearnLens uses HTTP (fine only on a local test setup).'),
    'Browsers block HTTPS pages from sending data to HTTP addresses. Put LearnLens on HTTPS, set PUBLIC_URL to that address, then download a new test package and re-wrap your courses.');

  // 4. Can this browser reach LearnLens?
  var reach = add('reach', 'Reach the LearnLens server', null, 'Checking…');
  var started = Date.now();
  var timer = setTimeout(function () { if (reach.ok === null) done(false, 'No answer after 20 seconds.', 'The server may be asleep or down. On free hosting it can take about a minute to wake up: wait, then reopen this test. Otherwise check that the server is running and the address is correct.'); }, 20000);
  function done(ok, detail, fix) {
    if (reach.ok !== null) return;
    clearTimeout(timer);
    reach.ok = ok; reach.detail = detail; reach.fix = fix;
    render();
    if (ok) report(); else finish();
  }
  if (!window.fetch) {
    done(false, 'This browser is too old to send data.', 'Use a current version of Chrome, Edge, Firefox or Safari.');
  } else {
    fetch(cfg.endpoint.replace(/\\/$/, '') + '/health', { cache: 'no-store' })
      .then(function (r) {
        if (r.ok) done(true, 'Answered in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.');
        else done(false, 'The server answered with status ' + r.status + '.', 'Check the server logs; it may be starting up or misconfigured.');
      })
      .catch(function (err) {
        setTimeout(function () {
          if (cspBlocked.length) done(false, 'Blocked by the LMS security policy: ' + cspBlocked[0], 'Your LMS (or its web server) sends a Content-Security-Policy that blocks connections to other sites. Ask your LMS administrator to add ' + cfg.endpoint + ' to "connect-src".');
          else if (mixed) done(false, 'Blocked because the LMS is HTTPS and LearnLens is HTTP.', 'Use an HTTPS address for LearnLens (see "Secure connection").');
          else done(false, 'The request failed: ' + (err && err.message ? err.message : 'network error') + '.', 'Check that the address is correct and reachable from this network (company firewalls and VPNs can block it). Open ' + cfg.endpoint + '/health in a new tab: it should show {"ok":true}.');
        }, 50);
      });
  }

  // 5. Send the results to the dashboard
  function report() {
    var sent = add('report', 'Send data to LearnLens', null, 'Sending…');
    var done = checks.filter(function (c) { return c.id !== 'report'; });
    var body = JSON.stringify({ origin: location.origin, ok: !done.some(function (c) { return c.ok === false; }), checks: done.map(function (c) { return { id: c.id, label: c.label, ok: c.ok, detail: c.detail }; }) });
    fetch(cfg.endpoint.replace(/\\/$/, '') + '/api/diagnostics?key=' + encodeURIComponent(cfg.key), { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' } })
      .then(function (r) {
        if (r.ok) { sent.ok = true; sent.detail = 'LearnLens received this test. It now shows on the Connect a course page.'; }
        else if (r.status === 401) { sent.ok = false; sent.detail = 'LearnLens did not recognise the course key.'; sent.fix = 'The course may have been deleted. Download a new test package from LearnLens.'; }
        else { sent.ok = false; sent.detail = 'The server answered with status ' + r.status + '.'; }
      })
      .catch(function (e) { sent.ok = false; sent.detail = 'Sending failed: ' + (e && e.message ? e.message : 'network error'); sent.fix = 'The server could be reached but sending data failed. Check firewalls or proxies that block POST requests.'; })
      .then(function () {
        var store = 'info';
        try { localStorage.setItem('learnlens_test', '1'); localStorage.removeItem('learnlens_test'); } catch (e) { store = false; }
        add('storage', 'Offline queue', store === 'info' ? 'info' : 'info', store === 'info' ? 'Available: if the network drops, events are kept and sent later.' : 'Not available in this LMS, so events can be lost if the network drops. Tracking still works.');
        finish();
        try {
          if (a12) { a12.api.LMSSetValue('cmi.core.lesson_status', 'completed'); a12.api.LMSCommit(''); }
          else if (a04) { a04.api.SetValue('cmi.completion_status', 'completed'); a04.api.Commit(''); }
        } catch (e) { /* ignore */ }
      });
  }
  window.addEventListener('pagehide', function () {
    try { if (a12) a12.api.LMSFinish(''); else if (a04) a04.api.Terminate(''); } catch (e) { /* ignore */ }
  });
})();
</script>
</body>
</html>
`;
}

export function buildDiagnosticPackage({ endpoint, key, courseName }) {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(manifest(courseName), 'utf8'));
  zip.addFile('index.html', Buffer.from(page({ endpoint, key, courseName }), 'utf8'));
  return zip.toBuffer();
}
