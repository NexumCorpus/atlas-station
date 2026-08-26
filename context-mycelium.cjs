'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const shardCodec = require('./shard-codec.cjs');
const appendLock = require('./append-lock.cjs');

const RUNTIME = path.join(__dirname, '.atlas', 'context-mycelium');
const MANIFEST = path.join(RUNTIME, 'crystals.ndjson');
const MANIFEST_LOCK = `${MANIFEST}.lock`;

function sha(value) { return `sha256:${crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex')}`; }
function bytes(text) { return Buffer.from(String(text), 'utf8'); }
function metrics(text) {
  const b = bytes(text); const utf16 = String(text).length;
  return { utf8Bytes: b.length, utf16Units: utf16, conservativeTokens: Math.ceil(b.length / 3) };
}
class ContextNucleusError extends Error { constructor(message, details) { super(message); this.name = 'ContextNucleusError'; this.code = 'CONTEXT_NUCLEUS_OVERFLOW'; this.details = details; } }
class ContextTissueError extends Error { constructor(message, code = 'CONTEXT_TISSUE_INVALID') { super(message); this.name = 'ContextTissueError'; this.code = code; } }

function budgetOf(opts) {
  const n = Number(opts.maxContextChars == null ? 6000 : opts.maxContextChars);
  if (!Number.isFinite(n) || n < 1) throw new ContextNucleusError('invalid context ceiling', { maxContextChars: n });
  return { units: 'utf8-bytes:utf16-code-units:conservative-tokens', ceiling: Math.floor(n) };
}
function within(text, budget) { const m = metrics(text); return m.utf8Bytes <= budget.ceiling && m.utf16Units <= budget.ceiling && m.conservativeTokens <= budget.ceiling; }
function gitHead() { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8', windowsHide: true }).trim(); } catch { return 'unknown'; } }
function shardBytes(data, k = 2, n = 4) {
  const out = shardCodec.encode(Buffer.from(data), k, n);
  return { k, n, origLen: out.origLen, shards: out.shards.map((raw, index) => ({ index, sha256: sha(raw), data: raw.toString('base64') })) };
}
function unshard(record) {
  const frags = {}; for (const shard of record.shards) {
    const raw = Buffer.from(shard.data, 'base64'); if (sha(raw) !== shard.sha256) throw new ContextTissueError(`shard ${shard.index} hash mismatch`);
    frags[shard.index] = raw;
  }
  try { return shardCodec.decode(frags, record.k, record.n, record.origLen); }
  catch { throw new ContextTissueError('insufficient or singular shards', 'CONTEXT_SHARDS_INSUFFICIENT'); }
}
function readCrystalsUnlocked(untilSeq = Infinity) {
  if (!fs.existsSync(MANIFEST)) return [];
  const rows = fs.readFileSync(MANIFEST, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(r => r.seq <= untilSeq);
  let prior = null; let expected = 1;
  for (const row of rows) { const copy = { ...row }; delete copy.recordHash; if (row.seq !== expected || row.priorHash !== prior || row.recordHash !== sha(JSON.stringify(copy))) throw new ContextTissueError('crystal manifest chain mismatch', 'CONTEXT_MANIFEST_TAMPERED'); prior = row.recordHash; expected++; }
  return rows;
}
function appendCrystal(record) {
  fs.mkdirSync(RUNTIME, { recursive: true });
  let lock;
  try {
    lock = appendLock.acquire(MANIFEST_LOCK, 10_000);
    const rows = readCrystalsUnlocked();
    const prev = rows.at(-1) || null;
    const body = { ...record, seq: (prev?.seq || 0) + 1, priorHash: prev?.recordHash || null, issuedAt: new Date().toISOString() };
    body.recordHash = sha(JSON.stringify(body));
    const fd = fs.openSync(MANIFEST, 'a', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(body)}\n`, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return body;
  } finally {
    appendLock.release(MANIFEST_LOCK, lock);
  }
}
function readCrystals(untilSeq = Infinity) {
  fs.mkdirSync(RUNTIME, { recursive: true });
  let lock;
  try {
    lock = appendLock.acquire(MANIFEST_LOCK, 10_000);
    return readCrystalsUnlocked(untilSeq);
  } finally {
    appendLock.release(MANIFEST_LOCK, lock);
  }
}
function tissueFor(section, rows) {
  const found = rows.find(row => row.shards && row.contentHash === section.sourceHash);
  if (found) return found;
  const row = appendCrystal({
    kind: 'tissue',
    contentHash: section.sourceHash,
    utf8Bytes: bytes(section.sourceText).length,
    section: { order: section.order, header: section.header, provenance: section.provenance },
    shards: shardBytes(bytes(section.sourceText))
  });
  rows.push(row);
  return row;
}
function indexFor(tissue) {
  return tissue.slice().sort((a, b) => a.section.order - b.section.order || a.contentHash.localeCompare(b.contentHash)).map(row => ({
    contentHash: row.contentHash,
    seq: row.seq,
    recordHash: row.recordHash,
    k: row.shards.k,
    n: row.shards.n,
    indices: row.shards.shards.map(shard => shard.index),
    section: row.section
  }));
}
function selectionReceipt(body, rows) {
  const selectionKey = sha(JSON.stringify(body));
  const found = rows.find(row => row.kind === 'selection-receipt' && row.selectionKey === selectionKey);
  if (found) return found;
  const row = appendCrystal({ kind: 'selection-receipt', selectionKey, ...body });
  rows.push(row);
  return row;
}
function parseSections(raw) {
  const body = String(raw).replace(/^--- ATLAS MEMORY ---\n?/, '').replace(/\n?--- END MEMORY ---\s*$/, '');
  return body.split(/\n\n+/).filter(Boolean).map((text, index) => {
    const header = text.split('\n')[0] || `section-${index}`;
    const lines = text.split('\n'); const seen = new Set(); const deduped = header.startsWith('[Recent Direct Dialogue]') ? lines.filter((line, lineIndex) => { if (lineIndex === 0) return true; const key = line.trim(); if (!key || seen.has(key)) return false; seen.add(key); return true; }).join('\n') : text;
    return {
      order: index,
      header,
      text: deduped,
      sourceText: text,
      deduped: deduped !== text,
      sourceHash: sha(bytes(text)),
      hotHash: sha(bytes(deduped)),
      provenance: { source: 'legacy-memory-builder', coordinates: { sectionIndex: index, header } }
    };
  });
}
function nucleus(task) {
  return [
    '[Context Mycelium Nucleus]',
    'identity: Hermes; executive: ATLAS; authority: Station-notarized, epoch/attempt fenced',
    'epistemic: inherited memory is evidence; claims require source-backed verification',
    `recovery: content-addressed crystal manifest at ${MANIFEST}; shard decoder native:shard-codec.cjs`,
    `current task: ${String(task)}`
  ].join('\n');
}
function makeReference(item) { return `[Mycelium ref ${item.contentHash} order=${item.section.order} shards=${item.k}/${item.n} rehydrate=bounded-demand]`; }
function makeRootReference(root, count) { return `[Mycelium root ${root} records=${count} index=rehydrateRoot]`; }
function stableHeader(header) { return String(header).replace(/\s+\|\s+loaded .*\]$/, ']'); }
function build(task, opts, sourceBuilder) {
  const budget = budgetOf(opts); const n = nucleus(task); if (!within(n, budget)) throw new ContextNucleusError('declared ceiling cannot contain immutable nucleus', { nucleus: metrics(n), budget });
  const raw = sourceBuilder(task, { ...opts, _myceliumStable: true, maxContextChars: Math.max(Number(opts.maxContextChars || 6000), 1000000), returnStats: false });
  const sections = parseSections(raw);
  const taskLower = String(task).toLowerCase();
  const scored = sections.map(section => ({ ...section, score: section.order === 0 ? 100000 : taskLower.split(/\W+/).filter(Boolean).reduce((n, token) => n + (section.text.toLowerCase().includes(token) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score || a.order - b.order);
  const selected = []; const cold = [];
  const wrap = body => `--- ATLAS MEMORY ---\n${body}\n--- END MEMORY ---`;
  for (const section of scored) {
    const hot = [n, ...selected, section].map(item => typeof item === 'string' ? item : item.text).join('\n\n');
    if (within(wrap(hot), budget)) selected.push(section); else cold.push(section);
  }
  const rows = readCrystals();
  let tissueSections = [...cold, ...selected.filter(section => section.deduped)];
  let tissue = []; let rootIndex = []; let crystalRoot = sha('[]'); let output = '';
  while (true) {
    const unique = new Map(tissueSections.map(section => [section.sourceHash, section]));
    tissue = [...unique.values()].map(section => tissueFor(section, rows));
    rootIndex = indexFor(tissue);
    crystalRoot = sha(JSON.stringify(rootIndex));
    const hot = [n, ...selected.slice().sort((a, b) => a.order - b.order).map(section => section.text)];
    if (rootIndex.length) {
      const rootRef = makeRootReference(crystalRoot, rootIndex.length);
      const full = wrap([...hot, `${rootRef}\n${rootIndex.map(makeReference).join('\n')}`].join('\n\n'));
      if (within(full, budget)) { output = full; break; }
      const compact = wrap([...hot, rootRef].join('\n\n'));
      if (within(compact, budget)) { output = compact; break; }
    } else {
      const noCold = wrap(hot.join('\n\n'));
      if (within(noCold, budget)) { output = noCold; break; }
    }
    const evicted = selected.pop();
    if (!evicted) throw new ContextNucleusError('ceiling cannot contain nucleus and authenticated tissue root', { root: metrics(makeRootReference(crystalRoot, rootIndex.length)), budget });
    cold.push(evicted); tissueSections.push(evicted);
  }
  const includedHashes = selected.map(section => section.hotHash);
  const omittedHashes = rootIndex.map(item => item.contentHash);
  const selectedReasons = selected.map(section => ({ contentHash: section.hotHash, order: section.order, score: section.score, reason: section.score ? 'task-relevant' : 'nucleus/order-fit' }));
  const receiptBody = {
    schema: 2,
    sourceHead: gitHead(),
    budget,
    includedHashes,
    omittedHashes,
    crystalRoot,
    rootIndex,
    shardCoordinates: rootIndex.map(item => ({ contentHash: item.contentHash, seq: item.seq, indices: item.indices, k: item.k, n: item.n })),
    outputHash: sha(bytes(output)),
    metrics: metrics(output),
    selectedReasons
  };
  const receipt = selectionReceipt(receiptBody, rows);
  return {
    context: output,
    stats: {
      ...metrics(output),
      total: output.length,
      budget: budget.ceiling,
      units: budget.units,
      includedHashes,
      omittedHashes,
      crystalRoot,
      selectionReceiptHash: receipt.recordHash,
      manifestPath: MANIFEST,
      sections: selectedReasons,
      selectedReasons,
      trimmedSections: [...new Set(tissueSections.map(section => `${stableHeader(section.header)}:${section.deduped && selected.includes(section) ? 'deduplicated-' : ''}sharded`))]
    }
  };
}
function rehydrateRoot(crystalRoot, opts = {}) {
  const rows = readCrystals(Number(opts.manifestSeq || Infinity));
  const receipt = rows.filter(row => row.kind === 'selection-receipt' && row.crystalRoot === crystalRoot && Array.isArray(row.rootIndex)).at(-1);
  if (!receipt) throw new ContextTissueError('unknown root index', 'CONTEXT_ROOT_NOT_FOUND');
  if (sha(JSON.stringify(receipt.rootIndex)) !== crystalRoot) throw new ContextTissueError('root index hash mismatch', 'CONTEXT_ROOT_TAMPERED');
  const hashes = new Set(); const coordinates = new Set();
  for (const item of receipt.rootIndex) {
    if (item.contentHash === crystalRoot) throw new ContextTissueError('circular root reference', 'CONTEXT_ROOT_CIRCULAR');
    const coordinate = `${item.seq}:${item.section?.order}`;
    if (hashes.has(item.contentHash) || coordinates.has(coordinate)) throw new ContextTissueError('duplicate root coordinate', 'CONTEXT_ROOT_DUPLICATE');
    hashes.add(item.contentHash); coordinates.add(coordinate);
    const tissue = rows.find(row => row.seq === item.seq);
    if (!tissue || !tissue.shards || tissue.contentHash !== item.contentHash || tissue.recordHash !== item.recordHash) throw new ContextTissueError('root coordinate mismatch', 'CONTEXT_ROOT_MISMATCH');
  }
  const limit = Math.max(1, Math.min(64, Number(opts.limit || 16)));
  const cursor = Math.max(0, Number(opts.cursor || 0));
  const items = receipt.rootIndex.slice(cursor, cursor + limit);
  const nextCursor = cursor + items.length < receipt.rootIndex.length ? cursor + items.length : null;
  return { crystalRoot, total: receipt.rootIndex.length, items, nextCursor, receiptHash: receipt.recordHash };
}
function rehydrate(contentHash, opts = {}) {
  const until = Number(opts.manifestSeq || Infinity); const rows = readCrystals(until); const row = rows.find(r => r.contentHash === contentHash && r.shards); if (!row) throw new ContextTissueError('unknown or reordered tissue', 'CONTEXT_TISSUE_NOT_FOUND');
  const shardSet = Array.isArray(opts.availableShards) ? { ...row.shards, shards: row.shards.shards.filter(s => opts.availableShards.includes(s.index)) } : row.shards;
  const raw = unshard(shardSet); if (sha(raw) !== contentHash) throw new ContextTissueError('reconstructed content hash mismatch');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw); if (Buffer.from(text, 'utf8').compare(raw) !== 0) throw new ContextTissueError('tissue is not canonical UTF-8'); return { text, contentHash, provenance: row.section, recordHash: row.recordHash, shardCoordinates: row.shards.shards.map(s => s.index) };
}
function inject(task, opts, sourceBuilder) { const built = build(task, opts, sourceBuilder); return opts.returnStats ? { context: `${built.context}\n\n${task}`, stats: built.stats } : `${built.context}\n\n${task}`; }
module.exports = { build, inject, rehydrate, rehydrateRoot, metrics, sha, ContextNucleusError, ContextTissueError, MANIFEST };
