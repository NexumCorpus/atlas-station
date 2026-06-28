// ATLAS // station — fleet-state persistence. Saves and restores the engine's
// per-agent snapshot across restarts so the oversight surface resumes where it
// left off instead of cold-starting. Writes are atomic (temp file + rename) so
// a crash mid-save can never leave a half-written, unparseable state file.
const fs = require("fs");
const path = require("path");

// Default store lives beside this module so the path is stable regardless of
// the process's working directory.
const DEFAULT_PATH = path.join(__dirname, "fleet-state.json");

// save(state, filePath) — serialize `state` to JSON and write it atomically.
// Strategy: write to a uniquely-named temp file in the SAME directory as the
// target (so the final rename stays on one filesystem and is therefore atomic),
// then rename it over the target. Returns the path written.
function save(state, filePath = DEFAULT_PATH) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const json = JSON.stringify(state, null, 2);

  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, json, "utf8");
    fs.fsyncSync(fd); // flush to disk before the rename so the bytes survive a crash
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmp, filePath);
  return filePath;
}

// load(filePath) — read and parse the persisted state. Returns the parsed
// object, or null if the file does not exist yet (a fresh fleet). Any other
// error (corrupt JSON, permissions) is thrown so it isn't silently swallowed.
function load(filePath = DEFAULT_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw);
}

// Fleet-agents store — persists the live brood so a window restart can
// repopulate it.  Stored as { version:1, agents:[...] } in the same dir.
const FLEET_AGENTS_PATH = path.join(__dirname, "fleet-agents.json");

// saveAgents(arr, filePath?) — atomically write the agents array to disk.
function saveAgents(arr, filePath = FLEET_AGENTS_PATH) {
  save({ version: 1, savedAt: new Date().toISOString(), agents: arr }, filePath);
}

// loadAgents(filePath?) — return the persisted agents array, or [] on miss.
function loadAgents(filePath = FLEET_AGENTS_PATH) {
  const state = load(filePath);
  if (!state) return [];
  return Array.isArray(state.agents) ? state.agents : [];
}

module.exports = { save, load, saveAgents, loadAgents };

// --- self-test: `node persist.cjs` round-trips a sample state and verifies it.
if (require.main === module) {
  const assert = require("assert");
  const os = require("os");

  // Write to temp files OUTSIDE the repo so the test never leaves stray files.
  const testPath = path.join(os.tmpdir(), `atlas-persist-selftest-${process.pid}.json`);
  const agentsPath = path.join(os.tmpdir(), `atlas-persist-agents-${process.pid}.json`);

  const sample = {
    version: 1,
    updatedAt: "2026-06-27T10:08:00.000Z",
    agents: [
      { id: "A-1", task: "review diff", status: "running", cwd: "E:\\repo", pct: 0.42 },
      { id: "A-2", task: "write tests", status: "idle", cwd: "E:\\other", pct: 0 },
    ],
    counter: 2,
    config: { maxConcurrent: 8, nested: { a: [1, 2, 3], b: null, c: true } },
  };

  // Sample agent records that mirror what fleethost persists.
  const sampleAgents = [
    { id: "A-3", task: "summarize repo", mode: "read", cwd: "E:\\atlas-station", state: "done",
      summary: "done", reply: "looks good", cost: 0.01, branch: null, session: "sess-abc", ts: "2026-01-01T00:00:00.000Z" },
    { id: "B-2", task: "add tests", mode: "build", cwd: "E:\\atlas-wt\\B-2", state: "working",
      summary: "running", reply: "", cost: null, branch: "fleet/B-2", session: "sess-xyz", ts: "2026-01-01T00:01:00.000Z" },
  ];

  let ok = false;
  let failure = null;
  try {
    // --- Test 1: generic save/load round-trip ---
    save(sample, testPath);
    const loaded = load(testPath);
    assert.deepStrictEqual(loaded, sample, "round-tripped state should deep-equal the original");

    // load() of a missing file must return null, not throw.
    fs.rmSync(testPath, { force: true });
    assert.strictEqual(load(testPath), null, "load() of a missing file should return null");

    // --- Test 2: saveAgents/loadAgents round-trip ---
    saveAgents(sampleAgents, agentsPath);
    const loadedAgents = loadAgents(agentsPath);
    assert.deepStrictEqual(loadedAgents, sampleAgents, "agents round-trip should deep-equal original");

    // loadAgents() of a missing file must return [], not throw.
    fs.rmSync(agentsPath, { force: true });
    const empty = loadAgents(agentsPath);
    assert.ok(Array.isArray(empty) && empty.length === 0, "loadAgents() of missing file should return []");

    ok = true;
  } catch (err) {
    failure = err;
  } finally {
    fs.rmSync(testPath, { force: true });
    fs.rmSync(agentsPath, { force: true });
  }

  if (ok) {
    console.log("PASS");
    process.exit(0);
  } else {
    console.error(`FAIL: ${failure ? failure.message : "unknown error"}`);
    process.exit(1);
  }
}
