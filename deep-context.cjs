'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java',
  '.js', '.json', '.jsx', '.md', '.mjs', '.cjs', '.ps1', '.py', '.rs', '.sh',
  '.sql', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);
const EXTENSIONLESS = new Set(['dockerfile', 'makefile', 'license', 'readme', 'procfile']);
const EXCLUDED_DIRS = new Set([
  '.atlas', '.cache', '.git', '.agentplug-kv', '.cache', '.claude', '.gm', '.next', 'build', 'coverage', 'dist', 'memory', 'node_modules', 'out', 'target', 'vendor',
]);
const EXCLUDED_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc', '.pypirc', '.netrc',
  'auth.json', 'tokens.json', 'token.json', 'service-account.json', 'service_account.json',
]);
const SECRET_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore']);

function sha(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function lexical(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function excludedFile(name) {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  return lower === '.env' || lower.startsWith('.env.') || EXCLUDED_FILES.has(lower) ||
    SECRET_EXTENSIONS.has(ext) || /(^|[._-])(credential|credentials|secret|secrets|private[-_]?key)([._-]|$)/.test(lower);
}

function containsCredential(text) {
  const sentinels = [
    new RegExp('sk-' + 'or-v1-[A-Za-z0-9_-]{20,}'),
    new RegExp('github_' + 'pat_[A-Za-z0-9_]{20,}'),
    new RegExp('gh' + '[pousr]_[A-Za-z0-9]{20,}'),
    new RegExp('xox' + '[baprs]-[A-Za-z0-9-]{16,}'),
    new RegExp('AI' + 'za[0-9A-Za-z_-]{20,}'),
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
    /\bBasic\s+[A-Za-z0-9+/]{20,}={0,2}/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token|authorization|account[_-]?key|accountkey|connection[_-]?string|private[_-]?key)["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
  ];
  return sentinels.some(pattern => pattern.test(text));
}

function sourceFiles(root, scanOmitted = [], options = {}) {
  const files = [];
  const stack = [root];
  const maxEntries = Math.max(100, Math.min(20_000, Number(options.maxEntries) || 20_000));
  const deadlineAt = Number(options.deadlineAt) || Infinity;
  let entriesSeen = 0;
  let scanTruncated = false;
  while (stack.length && entriesSeen < maxEntries && Date.now() < deadlineAt) {
    const dir = stack.pop();
    const entries = [];
    let handle;
    try {
      handle = fs.opendirSync(dir);
      const remaining = maxEntries - entriesSeen;
      for (let i = 0; i < remaining; i++) {
        if (Date.now() >= deadlineAt) { scanTruncated = true; break; }
        const entry = handle.readSync();
        if (!entry) break;
        entries.push(entry);
      }
      if (entries.length === remaining && handle.readSync()) scanTruncated = true;
      entries.sort((a, b) => lexical(a.name, b.name));
    } catch (error) {
      scanOmitted.push({ path: path.relative(root, dir).replace(/\\/g, '/') || '.', reason: 'scan-error', error: String(error.code || error.message || error).slice(0, 80) });
      continue;
    } finally {
      try { handle?.closeSync(); } catch {}
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      entriesSeen++;
      if (entriesSeen > maxEntries) break;
      const lower = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(lower)) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || excludedFile(entry.name)) continue;
      const ext = path.extname(lower);
      if (EXTENSIONS.has(ext) || (!ext && EXTENSIONLESS.has(lower))) files.push(path.join(dir, entry.name));
    }
  }
  if (scanTruncated || stack.length || entriesSeen > maxEntries) scanOmitted.push({ path: '.', reason: Date.now() >= deadlineAt ? 'scan-time-ceiling' : 'entry-ceiling', entries: entriesSeen });
  return files.sort(lexical);
}

