#!/usr/bin/env node
// NREM Sleep Consolidation — offline memory consolidation pass for ATLAS Station.
// Mirrors NREM sleep: strengthens co-activated edges (Hebbian), applies proportional
// decay (synaptic downscaling), and flags temporal contradictions.
//
// Call: node scripts/nrem-consolidation.mjs [repoPath]
// Default repoPath: derived from __dirname/../
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[2] || join(__dirname, '..');
const _require = createRequire(import.meta.url);

const _embstore = _require(join(REPO, 'embstore.cjs'));
const _embedding = _require(join(REPO, 'embedding.cjs'));

const MEM_DIR    = join(REPO, 'memory');
const FACTS_FILE = join(MEM_DIR, 'facts.jsonl');
const GRAPH_FILE = join(MEM_DIR, 'fact_graph.ndjson');
const NREM_LOG   = join(MEM_DIR, 'nrem-log.ndjson');

// ── Thresholds ─────────────────────────────────────────────────────────────────
const HEBBIAN_THRESHOLD    = 0.6;   // cosine: strengthen existing semantic edges
const NEW_EDGE_THRESHOLD   = 0.7;   // cosine: create a new semantic edge
const HEBBIAN_FACTOR       = 1.2;   // fire together, wire together — multiply weight
const DECAY_FACTOR         = 0.85;  // synaptic downscaling — applies to ALL edges
const PRUNE_THRESHOLD      = 0.05;  // remove edges that fall below this after decay
const DEFAULT_EDGE_WEIGHT  = 0.5;   // seed weight for edges that pre-date NREM
const RECENT_WINDOW_MS     = 24 * 60 * 60 * 1000; // 24 hours

// Signal words that indicate a fact supersedes another
const SIGNAL_WORDS = [
  'removed', 'replaced', 'no longer', 'deprecated',
  'now uses', 'changed to',
];

// ── Helpers ────────────────────────────────────────────────────────────────────
function loadLines(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim().length > 0);
  } catch {
    return [];
  }
}

