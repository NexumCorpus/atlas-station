// Regression (B-170 class): builds dying at error_max_turns left zero durable work.
// WIP checkpoints: every CHECKPOINT_TURNS turns during a BUILD-lane run the runner
// must snapshot attributable work (commit in isolated worktree; dirty-file list on
// shared tree), and terminal receipts must carry the checkpoint path for successors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(repo, 'fleethost.mjs'), 'utf8');

// 1) Configurable cadence via env CHECKPOINT_TURNS, default 10.
assert.match(src, /CHECKPOINT_TURNS \|\| '10'/, 'CHECKPOINT_TURNS env default must be 10');

// 2) Checkpoints fire only for build-lane runs inside consume().
const hook = src.match(/if \(build && turns > 0 && turns % CHECKPOINT_TURNS === 0\) wipCheckpoint\(id, branch\);/);
assert.ok(hook, 'consume() must hook wipCheckpoint on turn multiples (build lane only)');

// 3) Isolated worktree path commits attributable work.
assert.match(src, /kind: "wip-commit"/, 'worktree checkpoints must produce wip-commit records');

// 4) Shared dirty tree: file list only — never commit another process changes.
assert.match(src, /kind: "dirty-file-list"/, 'shared-tree checkpoints must record a dirty-file list');
const fnStart = src.indexOf('function wipCheckpoint(');
const fnEnd = src.indexOf('\n}', fnStart);
const fnBody = src.slice(fnStart, fnEnd);
assert.ok(!/["']commit["'], "-m"[^;]*branch\)\s*;?\s*$/m.test(fnBody.replace(/if \(branch\) \{[\s\S]*?\n    \} else \{/, '')), 'no commit allowed on the shared-tree branch');
const elseIdx = fnBody.indexOf("} else {");
const sharedBranch = fnBody.slice(elseIdx);
assert.ok(!/"-C", cwd, "commit"/.test(sharedBranch), 'shared-tree branch must not run git commit');

// 5) Terminal receipt carries checkpointPath so a successor can resume.
assert.match(src, /failSubtype: done \? undefined : m\.subtype, lastToolArg: null, \.\.\.\(build \? \{ checkpointPath:/,
  'agent state at result must include checkpointPath for build lanes');
assert.match(src, /checkpointPath: build \? \(agents\.get\(id\)\?\.checkpointPath \?\? null\) : null,/,
  'memstore appendRun receipt must record checkpointPath');
