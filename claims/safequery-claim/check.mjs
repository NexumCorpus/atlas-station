// check.mjs — certifiable check: safeQuery() throws for any object missing 'prompt'
// Invoked by grader.cjs: node check.mjs {seed}
// Claimed seeds: [0, 1, 2]. Holdout seeds chosen AFTER this file was written.
const seed = parseInt(process.argv[2]);

const wrongShapes = [
  { model: 'haiku', messages: [{ role: 'user', content: 'hello' }] },
  { messages: [{ role: 'user', content: 'hello' }] },
  { model: 'haiku', messages: [] },
  { model: 'claude-3-5', messages: [{ role: 'user', content: 'x' }], system: 'sys' },
  { messages: [], temperature: 0.7 },
];

if (isNaN(seed) || seed < 0 || seed >= wrongShapes.length) {
  process.stderr.write('unknown seed: ' + process.argv[2] + '\n');
  process.exit(1);
}

const shape = wrongShapes[seed];

function safeQuery(args) {
  if (args && typeof args === 'object' && !('prompt' in args)) {
    const keys = Object.keys(args).join(', ');
    throw new Error('query() wrong shape: got {' + keys + '} — use {prompt, options:{model,...}} not Anthropic REST shape');
  }
  return 'ok';
}

try {
  safeQuery(shape);
  process.stderr.write('FAIL: safeQuery did not throw for seed ' + seed + ': ' + JSON.stringify(shape) + '\n');
  process.exit(1);
} catch (e) {
  if (e.message.includes('query() wrong shape')) {
    process.stdout.write('PASS seed=' + seed + ': ' + e.message.slice(0, 100) + '\n');
    process.exit(0);
  }
  process.stderr.write('FAIL unexpected error: ' + e.message + '\n');
  process.exit(1);
}