function parseLines(lines) {
  return lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function consolidate() {
  mkdirSync(MEM_DIR, { recursive: true });

  const logEntry = {
    ts: new Date().toISOString(),
    factsScanned: 0,
    edgesStrengthened: 0,
    edgesCreated: 0,
    edgesPruned: 0,
    contradictionCandidates: [],
  };

  // ── Phase A: Load data ───────────────────────────────────────────────────────
  let facts = [];
  try {
    facts = parseLines(loadLines(FACTS_FILE));
    logEntry.factsScanned = facts.length;
  } catch (err) {
    console.error('[nrem] Phase A (facts) failed:', err.message);
  }

  // Load graph edges — seed any edge without a weight field at DEFAULT_EDGE_WEIGHT
  let allEdges = [];
  try {
    allEdges = parseLines(loadLines(GRAPH_FILE)).map(e => ({
      ...e,
      weight: (typeof e.weight === 'number') ? e.weight : DEFAULT_EDGE_WEIGHT,
    }));
  } catch (err) {
    console.error('[nrem] Phase A (graph) failed:', err.message);
  }

  // Build lookup: "fromKey|toKey|relation" → index in allEdges
  const edgeMap = new Map();
  for (let i = 0; i < allEdges.length; i++) {
    const e = allEdges[i];
    edgeMap.set(`${e.fromKey}|${e.toKey}|${e.relation}`, i);
  }

  // Load embeddings — try/catch so missing model doesn't crash
  let embMap = new Map();
  let embsAvailable = false;
  try {
    embMap = _embstore.getAllEmbs(MEM_DIR);
    embsAvailable = embMap.size > 0;
  } catch (err) {
    console.warn('[nrem] Could not load embeddings:', err.message);
  }

  // Identify recent facts (last 24h)
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recentFacts = facts.filter(f => {
    try { return f.ts && new Date(f.ts).getTime() > cutoff; } catch { return false; }
  });

  // ── Phase B: Hebbian strengthening (skipped if no embeddings) ───────────────
  if (!embsAvailable) {
    console.warn('[nrem] No embeddings available — skipping Phases B and C (Hebbian + decay)');
  } else {
    try {
      const recentWithEmbs = recentFacts.filter(f => f.id && embMap.has(f.id));

      for (let i = 0; i < recentWithEmbs.length; i++) {
        for (let j = i + 1; j < recentWithEmbs.length; j++) {
          const fa = recentWithEmbs[i];
          const fb = recentWithEmbs[j];
          const embA = embMap.get(fa.id);
          const embB = embMap.get(fb.id);
          const sim = _embedding.cosineSimilarity(embA, embB);

          if (sim <= HEBBIAN_THRESHOLD) continue;

          // Check for an existing semantic edge in either direction
          const keyAB = `${fa.id}|${fb.id}|semantic`;
          const keyBA = `${fb.id}|${fa.id}|semantic`;
          const existingIdx = edgeMap.has(keyAB) ? edgeMap.get(keyAB)
                            : edgeMap.has(keyBA) ? edgeMap.get(keyBA)
                            : undefined;

          if (existingIdx !== undefined) {
            // Strengthen: fire together, wire together
            allEdges[existingIdx].weight = Math.min(1.0, allEdges[existingIdx].weight * HEBBIAN_FACTOR);
            logEntry.edgesStrengthened++;
          } else if (sim > NEW_EDGE_THRESHOLD) {
            // Create new semantic edge with initial weight proportional to similarity
            const newEdge = {
              fromKey: fa.id,
              relation: 'semantic',
              toKey: fb.id,
              ts: new Date().toISOString(),
              weight: sim * 0.8,
            };
            const newIdx = allEdges.length;
            allEdges.push(newEdge);
            edgeMap.set(keyAB, newIdx);
            logEntry.edgesCreated++;
          }
        }
      }
    } catch (err) {
      console.error('[nrem] Phase B failed:', err.message);
    }

    // ── Phase C: Proportional decay on ALL edges ─────────────────────────────
    try {
      const survivors = [];
      for (const edge of allEdges) {
        const decayed = edge.weight * DECAY_FACTOR;
        if (decayed < PRUNE_THRESHOLD) {
          logEntry.edgesPruned++;
          // Do not push — edge is removed
        } else {
          survivors.push({ ...edge, weight: decayed });
        }
      }
      allEdges = survivors;
    } catch (err) {
      console.error('[nrem] Phase C failed:', err.message);
    }
  }

  // ── Phase D: Conflict detection ──────────────────────────────────────────────
  try {
    if (embsAvailable && recentFacts.length >= 2) {
      const recentWithEmbs = recentFacts.filter(f => f.id && embMap.has(f.id));
      for (let i = 0; i < recentWithEmbs.length; i++) {
        for (let j = i + 1; j < recentWithEmbs.length; j++) {
          const fa = recentWithEmbs[i];
          const fb = recentWithEmbs[j];
          const embA = embMap.get(fa.id);
          const embB = embMap.get(fb.id);
          const sim = _embedding.cosineSimilarity(embA, embB);
          if (sim <= 0.8) continue;

          const textA = (fa.fact || '').toLowerCase();
          const textB = (fb.fact || '').toLowerCase();
          const aHasSignal = SIGNAL_WORDS.some(w => textA.includes(w));
          const bHasSignal = SIGNAL_WORDS.some(w => textB.includes(w));

          // Exactly one has a signal word → the other may be stale
          if (aHasSignal !== bHasSignal) {
            const signalFact = aHasSignal ? fa : fb;
            const staleFact  = aHasSignal ? fb : fa;
            const signal = SIGNAL_WORDS.find(w =>
              (signalFact.fact || '').toLowerCase().includes(w)
            ) || '';
            logEntry.contradictionCandidates.push({
              factId: staleFact.id,
              signal,
              conflictsWith: signalFact.id,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[nrem] Phase D failed:', err.message);
  }

  // ── Phase E: Write results ───────────────────────────────────────────────────

  // Rewrite graph file with updated weights (replaces old file entirely)
  try {
    const graphLines = allEdges.map(e => JSON.stringify(e));
    const content = graphLines.length > 0 ? graphLines.join('\n') + '\n' : '';
    writeFileSync(GRAPH_FILE, content, 'utf8');
  } catch (err) {
    console.error('[nrem] Phase E (graph write) failed:', err.message);
  }

  // Append consolidation log entry
  try {
    appendFileSync(NREM_LOG, JSON.stringify(logEntry) + '\n', 'utf8');
  } catch (err) {
    console.error('[nrem] Phase E (log write) failed:', err.message);
  }

  const { edgesStrengthened, edgesCreated, edgesPruned, contradictionCandidates } = logEntry;
  console.log(
    `[nrem] consolidation complete: +${edgesStrengthened} edges strengthened, ` +
    `+${edgesCreated} created, -${edgesPruned} pruned, ` +
    `${contradictionCandidates.length} contradiction candidates`
  );
}

consolidate().catch(err => {
  // Never let a crash propagate to daemon-run.mjs
  console.error('[nrem] fatal error (non-fatal to daemon):', err.message);
  process.exit(0);
});