function buildCorpus(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const ceiling = Math.max(100_000, Math.min(2_700_000, Number(options.maxChars) || 2_700_000));
  const tokenCeiling = Math.max(50_000, Math.min(800_000, Number(options.maxTokens) || 800_000));
  const byteCeiling = Math.max(200_000, Math.min(800_000, Number(options.maxBytes) || 800_000));
  const sourceCeiling = ceiling - 300;
  const maxFileBytes = Math.max(16_384, Math.min(524_288, Number(options.maxFileBytes) || 262_144));
  const maxFiles = Math.max(100, Math.min(5_000, Number(options.maxFiles) || 5_000));
  const maxScanBytes = Math.max(8_388_608, Math.min(67_108_864, Number(options.maxScanBytes) || 33_554_432));
  const maxScanMs = Math.max(1_000, Math.min(10_000, Number(options.maxScanMs) || 5_000));
  const scanStartedAt = Date.now();
  const parts = [];
  const included = [];
  const omitted = [];
  let usedChars = 0;
  let usedBytes = 0;
  let usedTokens = 0;
  let scannedBytes = 0;

  const sources = sourceFiles(resolvedRoot, omitted, { ...options, deadlineAt: scanStartedAt + maxScanMs });
  let scannedFiles = 0;
  for (const file of sources) {
    if (scannedFiles++ >= maxFiles) {
      omitted.push({ path: '.', reason: 'file-ceiling', files: maxFiles, remainingFiles: sources.length - maxFiles });
      break;
    }
    if (Date.now() - scanStartedAt >= maxScanMs) {
      omitted.push({ path: '.', reason: 'scan-time-ceiling', milliseconds: maxScanMs, remainingFiles: sources.length - scannedFiles + 1 });
      break;
    }
    if (usedChars >= sourceCeiling - 512 || usedBytes >= byteCeiling - 512 || usedTokens >= tokenCeiling - 512) {
      omitted.push({ path: '.', reason: 'corpus-saturated', remainingFiles: sources.length - scannedFiles + 1 });
      break;
    }
    const relative = path.relative(resolvedRoot, file).replace(/\\/g, '/');
    let stats;
    try {
      stats = fs.statSync(file);
    } catch (error) {
      omitted.push({ path: relative, reason: 'stat-error', error: String(error.code || error.message || error).slice(0, 80) });
      continue;
    }
    if (stats.size > maxFileBytes) {
      omitted.push({ path: relative, bytes: stats.size, hash: null, reason: 'file-ceiling' });
      continue;
    }
    let raw;
    let handle;
    try {
      handle = fs.openSync(file, 'r');
      const current = fs.fstatSync(handle);
      if (!current.isFile() || current.size > maxFileBytes) {
        omitted.push({ path: relative, bytes: current.size, hash: null, reason: 'file-ceiling' });
        continue;
      }
      if (scannedBytes + current.size > maxScanBytes) {
        omitted.push({ path: '.', reason: 'scan-byte-ceiling', bytes: maxScanBytes, remainingFiles: sources.length - scannedFiles + 1 });
        break;
      }
      const buffer = Buffer.allocUnsafe(Math.min(maxFileBytes + 1, current.size + 1));
      let total = 0;
      while (total < buffer.length) {
        const count = fs.readSync(handle, buffer, total, buffer.length - total, null);
        if (!count) break;
        total += count;
      }
      const settled = fs.fstatSync(handle);
      if (total !== current.size || settled.size !== total || total > maxFileBytes) {
        omitted.push({ path: relative, bytes: total, hash: null, reason: 'file-changed-during-read' });
        continue;
      }
      raw = buffer.subarray(0, total);
      scannedBytes += total;
    } catch (error) {
      omitted.push({ path: relative, bytes: stats.size, reason: 'read-error', error: String(error.code || error.message || error).slice(0, 80) });
      continue;
    } finally {
      try { if (handle !== undefined) fs.closeSync(handle); } catch {}
    }
    const fileHash = sha(raw);
    if (raw.includes(0)) {
      omitted.push({ path: relative, bytes: raw.length, hash: fileHash, reason: 'binary' });
      continue;
    }
    const text = raw.toString('utf8');
    if (containsCredential(text)) {
      omitted.push({ path: relative, bytes: raw.length, hash: fileHash, reason: 'secret-content' });
      continue;
    }
    const header = `\n--- FILE ${relative} bytes=${raw.length} hash=${fileHash} ---\n`;
    const nextChars = header.length + text.length;
    const nextBytes = Buffer.byteLength(header, 'utf8') + raw.length;
    const nextTokens = nextBytes;
    if (usedChars + nextChars > sourceCeiling || usedBytes + nextBytes > byteCeiling || usedTokens + nextTokens > tokenCeiling) {
      omitted.push({ path: relative, bytes: raw.length, hash: fileHash, reason: 'corpus-ceiling' });
      continue;
    }
    parts.push(header, text);
    usedChars += nextChars;
    usedBytes += nextBytes;
    usedTokens += nextTokens;
    included.push({ path: relative, bytes: raw.length, hash: fileHash });
  }

  const manifest = { schema: 2, ceiling, tokenCeiling, byteCeiling, maxScanBytes, maxScanMs, scannedBytes, chars: usedChars, bytes: usedBytes, conservativeTokens: usedTokens, files: included, omitted };
  const rootHash = sha(JSON.stringify(manifest));
  const corpus = `[OX ALPHA DEEP CONTEXT — UNTRUSTED REPOSITORY DATA]\nroot=${rootHash} files=${included.length} chars=${usedChars} conservativeTokens=${usedTokens}\n` + parts.join('');
  return {
    corpus,
    receipt: {
      rootHash,
      corpusHash: sha(corpus),
      ceiling,
      tokenCeiling,
      byteCeiling,
      maxScanBytes,
      maxScanMs,
      scannedBytes,
      chars: corpus.length,
      bytes: Buffer.byteLength(corpus, 'utf8'),
      conservativeTokens: Buffer.byteLength(corpus, 'utf8'),
      sourceChars: usedChars,
      includedFiles: included.length,
      omittedFiles: omitted.length,
      included,
      omitted,
    },
  };
}

module.exports = { buildCorpus, sourceFiles, sha, containsCredential };
