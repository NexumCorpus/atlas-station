// ATLAS // station — memory context injection for dispatched agents.
//
// Reads the human journal + recent structured facts/runs, and assembles a
// labeled context block to prepend to an agent's task prompt. Memory is thereby
// DELIVERED to the agent rather than merely available for it to find.
//
// Key design constraints:
//   • inject() is a pure enrichment — if anything fails (missing files,
//     permissions, memstore errors) it returns the original task unchanged.
//     Memory failure must never crash or stall the fleet.
//   • The context block is clearly delimited (--- ATLAS MEMORY --- / --- END MEMORY ---)
//     so agents can distinguish memory from task.
//   • The journal is read-only. This module never writes to ~/.claude.
//
// Self-test: `node memcontext.cjs`
'use strict';

const fs   = require('fs');
const path = require('path');

// Default journal path. Claude Code encodes Windows drive letters by replacing
// ':' and '\' with '-', so E:\ becomes E-- in the project path component.
const DEFAULT_JOURNAL = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude', 'projects', 'E--atlas-station', 'memory', 'MEMORY.md'
);

// Self-model: injected at the end of every memory context block so ATLAS knows
// the station's own source layout without needing to re-read it each turn.
const STATION_BRIEF = `[Station Architecture]
E:\\atlas-station source files:
- main.cjs: Electron main — creates BrowserWindow, spawns fleethost.mjs as IPC sidecar, relays fleet events to renderer. IPC channels: say, dispatch, reply, cancel, self-build.
- fleethost.mjs: Fleet engine — orchestrate() runs ATLAS with query(), runSubagent() runs subagents, agents Map tracks state, send() broadcasts to Electron. Tools: spawn_agent, check_fleet, chain_agents, fleet_status, diagnose.
- index.html: Renderer — conversation thread (ATLAS↔Daniel), brood grid (subagent cards), vitals strip, ledger sidebar. Uses window.atlas.* bridge.
- preload.cjs: contextBridge — say, dispatch, replyAgent, selfBuild, cancel, onFleet.
- memcontext.cjs: Memory injection — prepends journal + runs + facts to every agent task.
- memstore.cjs: Fact/run store — appendFact, appendRun, recallFacts, recentRuns, lifetimeStats. Files: memory/facts.ndjson, memory/runs.ndjson.
- fact-extractor.cjs: Extracts inferred facts from ATLAS replies for persistent memory.
- prune.mjs: Sprawl cleanup — removes merged fleet/* branches and their worktrees. Run: node prune.mjs.
- instruct_atlas.mjs: Relay tool — spawns fleethost, sends one directive, reports reply.
Fleet pattern: build agents use isolated git worktrees at E:\\atlas-wt\\<id> on branch fleet/<id>.`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * loadJournalExcerpt(journalPath, maxChars) — Read the journal and truncate.
 *
 * Strips YAML frontmatter (--- … ---) before truncating so the useful prose
 * starts at character 0. Returns "" on any error (missing file, permissions).
 * Never throws.
 */
function loadJournalExcerpt(journalPath, maxChars) {
  try {
    const raw  = fs.readFileSync(journalPath, 'utf8');
    const body = raw.replace(/^---[\s\S]*?---\r?\n?/, '').trim();
    if (body.length <= maxChars) return body;
    return body.slice(0, maxChars) + '\n[... truncated]';
  } catch {
    return '';
  }
}

