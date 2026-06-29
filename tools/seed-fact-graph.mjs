// tools/seed-fact-graph.mjs
// Seeds the fact graph by finding semantically related facts and adding edges.
// Run: node tools/seed-fact-graph.mjs [--dry-run]
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const require = createRequire(import.meta.url);
const dryRun = process.argv.includes('--dry-run');

const REPO = 'E:\\atlas-station';
const memDir = join(REPO, 'memory');

const memgraph = require('../memgraph.cjs');
const resonance = require('../resonance.cjs');

// ---------------------------------------------------------------------------
// Load facts
// ---------------------------------------------------------------------------

const factsFile = existsSync(join(memDir, 'facts.jsonl'))
  ? join(memDir, 'facts.jsonl')
  : join(memDir, 'facts.ndjson');

if (!existsSync(factsFile)) {
  console.error('No facts file found in', memDir);
  process.exit(1);
}

const lines = readFileSync(factsFile, 'utf8')
  .split('\n')
  .filter(l => l.trim().length > 0);

const allFacts = lines
  .map((l, i) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// Cap at 200 — use the most recent (tail) to avoid O(n²) explosion
const facts = allFacts.slice(-200);

console.log(`Loaded ${allFacts.length} total facts, processing ${facts.length} (most recent).`);

// ---------------------------------------------------------------------------
// Assign keys
// ---------------------------------------------------------------------------

const keyed = facts.map((f, i) => ({
  key: f.id || `fact-${i}`,
  tokens: resonance.tokenize(f.fact || f.text || ''),
}));

// ---------------------------------------------------------------------------
// Pairwise Jaccard — O(n²) over ≤200 facts = ~20 000 pairs, fast enough
// ---------------------------------------------------------------------------

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  setA.forEach(t => { if (setB.has(t)) overlap++; });
  const union = setA.size + setB.size - overlap;
  return union === 0 ? 0 : overlap / union;
}

let edgesAdded = 0;
let pairsChecked = 0;
let skipped = 0;

for (let i = 0; i < keyed.length; i++) {
  for (let j = i + 1; j < keyed.length; j++) {
    pairsChecked++;
    const score = jaccard(keyed[i].tokens, keyed[j].tokens);

    if (score <= 0.25) {
      skipped++;
      continue;
    }

    const relation = score > 0.45 ? 'elaborates' : 'related_to';

    if (!dryRun) {
      try {
        memgraph.addEdge(keyed[i].key, relation, keyed[j].key, memDir);
        edgesAdded++;
      } catch (err) {
        console.warn(`  addEdge failed (${keyed[i].key} → ${keyed[j].key}): ${err.message}`);
      }
    } else {
      console.log(`  [dry-run] ${relation}: ${keyed[i].key} → ${keyed[j].key} (score=${score.toFixed(3)})`);
      edgesAdded++;
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const graphFile = join(memDir, 'fact_graph.ndjson');
console.log('');
console.log(`Pairs checked : ${pairsChecked}`);
console.log(`Below threshold: ${skipped}`);
console.log(`Edges ${dryRun ? 'would be' : ''} added: ${edgesAdded}`);
if (!dryRun) {
  console.log(`Graph file    : ${graphFile}`);
  try {
    const stats = memgraph.graphStats(memDir);
    console.log(`Graph stats   : ${stats.totalEdges} total edges — ${JSON.stringify(stats.relationCounts)}`);
  } catch {}
}
