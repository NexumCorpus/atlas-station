#!/usr/bin/env node
// Formal measurement runner for the MAP-Elites behavioral suite.
// It does not score model output itself: a caller supplies the observed
// scores and evidence notes, and this runner validates and records them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPopulation,
  savePopulation,
  recordBehavior,
} from "./population_engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TASK_DIR = path.join(ROOT, ".atlas", "behavioral_suite");

export function loadTasks(taskDir = DEFAULT_TASK_DIR) {
  return fs.readdirSync(taskDir)
    .filter((name) => /^task-\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(taskDir, name), "utf8")));
}

function assertMeasurement(measurement, task) {
  if (!measurement || measurement.taskId !== task.id) {
    throw new Error(`measurement taskId must be ${task.id}`);
  }
  if (!Number.isInteger(measurement.score) || measurement.score < 0 || measurement.score > 3) {
    throw new Error(`${task.id}: score must be an integer from 0 to 3`);
  }
  if (typeof measurement.notes !== "string" || !measurement.notes.trim()) {
    throw new Error(`${task.id}: notes are required evidence for the observed score`);
  }
}

/**
 * Record one complete, independently observed run of the canonical suite.
 * `measurements` must contain exactly one scored observation per task.
 */
export function measureVariant({ variantId, measurements, atlasDir, taskDir = DEFAULT_TASK_DIR, source = "manual-observation" }) {
  if (!variantId) throw new Error("variantId is required");
  if (!Array.isArray(measurements)) throw new Error("measurements must be an array");

  const tasks = loadTasks(taskDir);
  const byId = new Map(measurements.map((m) => [m?.taskId, m]));
  if (byId.size !== measurements.length) throw new Error("duplicate taskId in measurements");
  if (measurements.length !== tasks.length) {
    throw new Error(`exactly ${tasks.length} measurements are required`);
  }

  const pop = loadPopulation(atlasDir);
  const variant = pop.variants.find((v) => v.id === variantId);
  if (!variant) throw new Error(`Variant '${variantId}' not found in population`);
  const measuredAt = new Date().toISOString();

  for (const task of tasks) {
    const measurement = byId.get(task.id);
    assertMeasurement(measurement, task);
    recordBehavior(pop, variantId, task.id, { [task.axis]: measurement.score }, {
      score: measurement.score,
      axis: task.axis,
      measuredAt,
      notes: measurement.notes.trim(),
      source,
    });
  }

  savePopulation(pop, atlasDir);
  return {
    variantId,
    measuredAt,
    tasks: tasks.map((task) => ({
      taskId: task.id,
      axis: task.axis,
      score: byId.get(task.id).score,
    })),
    behavioralCell: pop.variants.find((v) => v.id === variantId).behavioralCell,
  };
}

function usage() {
  console.error("Usage: node scripts/measure_variant.mjs <variant-id> <measurements.json> [atlas-dir]");
  console.error('measurements.json: {"measurements":[{"taskId":"task-001","score":1,"notes":"..."}, ...]}');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , variantId, inputFile, atlasDir = path.join(ROOT, ".atlas")] = process.argv;
  if (!variantId || !inputFile) {
    usage();
    process.exit(1);
  }
  try {
    const input = JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf8"));
    const result = measureVariant({ variantId, measurements: input.measurements, atlasDir });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Measurement rejected: ${error.message}`);
    process.exit(1);
  }
}
