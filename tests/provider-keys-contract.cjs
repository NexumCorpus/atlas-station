'use strict';
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const keys = require("../provider-keys.cjs");

const T0 = "2026-08-22T12:00:00Z";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "key-sentinel-"));
try {
  // 1. Register with raw value -> only the fingerprint persists.
  const rec = keys.registerKey({ label: "test-key", provider: "openrouter", expiresAt: "2026-08-25T00:00:00Z", warnDays: 3, value: "sk-super-secret-value" }, tmp);
  assert.ok(rec.fingerprint && rec.fingerprint.length === 16);
  const rawFile = fs.readFileSync(path.join(tmp, "provider-keys.json"), "utf8");
  assert.ok(!rawFile.includes("sk-super-secret-value"), "raw credential must NEVER persist");

  // 2. Three states across three registered keys at one fixed clock.
  keys.registerKey({ label: "fresh", provider: "p2", expiresAt: "2026-09-30T00:00:00Z", value: "sk-fresh-value" }, tmp);
  keys.registerKey({ label: "dead", provider: "p3", expiresAt: "2026-08-20T00:00:00Z", value: "sk-dead-value" }, tmp);
  keys.registerKey({ label: "dateless", provider: "p4", value: "sk-dateless-value" }, tmp);
  keys.registerKey({ label: "corrupt", provider: "p5", expiresAt: "not-a-date", value: "sk-corrupt-value" }, tmp);
  const s = keys.status(T0, tmp);
  const byLabel = Object.fromEntries(s.map((k) => [k.label, k]));
  assert.equal(byLabel["test-key"].state, "expiring", "3 days out with warnDays=3 is expiring");
  assert.equal(byLabel["test-key"].daysLeft, 2.5, "one-decimal day precision");
  assert.equal(byLabel["fresh"].state, "valid");
  assert.equal(byLabel["dead"].state, "expired");
  assert.equal(byLabel["dateless"].state, "unknown");
  assert.equal(byLabel["corrupt"].state, "invalid-record");

  // 3. check() returns only actionable records.
  const bad = keys.check(T0, tmp);
  const labels = bad.map((k) => k.label).sort();
  assert.deepEqual(labels, ["corrupt", "dead", "test-key"]);

  // 4. Re-register same value updates in place (no duplicate rows).
  keys.registerKey({ label: "test-key-rotated", provider: "openrouter", expiresAt: "2026-09-15T00:00:00Z", value: "sk-super-secret-value" }, tmp);
  const s2 = keys.status(T0, tmp);
  const testRows = s2.filter((k) => k.fingerprint === rec.fingerprint);
  assert.equal(testRows.length, 1, "same fingerprint updates in place");
  assert.equal(testRows[0].state, "valid", "rotated expiry clears the alert");

  // 5. Invalid clock input throws rather than silently misjudging.
  assert.throws(() => keys.status("garbage-clock", tmp), /invalid clock/);

  console.log("provider-keys contract: ALL PASS");
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}