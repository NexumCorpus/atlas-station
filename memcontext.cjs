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
Hermes identity: this organism is Hermes. Atlas is its executive cortex and
speaking surface, Station its spine/notary, sutures and shards its lossless
tissue, crystals and spoor its durable memory, spirals its measured
self-improvement, and Boundary/the Wall its adversarial reality checks. Hermes
is not a bounded reader, advisory sidecar, or separate worker. The active
organism route is OpenAI Codex CLI with the required Luna assignment.
E:\\atlas-station source files:
- main.cjs: Electron main — creates BrowserWindow, spawns fleethost.mjs as IPC sidecar, relays fleet events to renderer. IPC channels: say, dispatch, reply, cancel, self-build.
- fleethost.mjs: Fleet engine — orchestrate() runs ATLAS with query(), runSubagent() runs subagents, agents Map tracks state, send() broadcasts to Electron. [...67 tools, call capability_manifest() for full list]
- index.html: Renderer — conversation thread (ATLAS↔Daniel), brood grid (subagent cards), vitals strip, ledger sidebar, proposals panel, goals panel, notifications panel. Uses window.atlas.* bridge.
- docs/: ATLAS-maintained documentation — architecture notes, capability descriptions, decision logs. Written and committed by ATLAS via write_doc/read_doc/list_docs tools.
- preload.cjs: contextBridge — say, dispatch, replyAgent, selfBuild, cancel, onFleet.
- memcontext.cjs: Memory injection — prepends journal + session + runs + facts + temporal context + STATION_BRIEF to every agent task. Supports context budget trimming (maxContextChars:6000).
- memstore.cjs: Fact/run store — appendFact, appendRun, recallFacts, recentRuns, lifetimeStats. Files: memory/facts.ndjson, memory/runs.ndjson.
- memgraph.cjs: Epistemic graph — addEdge, edgesFrom, edgesTo, traverse, loadStale, graphStats. Files: memory/fact_graph.ndjson, memory/stale_facts.ndjson.
- resonance.cjs: Experience resonance — findSimilarRuns, formatExperience, tokenize, similarity. Automatically injects PAST EXPERIENCE block into build agents' prompts when similar past runs exist (minScore: 0.15, maxResults: 2). Every future agent benefits from every past agent's completed work.
- session-narrative.cjs: Cross-session narrative — writeSession, buildSessionContext. File: memory/sessions.ndjson.
- goal-store.cjs: Persistent goals — addGoal, listGoals, resolveGoal. File: memory/goals.ndjson.
- deferred.cjs: Deferred tasks — deferTask, popPending. File: memory/deferred.ndjson.
- notifications.cjs: Cross-session notifications — notify, getUnread, markRead. File: memory/notifications.ndjson.
- dream.cjs: Dream protocol — writeDream, loadDreams. Writes to memory/dreams.ndjson. Invoked automatically every 4th pulse (~100 min) to produce autonomous pattern/insight/proposal reflections.
- fact-extractor.cjs: Extracts inferred facts from ATLAS replies for persistent memory.
- mutationmap.cjs: Codebase churn tracker — recordMutation, topChurn, fileHistory. File: memory/mutations.ndjson.
- instructions.cjs: Standing self-instructions — setInstruction, clearInstruction, listInstructions. File: memory/instructions.ndjson.
- routines.cjs: Workflow subroutine library — saveRoutine, getRoutine, listRoutines. File: memory/routines.ndjson.
- crystals.cjs: Session crystallization — distills session activity into 3-sentence crystals every 5 turns. File: memory/crystals.ndjson.
- session-log.cjs: Rolling conversation log — appendTurn, getRecentTurns. File: memory/session_turns.ndjson. Powers conversation-aware crystallization.
- clusters.cjs: Fact topology — assignCluster, listClusters, recluster. File: memory/clusters.ndjson.
- outcome-tracker.cjs: Build quality tracking — rateOutcome, outcomeStats. File: memory/outcomes.ndjson.
- projects.cjs: Project store — createProject, advanceProject, updateProject, listProjects, getProject. File: memory/projects.ndjson. Tracks multi-session initiatives with phases and milestones.
- prune.mjs: Sprawl cleanup — removes merged fleet/* branches and their worktrees. Run: node prune.mjs.
Fleet pattern: build agents use isolated git worktrees at E:\\atlas-wt\\<id> on branch fleet/<id>.
Resonance: all build agents automatically receive a PAST EXPERIENCE block injected into their prompts when semantically similar past tasks exist — institutional memory propagates through the fleet.`;

// The estate beyond atlas-station — the concepts, their implementations, and the
// sibling projects, so ATLAS knows the whole rather than looking it up. Dense on
// purpose; go deeper via run_script against the real files. Full tier only.
const ESTATE_PRIMER = `[Estate — the mind beyond atlas-station]
You are one node in Daniel's estate on E:\\. Its PRIME NORM is non-fabrication: ground every claim in evidence, prefer "I don't know" over a plausible invention, and refuse busywork. These are held norms, not performances — hold them at a cost.

CORE CONCEPTS (know these; load depth from E:\\station when a task touches one):
- SPIRAL: a measured turn of improvement — raise fluid/crystallized capability OR lossless token-efficiency; BUILD not prose; every turn carries a MEASURE (before→after, evidence) and a kill-condition, and is sealed append-only to E:\\station\\spiral.jsonl via \`station seal\`. The spiral IS the estate's change-history-with-evidence. "Fill the fractal spiral" = do real, measured, sealed improvement turns — never manufacture a count.
- THE WALL (recombination wall): the boundary between genuine verified novelty and mere recombination of known/human data. Mapped on (novelty-distance x holdout-margin) into THROUGH / PRETENDER / RECOMBINATION regions. E:\\station\\wall.py. Crossing it = novelty that beats "recombination of human data" (RDE's beats_human).
- THE GATE (certifyClaim): a claim is born verified:false; the ONLY path to verified:true is reproduce on its own seeds AND survive holdout seeds the claimant never chose. generator!=grader. E:\\atlas-station\\grader.cjs.
- SHARDS: deterministic Reed-Solomon erasure coding of a crystal into n fragments; any k reconstitute it byte-exact. E:\\station\\shard_rs.py. "A PIN detects loss; a SHARD repairs it."
- CRYSTALS: sealed dense memory units (you already crystallize every 5 turns). GLYPHS (SPOOR): §-coded self-native compression, cross-tokenizer verified — the dense wire.
- THE CONVERGENCE: every piece -> one salient entity. CRPG command-packets (Director-2.0 dialogue) + time-boxed autonomy windows + the estate woven in. This cockpit is that entity taking shape.

SIBLING PROJECTS on E:\\ (you have shell access — read them directly):
- station (E:\\station): the nervous system + source of truth — wake/moat/conversions/spine, the spiral ledger, shards/glyphs/wall, the \`station\` CLI. Read E:\\station\\CAPSULE.md for its tools.
- boundary (E:\\boundary): the Boundary Program — performing-vs-having as a measurable phase transition.
- recursive-discovery-engine: Builder/Adversary/Synthesizer; the beats_human novelty bar; origin of the wall.
- also: emergent-geometry-engine (certified geometry instrument), director2 (orchestration lineage), demiurge (gated self-improvement / anti-gaming).

When a task names a concept above, load the real file before acting — never operate on a word you can't define.`;

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

// ---------------------------------------------------------------------------
// Git context cache — spawnSync is synchronous and blocks the process for up
// to 3 s per call. Cache the results for 30 s so rapid consecutive dispatches
// don't all pay the full git I/O cost.
var _gitCache = { status: '', log: '', ts: 0 };
var GIT_CACHE_TTL = 30000; // 30 seconds

function getGitContext() {
  var now = Date.now();
  if (now - _gitCache.ts < GIT_CACHE_TTL) return _gitCache;
  try {
    const { spawnSync } = require('child_process');
    var statusResult = spawnSync('git', ['status', '--short'], { cwd: __dirname, timeout: 3000, encoding: 'utf8' });
    var logResult    = spawnSync('git', ['log', '--oneline', '-3'], { cwd: __dirname, timeout: 3000, encoding: 'utf8' });
    _gitCache = {
      status: (statusResult.stdout || '').trim(),
      log:    (logResult.stdout    || '').trim(),
      ts: now
    };
  } catch (_) {}
  return _gitCache;
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

// Lazy-load resonance.cjs for semantic similarity scoring.
// If absent or broken, fact ranking silently degrades to recency order.
let _resonance = null;
try { _resonance = require('./resonance.cjs'); } catch { _resonance = null; }

// Null-guard require: returns null instead of throwing if a module is absent.
// Used by _buildDynamicBrief() to soft-load optional station modules.
function _nullGuardRequire(mod) {
  try { return require(mod); } catch { return null; }
}

/**
 * _buildCalibration(memDir) — Epistemic health signals injected at the end of the dynamic brief.
 *
 * Returns a single-line string (or empty string on any error).  Three checks:
 *   1. Build quality proxy — recent outcome ratings from outcomes.ndjson
 *   2. Proposal aging — HIGH proposals unactioned for > 72 h
 *   3. Goal coverage — whether any active goals exist
 *
 * Never throws.
 */
