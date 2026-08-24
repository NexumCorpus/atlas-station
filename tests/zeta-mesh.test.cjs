'use strict';
/* tests/zeta-mesh.test.cjs - mocked-fetch coverage for zeta-mesh.cjs */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runMesh, splitReply } = require('../zeta-mesh.cjs');

function tmpReceipt() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zeta-mesh-')), 'receipt.ndjson');
}

function glyphReply(seed) {
  return `\u00a7T${seed}\u00a7 \u00a7A\u2192B\u00a7 \u00a7\u0394+1\u00a7\nPLAIN: plain expansion number ${seed} with some length to it.`;
}

// fetch mock: counts calls, can fail specific worker indexes per call
function makeMock(opts) {
  const calls = [];
  let n = 0;
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    const isMerge = body.messages[0].content.includes('synthesizer');
    calls.push({ url, init, body, isMerge });
    if (!isMerge) {
      const sys = body.messages[0].content;
      // worker index inferred from angle marker "#k"
      const m = sys.match(/#(\d+)/);
      const wi = m ? parseInt(m[1], 10) - 1 : 0;
      if (opts.failWorker === wi && !calls.some(c => !c.isMerge && JSON.parse(c.init.body).messages[0].content.match(/#(\d+)/)[1] == String(wi + 1))) {
        const res = { ok: false, status: 503, json: async () => ({}) };
        n++;
        return res;
      }
      if (opts.failWorkerAlways === wi) return { ok: false, status: 500, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: isMerge ? 'MERGED ANSWER' : glyphReply(String.fromCharCode(65 + (n++ % 26))) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('splitReply computes compression ratio', () => {
  const r = splitReply('\u00a7abc\nPLAIN: hello');
  assert.strictEqual(r.glyph, '\u00a7abc');
  assert.strictEqual(r.plain, 'hello');
  assert.strictEqual(r.ratio, 0.8);
});

test('fan-out: one call per angle in round 1 + merge', async () => {
  const rp = tmpReceipt();
  const f = makeMock({});
  const rec = await runMesh({ task: 'do thing', angles: 3, rounds: 1, apiKey: 'k', model: 'm', fetchImpl: f, receiptPath: rp });
  const workerCalls = f.calls.filter(c => !c.isMerge);
  assert.strictEqual(workerCalls.length, 3);
  assert.ok(f.calls.some(c => c.isMerge));
  assert.strictEqual(rec.survivors, 3);
  assert.strictEqual(rec.merged, 'MERGED ANSWER');
  // distinct angles
  const angles = new Set(rec.workers.map(w => w.angle));
  assert.strictEqual(angles.size, 3);
  assert.strictEqual(rec.verified, false);
});

test('round relay: round 2 system prompt carries peer outputs', async () => {
  const rp = tmpReceipt();
  const f = makeMock({});
  await runMesh({ task: 't', angles: 2, rounds: 2, apiKey: 'k', fetchImpl: f, receiptPath: rp });
  const round2 = f.calls.filter(c => !c.isMerge).filter(c => c.body.messages.filter(m => m.role === 'system').length >= 2);
  assert.ok(round2.length >= 2);
  for (const c of round2) {
    const lastSys = c.body.messages.filter(m => m.role === 'system').pop().content;
    assert.ok(lastSys.includes('PEER OUTPUTS'), 'round2 includes peers');
  }
});

test('partial failure survival: mesh completes when one worker dies', async () => {
  const rp = tmpReceipt();
  const f = makeMock({ failWorkerAlways: 0 });
  const rec = await runMesh({ task: 't', angles: 3, rounds: 1, apiKey: 'k', fetchImpl: f, receiptPath: rp });
  assert.strictEqual(rec.survivors, 2);
  assert.strictEqual(rec.deaths, 1);
  assert.ok(rec.workers[0].dead);
  assert.strictEqual(rec.merged, 'MERGED ANSWER');
});

test('ndjson receipt integrity: sha256 matches transcript, append-only', async () => {
  const rp = tmpReceipt();
  const f = makeMock({});
  const rec1 = await runMesh({ task: 'first', angles: 2, rounds: 1, apiKey: 'k', fetchImpl: f, receiptPath: rp });
  const rec2 = await runMesh({ task: 'second', angles: 1, rounds: 1, apiKey: 'k', fetchImpl: f, receiptPath: rp });
  const lines = fs.readFileSync(rp, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  for (const line of lines) {
    const { transcript, ...rest } = line;
    const receiptNoHash = { ...rest }; delete receiptNoHash.transcriptSha256;
    const h = crypto.createHash('sha256').update(JSON.stringify({ receipt: receiptNoHash, transcript })).digest('hex');
    assert.strictEqual(rest.transcriptSha256, h);
    assert.ok(rest.ts);
    assert.ok(rest.workers.every(w => w.usage && typeof w.compressionRatio === 'number'));
    assert.ok(rest.wallClockMs >= 0 && rest.speedup > 0);
    assert.strictEqual(rest.verified, false);
  }
  assert.notStrictEqual(lines[0].task, lines[1].task); // appended, not overwritten
});
