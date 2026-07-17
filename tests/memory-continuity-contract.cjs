const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const turns = require('../session-log.cjs');
const crystals = require('../crystals.cjs');
const memstore = require('../memstore.cjs');
const memgraph = require('../memgraph.cjs');
const sessions = require('../session-narrative.cjs');
const { loadJournalExcerpt } = require('../memcontext.cjs');
const resonance = require('../resonance.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-memory-contract-'));
const missingDir = path.join(root, 'nested', 'memory');
try {
  turns.appendTurn(42, missingDir, null, 'atlas');
  turns.appendTurn('second', missingDir, null, 'user');
  assert.equal(turns.getRecentTurns(missingDir, 0).length, 0);
  assert.equal(turns.getRecentTurns(missingDir, 2)[0].text, '42');

  crystals.appendCrystal(99, [1, 1], missingDir);
  crystals.appendCrystal('second', [2, 2], missingDir);
  assert.equal(crystals.loadCrystals(missingDir, 0).length, 0);
  assert.equal(crystals.loadCrystals(missingDir, 2)[0].text, '99');

  memstore.appendRun({ agentId: 'R-1', task: 'first', mode: 'read', state: 'done' }, missingDir);
  memstore.appendRun({ agentId: 'R-2', task: 'second', mode: 'read', state: 'done' }, missingDir);
  assert.equal(memstore.recentRuns(0, missingDir).length, 0);
  assert.equal(memstore.recentRuns(1, missingDir)[0].agentId, 'R-2');

  const freshGraph = path.join(root, 'fresh-graph');
  memgraph.addEdge('f-1', 'supports', 'f-2', freshGraph);
  assert.equal(memgraph.edgesFrom('f-1', freshGraph).length, 1);

  const journal = path.join(root, 'journal.md');
  fs.writeFileSync(journal, 'journal continuity evidence');
  assert.equal(loadJournalExcerpt(journal, 0), '');
  assert.equal(loadJournalExcerpt(journal, 8), 'journal \n[... truncated]');

  const session = sessions.writeSession({ ts: '2026-07-11T12:00:00Z', agentCount: 1 }, missingDir);
  assert.equal(session.agentCount, 1);
  assert.equal(sessions.loadLastSession(missingDir).agentCount, 1);

  const runsFile = path.join(root, 'resonance-runs.ndjson');
  fs.writeFileSync(runsFile, [
    JSON.stringify({ agentId: 'R-1', task: 'memory continuity', summary: 'kept memory intact', state: 'done' }),
    JSON.stringify({ agentId: 'R-2', task: 'memory context', summary: 'kept context intact', state: 'done' }),
  ].join('\n') + '\n');
  assert.equal(resonance.findSimilarRuns('memory', runsFile, { maxResults: -1 }).length, 0);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('memory continuity: ALL PASS');
