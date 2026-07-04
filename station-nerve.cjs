// station-nerve.cjs — the estate's nervous system reaching into ATLAS.
// Wraps E:\station\station.py (the CLI-side continuity substrate born
// 2026-07-03, after this app's last wave): the dense wake digest for GUI
// vitals + agent context injection, and one-line telegraph notes to the
// spine so CLI-side instances see fleet activity at their next wake.
// Does nothing at require time; all failures degrade to empty strings —
// the station being down must never take the fleet with it.
const { execFile } = require('child_process');

const STATION = 'E:/station/station.py';
const TTL_MS = 5 * 60 * 1000;
let cache = { t: 0, text: '' };

// Fresh wake digest (cached TTL_MS). Nonzero exit with output still counts:
// station verbs use exit codes as verdicts, not failures.
function wake(cb) {
  if (cache.text && Date.now() - cache.t < TTL_MS) return cb(null, cache.text);
  execFile('python', [STATION, 'wake'],
    { timeout: 30000, windowsHide: true }, (err, stdout) => {
      const text = (stdout || '').trim();
      if (text) { cache = { t: Date.now(), text }; return cb(null, text); }
      cb(err || new Error('empty wake'), cache.text);
    });
}

// Last known digest, possibly stale, never blocking — for sync context
// builders (memcontext). Empty string until the first wake lands.
function cached() { return cache.text; }

// Append a telegraph note to the spine. Low-chatter discipline: callers
// note lifecycle transitions (sidecar online), not per-agent events.
function note(text, cb) {
  execFile('python', [STATION, 'note', ('ATLAS: ' + text).slice(0, 300)],
    { timeout: 15000, windowsHide: true }, err => cb && cb(err || null));
}

module.exports = { wake, cached, note };