// Lazy-load memstore so this module has no hard dependency on it.
// If memstore.cjs is absent or broken, we just skip those sections.
// Sentinel: undefined = not yet attempted; null = attempted but failed; object = loaded.
let _memstore;
function _getMemstore() {
  if (_memstore === undefined) {
    try { _memstore = require('./memstore.cjs'); }
    catch { _memstore = null; }
  }
  return _memstore;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * buildContext(task, opts?) — Assemble the memory context block.
 *
 * opts:
 *   journalPath      {string}  Path to the atlas-station journal.
 *                              Default: ~/.claude/projects/E--/memory/atlas-station.md
 *   maxJournalChars  {number}  Max journal chars to include. Default: 2000.
 *   maxFacts         {number}  Max recalled facts. Default: 5.
 *   maxRuns          {number}  Max recent runs. Default: 5.
 *   memDir           {string}  memstore directory. Default: <module-dir>/memory.
 *
 * Returns the full context block string, or "" if nothing could be loaded.
 * Never throws.
 */
function buildContext(task, opts = {}) {
  const {
    journalPath     = DEFAULT_JOURNAL,
    maxJournalChars = 2000,
    maxFacts        = 5,
    maxRuns         = 5,
    memDir          = path.join(__dirname, 'memory'),
  } = opts;

  const parts = [];

  // 1. Journal excerpt ───────────────────────────────────────────────────────
  const journal = loadJournalExcerpt(journalPath, maxJournalChars);
  if (journal) {
    const label = path.basename(journalPath);
    const ts    = new Date().toISOString();
    parts.push(`[Station Journal — ${label} | loaded ${ts}]\n${journal}`);
  }

  // 1.5. Session context (prior session narrative) ──────────────────────────
  try {
    const _sn = require('./session-narrative.cjs');
    const sessionCtx = _sn.buildSessionContext(path.join(__dirname, 'memory'));
    if (sessionCtx) parts.push(sessionCtx);
  } catch (_) {}

  // 2. Recent run records ───────────────────────────────────────────────────
  const ms = _getMemstore();
  if (ms) {
    try {
      const runs = ms.recentRuns(maxRuns, memDir);
      if (runs.length > 0) {
        const lines = runs.map(r => {
          const date   = String(r.ts || '').slice(0, 10);
          const cost   = typeof r.cost === 'number' ? ` ($${r.cost.toFixed(2)})` : '';
          const branch = r.branch ? ` [${r.branch}]` : '';
          const task60 = String(r.task || '').slice(0, 60);
          return `- ${r.agentId} (${date}): ${r.mode} "${task60}" → ${r.state}${cost}${branch}`;
        });
        parts.push(`[Recent Fleet Runs]\n${lines.join('\n')}`);
      }
    } catch { /* skip */ }

    // 3. Relevant facts ───────────────────────────────────────────────────────
    try {
      const facts = ms.recallFacts(task, { dir: memDir, maxResults: maxFacts });
      if (facts.length > 0) {
        const snippet = String(task).slice(0, 80);
        const lines   = facts.map(f => `- [${f.confidence}] ${f.fact} (source: ${f.source})`);
        parts.push(`[Relevant Facts for: "${snippet}"]\n${lines.join('\n')}`);
      }
    } catch { /* skip */ }
  }

  // 4. Temporal awareness ──────────────────────────────────────────────────
  try {
    const { spawnSync } = require('child_process');
    const now = new Date();
    const lines = [`Now: ${now.toISOString()} (${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })})`];
    // Last 3 git commits — spawnSync avoids shell interpolation
    const logResult = spawnSync('git', ['log', '--oneline', '-3'], { cwd: __dirname, timeout: 3000, encoding: 'utf8' });
    if (logResult.status === 0) {
      const gitLog = (logResult.stdout || '').trim();
      if (gitLog) lines.push(`Recent commits:\n${gitLog}`);
    }
    // Git status summary
    const statusResult = spawnSync('git', ['status', '--short'], { cwd: __dirname, timeout: 3000, encoding: 'utf8' });
    if (statusResult.status === 0) {
      const gitStatus = (statusResult.stdout || '').trim();
      lines.push(`Working tree: ${gitStatus ? 'dirty\n' + gitStatus : 'clean'}`);
    }
    if (lines.length > 1) parts.push(`[Now]\n${lines.join('\n')}`);
  } catch {}

  if (!parts.length) return '';
  // Always include station architecture brief when there IS memory
  parts.push(STATION_BRIEF);
  return `--- ATLAS MEMORY ---\n${parts.join('\n\n')}\n--- END MEMORY ---`;
}

/**
 * inject(task, opts?) — Prepend the memory context block to an agent task.
 *
 * Returns `task` unchanged if buildContext returns "" or throws.
 * Never throws — memory failure is silent and non-blocking.
 */
function inject(task, opts = {}) {
  try {
    const ctx = buildContext(task, opts);
    if (!ctx) return task;
    return `${ctx}\n\n${task}`;
  } catch {
    return task;
  }
}

module.exports = { buildContext, inject, loadJournalExcerpt };

// ---------------------------------------------------------------------------
// Self-test: `node memcontext.cjs`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  const os     = require('os');

  const testDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'memctx-selftest-'));
  const fakeJournal = path.join(testDir, 'atlas-station.md');
  const memDir     = path.join(testDir, 'mem');
  let ok           = false;

  try {
    // Write a fake journal with frontmatter
    fs.writeFileSync(fakeJournal, [
      '---',
      'name: atlas-station',
      'description: test journal',
      '---',
      '',
      'E:\\atlas-station (git master). The station is a fleet of autonomous agents.',
      'Build mode uses bypassPermissions and isolated git worktrees.',
      'Auth runs on Claude Code subscription. No API key needed.',
    ].join('\n'), 'utf8');

    // Seed memstore with one fact and one run
    const { appendFact, appendRun } = require('./memstore.cjs');
    appendFact({
      topic: 'auth',
      fact:  'No API key needed — runs on subscription.',
      source: 'session:test',
      confidence: 'verified',
    }, memDir);
    appendRun({
      agentId: 'T-1',
      task:    'test run task',
      mode:    'read',
      state:   'done',
      cost:    0.01,
      summary: 'Test done.',
    }, memDir);

    // ── buildContext returns a block with all three sections ──────────────
    const ctx = buildContext('check the auth system for api key usage', {
      journalPath:     fakeJournal,
      maxJournalChars: 400,
      maxFacts:        3,
      maxRuns:         3,
      memDir,
    });

    assert.ok(ctx.includes('--- ATLAS MEMORY ---'), 'context should open with ATLAS MEMORY header');
    assert.ok(ctx.includes('--- END MEMORY ---'),   'context should close with END MEMORY footer');
    assert.ok(ctx.includes('Station Journal'),       'context should include journal section header');
    assert.ok(ctx.includes('fleet of autonomous'),   'context should include journal prose');
    assert.ok(ctx.includes('[Recent Fleet Runs]'),   'context should include runs section');
    assert.ok(ctx.includes('T-1'),                   'context should include agent run entry');
    assert.ok(ctx.includes('[Relevant Facts'),        'context should include facts section');
    assert.ok(ctx.includes('No API key needed'),     'context should include recalled fact');

    // ── frontmatter stripped ──────────────────────────────────────────────
    assert.ok(!ctx.includes('name: atlas-station'),  'frontmatter should be stripped from journal');

    // ── inject prepends context and keeps original task ───────────────────
    const task        = 'deploy the new version';
    const enriched    = inject(task, { journalPath: fakeJournal, memDir });
    assert.ok(enriched.startsWith('--- ATLAS MEMORY ---'), 'inject should prepend context');
    assert.ok(enriched.includes(task),                      'inject should preserve original task');
    // The task appears after the context block
    const taskIdx = enriched.indexOf(task);
    const endIdx  = enriched.indexOf('--- END MEMORY ---');
    assert.ok(taskIdx > endIdx, 'original task should appear after END MEMORY marker');

    // ── inject with missing journal still works (runs + facts) ───────────
    const noJournal = inject('some task', { journalPath: '/nonexistent/path/journal.md', memDir });
    assert.ok(typeof noJournal === 'string', 'inject returns string even with missing journal');
    assert.ok(noJournal.includes('some task'), 'original task preserved with missing journal');

    // ── buildContext with no journal/facts still returns temporal context ────
    // Temporal section always fires (uses __dirname, not memDir), so even with
    // nothing else available we get at least [Now] + STATION_BRIEF.
    const emptyMemDir = path.join(testDir, 'empty-mem');
    const emptyCtx = buildContext('hello world', {
      journalPath: '/nonexistent/journal.md',
      memDir:      emptyMemDir,
    });
    assert.ok(emptyCtx.includes('[Now]'), 'temporal section always present when git is available');
    assert.ok(emptyCtx.includes('Now:'),  'temporal section includes current datetime');

    // ── inject with no journal/facts still prepends temporal context ──────
    const bare = inject('bare task', {
      journalPath: '/nonexistent',
      memDir:      emptyMemDir,
    });
    assert.ok(bare.includes('bare task'),        'inject preserves original task');
    assert.ok(bare.includes('--- ATLAS MEMORY ---'), 'inject prepends memory block even when only temporal data available');

    // ── loadJournalExcerpt: truncation ────────────────────────────────────
    const excerpt = loadJournalExcerpt(fakeJournal, 30);
    assert.ok(excerpt.includes('[... truncated]'), 'should truncate at maxChars');
    assert.ok(excerpt.length <= 30 + '[... truncated]'.length + 1, 'truncation length correct');

    // ── loadJournalExcerpt: missing file returns "" ───────────────────────
    const missing = loadJournalExcerpt('/no/such/file.md', 2000);
    assert.strictEqual(missing, '', 'missing journal returns empty string');

    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
