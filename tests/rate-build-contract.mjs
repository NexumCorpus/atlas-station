import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "rate-build.mjs");

const missing = spawnSync(process.execPath, [script, "A-test", "bad"], { cwd: root, encoding: "utf8" });
assert.notEqual(missing.status, 0);
assert.match(missing.stderr, /require both causalChain and notes/);

const opaque = spawnSync(process.execPath, [script, "A-test", "bad", "failure step", "auto-tagged: unknown"], { cwd: root, encoding: "utf8" });
assert.notEqual(opaque.status, 0);
assert.match(opaque.stderr, /cannot use an opaque unknown note/);

console.log("rate-build contract: ALL PASS");