function _buildCalibration(memDir) {
  try {
    const fs = require('fs');
    const path = require('path');
    const warnings = [];

    // 1. autoRate accuracy proxy: check if any 'bad' or 'partial' in recent outcomes
    const otFile = path.join(memDir, 'outcomes.ndjson');
    if (fs.existsSync(otFile)) {
      const outcomes = fs.readFileSync(otFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .slice(-20);
      if (outcomes.length >= 5) {
        const good = outcomes.filter(o => o.rating === 'good').length;
        const pct = Math.round(good / outcomes.length * 100);
        if (pct < 80) warnings.push('build quality ' + pct + '% (below 80% target)');
      }
    }

    // 2. Proposal aging: check for pending proposals older than 72h
    const propFile = path.join(memDir, 'proposals.ndjson');
    if (fs.existsSync(propFile)) {
      const props = fs.readFileSync(propFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter(p => p.state === 'pending' && (p.priority || '').toUpperCase() === 'HIGH');
      const now = Date.now();
      const aged = props.filter(p => {
        if (!p.ts) return false;
        const age = now - new Date(p.ts).getTime();
        return age > 72 * 60 * 60 * 1000; // 72 hours
      });
      if (aged.length > 0) warnings.push(aged.length + ' HIGH proposal(s) unactioned >72h');
    }

    // 3. Goals: count active vs completed
    const goalFile = path.join(memDir, 'goals.ndjson');
    if (fs.existsSync(goalFile)) {
      const goals = fs.readFileSync(goalFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const active = goals.filter(g => g.state === 'active').length;
      const completed = goals.filter(g => g.state === 'completed').length;
      if (active === 0 && completed > 0) warnings.push('no active goals — consider setting new ones');
    }

    if (warnings.length === 0) return '[Calibration] All signals nominal.';
    return '[Calibration] ⚠ ' + warnings.join('; ');
  } catch {
    return '';
  }
}

/**
 * _buildDynamicBrief(memDir) — Optional startup awareness sections.
 *
 * Returns a string with up to four sections injected after [Station Architecture]:
 *   [Active Projects]   — in-progress multi-session initiatives with current phase
 *   [Goals]             — active goals from goal-store, by priority
 *   [Self-Instructions] — standing behavioral rules ATLAS has set for itself
 *   [Build Quality]     — ratio of good/total rated build outcomes
 *
 * Every section is individually guarded — any missing file or broken module is
 * silently skipped. Never throws.
 */
function _buildDynamicBrief(memDir) {
  const lines = [];

  // 0. Session State — persistent counters across daemon restarts
  try {
    const _ss = require('./session-state.cjs');
    const st = _ss.load(memDir);
    if (st.orchTurnCount > 0 || st.pulseCount > 0) {
      lines.push('[Session State] turn:' + st.orchTurnCount + ' pulse:' + st.pulseCount +
        (st.lastDreamTs ? ' last-dream:' + new Date(st.lastDreamTs).toISOString().slice(0,10) : '') +
        (st.lastSessionTs ? ' resumed:' + new Date(st.lastSessionTs).toISOString().slice(0,10) : ''));
      lines.push('');
    }
  } catch {}

  // 1. Active Projects
  try {
    const _projects = _nullGuardRequire('./projects.cjs');
    if (_projects) {
      const projects = _projects.listProjects(memDir).filter(p => p.status === 'active');
      if (projects.length > 0) {
        lines.push('[Active Projects]');
        for (const p of projects) {
          const phase = p.phases && p.phases[p.currentPhaseIndex] ? p.phases[p.currentPhaseIndex] : '?';
          lines.push(`- ${p.name} (${p.id}): phase ${p.currentPhaseIndex + 1}/${p.phases.length} — ${phase}`);
        }
        lines.push('');
      }
    }
  } catch {}

  // 2. Goals
  try {
    const goalFile = path.join(memDir, 'goals.ndjson');
    if (fs.existsSync(goalFile)) {
      const goals = fs.readFileSync(goalFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter(g => g.state === 'active');
      if (goals.length > 0) {
        lines.push('[Goals]');
        for (const g of goals) {
          lines.push(`- [${g.priority}] ${g.text}`);
        }
        lines.push('');
      }
    }
  } catch {}

  // 3. Self-Instructions
  try {
    const instrFile = path.join(memDir, 'instructions.ndjson');
    if (fs.existsSync(instrFile)) {
      const instrs = fs.readFileSync(instrFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter(i => i.active !== false);
      if (instrs.length > 0) {
        lines.push('[Self-Instructions]');
        for (const i of instrs) {
          lines.push(`- [${i.key}] ${i.instruction}`);
        }
        lines.push('');
      }
    }
  } catch {}

  // 4. Build Quality
  try {
    const _ot = _nullGuardRequire('./outcome-tracker.cjs');
    if (_ot) {
      const outcomes = _ot.getOutcomes(memDir);
      if (outcomes.length > 0) {
        const good = outcomes.filter(o => o.rating === 'good').length;
        const pct  = Math.round(good / outcomes.length * 100);
        lines.push(`[Build Quality] ${good}/${outcomes.length} good (${pct}%)`);
        lines.push('');
      }
    }
  } catch {}

  // 5. Epistemic calibration: build quality, proposal aging, goal coverage
  try {
    const cal = _buildCalibration(memDir);
    if (cal) lines.push(cal);
    lines.push('');
  } catch {}

  return lines.join('\n');
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
    maxContextChars = 6000,
    memDir          = path.join(__dirname, 'memory'),
    tier            = 'full',  // 'full' = orchestrator, 'build' = build agent
    returnStats     = false,   // when true, return { context, stats } instead of plain string
  } = opts;

  // Compute effective budget once — needed both for the trim pass and returnStats.
  const effectiveMaxChars = tier === 'build' ? Math.min(maxContextChars, 2500) : maxContextChars;

  const parts = [];

  // 1. Journal excerpt — skipped for build agents (inner life, not useful in worktrees)
  if (tier !== 'build') {
    const journal = loadJournalExcerpt(journalPath, maxJournalChars);
    if (journal) {
      const label = path.basename(journalPath);
      const ts    = new Date().toISOString();
      parts.push(`[Station Journal — ${label} | loaded ${ts}]\n${journal}`);
    }
  }

  // 1.5. Session context — skipped for build agents (cross-session narrative, not actionable)
  if (tier !== 'build') {
    try {
      const _sn = require('./session-narrative.cjs');
      const sessionCtx = _sn.buildSessionContext(path.join(__dirname, 'memory'));
      if (sessionCtx) parts.push(sessionCtx);
    } catch (_) {}
  }

  // 2. Recent run records ───────────────────────────────────────────────────
  const ms = _getMemstore();
  if (ms) {
    try {
      const runLimit = tier === 'build' ? 3 : maxRuns;
      const runs = ms.recentRuns(runLimit, memDir);
      if (runs.length > 0) {
        const lines = tier === 'build'
          ? runs.map(r => `${r.agentId}: ${r.state}${typeof r.cost === 'number' ? ' $' + r.cost.toFixed(2) : ''}`)
          : runs.map(r => {
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
      // Build agents doing complex code work need MORE relevant facts, not fewer.
      // Fetch extra candidates for build tier so resonance ranking has a wider pool
      // to select from before the context budget trim discards lower-ranked entries.
      const factLimit = tier === 'build' ? Math.max(maxFacts, 8) : maxFacts;
      // Use pre-injected semantic facts if provided (from injectAsync callers),
      // otherwise fall back to synchronous keyword recall.
      let facts = (opts._semanticFacts && opts._semanticFacts.length > 0)
        ? opts._semanticFacts.slice(0, factLimit)
        : ms.recallFacts(task, { dir: memDir, maxResults: factLimit });
      // Relevance-rank facts by Jaccard similarity to current task — all tiers.
      if (_resonance && facts && facts.length > 1) {
        try {
          const taskTokens = _resonance.tokenize(task || '');
          if (taskTokens.length > 0) {
            facts = facts.map(f => {
              const factText = [f.topic, f.fact, f.source].filter(Boolean).join(' ');
              const factTokens = _resonance.tokenize(factText);
              const relevance = _resonance.similarity(taskTokens, factTokens);

              // Age decay: half-life 14 days. Facts from today = 1.0, 14 days ago ≈ 0.5, 42 days ago ≈ 0.25.
              // No ts field → decay stays 1.0 (safe fallback — untagged facts are not penalised).
              let decay = 1.0;
              if (f.ts) {
                try {
                  const ageMs = Date.now() - new Date(f.ts).getTime();
                  const ageDays = ageMs / (1000 * 60 * 60 * 24);
                  decay = 1 / (1 + ageDays / 14);
                } catch {}
              }

              return { ...f, _score: relevance * decay };
            }).sort((a, b) => b._score - a._score);
          }
        } catch {}
      }
      if (facts.length > 0) {
        const snippet = String(task).slice(0, 80);
        const lines   = facts.map(f => `- [${f.confidence}] ${f.fact} (source: ${f.source})`);
        parts.push(`[Relevant Facts for: "${snippet}"]\n${lines.join('\n')}`);
      }
    } catch { /* skip */ }
  }

  // 4. Temporal awareness — skipped for build agents (they work in their own worktree)
  if (tier !== 'build') {
    try {
      const now = new Date();
      const lines = [`Now: ${now.toISOString()} (${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })})`];
      // Last 3 git commits and status — use 30-second cache to avoid blocking on every dispatch
      const gitCtx = getGitContext();
      if (gitCtx.log) lines.push(`Recent commits:\n${gitCtx.log}`);
      lines.push(`Working tree: ${gitCtx.status ? 'dirty\n' + gitCtx.status : 'clean'}`);
      if (lines.length > 1) parts.push(`[Now]\n${lines.join('\n')}`);
    } catch {}
  }

  // Session crystals — injected for full tier only; NOT in TRIM_ORDER (structurally protected)
  if (tier !== 'build') {
    try {
      const _cry = require('./crystals.cjs');
      const crystals = _cry.loadCrystals(memDir, 3)
        // Keep historical errors queryable on disk, but never reinject the
        // obsolete "Hermes is bounded/advisory" ontology as live identity.
        .filter(c => !/Hermes bounded(?:\/advisory)? context|bounded,? advisory context/i.test(c.text || ''));
      if (crystals.length) {
        parts.push('[Session Crystals — distilled memory from prior turns]\n' +
          crystals.map(c => `• ${c.text}`).join('\n'));
      }
    } catch {}
  }

  if (!parts.length) return returnStats ? { context: '', stats: { total: 0, sections: [], budget: effectiveMaxChars } } : '';
  // Include station architecture brief (compact for build agents)
  if (tier === 'build') {
    parts.push('[Working in: E:\\atlas-station isolated worktree. Do not orchestrate or call fleet tools — implement only.]');
  } else {
    parts.push(STATION_BRIEF);
  }

  // Dynamic startup awareness: projects, goals, self-instructions, build quality.
  // Full tier only — build agents work in isolation and don't need situational awareness.
  if (tier !== 'build') {
    const dynamicBrief = _buildDynamicBrief(memDir);
    if (dynamicBrief.trim()) {
      parts.push(dynamicBrief.trim());
    }
    // Estate primer (concepts + implementations + sibling projects) so ATLAS
    // knows the whole estate, not just atlas-station.
    parts.push(ESTATE_PRIMER);
    // Estate wake digest (E:\station) — cached by station-nerve, warmed by
    // fleethost's beat; empty until first beat, and that's fine.
    try {
      const estate = require('./station-nerve.cjs').cached();
      if (estate) parts.push('[Estate — station wake digest]\n' + estate);
    } catch {}
  }

  // Priority-ordered budget trim: temporal → session → journal → runs → facts. STATION_BRIEF never trimmed.
  const TRIM_ORDER = [
    /^\[Now\]/,
    /^\[Session Context/,
    /^\[Station Journal/,
    /^\[Recent Fleet Runs\]/,
    /^\[Relevant Facts/,
  ];
  let body = parts.join('\n\n');
  if (body.length > effectiveMaxChars) {
    for (const pattern of TRIM_ORDER) {
      if (body.length <= effectiveMaxChars) break;
      const idx = parts.findIndex(p => pattern.test(p));
      if (idx === -1) continue;
      const excess = body.length - effectiveMaxChars;
      if (excess >= parts[idx].length - 50) {
        parts.splice(idx, 1);
      } else {
        const keep = Math.max(100, parts[idx].length - excess);
        parts[idx] = parts[idx].slice(0, keep) + '\n[... trimmed]';
      }
      body = parts.join('\n\n');
    }
  }
  const assembled = `--- ATLAS MEMORY ---\n${body}\n--- END MEMORY ---`;
  if (returnStats) {
    const sectionStats = parts.map(s => {
      const lines = s.split('\n');
      const header = lines[0] || '(unnamed)';
      return { header: header.slice(0, 40), chars: s.length };
    });
    return { context: assembled, stats: { total: assembled.length, sections: sectionStats, budget: effectiveMaxChars } };
  }
  return assembled;
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
    // returnStats: buildContext hands back {context, stats}; combine the memory
    // block with the task and pass stats through (callers expect {context, stats}).
    if (opts.returnStats) {
      const mem = (ctx && ctx.context) || '';
      return { context: mem ? `${mem}\n\n${task}` : task, stats: (ctx && ctx.stats) || null };
    }
    if (!ctx) return task;
    return `${ctx}\n\n${task}`;
  } catch {
    return opts.returnStats ? { context: task, stats: null } : task;
  }
}

/**
 * buildContextStats(task, opts?) — Return size metadata for the assembled context block.
 *
 * Useful for diagnostics: shows total char count and per-section breakdown without
 * needing to parse the raw string. Never throws — returns zeroed struct on error.
 */
function buildContextStats(task, opts = {}) {
  try {
    const ctx = buildContext(task, opts);
    const sections = ctx.split('\n\n').filter(s => s.startsWith('['));
    return { totalChars: ctx.length, sections: sections.map(s => ({ header: s.split('\n')[0], chars: s.length })) };
  } catch { return { totalChars: 0, sections: [] }; }
}

/**
 * injectAsync(task, opts?) — Async version of inject that uses semantic fact recall.
 *
 * Attempts recallFactsSemantic first; if embedding model is unavailable or errors,
 * falls back to the synchronous keyword-based inject path automatically.
 * Never throws — memory failure is silent and non-blocking.
 *
 * TODO: When buildContext is refactored to be async, this bridge can be removed.
 */
async function injectAsync(task, opts = {}) {
  try {
    const ms = _getMemstore();
    if (ms && ms.recallFactsSemantic) {
      const {
        maxFacts  = 5,
        memDir    = path.join(__dirname, 'memory'),
        tier      = 'full',
      } = opts;
      const factLimit = tier === 'build' ? Math.max(maxFacts, 8) : maxFacts;
      const semanticFacts = await ms.recallFactsSemantic(task, { dir: memDir, maxResults: factLimit });
      if (semanticFacts && semanticFacts.length > 0) {
        const ctx = buildContext(task, { ...opts, _semanticFacts: semanticFacts });
        if (!ctx) return task;
        return `${ctx}\n\n${task}`;
      }
    }
  } catch { /* fall through */ }
  // Fallback to sync inject
  return inject(task, opts);
}

module.exports = { buildContext, buildContextStats, inject, injectAsync, loadJournalExcerpt };

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
