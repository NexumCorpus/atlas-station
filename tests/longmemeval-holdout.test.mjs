// LongMemEval holdout: frozen 24-question stratified sample (oracle evidence).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'longmemeval-holdout.json');
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

test('holdout fixture intact', () => {
  const h = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(h.questions.length, 24);
  for (const q of h.questions) {
    assert.ok(q.qid && q.question && q.answer);
    assert.ok(Array.isArray(q.evidence_turns) && q.evidence_turns.length > 0);
  }
});

function retrieve(q) {
  const terms = norm(q.question).split(' ').filter(t => t.length > 3);
  let best = '', bestScore = 0;
  for (const turn of q.evidence_turns) {
    const t = norm(turn);
    const score = terms.reduce((s, w) => s + (t.split(w).length - 1), 0);
    if (score > bestScore) { bestScore = score; best = turn; }
  }
  return best;
}

const covered = (a, g) => g.split(' ').every(w => norm(a).includes(w));

test('baseline retrieval meets floor on holdout', () => {
  const h = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const hits = h.questions.filter(q => covered(retrieve(q), norm(q.answer))).length;
  assert.ok(hits >= 8, 'baseline hits ' + hits + '/24 below kill-condition floor of 8');
});
