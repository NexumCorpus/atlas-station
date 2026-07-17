import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preload = fs.readFileSync(path.join(root, "preload.cjs"), "utf8");
const main = fs.readFileSync(path.join(root, "main.cjs"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert.match(preload, /resolveGoal: \(id, outcome\) => ipcRenderer\.send\("resolve-goal"/);
assert.match(main, /ipcMain\.on\("resolve-goal"/);
assert.match(main, /goalStore\.resolveGoal\(p\.id/);
assert.match(main, /source: "operator-ui"/);
assert.match(fs.readFileSync(path.join(root, "goal-store.cjs"), "utf8"), /resolutionSource = String\(metadata\.source/);
assert.match(fs.readFileSync(path.join(root, "fleethost.mjs"), "utf8"), /source: 'atlas-tool'/);
assert.match(main, /g\.state !== "completed" && g\.state !== "done"/);
assert.match(html, /window\.atlas\.resolveGoal\(gid, 'done'\)/);
assert.doesNotMatch(html, /window\.atlas\.say\(['"]Goal completed:/);

console.log("goal resolution contract: ALL PASS");
