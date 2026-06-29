#!/usr/bin/env node
// Backfill embeddings for all existing facts in memory/facts.jsonl
// Run once: node scripts/backfill-embeddings.mjs
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const _require = createRequire(import.meta.url);

const { generateEmbedding } = _require(join(REPO, 'embedding.cjs'));
const { setEmb, getAllEmbs } = _require(join(REPO, 'embstore.cjs'));

const factsFile = join(REPO, 'memory', 'facts.jsonl');
if (!existsSync(factsFile)) { console.log('No facts.jsonl found.'); process.exit(0); }

const facts = readFileSync(factsFile, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const existing = getAllEmbs(join(REPO, 'memory'));
const missing = facts.filter(f => f.id && !existing.has(f.id));

console.log(`${facts.length} facts total, ${missing.length} need embeddings`);

let done = 0;
for (const f of missing) {
  const emb = await generateEmbedding(`${f.topic} ${f.fact}`);
  if (emb) { setEmb(f.id, emb, join(REPO, 'memory')); done++; }
  if (done % 10 === 0 && done > 0) process.stdout.write(`\r${done}/${missing.length}`);
}
console.log(`\nDone: ${done} embeddings generated.`);
process.exit(0);
