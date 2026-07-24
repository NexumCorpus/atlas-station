'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeDreamReceipt, loadDreamReceipts, sha256 } = require('../dream.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-dream-receipt-'));

const input = 'exact dream prompt';
const output = 'usage limit';
const receipt = writeDreamReceipt({
  dreamId: 'DREAM-300',
  pulseCount: 300,
  event: 'terminal',
  state: 'failed',
  task: 'dream protocol (pulse 300)',
  input,
  output,
  error: { name: 'DreamRunFailed', message: output },
  exit: { state: 'failed', code: null, signal: null },
}, dir);

assert.strictEqual(receipt.input, input);
assert.strictEqual(receipt.inputSha256, sha256(input));
assert.strictEqual(receipt.inputBytes, Buffer.byteLength(input, 'utf8'));
assert.strictEqual(receipt.output, output);
assert.strictEqual(receipt.outputSha256, sha256(output));
assert.deepStrictEqual(receipt.exit, { state: 'failed', code: null, signal: null });

const loaded = loadDreamReceipts(dir, 1);
assert.strictEqual(loaded.length, 1);
assert.strictEqual(loaded[0].dreamId, 'DREAM-300');
assert.strictEqual(loaded[0].error.message, output);

console.log('dream receipt contract: ALL PASS');
