# Capstone Phase 0: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze EGE under git, gate-merge director2 v3, and land Wing Protocol v1 with a passing acceptance test.

**Architecture:** Three independent repos, three independent tasks. Wing Protocol v1 = a host module (`wing-host.cjs`) that launches a wing process from a `wing.json` manifest, parses JSONL events from its stdout, writes commands as JSON files into a spool directory (gm pattern), and force-tags every `claim` event `verified:false` (no grader exists yet — Phase 3 adds it).

**Tech Stack:** git, pytest (EGE, director2), plain Node (atlas-station — no test framework, `node tests/x.mjs` scripts).

**Windows notes:** use `E:/`-style paths for Python, UTF-8 everywhere, no `/tmp` for Python work.

---

### Task 1: EGE git freeze

**Files:**
- Create: `E:/emergent-geometry-engine/.gitignore`
- Create: git repo at `E:/emergent-geometry-engine`

- [ ] **Step 1: Verify the certified state is green before freezing**

Run: `cd /e/emergent-geometry-engine && python -m pytest -q`
Expected: all tests pass (~71 per Phase 0 certification). If anything fails, STOP — freeze anyway with a `KNOWN-STATE.md` noting the failures, but flag to Daniel before Phase 5 cites EGE.

- [ ] **Step 2: Write .gitignore**

```gitignore
__pycache__/
*.pyc
.pytest_cache/
*.egg-info/
.venv/
venv/
```

- [ ] **Step 3: Init and freeze-commit**

```bash
cd /e/emergent-geometry-engine && git init -b master && git add -A && \
git commit -m "freeze: Phase 0 certified state under version control

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Verify**

Run: `git -C /e/emergent-geometry-engine log --oneline` → exactly 1 commit; `git status --short` → clean.

### Task 2: director2 v3 gate-merge

**Files:**
- Modify: git state only at `E:/director2` (currently on `exp/dose-response-thoroughness`; untracked files present — do not touch them)

- [ ] **Step 1: Suite on the exp branch**

Run: `cd /e/director2 && python -m pytest -q`
Expected: all pass (455+ tests). If FAIL → skip merge entirely, `git checkout master`, record failures in the ledger; master is the Phase 1+ base.

- [ ] **Step 2: Merge to master (only if Step 1 green)**

```bash
cd /e/director2 && git checkout master && git merge --no-ff exp/dose-response-thoroughness \
  -m "merge: nervous-system v3 (homeostat + self-model) — suite-gated"
```
If merge conflicts: `git merge --abort`, stay on master, record.

- [ ] **Step 3: Post-merge suite**

Run: `python -m pytest -q`
Expected: all pass. If FAIL: `git reset --hard ORIG_HEAD` (undoes only the merge commit), record, master-without-v3 is the base.

- [ ] **Step 4: Verify**

Run: `git log --oneline -3` → merge commit on master; suite green recorded in ledger.

### Task 3: Wing Protocol v1 (in `E:/atlas-wt-capstone`, branch `capstone/design`)

**Files:**
- Create: `docs/design/wing-protocol-v1.md`
- Create: `wings/echo/wing.json`
- Create: `wings/echo/echo-wing.mjs`
- Create: `wing-host.cjs`
- Test: `tests/wing.test.mjs`
- Modify: `package.json` (add `"test:wing": "node tests/wing.test.mjs"` to scripts)

- [ ] **Step 1: Write the failing acceptance test**

`tests/wing.test.mjs`:
```js
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startWing } = require('../wing-host.cjs');

const events = [];
const spool = mkdtempSync(path.join(tmpdir(), 'wing-spool-'));
const wing = startWing(path.resolve('wings/echo/wing.json'),
  { spoolDir: spool, onEvent: (e) => events.push(e) });

const waitFor = (pred, ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const hit = events.find(pred);
    if (hit) { clearInterval(iv); res(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout: ' + JSON.stringify(events))); }
  }, 25);
});

