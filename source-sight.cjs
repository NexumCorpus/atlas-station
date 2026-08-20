'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.py', '.ts', '.yml', '.yaml']);
const OMIT = new Set(['.agentplug', '.agentplug-kv', '.atlas', '.claude', '.git', '.gm', 'memory', 'node_modules']);
const MAX_FILES = 512;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function hash(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function termsFor(query) {
  const normalized = query.normalize('NFKC').trim();
  if (!normalized || normalized.length > 200) throw new Error('query must contain 1 through 200 characters');
  const terms = [...new Set((normalized.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) || []).filter((term) => term.length > 1))];
  if (!terms.length) throw new Error('query must contain a searchable letter or number');
  return { normalized, lower: normalized.toLocaleLowerCase('en-US'), terms: terms.slice(0, 12) };
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sourceFiles(root, scope) {
  const start = path.resolve(root, scope || '.');
  if (!within(root, start)) throw new Error('source scope escapes repository root');
  const files = [];
  const stack = [start];
  while (stack.length && files.length < MAX_FILES) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (EXTENSIONS.has(path.extname(current).toLowerCase())) files.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !OMIT.has(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, 'en'));
    for (const entry of entries) stack.push(path.join(current, entry.name));
  }
  return { files: files.sort((a, b) => a.localeCompare(b, 'en')), fileLimitReached: stack.length > 0 };
}

function searchSource({ root = __dirname, query, scope = '.', limit = 20 } = {}) {
  root = path.resolve(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('source root must be a directory');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 through 50');
  const needle = termsFor(String(query ?? ''));
  const inventory = sourceFiles(root, scope);
  const results = [];
  let scannedBytes = 0;
  let scannedFiles = 0;
  let skippedOversize = 0;
  let byteLimitReached = false;
  for (const file of inventory.files) {
    const size = fs.statSync(file).size;
    if (size > MAX_FILE_BYTES) { skippedOversize += 1; continue; }
    if (scannedBytes + size > MAX_TOTAL_BYTES) { byteLimitReached = true; break; }
    const bytes = fs.readFileSync(file);
    const text = bytes.toString('utf8');
    const sourceHash = hash(bytes);
    scannedBytes += bytes.length;
    scannedFiles += 1;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const lower = line.toLocaleLowerCase('en-US');
      const matchedTerms = needle.terms.filter((term) => lower.includes(term));
      if (!matchedTerms.length) continue;
      const exactPhrase = lower.includes(needle.lower);
      const score = (exactPhrase ? 1000 : 0) + matchedTerms.length * 100 - Math.min(line.length, 99);
      results.push({
        path: path.relative(root, file).replaceAll('\\', '/'),
        line: index + 1,
        excerpt: line.trim().slice(0, 300),
        exactPhrase,
        matchedTerms,
        score,
        sourceHash,
      });
    }
  }
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en') || a.line - b.line);
  return Object.freeze({
    schema: 1,
    engine: 'atlas-source-sight',
    authority: 'read-only-evidence',
    query: needle.normalized,
    terms: needle.terms,
    scope: path.relative(root, path.resolve(root, scope || '.')).replaceAll('\\', '/') || '.',
    scannedFiles,
    scannedBytes,
    fileLimitReached: inventory.fileLimitReached,
    byteLimitReached,
    skippedOversize,
    resultCount: Math.min(results.length, limit),
    totalMatches: results.length,
    results: results.slice(0, limit),
  });
}

module.exports = { searchSource };
