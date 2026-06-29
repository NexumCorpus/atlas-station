'use strict';
const fs = require('fs');
const path = require('path');

const CLUSTERS_FILE = (dir) => path.join(dir, 'clusters.ndjson');

function tokenize(text) {
  const STOP = new Set(['the','a','an','is','are','was','were','it','of','in','to','and','or','for','with','that','this','from','by','on','at','as','be','has','have','had','not','but']);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}

function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

function loadClusters(memDir) {
  const f = CLUSTERS_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function saveClusters(clusters, memDir) {
  const dir = memDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CLUSTERS_FILE(memDir), clusters.map(c => JSON.stringify(c)).join('\n') + (clusters.length ? '\n' : ''), 'utf8');
}

// Assign a fact to the nearest cluster, creating a new cluster if no match above threshold
function assignCluster(fact, memDir, threshold = 0.12) {
  const clusters = loadClusters(memDir);
  const factText = [fact.topic, fact.fact, fact.source].filter(Boolean).join(' ');
  const factTokens = tokenize(factText);
  if (factTokens.length === 0) return null;

  let bestCluster = null, bestScore = 0;
  for (const c of clusters) {
    const score = jaccard(factTokens, c.keywords || []);
    if (score > bestScore) { bestScore = score; bestCluster = c; }
  }

  if (bestCluster && bestScore >= threshold) {
    // Update cluster: merge keywords, increment count
    bestCluster.factCount = (bestCluster.factCount || 0) + 1;
    bestCluster.lastTs = new Date().toISOString();
    // Merge top keywords (keep top 20 by frequency)
    const merged = [...new Set([...(bestCluster.keywords || []), ...factTokens])].slice(0, 20);
    bestCluster.keywords = merged;
    saveClusters(clusters, memDir);
    return bestCluster.key;
  } else {
    // Create new cluster
    // Label: capitalize and join top 3 tokens
    const label = factTokens.slice(0, 3).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    const key = 'cluster_' + Date.now();
    const newCluster = { key, label, keywords: factTokens.slice(0, 15), factCount: 1, createdTs: new Date().toISOString(), lastTs: new Date().toISOString() };
    clusters.push(newCluster);
    saveClusters(clusters, memDir);
    return key;
  }
}

function listClusters(memDir) {
  return loadClusters(memDir).sort((a, b) => (b.factCount || 0) - (a.factCount || 0));
}

// Recluster: re-read all facts and rebuild clusters from scratch
function recluster(memDir, factsFile) {
  const factsPath = factsFile || path.join(memDir, 'facts.ndjson');
  if (!fs.existsSync(factsPath)) return { message: 'No facts file found', clusters: 0 };
  // Clear clusters
  saveClusters([], memDir);
  const lines = fs.readFileSync(factsPath, 'utf8').trim().split('\n').filter(Boolean);
  let assigned = 0;
  for (const line of lines) {
    try {
      const fact = JSON.parse(line);
      assignCluster(fact, memDir);
      assigned++;
    } catch {}
  }
  const result = listClusters(memDir);
  return { message: `Reclustered ${assigned} facts into ${result.length} clusters`, clusters: result.length };
}

module.exports = { assignCluster, listClusters, recluster, loadClusters };
