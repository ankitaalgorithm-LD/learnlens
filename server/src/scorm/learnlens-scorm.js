/*!
 * LearnLens SCORM tracking layer (MIT licence)
 * Injected into a SCORM 1.2 / 2004 package by the LearnLens wrapper.
 *
 * How it works: the course looks for the LMS's SCORM API object (window.API
 * or window.API_1484_11) starting from its own window. We find the real API
 * first, then place a transparent proxy in the course's window. Every call is
 * passed straight through to the LMS, unchanged; we only read what the course
 * reports (pages, answers, scores, status) and send a copy to LearnLens.
 * If LearnLens is unreachable, the course and the LMS keep working normally.
 */
(function () {
  'use strict';
  var cfg = window.LEARNLENS_CONFIG || {};
  if (!cfg.endpoint || !cfg.key) return;

  var QUEUE_KEY = 'learnlens_queue_' + cfg.key;
  var url = cfg.endpoint.replace(/\/$/, '') + '/api/ingest?key=' + encodeURIComponent(cfg.key);
  var queue = [];
  var learner = null;
  var session = 'scorm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var page = null; // { id, since }
  var interactions = {};
  var sentInteractions = {};
  var lastStatus = {};
  var scoreParts = {};

  function findApi(name) {
    var win = window.parent && window.parent !== window ? window.parent : null;
    var hops = 0;
    while (win && hops < 12) {
      try { if (win[name]) return win[name]; } catch (e) { /* cross-origin frame */ }
      if (win.parent === win) break;
      win = win.parent; hops++;
    }
    try {
      var op = window.top && window.top.opener;
      hops = 0;
      while (op && hops < 12) {
        try { if (op[name]) return op[name]; } catch (e2) { break; }
        if (op.parent === op) break;
        op = op.parent; hops++;
      }
    } catch (e3) { /* ignore */ }
    return null;
  }

  // ---------- sending ----------
  function loadSaved() {
    try {
      var saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      if (saved.length) { queue = saved.concat(queue); localStorage.removeItem(QUEUE_KEY); }
    } catch (e) { /* storage blocked */ }
  }
  function save() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-1000))); } catch (e) { /* ignore */ }
  }
  function flush(useBeacon) {
    if (!queue.length) return;
    var batch = queue.splice(0, 200);
    var body = JSON.stringify({ events: batch });
    try {
      if (useBeacon && navigator.sendBeacon) {
        var ok = navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
        if (!ok) { queue = batch.concat(queue); save(); }
        return;
      }
      if (window.fetch) {
        fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
          .then(function (r) { if (!r.ok && r.status >= 500) throw new Error(r.status); })
          ['catch'](function () { queue = batch.concat(queue); save(); });
      }
    } catch (e) { queue = batch.concat(queue); save(); }
  }
  function emit(evt) {
    if (!learner) return;
    evt.learner = learner;
    evt.session = session;
    evt.ts = new Date().toISOString();
    if (cfg.version) evt.version = cfg.version;
    queue.push(evt);
    if (queue.length >= 50) flush(false);
  }

  // ---------- SCORM value parsing ----------
  function parseTime12(v) { // HH:MM:SS(.ss)
    var m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(v || ''));
    return m ? Math.round(((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000) : null;
  }
  function parseIso(v) {
    var m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(v || ''));
    if (!m) return null;
    return Math.round((((+(m[1] || 0)) * 24 + +(m[2] || 0)) * 60 + +(m[3] || 0)) * 60000 + +(m[4] || 0) * 1000);
  }

  function leavePage() {
    if (page) {
      emit({ type: 'page_viewed', objectId: page.id, durationMs: Date.now() - page.since });
      page = null;
    }
  }
  function enterPage(id) {
    if (!id || (page && page.id === id)) return;
    leavePage();
    page = { id: String(id), since: Date.now() };
  }

  function flushInteractions() {
    for (var n in interactions) {
      if (!interactions.hasOwnProperty(n) || sentInteractions[n]) continue;
      var it = interactions[n];
      if (!it.id || it.result === undefined) continue;
      var r = String(it.result).toLowerCase();
      var success = r === 'correct' ? true : (r === 'wrong' || r === 'incorrect') ? false : (isFinite(r) ? +r > 0 : null);
      emit({
        type: 'question_answered', objectId: it.id, objectName: it.description || it.id,
        response: it.response, success: success, durationMs: it.latency, correctResponse: it.correct
      });
      sentInteractions[n] = true;
    }
  }

  function reportScore() {
    var s = null;
    if (scoreParts.scaled !== undefined && scoreParts.scaled !== '') s = +scoreParts.scaled;
    else if (scoreParts.raw !== undefined && scoreParts.raw !== '') {
      var max = scoreParts.max !== undefined && scoreParts.max !== '' ? +scoreParts.max : 100;
      var min = scoreParts.min !== undefined && scoreParts.min !== '' ? +scoreParts.min : 0;
      s = max > min ? (+scoreParts.raw - min) / (max - min) : null;
    }
    if (s !== null && isFinite(s) && s !== scoreParts.lastSent) {
      emit({ type: 'score_reported', score: s });
      scoreParts.lastSent = s;
    }
    return s;
  }

  function status(kind, value) {
    value = String(value || '').toLowerCase();
    if (lastStatus[kind] === value) return;
    lastStatus[kind] = value;
    var s = reportScore();
    if (value === 'passed') emit({ type: 'course_passed', score: s });
    else if (value === 'failed') emit({ type: 'course_failed', score: s });
    else if (value === 'completed') emit({ type: 'course_completed' });
  }

  function onSet(key, value) {
    var m;
    if (key === 'cmi.core.lesson_location' || key === 'cmi.location') return enterPage(value);
    if (key === 'cmi.core.lesson_status') return status('lesson', value);
    if (key === 'cmi.completion_status') return status('completion', value);
    if (key === 'cmi.success_status') return status('success', value);
    if ((m = /^cmi\.(?:core\.)?score\.(raw|min|max|scaled)$/.exec(key))) { scoreParts[m[1]] = value; return; }
    if ((m = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(key))) {
      var it = interactions[m[1]] || (interactions[m[1]] = {});
      var field = m[2];
      if (field === 'id') it.id = value;
      else if (field === 'student_response' || field === 'learner_response') it.response = value;
      else if (field === 'result') { it.result = value; setTimeout(flushInteractions, 0); }
      else if (field === 'latency') it.latency = parseTime12(value) !== null ? parseTime12(value) : parseIso(value);
      else if (field === 'description') it.description = value;
      else if (field === 'correct_responses.0.pattern') it.correct = value;
    }
  }

  function start(api, is2004) {
    try {
      var id = is2004 ? api.GetValue('cmi.learner_id') : api.LMSGetValue('cmi.core.student_id');
      var name = is2004 ? api.GetValue('cmi.learner_name') : api.LMSGetValue('cmi.core.student_name');
      if (!id) id = 'anonymous-' + session;
      learner = { id: String(id) };
      if (cfg.sendNames && name) learner.name = String(name);
      loadSaved();
      emit({ type: 'session_started' });
      var loc = is2004 ? api.GetValue('cmi.location') : api.LMSGetValue('cmi.core.lesson_location');
      if (loc) enterPage(loc);
    } catch (e) { /* never break the course */ }
  }

  function wrap(api, is2004) {
    var p = {};
    var names = is2004
      ? ['Initialize', 'Terminate', 'GetValue', 'SetValue', 'Commit', 'GetLastError', 'GetErrorString', 'GetDiagnostic']
      : ['LMSInitialize', 'LMSFinish', 'LMSGetValue', 'LMSSetValue', 'LMSCommit', 'LMSGetLastError', 'LMSGetErrorString', 'LMSGetDiagnostic'];
    names.forEach(function (n) {
      p[n] = function () {
        var result = api[n].apply(api, arguments);
        try {
          if (n === 'Initialize' || n === 'LMSInitialize') start(api, is2004);
          else if (n === 'SetValue' || n === 'LMSSetValue') onSet(String(arguments[0]), arguments[1]);
          else if (n === 'Commit' || n === 'LMSCommit') { flushInteractions(); reportScore(); flush(false); }
          else if (n === 'Terminate' || n === 'LMSFinish') { flushInteractions(); reportScore(); leavePage(); flush(true); }
        } catch (e) { /* never break the course */ }
        return result;
      };
    });
    return p;
  }

  var api12 = findApi('API');
  var api2004 = findApi('API_1484_11');
  if (api2004) window.API_1484_11 = wrap(api2004, true);
  if (api12) window.API = wrap(api12, false);

  setInterval(function () { flush(false); }, 5000);
  window.addEventListener('pagehide', function () { flushInteractions(); leavePage(); flush(true); });
})();
