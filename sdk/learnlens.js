/*!
 * LearnLens JavaScript SDK (MIT licence)
 * Track learner behaviour from custom HTML5, Three.js, Babylon.js, Unity WebGL
 * or any browser-based learning content.
 *
 *   const track = LearnLens.init({
 *     endpoint: 'https://your-learnlens-server',
 *     key: 'ck_...',                         // from "Connect a course"
 *     learner: { id: 'lms-user-42', name: 'Priya Nair', team: 'Warehouse' }
 *   });
 *   track.page('intro', 'Introduction');
 *   track.question('q1', { response: 'B', correct: true });
 *   track.decision('check_mirrors', { correct: true });
 *   track.error('missed_hazard', { critical: true });
 *   track.complete({ passed: true, score: 0.82 });
 *
 * Works as a <script> tag (window.LearnLens), CommonJS or via a bundler.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LearnLens = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function init(options) {
    var opts = options || {};
    if (!opts.endpoint || !opts.key) throw new Error('LearnLens.init: endpoint and key are required');
    if (!opts.learner || !opts.learner.id) throw new Error('LearnLens.init: learner.id is required');

    var url = String(opts.endpoint).replace(/\/$/, '') + '/api/ingest?key=' + encodeURIComponent(opts.key);
    var session = opts.session || 'sdk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    var storageKey = 'learnlens_sdk_queue_' + opts.key;
    var queue = [];
    var page = null;
    var sectionPos = 0;
    var flushTimer = null;
    var debug = Boolean(opts.debug);

    try {
      var saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (saved.length) { queue = saved; localStorage.removeItem(storageKey); }
    } catch (e) { /* storage unavailable */ }

    function persist() {
      try { localStorage.setItem(storageKey, JSON.stringify(queue.slice(-1000))); } catch (e) { /* ignore */ }
    }

    function send(useBeacon) {
      if (!queue.length) return Promise.resolve();
      var batch = queue.splice(0, 200);
      var body = JSON.stringify({ events: batch });
      if (debug) console.log('[LearnLens] sending', batch);
      if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        if (!navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) { queue = batch.concat(queue); persist(); }
        return Promise.resolve();
      }
      return fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
        .then(function (res) {
          if (res.status >= 500) throw new Error('server error ' + res.status);
          if (!res.ok && debug) res.text().then(function (t) { console.warn('[LearnLens] rejected:', t); });
        })
        .catch(function (err) {
          if (debug) console.warn('[LearnLens] will retry later:', err.message);
          queue = batch.concat(queue);
          persist();
        });
    }

    function emit(evt) {
      evt.learner = opts.learner;
      evt.session = session;
      evt.ts = new Date().toISOString();
      if (opts.version) evt.version = opts.version;
      queue.push(evt);
      if (queue.length >= 50) send(false);
      else if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; send(false); }, 3000);
    }

    function leavePage() {
      if (!page) return;
      emit({ type: 'page_viewed', objectId: page.id, objectName: page.name, position: page.position, durationMs: Date.now() - page.since });
      page = null;
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', function () { leavePage(); send(true); });
    }

    emit({ type: 'session_started' });

    return {
      /** Learner entered a slide, section or scene. Time on the previous one is recorded. */
      page: function (id, name) {
        leavePage();
        sectionPos += 1;
        page = { id: String(id), name: name || String(id), position: sectionPos, since: Date.now() };
      },
      /** A quiz/assessment answer. */
      question: function (id, d) {
        d = d || {};
        emit({ type: 'question_answered', objectId: String(id), objectName: d.name, response: d.response,
          success: d.correct, durationMs: d.durationMs, correctResponse: d.correctResponse });
      },
      /** A decision in a scenario or simulation. */
      decision: function (id, d) {
        d = d || {};
        emit({ type: 'decision_made', objectId: String(id), objectName: d.name, success: d.correct,
          critical: Boolean(d.critical), durationMs: d.durationMs });
      },
      hint: function (id) { emit({ type: 'hint_used', objectId: id ? String(id) : undefined }); },
      /** A mistake. Mark critical: true for safety or quality-critical errors. */
      error: function (id, d) {
        d = d || {};
        emit({ type: 'error_made', objectId: String(id), objectName: d.name, critical: Boolean(d.critical) });
      },
      /** Score between 0 and 1. */
      score: function (value) { emit({ type: 'score_reported', score: value }); },
      /** Finish the attempt. passed: true/false, or leave out for "completed" only. */
      complete: function (d) {
        d = d || {};
        leavePage();
        if (typeof d.score === 'number') emit({ type: 'score_reported', score: d.score });
        emit({ type: 'course_completed' });
        if (d.passed === true) emit({ type: 'course_passed', score: d.score });
        if (d.passed === false) emit({ type: 'course_failed', score: d.score });
        return send(false);
      },
      /** Send everything queued now. Returns a Promise. */
      flush: function () { return send(false); }
    };
  }

  return { init: init, version: '0.1.0' };
});
