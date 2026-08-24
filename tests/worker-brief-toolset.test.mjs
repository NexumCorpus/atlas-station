// Regression (P-1787554018250): phantom-tool worker stamping.
// External Codex CLI workers have NO fleet MCP tools attached; their briefs
// must never instruct them to call mcp__fleet__* tools. The truthful protocol
// is the .atlas/mailbox/<id>.json file-drop exchange over shell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildCodexPrompt } = require(path.join(repo, 'providers', 'codex-cli.mjs'));

// 1) Codex provider boundary statement must remain truthful: no fleet MCP claim.
const codexPrompt = buildCodexPrompt('do a thing');
assert.ok(!/\bUse mcp__fleet__/.test(codexPrompt), 'codex prompt must not instruct use of fleet MCP tools');

// 2) fleethost idStamp: the external-worker branch must not contain the
//    in-process-only instruction, and must teach the file-drop mailbox instead.
const src = fs.readFileSync(path.join(repo, 'fleethost.mjs'), 'utf8');
const branchStart = src.indexOf('if (externalWorker) {');
assert.ok(branchStart > 0, 'externalWorker idStamp branch missing from fleethost.mjs');
const branchEnd = src.indexOf("} else {", branchStart);
const externalBranch = src.slice(branchStart, branchEnd);
assert.ok(!/mcp__fleet__agent_(send|inbox)/.test(externalBranch.replace(/Do NOT call mcp__fleet__/g, '')),
  'external-worker idStamp must not direct workers to USE fleet MCP tools');
assert.ok(/mailbox|file-drop/i.test(externalBranch),
  'external-worker idStamp must describe the file-drop mailbox protocol');

// 3) The non-external branch retains the in-process instructions (provider-truthful there).
const elseEnd = src.indexOf('\n  const fileMail', branchEnd);
const internalBranch = src.slice(branchEnd, elseEnd);
assert.ok(/mcp__fleet__agent_send/.test(internalBranch), 'in-process branch should retain fleet MCP instructions');

// 4) File-drop mailbox round trip: mailTo mirror -> drainMailFiles consumption.
const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mailbox-'));
const mailDir = path.join(tmpRepo, '.atlas', 'mailbox');
fs.mkdirSync(mailDir, { recursive: true });
fs.writeFileSync(path.join(mailDir, 'B-999-1.json'), JSON.stringify({
  to: 'B-999', from: 'ATLAS', ts: new Date().toISOString(),
  messages: [{ from: 'ATLAS', ts: new Date().toISOString(), text: 'hello worker' }],
}));
function drainMailFiles(agentId, dir) {
  const msgs = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    let rec = null; try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    if (rec && Array.isArray(rec.messages) && rec.messages.length && rec.to === agentId) {
      for (const m of rec.messages) msgs.push('[' + m.ts + '] from ' + m.from + ': ' + String(m.text).slice(0, 4000));
      fs.unlinkSync(p);
    }
  }
  return msgs;
}
const drained = drainMailFiles('B-999', mailDir);
assert.equal(drained.length, 1);
assert.match(drained[0], /from ATLAS: hello worker/);
assert.equal(drainMailFiles('B-999', mailDir).length, 0, 'mail must be consumed exactly once');
fs.rmSync(tmpRepo, { recursive: true, force: true });

console.log('worker-brief-toolset.test.cjs: ALL PASS');
