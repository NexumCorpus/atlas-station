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

module.exports = { save, load };

// --- self-test: `node persist.cjs` round-trips a sample state and verifies it.
if (require.main === module) {
  const assert = require("assert");
  const os = require("os");

  // Write to a temp file OUTSIDE the repo so the test never leaves a stray
  // fleet-state.json in the working tree.
  const testPath = path.join(os.tmpdir(), `atlas-persist-selftest-${process.pid}.json`);

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

  let ok = false;
  let failure = null;
  try {
    save(sample, testPath);

    const loaded = load(testPath);
    assert.deepStrictEqual(loaded, sample, "round-tripped state should deep-equal the original");

    // load() of a missing file must return null, not throw.
    fs.rmSync(testPath, { force: true });
    assert.strictEqual(load(testPath), null, "load() of a missing file should return null");

    ok = true;
  } catch (err) {
    failure = err;
  } finally {
    fs.rmSync(testPath, { force: true }); // clean up regardless of outcome
  }

  if (ok) {
    console.log("PASS");
    process.exit(0);
  } else {
    console.error(`FAIL: ${failure ? failure.message : "unknown error"}`);
    process.exit(1);
  }
}