await waitFor(e => e.t === 'status' && e.state === 'ready');          // 1. health: wing announces ready
wing.send({ op: 'echo', payload: 'capstone' });
await waitFor(e => e.t === 'status' && e.echo === 'capstone');        // 2. spool command round-trips
wing.send({ op: 'claim', id: 'c1' });
const claim = await waitFor(e => e.t === 'claim' && e.id === 'c1');
assert.strictEqual(claim.verified, false);                            // 3. claims default UNVERIFIED
wing.send({ op: 'stop' });
await waitFor(e => e.t === 'status' && e.state === 'stopped');        // 4. clean shutdown
wing.stop();
console.log('wing protocol v1: ALL PASS');
process.exit(0);
```

- [ ] **Step 2: Run it — must fail** with "Cannot find module '../wing-host.cjs'"

Run: `cd /e/atlas-wt-capstone && node tests/wing.test.mjs`

- [ ] **Step 3: Write the manifest + echo wing**

`wings/echo/wing.json`:
```json
{
  "name": "echo",
  "version": 1,
  "launch": ["node", "echo-wing.mjs"],
  "capabilities": ["echo"]
}
```

`wings/echo/echo-wing.mjs`:
```js
import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
const spool = process.env.WING_SPOOL;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ t: 'status', state: 'ready' });
const tick = async () => {
  for (const f of (await readdir(spool)).filter(f => f.endsWith('.json')).sort()) {
    const p = path.join(spool, f);
    const cmd = JSON.parse(await readFile(p, 'utf8'));
    await unlink(p);
    if (cmd.op === 'echo') emit({ t: 'status', state: 'ready', echo: cmd.payload });
    else if (cmd.op === 'claim') emit({ t: 'claim', id: cmd.id, bundle: cmd.bundle ?? null });
    else if (cmd.op === 'stop') { emit({ t: 'status', state: 'stopped' }); process.exit(0); }
  }
  setTimeout(tick, 50);
};
tick();
```

- [ ] **Step 4: Write the host**

`wing-host.cjs`:
```js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Wing Protocol v1: launch from manifest, JSONL events out, spooled JSON commands in.
// Every claim is verified:false until an independent grader exists (Phase 3).
function startWing(manifestPath, { spoolDir, onEvent }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.mkdirSync(spoolDir, { recursive: true });
  const [cmd, ...args] = manifest.launch;
  const child = spawn(cmd, args, {
    cwd: path.dirname(manifestPath),
    env: { ...process.env, WING_SPOOL: spoolDir },
  });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { ev = { t: 'garbled', raw: line }; }
      if (ev.t === 'claim') ev.verified = false;
      onEvent(ev);
    }
  });
  let seq = 0;
  return {
    manifest,
    send(obj) {
      const f = path.join(spoolDir, `${Date.now()}-${String(seq++).padStart(4, '0')}.json`);
      fs.writeFileSync(f + '.tmp', JSON.stringify(obj));
      fs.renameSync(f + '.tmp', f);
    },
    stop() { child.kill(); },
    process: child,
  };
}
module.exports = { startWing };
```

- [ ] **Step 5: Run test — must pass**

Run: `node tests/wing.test.mjs` → `wing protocol v1: ALL PASS`

- [ ] **Step 6: Protocol doc + package script**

`docs/design/wing-protocol-v1.md`: document manifest fields (`name`, `version`, `launch`, `capabilities`), the four event types (`status`, `felt-state`, `need`, `claim` — `felt-state`/`need` reserved in v1, parsed but unused), spool command format (atomic write via `.tmp`+rename, consumed in sorted order, deleted after processing), and the claim-gate default. Add `"test:wing": "node tests/wing.test.mjs"` to `package.json` scripts.

- [ ] **Step 7: Commit**

```bash
git add wings wing-host.cjs tests/wing.test.mjs docs/design/wing-protocol-v1.md package.json
git commit -m "feat(wing): Wing Protocol v1 — manifest host, JSONL events, spool commands, claims default unverified

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

**Ledger requirement:** after all tasks, record what passed/failed/was skipped, honestly, in the final report.
