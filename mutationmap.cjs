'use strict';
const fs = require('fs');
const path = require('path');
const circulation = require('./circulation.cjs');

const MUTATIONS_FILE = (dir) => path.join(dir, 'mutations.ndjson');

// Record files changed by an agent after a commit
function recordMutation(agentId, files, memDir, hermes = null) {
  if (!files || !files.length) return;
  const entry = {
    ts: new Date().toISOString(),
    agentId,
    files: files.slice(0, 50), // cap at 50 files
    hermes: circulation.envelope(hermes, 'proposal', String(agentId || 'mutation')),
  };
  fs.appendFileSync(MUTATIONS_FILE(memDir), JSON.stringify(entry) + '\n', 'utf8');
}

// Load all mutation records
function loadMutations(memDir) {
  const f = MUTATIONS_FILE(memDir);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Build a churn map: { file: { count, agents: Set, lastTs } }
function buildChurnMap(mutations) {
  const map = {};
  mutations.forEach(m => {
    (m.files || []).forEach(file => {
      if (!map[file]) map[file] = { count: 0, agents: new Set(), lastTs: null };
      map[file].count++;
      map[file].agents.add(m.agentId);
      if (!map[file].lastTs || m.ts > map[file].lastTs) map[file].lastTs = m.ts;
    });
  });
  return map;
}

// Get top-N churned files
function topChurn(memDir, n = 10) {
  const mutations = loadMutations(memDir);
  const churnMap = buildChurnMap(mutations);
  return Object.entries(churnMap)
    .map(([file, info]) => ({
      file,
      count: info.count,
      agents: [...info.agents],
      lastTs: info.lastTs,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// Get mutation history for a specific file
function fileHistory(memDir, targetFile) {
  return loadMutations(memDir)
    .filter(m => (m.files || []).includes(targetFile))
    .map(m => ({ ts: m.ts, agentId: m.agentId }))
    .reverse()
    .slice(0, 20);
}

module.exports = { recordMutation, topChurn, fileHistory, loadMutations };
