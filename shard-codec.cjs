'use strict';

const EXP = new Uint8Array(512);
const LOG = new Int16Array(256);
let fieldValue = 1;
for (let exponent = 0; exponent < 255; exponent++) {
  EXP[exponent] = fieldValue;
  LOG[fieldValue] = exponent;
  fieldValue <<= 1;
  if (fieldValue & 0x100) fieldValue ^= 0x11d;
}
for (let exponent = 255; exponent < EXP.length; exponent++) EXP[exponent] = EXP[exponent - 255];

function multiply(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
function inverse(value) {
  if (!value) throw new Error('singular shard matrix');
  return EXP[255 - LOG[value]];
}

function invert(matrix) {
  const size = matrix.length;
  const rows = matrix.map((row, index) => Uint8Array.from([...row, ...Array.from({ length: size }, (_, column) => Number(column === index))]));
  for (let column = 0; column < size; column++) {
    let pivot = column;
    while (pivot < size && !rows[pivot][column]) pivot++;
    if (pivot === size) throw new Error('singular shard matrix');
    if (pivot !== column) [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const scale = inverse(rows[column][column]);
    for (let offset = 0; offset < size * 2; offset++) rows[column][offset] = multiply(rows[column][offset], scale);
    for (let row = 0; row < size; row++) {
      if (row === column || !rows[row][column]) continue;
      const factor = rows[row][column];
      for (let offset = 0; offset < size * 2; offset++) rows[row][offset] ^= multiply(factor, rows[column][offset]);
    }
  }
  return rows.map(row => row.slice(size));
}

function generator(k, n) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || k > n || n > 256) throw new Error('shard dimensions require 1 <= k <= n <= 256');
  return Array.from({ length: n }, (_, row) => {
    if (row < k) return Array.from({ length: k }, (_, column) => Number(row === column));
    return Array.from({ length: k }, (_, column) => inverse(row ^ column));
  });
}

function transform(rows, coefficients, width) {
  return coefficients.map(coefficientRow => {
    const output = Buffer.alloc(width);
    for (let byte = 0; byte < width; byte++) {
      let value = 0;
      for (let row = 0; row < rows.length; row++) value ^= multiply(coefficientRow[row], rows[row][byte]);
      output[byte] = value;
    }
    return output;
  });
}


// --- Per-shard sealing: detect + localize corruption before reconstruction ---
// Research basis (2026-08-26): erasure-coded systems (Backblaze Vault et al.) store a
// checksum beside every shard so bit-rot is caught locally instead of only at
// whole-file rehash during recovery. Sealed shards are verified on decode; corrupt
// fragments are named and excluded, so recovery proceeds from survivors.
const crypto = require('crypto');
function sealShards(shards) {
  return shards.map(data => crypto.createHash('sha256').update(data).digest('hex'));
}
function verifyShards(fragments, checksums) {
  const corrupt = [];
  for (const [index, data] of Object.entries(fragments)) {
    if (!checksums || !checksums[index]) continue;
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== checksums[index]) corrupt.push(Number(index));
  }
  return { ok: corrupt.length === 0, corrupt };
}

function encode(input, k = 2, n = 4) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const matrix = generator(k, n);
  const width = Math.ceil(data.length / k);
  const padded = Buffer.alloc(width * k);
  data.copy(padded);
  const rows = Array.from({ length: k }, (_, index) => padded.subarray(index * width, (index + 1) * width));
  const shardOutputs = transform(rows, matrix, width);
  return { origLen: data.length, shards: shardOutputs, checksums: sealShards(shardOutputs) };
}

function decode(fragments, k, n, origLen) {
  const matrix = generator(k, n);
  if (!Number.isSafeInteger(origLen) || origLen < 0) throw new Error('invalid original length');
  const entries = Object.entries(fragments || {}).map(([index, data]) => [Number(index), data]).sort((a, b) => a[0] - b[0]);
  if (entries.length < k) throw new Error('insufficient shards');
  const indices = new Set();
  let width = null;
  for (const [index, data] of entries) {
    if (!Number.isInteger(index) || index < 0 || index >= n || indices.has(index) || !Buffer.isBuffer(data)) throw new Error('invalid shard set');
    indices.add(index);
    if (width == null) width = data.length;
    if (data.length !== width) throw new Error('inconsistent shard lengths');
  }
  if (origLen > width * k) throw new Error('original length exceeds shard capacity');
  const selected = entries.slice(0, k);
  const recovery = invert(selected.map(([index]) => matrix[index]));
  return Buffer.concat(transform(selected.map(([, data]) => data), recovery, width)).subarray(0, origLen);
}

module.exports = { encode, decode, sealShards, verifyShards };
