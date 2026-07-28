'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PYTHON = process.env.PYTHON || 'python';
const RUNTIME = path.join(__dirname, '.atlas', 'context-mycelium');
const MANIFEST = path.join(RUNTIME, 'crystals.ndjson');

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
function pythonShard(mode, payload) {
  const script = [
    'import sys,json,base64,importlib.util',
    'p=r"E:/station/shard_rs.py"',
    's=importlib.util.spec_from_file_location("station_shard",p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
    'x=json.loads(sys.stdin.read())',
    'if x["mode"]=="encode":',
    ' d=base64.b64decode(x["data"]); f,o=m.encode(d,x["k"],x["n"]); print(json.dumps({"origLen":o,"shards":[base64.b64encode(a).decode() for a in f]}))',
    'else:',
    ' f={int(k):base64.b64decode(v) for k,v in x["frags"].items()}; d=m.decode(f,x["k"],x["n"],x["origLen"]); print(json.dumps({"data":None if d is None else base64.b64encode(d).decode()}))'
  ].join('\n');
  const out = execFileSync(PYTHON, ['-c', script], { input: JSON.stringify({ mode, ...payload }), encoding: 'utf8', windowsHide: true });
  return JSON.parse(out);
}
function shardBytes(data, k = 2, n = 4) {
  const out = pythonShard('encode', { data: Buffer.from(data).toString('base64'), k, n });
  return { k, n, origLen: out.origLen, shards: out.shards.map((s, index) => ({ index, sha256: sha(Buffer.from(s, 'base64')), data: s })) };
}
function unshard(record) {
  const frags = {}; for (const shard of record.shards) {
    const raw = Buffer.from(shard.data, 'base64'); if (sha(raw) !== shard.sha256) throw new ContextTissueError(`shard ${shard.index} hash mismatch`);
    frags[shard.index] = raw.toString('base64');
  }
  const out = pythonShard('decode', { frags: Object.fromEntries(Object.entries(frags)), k: record.k, n: record.n, origLen: record.origLen });
  if (!out.data) throw new ContextTissueError('insufficient or singular shards', 'CONTEXT_SHARDS_INSUFFICIENT');
  return Buffer.from(out.data, 'base64');
}
function appendCrystal(record) {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const prior = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8').trim().split(/\r?\n/).filter(Boolean).at(-1) : '';
  const prev = prior ? JSON.parse(prior) : null;
  const body = { ...record, seq: (prev?.seq || 0) + 1, priorHash: prev?.recordHash || null, issuedAt: new Date().toISOString() };
  body.recordHash = sha(JSON.stringify(body));
  fs.appendFileSync(MANIFEST, JSON.stringify(body) + '\n', 'utf8');
  return body;
}
function readCrystals(untilSeq = Infinity) {
  if (!fs.existsSync(MANIFEST)) return [];
  const rows = fs.readFileSync(MANIFEST, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(r => r.seq <= untilSeq);
  let prior = null; let expected = 1;
  for (const row of rows) { const copy = { ...row }; delete copy.recordHash; if (row.seq !== expected || row.priorHash !== prior || row.recordHash !== sha(JSON.stringify(copy))) throw new ContextTissueError('crystal manifest chain mismatch', 'CONTEXT_MANIFEST_TAMPERED'); prior = row.recordHash; expected++; }
  return rows;
}
function parseSections(raw) {
  const body = String(raw).replace(/^--- ATLAS MEMORY ---\n?/, '').replace(/\n?--- END MEMORY ---\s*$/, '');
  return body.split(/\n\n+/).filter(Boolean).map((text, index) => {
    const header = text.split('\n')[0] || `section-${index}`;
    const lines = text.split('\n'); const seen = new Set(); const deduped = header.startsWith('[Recent Direct Dialogue]') ? lines.filter((line, lineIndex) => { if (lineIndex === 0) return true; const key = line.trim(); if (!key || seen.has(key)) return false; seen.add(key); return true; }).join('\n') : text;
    return { order: index, header, text: deduped, sourceText: text, deduped: deduped !== text, contentHash: sha(bytes(text)), provenance: { source: 'legacy-memory-builder', coordinates: { sectionIndex: index, header } } };
  });
}
function nucleus(task) {
  return [
    '[Context Mycelium Nucleus]',
    'identity: Hermes; executive: ATLAS; authority: Station-notarized, epoch/attempt fenced',
    'epistemic: inherited memory is evidence; claims require source-backed verification',
    `recovery: content-addressed crystal manifest at ${MANIFEST}; shard decoder E:/station/shard_rs.py`,
    `current task: ${String(task)}`
  ].join('\n');
}
function makeReference(hash, order) { return `[Mycelium ref ${hash} order=${order} shards=2/4 rehydrate=bounded-demand]`; }
function stableHeader(header) { return String(header).replace(/\s+\|\s+loaded .*\]$/, ']'); }
function build(task, opts, sourceBuilder) {
  const budget = budgetOf(opts); const n = nucleus(task); if (!within(n, budget)) throw new ContextNucleusError('declared ceiling cannot contain immutable nucleus', { nucleus: metrics(n), budget });
  const raw = sourceBuilder(task, { ...opts, _myceliumStable: true, maxContextChars: Math.max(Number(opts.maxContextChars || 6000), 1000000), returnStats: false });
  const sections = parseSections(raw);
  const taskLower = String(task).toLowerCase();
  const scored = sections.map(section => ({ ...section, score: section.order === 0 ? 100000 : taskLower.split(/\W+/).filter(Boolean).reduce((n, token) => n + (section.text.toLowerCase().includes(token) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score || a.order - b.order);
  const selected = []; const omitted = []; let hot = n;
  for (const section of scored) { const candidate = `${hot}\n\n${section.text}`; if (within(candidate, budget)) { selected.push(section); hot = candidate; } else omitted.push(section); }
  const tissue = []; const existing = readCrystals().filter(r => r.shards); for (const section of [...omitted, ...selected.filter(s => s.deduped)]) { const sourceText = section.sourceText || section.text; const row = existing.find(r => r.contentHash === section.contentHash) || appendCrystal({ contentHash: section.contentHash, utf8Bytes: bytes(sourceText).length, section: { order: section.order, header: section.header, provenance: section.provenance }, shards: shardBytes(bytes(sourceText)) }); tissue.push(row); }
  const omittedHashes = tissue.map(r => r.contentHash); const includedHashes = selected.map(s => s.contentHash);
  const crystalRoot = sha(JSON.stringify(omittedHashes)); const refs = tissue.map(r => makeReference(r.contentHash, r.section.order));
  const rootRef = `[Mycelium root ${crystalRoot} records=${tissue.length} manifest=${MANIFEST}]`;
  const withRefs = refs.length ? `${hot}\n\n${rootRef}\n${refs.join('\n')}` : hot;
  const finalText = `--- ATLAS MEMORY ---\n${withRefs}\n--- END MEMORY ---`;
  if (!within(finalText, budget)) { const compact = `${n}\n\n${rootRef}`; if (!within(`--- ATLAS MEMORY ---\n${compact}\n--- END MEMORY ---`, budget)) throw new ContextNucleusError('ceiling cannot contain nucleus and authenticated tissue root', { output: metrics(finalText), budget }); }
  const output = within(finalText, budget) ? finalText : `--- ATLAS MEMORY ---\n${n}\n\n${rootRef}\n--- END MEMORY ---`;
  const receiptBody = { schema: 1, sourceHead: gitHead(), budget, includedHashes, omittedHashes, crystalRoot, shardCoordinates: tissue.map(r => ({ contentHash: r.contentHash, seq: r.seq, indices: r.shards.shards.map(s => s.index), k: r.shards.k, n: r.shards.n })), outputHash: sha(bytes(output)), metrics: metrics(output), selectedReasons: selected.map(s => ({ contentHash: s.contentHash, order: s.order, score: s.score, reason: s.score ? 'task-relevant' : 'nucleus/order-fit' })) };
  const receipt = appendCrystal({ kind: 'selection-receipt', ...receiptBody });
  return { context: output, stats: { ...metrics(output), total: output.length, budget: budget.ceiling, units: budget.units, includedHashes, omittedHashes, crystalRoot, selectionReceiptHash: receipt.recordHash, manifestPath: MANIFEST, sections: receipt.selectedReasons, selectedReasons: receipt.selectedReasons, trimmedSections: omitted.map(s => `${stableHeader(s.header)}:sharded`) } };
}
function rehydrate(contentHash, opts = {}) {
  const until = Number(opts.manifestSeq || Infinity); const rows = readCrystals(until); const row = rows.find(r => r.contentHash === contentHash && r.shards); if (!row) throw new ContextTissueError('unknown or reordered tissue', 'CONTEXT_TISSUE_NOT_FOUND');
  const shardSet = Array.isArray(opts.availableShards) ? { ...row.shards, shards: row.shards.shards.filter(s => opts.availableShards.includes(s.index)) } : row.shards;
  const raw = unshard(shardSet); if (sha(raw) !== contentHash) throw new ContextTissueError('reconstructed content hash mismatch');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw); if (Buffer.from(text, 'utf8').compare(raw) !== 0) throw new ContextTissueError('tissue is not canonical UTF-8'); return { text, contentHash, provenance: row.section, recordHash: row.recordHash, shardCoordinates: row.shards.shards.map(s => s.index) };
}
function inject(task, opts, sourceBuilder) { const built = build(task, opts, sourceBuilder); return opts.returnStats ? { context: `${built.context}\n\n${task}`, stats: built.stats } : `${built.context}\n\n${task}`; }
module.exports = { build, inject, rehydrate, metrics, sha, ContextNucleusError, ContextTissueError, MANIFEST };
