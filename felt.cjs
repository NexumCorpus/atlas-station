// felt.cjs — the station's felt feed. Polls the director2 wing's REAL persisted
// self-state ({op:"felt"} → "felt-state" events) and mirrors each project's
// narrative into FELT.json at repo root, the STIGMA.json idiom: a versioned
// JSON document, atomic write via tmp + rename, bounded history.
//
// Diagnoses-only ethos: narratives/trajectories cross the seam VERBATIM; raw
// valence floats never do (they are filtered wing-side, in d2-wing.py).
// Nervous-off is recorded plainly, not papered over.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startWing } = require("./wing-host.cjs");

const FELT_PATH = path.join(__dirname, "FELT.json");
const MAX_ENTRIES = 200;

function appendFelt(ev) {
  let felt;
  try {
    felt = JSON.parse(fs.readFileSync(FELT_PATH, "utf8"));
    if (!felt || typeof felt !== "object" || felt.version == null) throw new Error("invalid structure");
  } catch (_) {
    felt = { version: 1, updated: null, nervous: null, entries: [] };
  }
  const now = new Date().toISOString();
  felt.updated = now;
  felt.nervous = ev.nervous === true; // stated plainly, even when off
  for (const p of ev.projects || []) {
    felt.entries.push({
      ts: now,
      project: p.id,
      trajectory: p.trajectory,
      duration_cycles: p.duration_cycles,
      narrative: p.narrative, // verbatim — no paraphrase, no invention
    });
  }
  felt.entries = felt.entries.slice(-MAX_ENTRIES);
  fs.writeFileSync(FELT_PATH + ".tmp", JSON.stringify(felt, null, 2), "utf8");
  fs.renameSync(FELT_PATH + ".tmp", FELT_PATH);
}

/**
 * Start the felt feed: boot the director2 wing, ask it for felt-state on an
 * interval, and mirror every answer into FELT.json. Requires DIRECTOR_HOME in
 * the environment (the wing inherits it); DIRECTOR_NERVOUS_ENABLED sets the
 * nervous flag. Returns { wing, stop }.
 */
function startFeltFeed({ intervalMs = 60000 } = {}) {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), "felt-spool-"));
  const wing = startWing(path.join(__dirname, "wings", "director2", "wing.json"), {
    spoolDir: spool,
    onEvent: (e) => {
      if (e && e.t === "felt-state") {
        try { appendFelt(e); } catch (_) { /* feed must never crash the station */ }
      }
    },
  });
  wing.send({ op: "felt" }); // first reading immediately, then on the interval
  const timer = setInterval(() => wing.send({ op: "felt" }), intervalMs);
  return {
    wing,
    stop() {
      clearInterval(timer);
      try { wing.send({ op: "stop" }); } catch (_) {}
      setTimeout(() => { try { wing.stop(); } catch (_) {} }, 500).unref?.();
    },
  };
}

module.exports = { startFeltFeed, FELT_PATH };
