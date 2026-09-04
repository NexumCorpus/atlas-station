const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function score(item) {
  const n = key => Math.max(0, Number(item[key]) || 0);
  return (1 + n('recurrence')) * (1 + n('verifiability')) * (1 + n('uncertainty')) * (1 + n('downstreamReuse')) / (1 + n('cost'));
}

function createLongMind(root, options = {}) {
  const dir = options.dir || path.join(root, '.atlas', 'long-mind');
  const ledgerFile = path.join(dir, 'ledger.ndjson');
  const stateFile = path.join(dir, 'state.json');
  fs.mkdirSync(dir, { recursive: true });
  let state = { version: 1, sequence: 0, head: null, cycles: 0, failures: 0, lastCycleAt: null, curriculum: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {}

  function append(kind, payload = {}) {
    const base = { version: 1, sequence: state.sequence + 1, timestamp: new Date().toISOString(), kind, previous: state.head, payload };
    const entry = { ...base, hash: hash(base) };
    fs.appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`, 'utf8');
    state.sequence = entry.sequence;
    state.head = entry.hash;
    atomicJson(stateFile, state);
    return entry;
  }

  function beginCycle({ provider, model, reason = 'scheduled', target = null } = {}) {
    const cycleId = `LM-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    state.cycles += 1;
    state.lastCycleAt = new Date().toISOString();
    append('cycle-start', { cycleId, provider, model, reason, target, epistemicStatus: 'observation' });
    return cycleId;
  }

  function settleCycle({ cycleId, status, summary, evidence = [], falsifier = null, killCondition = null } = {}) {
    const allowed = new Set(['observed', 'staged', 'rejected', 'failed']);
    if (!allowed.has(status)) throw new Error(`Long Mind cannot settle status '${status}'; promotion requires an external admission path.`);
    if (status === 'failed') state.failures += 1;
    return append('cycle-settle', { cycleId, status, summary, evidence, falsifier, killCondition, epistemicStatus: status === 'rejected' ? 'rejected' : 'observation' });
  }

  function recordBoundary({ accepted, rejected, discriminator, evidence = [], falsifier, killCondition = null } = {}) {
    if (!accepted || !rejected || !discriminator || !falsifier) throw new Error('A boundary requires accepted, rejected, discriminator, and falsifier.');
    return append('boundary', { accepted, rejected, discriminator, evidence, falsifier, killCondition, epistemicStatus: 'candidate' });
  }

  function addCurriculum(item) {
    const record = { id: item.id || `C-${Date.now()}`, ...item };
    record.score = score(record);
    state.curriculum = [...state.curriculum.filter(x => x.id !== record.id), record].sort((a, b) => b.score - a.score).slice(0, 128);
    append('curriculum', record);
    return record;
  }

  function selectTarget() { return state.curriculum.find(x => x.status !== 'retired') || null; }
  function status() { return { ...state, dir, ledgerFile, chain: verify() }; }
  function verify() {
    if (!fs.existsSync(ledgerFile)) return { valid: true, entries: 0, head: null };
    let previous = null; let sequence = 0;
    for (const line of fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const entry = JSON.parse(line); const { hash: claimed, ...base } = entry;
      if (base.previous !== previous || base.sequence !== sequence + 1 || hash(base) !== claimed) return { valid: false, entries: sequence, head: previous };
      previous = claimed; sequence = base.sequence;
    }
    return { valid: previous === state.head && sequence === state.sequence, entries: sequence, head: previous };
  }

  function recoverInterrupted() {
    if (!fs.existsSync(ledgerFile)) return null;
    const lines = fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    if (last.kind !== 'cycle-start') return null;
    state.failures += 1;
    return append('cycle-settle', {
      cycleId: last.payload?.cycleId,
      status: 'failed',
      summary: 'Prior process ended before cycle settlement; recovered as an interrupted observation.',
      evidence: [last.hash],
      falsifier: 'a terminal receipt for the same cycle exists elsewhere',
      killCondition: 'repeated interruption at the same phase',
      epistemicStatus: 'observation',
    });
  }

  function buildPrompt({ cycleId, target, provider, model } = {}) {
    return `[LONG MIND CYCLE ${cycleId}]\nCortex: ${provider}/${model}. Target: ${target ? JSON.stringify(target) : 'select the highest-value unresolved local residue'}.\n\nPerform exactly one bounded, reversible learning experiment. Sequentially inhabit these roles, passing artifacts rather than persuasive prose: (1) compiler freezes one falsifiable claim and same-surface metric; (2) historian retrieves relevant source, receipts, failures, and nearest negative boundary; (3) minimal constructor proposes the smallest mutation; (4) radical constructor proposes a structurally different mutation; (5) attacker seeks the cheapest counterexample and hidden circularity; (6) verifier runs the frozen check in an isolated worktree; (7) adjudicator records observed/staged/rejected only.\n\nYou may inspect freely and create isolated build candidates. Do not merge, push, publish, spend, contact outsiders, alter credentials, or claim self-improvement from a summary. A candidate survives only with exact commands/artifacts, a falsifier, kill condition, and its nearest rejected sibling plus discriminator. If no mutation survives, record the negative boundary: that is useful learning. Preserve live constraints verbatim and use summaries only as navigation to byte-exact evidence. End with a compact JSON envelope containing exactly this cycle_id: ${cycleId}; output lacking that identifier is rejected as stale context.`;
  }

  return { beginCycle, settleCycle, recordBoundary, addCurriculum, selectTarget, status, verify, recoverInterrupted, buildPrompt };
}

module.exports = { createLongMind, score, canonical };
