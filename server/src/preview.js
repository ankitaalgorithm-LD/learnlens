// A tiny mock LMS used to try a wrapped SCORM package in the browser,
// without uploading it to a real LMS first. It implements the SCORM 1.2
// and 2004 runtime APIs in memory and shows every call in a side panel.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function previewPage({ packageId, launch, courseName }) {
  const src = `/packages/${packageId}/${launch.split('/').map(encodeURIComponent).join('/')}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview · ${esc(courseName)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #0E1A2B; color: #E2E8F0; display: flex; flex-wrap: wrap; min-height: 100vh; }
  header { flex: 1 1 100%; padding: 12px 20px; display: flex; gap: 12px; align-items: center; justify-content: space-between; border-bottom: 1px solid #1B2A40; font-size: 14px; }
  header strong { color: #fff; }
  .tag { background: #FFF4E5; color: #9A3412; padding: 3px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  main { flex: 999 1 600px; padding: 16px; min-width: 0; }
  iframe { width: 100%; height: calc(100vh - 100px); border: 0; border-radius: 10px; background: #fff; }
  aside { flex: 1 1 320px; padding: 16px; box-sizing: border-box; max-height: calc(100vh - 60px); overflow: auto; font: 12px/1.6 ui-monospace, Menlo, monospace; }
  aside h2 { font: 600 13px Inter, system-ui, sans-serif; color: #fff; margin: 0 0 8px; }
  .set { color: #93C5FD; } .call { color: #94A3B8; }
</style>
</head>
<body>
<header><span><strong>${esc(courseName)}</strong> &nbsp;in the LearnLens test LMS</span>
<span class="tag">Test data: learner "Preview tester"</span></header>
<main><iframe src="${esc(src)}" title="Course preview"></iframe></main>
<aside><h2>SCORM calls (what your LMS would see)</h2><div id="log"></div></aside>
<script>
(function () {
  var data = {};
  var log = document.getElementById('log');
  function line(cls, text) {
    var d = document.createElement('div'); d.className = cls; d.textContent = text;
    log.insertBefore(d, log.firstChild);
  }
  var learner12 = { 'cmi.core.student_id': 'preview-tester', 'cmi.core.student_name': 'Tester, Preview', 'cmi.core.lesson_status': 'not attempted', 'cmi.core.entry': 'ab-initio' };
  var learner2004 = { 'cmi.learner_id': 'preview-tester', 'cmi.learner_name': 'Preview Tester', 'cmi.completion_status': 'unknown', 'cmi.entry': 'ab-initio' };
  function get(k, defaults) { return k in data ? data[k] : (k in defaults ? defaults[k] : ''); }
  function set(k, v) {
    data[k] = String(v); line('set', k + ' = ' + v);
    var m = /^cmi\\.interactions\\.(\\d+)\\./.exec(k);
    if (m) {
      var n = +m[1] + 1, key = k.indexOf('cmi.interactions') === 0 ? 'cmi.interactions._count' : '';
      if (!data[key] || +data[key] < n) data[key] = String(n);
    }
    return 'true';
  }
  window.API = {
    LMSInitialize: function () { line('call', 'LMSInitialize'); return 'true'; },
    LMSFinish: function () { line('call', 'LMSFinish'); return 'true'; },
    LMSGetValue: function (k) { return get(k, learner12); },
    LMSSetValue: set,
    LMSCommit: function () { line('call', 'LMSCommit'); return 'true'; },
    LMSGetLastError: function () { return '0'; },
    LMSGetErrorString: function () { return ''; },
    LMSGetDiagnostic: function () { return ''; }
  };
  window.API_1484_11 = {
    Initialize: function () { line('call', 'Initialize'); return 'true'; },
    Terminate: function () { line('call', 'Terminate'); return 'true'; },
    GetValue: function (k) { return get(k, learner2004); },
    SetValue: set,
    Commit: function () { line('call', 'Commit'); return 'true'; },
    GetLastError: function () { return '0'; },
    GetErrorString: function () { return ''; },
    GetDiagnostic: function () { return ''; }
  };
})();
</script>
</body>
</html>`;
}
