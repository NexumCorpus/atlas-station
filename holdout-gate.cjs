// holdout-gate.cjs — BEFORE-merge holdout verification for fleet branches.
// Stages a fleet branch on a temp worktree off master, runs node --check on
// changed JS/MJS/CJS files plus the behavioral test suite against the staged
// tree. Never touches master. Appends JSONL receipts for accepted/rejected.
'use strict';
const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, appendFileSync, readFileSync } = require('fs');
const path = require('path');

function safeId(id) { return String(id).replace(/[^A-Za-z0-9._-]/g, '_'); }

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 15000,
  });
}

function receiptPath(repo) { return path.join(repo, '.atlas', 'receipts', 'holdout-reject.ndjson'); }
function acceptPath(repo) { return path.join(repo, '.atlas', 'receipts', 'holdout-accept.ndjson'); }

function recordReceipt(repo, file, entry) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

// Returns { pass, failedTests[], filesChecked[] , reason }
function stagedHoldout(agentId, repo) {
  const branch = 'fleet/' + agentId;
  const temp = 'holdout-temp-' + safeId(agentId) + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  const wtDir = path.join(path.dirname(repo), temp);
  const cleanup = () => {
    try { git(repo, ['worktree', 'remove', '--force', wtDir]); } catch (_) {}
    try { git(repo, ['branch', '-D', temp]); } catch (_) {}
  };
  const fail = (reason, failedTests = [], filesChecked = []) => {
    cleanup();
    return { pass: false, reason, failedTests, filesChecked };
  };
  let filesChecked = [];
  try {
    if (!existsSync(path.dirname(wtDir))) mkdirSync(path.dirname(wtDir), { recursive: true });
    cleanup();
    git(repo, ['worktree', 'add', '-f', '-b', temp, wtDir, 'master']);
    try {
      git(wtDir, ['merge', '--no-ff', '--no-commit', branch], { timeoutMs: 60000 });
    } catch (e) {
      return fail('merge conflict on ' + branch + ': ' + String(e.message || e).slice(0, 300));
    }
    const diff = git(repo, ['diff', '--name-only', 'master', branch]).trim();
    filesChecked = diff.split('\n').filter((f) => f && /\.(js|cjs|mjs)$/.test(f));
    for (const rel of filesChecked) {
      try {
        execFileSync(process.execPath, ['--check', path.join(wtDir, rel)], { timeout: 10000, stdio: 'pipe' });
      } catch (e) {
        return fail('syntax error in ' + rel, [rel + ': ' + String(e.stderr || e.message || '').slice(0, 200)], filesChecked);
      }
    }
    // Behavioral test suite against the staged tree
    const suite = path.join(wtDir, 'tests', 'behavioral.mjs');
    if (!existsSync(suite)) return fail('behavioral suite missing in staged tree', [], filesChecked);
    let out = '';
    try {
      out = execFileSync(process.execPath, [suite], { cwd: wtDir, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    const failMatch = out.match(/(\d+) failed/);
    if (failMatch && parseInt(failMatch[1], 10) > 0) {
      const failedTests = out.split('\n').filter((l) => l.trim().startsWith('FAIL:')).slice(0, 20)
        .map((l) => l.trim().slice(0, 200));
      return fail('behavioral tests failed (' + failMatch[1] + ')', failedTests.length ? failedTests : ['behavioral suite reported ' + failMatch[1] + ' failures'], filesChecked);
    }
    cleanup();
    return { pass: true, failedTests: [], filesChecked };
  } catch (e) {
    return fail('stagedHoldout error: ' + String(e.message || e).slice(0, 300), [], filesChecked);
  }
}

// Metric counters over time, derived from append-only receipts.
function counters(repo) {
  const tally = (file, key) => {
    try {
      if (!existsSync(file)) return 0;
      return readFileSync(file, 'utf8').split('\n').filter((l) => {
        if (!l.trim()) return false;
        try { const j = JSON.parse(l); return key === 'reject' ? !!j.agentId : !!j.agentId; } catch (_) { return false; }
      }).length;
    } catch (_) { return 0; }
  };
  return { accepted: tally(acceptPath(repo), 'accept'), rejected: tally(receiptPath(repo), 'reject') };
}

module.exports = { stagedHoldout, counters, recordReceipt, receiptPath, acceptPath };