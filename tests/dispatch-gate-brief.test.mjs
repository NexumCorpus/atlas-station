import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../fleethost.mjs', import.meta.url), 'utf8');

const start = source.indexOf('function _wrapBuildBrief(');
assert.ok(start >= 0, 'missing _wrapBuildBrief');
// extract balanced-brace body of the function
let i = source.indexOf('{', start), depth = 0, j = i;
for (; j < source.length; j++) {
  if (source[j] === '{') depth++;
  else if (source[j] === '}') { depth--; if (depth === 0) break; }
}
assert.ok(depth === 0, 'unbalanced braces extracting _wrapBuildBrief');
const fnSrc = source.slice(start, j + 1);
// eslint-disable-next-line no-eval
const _wrapBuildBrief = eval('(' + fnSrc + ')');

// 1) rejects thin brief: <200 chars, no directive verb
let threw = null;
try { _wrapBuildBrief('UI grip round 13 on index.htm tweak spacing'); } catch (e) { threw = e; }
assert.ok(threw, 'thin brief (<200 chars, no directive verb) must be rejected');
assert.match(String(threw.message), /thin-brief rejected/i);

// also: >=200 chars but still no directive verb must be rejected
let noVerb = null;
try {
  _wrapBuildBrief('The situation regarding the layout of the page is under review. ' +
    'Considerations about spacing, margins, and general appearance continue to be discussed at length. ' +
    'No concrete action items exist yet for this particular topic of interest today.');
} catch (e) { noVerb = e; }
assert.ok(noVerb, 'long brief lacking directive verbs must also be rejected');

// 2) accepts well-formed 300+ char directive-verb brief with scope/acceptance sections
const good = [
  '## Build Brief',
  '',
  '### Scope',
  'Add a retry backoff helper to the ingestion pipeline so transient provider failures do not abort the batch run.',
  '',
  '### Acceptance Criteria',
  'Retries use exponential delay capped at 30 seconds; unit test covers three consecutive failures then success; node --check passes on all modified files.',
].join('\n');
assert.ok(good.length > 300, 'test fixture should exceed 300 chars');
const wrapped = String(_wrapBuildBrief(good));
assert.match(wrapped, /^## Build Brief/, 'accepted brief must come back wrapped');
assert.ok(wrapped.length > good.length, 'wrapped output must contain the task');
console.log('dispatch-gate-brief: all assertions passed');
