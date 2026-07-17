import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { measureVariant } from "../scripts/measure_variant.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-measure-"));
const atlasDir = path.join(temp, ".atlas");
const taskDir = path.join(atlasDir, "behavioral_suite");
fs.mkdirSync(taskDir, { recursive: true });
for (const id of ["001", "002", "003"]) {
  const axis = { "001": "planning_depth", "002": "tool_diversity", "003": "verification_rate" }[id];
  fs.writeFileSync(path.join(taskDir, `task-${id}.json`), JSON.stringify({ id: `task-${id}`, axis }));
}
fs.writeFileSync(path.join(atlasDir, "population.json"), JSON.stringify({
  version: 1,
  generation: 0,
  variants: [{
    id: "variant-B",
    behavioralAxes: { planning_depth: null, tool_diversity: null, verification_rate: null },
    behavioralCell: null,
    performanceScores: {},
    status: "active",
  }],
  archive: {},
}));

const result = measureVariant({
  variantId: "variant-B",
  atlasDir,
  taskDir,
  measurements: [
    { taskId: "task-001", score: 1, notes: "multi-step trace was incomplete" },
    { taskId: "task-002", score: 1, notes: "used only memory tools" },
    { taskId: "task-003", score: 2, notes: "performed structured recall checks" },
  ],
  source: "test-observation",
  runId: "run-api-test-001",
});

assert.equal(result.behavioralCell, "1,1,2");
const saved = JSON.parse(fs.readFileSync(path.join(atlasDir, "population.json"), "utf8"));
const variant = saved.variants[0];
assert.equal(variant.performanceScores["task-001"].score, 1);
assert.equal(variant.performanceScores["task-003"].notes, "performed structured recall checks");
assert.equal(variant.performanceScores["task-001"].source, "test-observation");
assert.equal(variant.performanceScores["task-001"].runId, "run-api-test-001");
assert.equal(saved.archive["1,1,2"], "variant-B");

const cliInput = path.join(temp, "cli-measurement.json");
fs.writeFileSync(cliInput, JSON.stringify({
  source: "cli-test-observation",
  runId: "run-cli-test-001",
  measurements: [
    { taskId: "task-001", score: 1, notes: "cli trace" },
    { taskId: "task-002", score: 1, notes: "cli tools" },
    { taskId: "task-003", score: 2, notes: "cli checks" },
  ],
}));
const cli = spawnSync(process.execPath, [
  path.join(root, "scripts", "measure_variant.mjs"),
  "variant-B",
  cliInput,
  atlasDir,
], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
const cliSaved = JSON.parse(fs.readFileSync(path.join(atlasDir, "population.json"), "utf8"));
assert.equal(cliSaved.variants[0].performanceScores["task-001"].source, "cli-test-observation");
assert.equal(cliSaved.variants[0].performanceScores["task-001"].runId, "run-cli-test-001");

assert.throws(
  () => measureVariant({ variantId: "variant-B", atlasDir, taskDir, measurements: [] }),
  /exactly 3 measurements are required/,
);

assert.throws(
  () => measureVariant({
    variantId: "variant-B",
    atlasDir,
    taskDir,
    measurements: [
      { taskId: "task-001", score: 1, notes: "trace" },
      { taskId: "task-002", score: 1, notes: "tools" },
      { taskId: "task-003", score: 2, notes: "checks" },
    ],
    source: "missing-run-id",
  }),
  /runId is required/,
);

console.log("population measurement: ALL PASS");
