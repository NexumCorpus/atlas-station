'use strict';
// Provider credential expiry sentinel. Stores ONLY fingerprints and dates -
// never the credentials themselves. The registry lives in gitignored memory/
// beside the runtime state, so it never enters version control.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FILE = "provider-keys.json";
const DEFAULT_WARN_DAYS = 3;

function _load(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
  } catch { return { keys: [] }; }
}

function _save(reg, dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, FILE);
  fs.writeFileSync(fp + ".tmp", JSON.stringify(reg, null, 2), "utf8");
  fs.renameSync(fp + ".tmp", fp);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function registerKey(entry, dir) {
  dir = dir || path.join(__dirname, "memory");
  const reg = _load(dir);
  const clean = { ...entry };
  const value = clean.value;
  delete clean.value;
  const fp = clean.fingerprint || (value ? fingerprint(value) : null);
  if (!fp) throw new Error("registerKey: needs fingerprint or value");
  const prior = reg.keys.find((k) => k.fingerprint === fp);
  if (prior) {
    Object.assign(prior, clean, { fingerprint: fp });
    _save(reg, dir);
    return prior;
  }
  const record = { id: 'PK-' + Date.now(), ts: new Date().toISOString(), fingerprint: fp, ...clean };
  reg.keys.push(record);
  _save(reg, dir);
  return record;
}

function status(now, dir) {
  dir = dir || path.join(__dirname, "memory");
  const ms = now == null ? Date.now() : new Date(now).getTime();
  if (Number.isNaN(ms)) throw new Error("status: invalid clock input");
  const reg = _load(dir);
  return reg.keys.map((k) => {
    if (!k.expiresAt) return { ...k, state: "unknown", daysLeft: null };
    const exp = new Date(k.expiresAt).getTime();
    if (Number.isNaN(exp)) return { ...k, state: "invalid-record", daysLeft: null };
    const daysLeft = Math.round(((exp - ms) / 86400000) * 10) / 10;
    const warnDays = typeof k.warnDays === "number" ? k.warnDays : DEFAULT_WARN_DAYS;
    let state = "valid";
    if (exp <= ms) state = "expired";
    else if (daysLeft <= warnDays) state = "expiring";
    return { ...k, state, daysLeft };
  });
}

function check(now, dir) {
  return status(now, dir).filter((k) => k.state !== "valid" && k.state !== "unknown");
}

module.exports = { registerKey, status, check, fingerprint, DEFAULT_WARN_DAYS };