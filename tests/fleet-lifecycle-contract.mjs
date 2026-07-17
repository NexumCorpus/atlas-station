import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = fs.readFileSync(path.join(root, "main.cjs"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert.match(main, /let fleetGeneration = 0/);
assert.match(main, /type: "fleet_lifecycle", state: "started"/);
assert.match(main, /generation, pid: fleet\.pid, startedAt/);
assert.match(main, /type: "fleet_lifecycle", state: "exited"/);
assert.match(main, /type: "fleet_lifecycle", state: "failed"/);
assert.match(main, /if \(!fleet\) startFleet\(\)/);
assert.match(html, /m\.type===\"fleet_lifecycle\"/);
assert.match(html, /fleet sidecar started/);
assert.match(html, /fleet sidecar exited/);
assert.match(html, /fleet sidecar start failed/);

console.log("fleet lifecycle contract: ALL PASS");
