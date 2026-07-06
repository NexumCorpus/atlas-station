'use strict';
// ATLAS Station — persistent project store.
//
// Projects are multi-session initiatives with phases and milestones —
// something between a goal (one objective) and a routine (a fixed sequence).
// Backed by memory/projects.ndjson (one JSON object per line).
//
// Self-test: `node projects.cjs`

const fs   = require('fs');
const path = require('path');

const PROJECTS_FILE = 'projects.ndjson';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _load(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, PROJECTS_FILE), 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function _save(projects, dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const _fp = path.join(dir, PROJECTS_FILE);
  fs.writeFileSync(_fp + '.tmp', projects.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
  fs.renameSync(_fp + '.tmp', _fp);
}

function _defaultDir() {
  return path.join(__dirname, 'memory');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * createProject(name, description, phases, options, memDir)
 *
 * phases: string[] (e.g. ["Research", "Build", "Verify", "Deploy"])
 * options: { area?, milestones?, linkedGoalId? }
 * Returns the new project object.
 */
function createProject(name, description, phases, options, memDir) {
  memDir = memDir || _defaultDir();
  options = options || {};
  const now = new Date().toISOString();
  const milestones = (options.milestones || []).map(label => ({ label, done: false, doneTs: null }));
  const project = {
    id: 'P-' + Date.now(),
    ts: now,
    updatedTs: now,
    name: name || 'Untitled Project',
    description: description || '',
    area: options.area || 'general',
    phases: phases && phases.length ? phases : ['Phase 1'],
    currentPhaseIndex: 0,
    milestones,
    linkedGoalId: options.linkedGoalId || null,
    status: 'active',
    log: [{ ts: now, action: 'created', notes: description || '' }],
  };
  const projects = _load(memDir);
  projects.push(project);
  _save(projects, memDir);
  return project;
}

/**
 * advanceProject(id, notes, memDir)
 *
 * Move to next phase, recording transition notes.
 * If already on last phase, sets status to 'completed'.
 * Returns the updated project, or null if not found.
 */
function advanceProject(id, notes, memDir) {
  memDir = memDir || _defaultDir();
  const projects = _load(memDir);
  const p = projects.find(p => p.id === id);
  if (!p) return null;
  const now = new Date().toISOString();
  p.updatedTs = now;
  const prevPhase = p.phases[p.currentPhaseIndex] || 'unknown';
  if (p.currentPhaseIndex >= p.phases.length - 1) {
    // Already on last phase — complete it
    p.status = 'completed';
    p.log.push({ ts: now, action: 'completed', notes: notes || '' });
  } else {
    p.currentPhaseIndex++;
    const nextPhase = p.phases[p.currentPhaseIndex];
    p.log.push({ ts: now, action: `advanced: ${prevPhase} → ${nextPhase}`, notes: notes || '' });
  }
  _save(projects, memDir);
  return p;
}

/**
 * updateProject(id, changes, memDir)
 *
 * Patch any fields: status, currentPhaseIndex, notes, linkedGoalId, etc.
 * Returns the updated project, or null if not found.
 */
function updateProject(id, changes, memDir) {
  memDir = memDir || _defaultDir();
  const projects = _load(memDir);
  const p = projects.find(p => p.id === id);
  if (!p) return null;
  const now = new Date().toISOString();
  Object.assign(p, changes, { updatedTs: now });
  const action = changes.status ? `status → ${changes.status}` : 'updated';
  const notes = changes.notes || '';
  p.log = p.log || [];
  p.log.push({ ts: now, action, notes });
  _save(projects, memDir);
  return p;
}

/**
 * listProjects(filter, memDir)
 *
 * filter: 'active' | 'all' | 'completed' — default 'active'
 * Returns array of project objects.
 */
function listProjects(filter, memDir) {
  memDir = memDir || _defaultDir();
  const all = _load(memDir);
  const f = filter || 'active';
  if (f === 'all') return all;
  if (f === 'completed') return all.filter(p => p.status === 'completed');
  return all.filter(p => p.status === 'active'); // default
}

/**
 * getProject(id, memDir)
 *
 * Returns single project object, or null if not found.
 */
function getProject(id, memDir) {
  memDir = memDir || _defaultDir();
  return _load(memDir).find(p => p.id === id) || null;
}

module.exports = { createProject, advanceProject, updateProject, listProjects, getProject };

// ---------------------------------------------------------------------------
// Self-test: `node projects.cjs`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  const os = require('os');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-selftest-'));
  let ok = false;

  try {
    // createProject
    const p1 = createProject('Test Project', 'A test', ['Alpha', 'Beta', 'Gamma'], { area: 'fleet', milestones: ['Ship v1'] }, testDir);
    assert.ok(p1.id.startsWith('P-'), 'id should start with P-');
    assert.strictEqual(p1.name, 'Test Project');
    assert.strictEqual(p1.phases.length, 3);
    assert.strictEqual(p1.currentPhaseIndex, 0);
    assert.strictEqual(p1.status, 'active');
    assert.strictEqual(p1.milestones.length, 1);
    assert.strictEqual(p1.milestones[0].done, false);

    // listProjects active
    const active = listProjects('active', testDir);
    assert.strictEqual(active.length, 1);

    // getProject
    const fetched = getProject(p1.id, testDir);
    assert.strictEqual(fetched.name, 'Test Project');

    // advanceProject
    const adv1 = advanceProject(p1.id, 'Alpha done', testDir);
    assert.strictEqual(adv1.currentPhaseIndex, 1);
    assert.strictEqual(adv1.status, 'active');

    const adv2 = advanceProject(p1.id, 'Beta done', testDir);
    assert.strictEqual(adv2.currentPhaseIndex, 2);

    // Last phase → completed
    const adv3 = advanceProject(p1.id, 'Gamma done', testDir);
    assert.strictEqual(adv3.status, 'completed');

    // listProjects completed
    const completed = listProjects('completed', testDir);
    assert.strictEqual(completed.length, 1);

    // listProjects active should now be empty
    const active2 = listProjects('active', testDir);
    assert.strictEqual(active2.length, 0);

    // updateProject
    const p2 = createProject('Another', 'desc', ['Phase 1'], {}, testDir);
    const updated = updateProject(p2.id, { status: 'abandoned' }, testDir);
    assert.strictEqual(updated.status, 'abandoned');

    // listProjects all
    const all = listProjects('all', testDir);
    assert.strictEqual(all.length, 2);

    // getProject returns null for unknown id
    const missing = getProject('P-9999999', testDir);
    assert.strictEqual(missing, null);

    // advanceProject returns null for unknown id
    const noAdv = advanceProject('P-9999999', '', testDir);
    assert.strictEqual(noAdv, null);

    ok = true;
  } catch (err) {
    console.error('FAIL:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
