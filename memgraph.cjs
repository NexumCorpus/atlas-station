'use strict';
const fs = require('fs');
const path = require('path');

const GRAPH_FILE = (dir) => path.join(dir, 'fact_graph.ndjson');

// Valid relation types
const RELATIONS = new Set(['supports', 'contradicts', 'elaborates', 'supersedes', 'related_to', 'semantic']);

// Add a directed edge: fromKey --relation--> toKey
function addEdge(fromKey, relation, toKey, memDir) {
  if (!RELATIONS.has(relation)) throw new Error(`Unknown relation: ${relation}`);
  fs.mkdirSync(memDir, { recursive: true });
  const edge = { fromKey, relation, toKey, ts: new Date().toISOString() };
  fs.appendFileSync(GRAPH_FILE(memDir), JSON.stringify(edge) + '\n', 'utf8');
  // If relation is 'supersedes', mark toKey as stale in a separate stale index
  if (relation === 'supersedes') markStale(toKey, memDir);
  return edge;
}

// Mark a fact key as stale (superseded)
function markStale(key, memDir) {
  fs.mkdirSync(memDir, { recursive: true });
  const staleFile = path.join(memDir, 'stale_facts.ndjson');
  fs.appendFileSync(staleFile, JSON.stringify({ key, ts: new Date().toISOString() }) + '\n', 'utf8');
}

// Load all edges from the graph file
function loadEdges(memDir) {
  const f = GRAPH_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Load all stale keys
function loadStale(memDir) {
  const f = path.join(memDir, 'stale_facts.ndjson');
  if (!fs.existsSync(f)) return new Set();
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return new Set(lines.map(l => l.key));
}

// Get all edges from a given key (outbound)
function edgesFrom(key, memDir) {
  return loadEdges(memDir).filter(e => e.fromKey === key);
}

// Get all edges TO a given key (inbound)
function edgesTo(key, memDir) {
  return loadEdges(memDir).filter(e => e.toKey === key);
}

// Traverse: given a starting key, return all keys reachable within maxDepth hops
// Returns array of { key, relation, depth }
function traverse(startKey, memDir, maxDepth = 2) {
  const edges = loadEdges(memDir);
  const visited = new Set([startKey]);
  const result = [];
  const queue = [{ key: startKey, depth: 0 }];
  while (queue.length) {
    const { key, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const outbound = edges.filter(e => e.fromKey === key);
    for (const e of outbound) {
      if (!visited.has(e.toKey)) {
        visited.add(e.toKey);
        result.push({ key: e.toKey, relation: e.relation, depth: depth + 1 });
        queue.push({ key: e.toKey, depth: depth + 1 });
      }
    }
  }
  return result;
}

// Summary of the graph: total edges, relation type counts, stale fact count
function graphStats(memDir) {
  const edges = loadEdges(memDir);
  const stale = loadStale(memDir);
  const counts = {};
  edges.forEach(e => { counts[e.relation] = (counts[e.relation] || 0) + 1; });
  return { totalEdges: edges.length, relationCounts: counts, staleCount: stale.size };
}

// Propagate a new fact's signal through the graph.
// 'supports' edges: returns keys that now have reinforced support
// 'contradicts' edges: returns keys flagged for review
// 'elaborates' and 'related_to' are neutral — returned in neither list
// Returns { reinforced: string[], flagged: string[] }
function propagateSignal(fromKey, memDir) {
  const edges = loadEdges(memDir);
  const stale = loadStale(memDir);
  const outbound = edges.filter(e => e.fromKey === fromKey && !stale.has(e.toKey));
  const reinforced = outbound.filter(e => e.relation === 'supports').map(e => e.toKey);
  const flagged = outbound.filter(e => e.relation === 'contradicts').map(e => e.toKey);
  return { reinforced, flagged };
}

module.exports = { addEdge, edgesFrom, edgesTo, traverse, loadStale, graphStats, propagateSignal, RELATIONS };
