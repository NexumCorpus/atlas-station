#!/usr/bin/env node
// population_engine.mjs — MAP-Elites behavioral archive manager for ATLAS Station.
// ESM, no npm dependencies beyond Node.js built-ins.
//
// Behavioral space: 3 axes, 4 bins each → 64 possible cells.
//   planning_depth   (0-3): greedy-reactive → multi-step planner
//   tool_diversity   (0-3): mono-tool → broad multi-tool combiner
//   verification_rate (0-3): accepts first result → cross-validates each claim
//
// Archive rule: each cell holds at most one variant (the highest-scoring occupant).
// Population accumulates behavioral measurements; selectParent() uses fitness-proportional
// sampling so low-performers stay alive (preserving diversity) while high-performers
// are chosen more often for reproduction.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ATLAS_DIR = path.join(__dirname, "..", ".atlas");
const POP_FILE = "population.json";

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/** Load population.json from atlasDir (defaults to .atlas/ next to this script). */
export function loadPopulation(atlasDir = DEFAULT_ATLAS_DIR) {
  const filePath = path.join(atlasDir, POP_FILE);
  if (!fs.existsSync(filePath)) {
    throw new Error(`population.json not found at ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

/** Write population.json atomically (.tmp → rename). */
export function savePopulation(pop, atlasDir = DEFAULT_ATLAS_DIR) {
  pop.lastUpdated = new Date().toISOString();
  const filePath = path.join(atlasDir, POP_FILE);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(pop, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Mean of an object's numeric values; null/missing values → 0. */
function meanScore(performanceScores) {
  const vals = Object.values(performanceScores || {});
  if (!vals.length) return 0;
  const nums = vals.map((v) => v == null ? 0 : typeof v === 'object' ? Number(v.score ?? 0) : Number(v));
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * List variants sorted by mean performance score (best first).
 * Variants with no scores sort last (treated as 0).
 */
export function listVariants(pop) {
  return [...pop.variants].sort(
    (a, b) => meanScore(b.performanceScores) - meanScore(a.performanceScores)
  );
}

// ---------------------------------------------------------------------------
// Core archive operations
// ---------------------------------------------------------------------------

/**
 * Record a behavioral measurement for a variant.
 *
 * @param {object} pop        - The population object (mutated in place).
 * @param {string} variantId  - ID of the variant being measured.
 * @param {string} taskId     - ID of the behavioral task (e.g. "task-001").
 * @param {object} axes       - { planning_depth: 0-3, tool_diversity: 0-3, verification_rate: 0-3 }
 * @param {number} score      - Numeric performance score for this task.
 */
export function recordBehavior(pop, variantId, taskId, axes, score) {
  const variant = pop.variants.find((v) => v.id === variantId);
  if (!variant) throw new Error(`Variant '${variantId}' not found in population`);

  // Update per-axis measurement on this variant.
  variant.behavioralAxes = { ...variant.behavioralAxes, ...axes };

  // Compute behavioral cell key from the variant's full axis state after merge.
  const ax = variant.behavioralAxes;
  const cellKey =
    ax.planning_depth != null &&
    ax.tool_diversity != null &&
    ax.verification_rate != null
      ? `${ax.planning_depth},${ax.tool_diversity},${ax.verification_rate}`
      : null;
  variant.behavioralCell = cellKey;

  // Record task score.
  variant.performanceScores[taskId] = score;

  // Update archive: occupant is the highest-scoring variant per cell.
  if (cellKey) {
    const currentOccupant = pop.archive[cellKey];
    if (!currentOccupant) {
      // Empty cell — claim it.
      pop.archive[cellKey] = variantId;
    } else if (currentOccupant !== variantId) {
      // Compare against current occupant.
      const occupant = pop.variants.find((v) => v.id === currentOccupant);
      const occupantScore = occupant ? meanScore(occupant.performanceScores) : 0;
      const newScore = meanScore(variant.performanceScores);
      if (newScore > occupantScore) {
        pop.archive[cellKey] = variantId;
      }
    }
    // If same variant already occupies this cell, no change needed.
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Fitness-proportional parent selection (roulette wheel).
 * Returns a variant id sampled with probability ∝ mean score.
 * Variants with score 0 receive a small floor (1e-6) so they're never
 * completely excluded — preserving behavioral diversity.
 */
export function selectParent(pop) {
  const active = pop.variants.filter((v) => v.status === "active");
  if (!active.length) throw new Error("No active variants to select from");
  if (active.length === 1) return active[0].id;

  const FLOOR = 1e-6;
  const scores = active.map((v) => Math.max(meanScore(v.performanceScores), FLOOR));
  const total = scores.reduce((a, b) => a + b, 0);
  const probs = scores.map((s) => s / total);

  let r = Math.random();
  for (let i = 0; i < active.length; i++) {
    r -= probs[i];
    if (r <= 0) return active[i].id;
  }
  return active[active.length - 1].id;
}

// ---------------------------------------------------------------------------
// Variant registration
// ---------------------------------------------------------------------------

/**
 * Register a new variant in the population.
 *
 * @param {object} pop       - The population object (mutated in place).
 * @param {string} parentId  - ID of the parent variant (or null for root).
 * @param {string} label     - Human-readable name.
 * @param {string} dialect   - Mutation dialect (e.g. "unrestricted", "tool-constrained").
 * @param {string} branch    - Git branch this variant lives on.
 * @returns {object} The newly created variant.
 */
export function createVariant(pop, parentId, label, dialect, branch) {
  const id = "variant-" + (pop.variants.length + 1);
  const parent = parentId ? pop.variants.find((v) => v.id === parentId) : null;

  const variant = {
    id,
    label,
    generation: parent ? parent.generation + 1 : 0,
    parentId: parentId || null,
    branch,
    mutationDialect: dialect || "unrestricted",
    behavioralCell: null,
    behavioralAxes: { planning_depth: null, tool_diversity: null, verification_rate: null },
    performanceScores: {},
    noveltyScore: null,
    childrenCount: 0,
    status: "active",
    createdAt: new Date().toISOString(),
    notes: "",
  };

  pop.variants.push(variant);
  pop.generation = Math.max(pop.generation, variant.generation);

  // Increment parent's childrenCount.
  if (parent) parent.childrenCount += 1;

  return variant;
}

// ---------------------------------------------------------------------------
// Default export (convenience bundle)
// ---------------------------------------------------------------------------

export default {
  loadPopulation,
  savePopulation,
  listVariants,
  recordBehavior,
  selectParent,
  createVariant,
};

// ---------------------------------------------------------------------------
// CLI: node scripts/population_engine.mjs [list|status]
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] || "list";
  const atlasDir = DEFAULT_ATLAS_DIR;

  try {
    const pop = loadPopulation(atlasDir);

    if (cmd === "list" || cmd === "status") {
      const sorted = listVariants(pop);
      const archiveSize = Object.keys(pop.archive || {}).length;

      console.log(`\nATLAS Population — Generation ${pop.generation}`);
      console.log(`Variants: ${pop.variants.length}  |  Archive cells occupied: ${archiveSize}/64`);
      console.log(`Last updated: ${pop.lastUpdated}\n`);

      // Table header
      const COL = [12, 20, 6, 10, 14, 14, 10];
      const hdrs = ["ID", "Label", "Gen", "Status", "Cell", "Dialect", "MeanScore"];
      console.log(
        hdrs.map((h, i) => h.padEnd(COL[i])).join("  ")
      );
      console.log("-".repeat(COL.reduce((a, b) => a + b, 0) + COL.length * 2));

      for (const v of sorted) {
        const score = meanScore(v.performanceScores);
        const scoreStr = Object.keys(v.performanceScores).length
          ? score.toFixed(3)
          : "(none)";
        const row = [
          v.id,
          v.label,
          String(v.generation),
          v.status,
          v.behavioralCell || "unmeasured",
          v.mutationDialect,
          scoreStr,
        ];
        console.log(row.map((c, i) => String(c).padEnd(COL[i])).join("  "));
      }

      if (archiveSize) {
        console.log(`\nArchive occupants:`);
        for (const [cell, vid] of Object.entries(pop.archive)) {
          console.log(`  [${cell}] → ${vid}`);
        }
      }
      console.log();
    } else {
      console.error(`Unknown command: ${cmd}`);
      console.error("Usage: node scripts/population_engine.mjs [list|status]");
      process.exit(1);
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}
