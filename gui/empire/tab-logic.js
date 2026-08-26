/* Hermes Empire tab logic - plain browser JS, no frameworks.
   Dark theme: bg transparent, text #d8deec, accents #9d6bff / #49ff9e / #22e1ff, 11px. */
(function () {
  'use strict';
  var ORGANS = ['crystal', 'shard', 'deferral', 'decision', 'continuity', 'xenosoma', 'dream', 'tap'];
  var MAX_WORKER_ROWS = 8;
  var COL = { text: '#d8deec', purple: '#9d6bff', green: '#49ff9e', cyan: '#22e1ff', dim: '#6a7185', red: '#ff5566' };
  var workerRows = [];
  var countSpans = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  window.empireInit = function () {
    var organs = document.getElementById('empire-organs');
    if (!organs) return;
    organs.innerHTML = '';
    countSpans = {};
    for (var i = 0; i < ORGANS.length; i++) {
      var name = ORGANS[i];
      var dot = document.createElement('span');
      dot.className = 'organ-dot';
      dot.setAttribute('data-organ', name);
      dot.style.cssText =
        'background:transparent;color:' + COL.text + ';font-size:11px;' +
        'border:1px solid #2a2f3e;border-radius:3px;padding:1px 5px;' +
        'display:inline-block;transition:background 0.35s;';
      var label = document.createElement('span');
      label.textContent = name;
      label.style.color = COL.purple;
      var count = document.createElement('span');
      count.textContent = '0';
      count.style.color = COL.cyan;
      count.style.marginLeft = '4px';
      dot.appendChild(label);
      dot.appendChild(count);
      organs.appendChild(dot);
      countSpans[name] = count;
    }
    workerRows = [];
    renderWorkers();
    var hdr = document.getElementById('empire-header');
    if (hdr && !document.getElementById('empire-activity')) {
      var t = document.createElement('div');
      t.id = 'empire-activity';
      t.style.cssText = 'color:#6a7185;font-size:11px;margin-top:3px;';
      hdr.appendChild(t);
      setInterval(function () {
        var newest = 0;
        for (var i = 0; i < workerRows.length; i++) if (workerRows[i].ts > newest) newest = workerRows[i].ts;
        t.textContent = newest ? 'last activity: ' + Math.max(0, Math.round((Date.now() - newest) / 1000)) + 's ago' : 'last activity: -';
      }, 1000);
    }
  };

  function renderWorkers() {
    var box = document.getElementById('empire-workers');
    if (!box) return;
    var html = '';
    for (var i = 0; i < workerRows.length; i++) {
      var r = workerRows[i]; // newest first
      var stateCol = r.state === 'success' ? COL.green : (r.state === 'failed' ? COL.red : COL.dim);
      var glowCss = r.state === 'failed' ? ';box-shadow:-2px 0 0 0 #ff5566, inset 3px 0 6px -3px rgba(255,85,102,.8);border-left:2px solid #ff5566;' : (r.state === 'success' ? ';box-shadow:-2px 0 0 0 rgba(73,255,158,.35);border-left:2px solid rgba(73,255,158,.35);' : '');
      html +=
        '<div data-worker-row style="background:transparent;color:' + COL.text + ';font-size:11px;padding:1px 0;border-bottom:1px dotted #22263a;' + glowCss + '">' +
        '<span style="color:' + COL.text + ';">' + esc(r.id) + '</span>' +
        '<span style="color:' + COL.dim + ';"> &#8594; </span>' +
        '<span style="color:' + COL.cyan + ';">' + esc(r.route) + '</span>' +
        '<span style="color:' + COL.dim + '"> | </span>' +
        '<span style="color:' + stateCol + ';">' + esc(r.state) + '</span>' +
        '<span style="color:' + COL.dim + ';"> ' + Number(r.ms) + 'ms</span>' +
        '</div>';
    }
    box.innerHTML = html;
  }

  window.empireUpdate = function (m) {
    if (!m || !m.type) return;

    if (m.type === 'tap') {
      // newest first, hard cap of 8 rows
      workerRows.unshift({ id: m.agentId, route: m.route, state: m.state, ms: m.ms, ts: Date.now() });
      if (workerRows.length > MAX_WORKER_ROWS) workerRows.length = MAX_WORKER_ROWS;
      renderWorkers();
      return;
    }

    // organ event: bump matching dot counter and flash it
    var dot = document.querySelector('.organ-dot[data-organ="' + esc(m.type) + '"]');
    var count = countSpans[m.type];
    if (count && dot) {
      count.textContent = String((parseInt(count.textContent, 10) || 0) + 1);
      if (count.className.indexOf('live') < 0) count.className += ' live';
      dot.style.background = COL.purple;
      setTimeout(function () { dot.style.background = 'transparent'; }, 350);
    }
  };
})();
