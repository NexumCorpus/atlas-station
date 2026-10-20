'use strict';

const assert = require('assert');
const { resolveNodeBin, nextRestart, WINDOWS_DEFAULT_NODE, RESTART_MAX_MS, HEALTHY_UPTIME_MS } = require('../fleet-launch.cjs');

// NODE_BIN always wins.
assert.equal(resolveNodeBin({ env: { NODE_BIN: '/opt/custom/node', PATH: '/usr/bin' }, platform: 'linux', exists: () => true }), '/opt/custom/node');

// Windows: the standard install keeps its old priority over PATH.
assert.equal(resolveNodeBin({ env: { PATH: 'D:\\tools' }, platform: 'win32', exists: (p) => p === WINDOWS_DEFAULT_NODE || p === 'D:\\tools\\node.exe' }), WINDOWS_DEFAULT_NODE);

// Windows without the standard install (nvm, Volta, Scoop): first node.exe on PATH.
const volta = 'C:\\Users\\u\\AppData\\Local\\Volta\\bin\\node.exe';
assert.equal(resolveNodeBin({ env: { PATH: 'C:\\x;C:\\Users\\u\\AppData\\Local\\Volta\\bin;C:\\y' }, platform: 'win32', exists: (p) => p === volta }), volta);

// Linux / macOS: first node on PATH, skipping empty entries.
assert.equal(resolveNodeBin({ env: { PATH: ':/nope:/home/u/.nvm/bin' }, platform: 'linux', exists: (p) => p === '/home/u/.nvm/bin/node' }), '/home/u/.nvm/bin/node');

// Nothing found: the bare name, so the spawn error is visible rather than guessed.
assert.equal(resolveNodeBin({ env: { PATH: '/nope' }, platform: 'linux', exists: () => false }), 'node');

// Restart policy: first quick exit is immediate, then 1s, 2s, 4s ... capped.
let state = { fastExits: 0 };
const delays = [];
for (let i = 0; i < 10; i += 1) {
  state = nextRestart({ uptimeMs: 100, fastExits: state.fastExits });
  delays.push(state.delayMs);
}
assert.deepEqual(delays, [0, 1000, 2000, 4000, 8000, 16000, 32000, RESTART_MAX_MS, RESTART_MAX_MS, RESTART_MAX_MS]);

// A sidecar that lived long enough resets the count.
assert.deepEqual(nextRestart({ uptimeMs: HEALTHY_UPTIME_MS, fastExits: 9 }), { fastExits: 0, delayMs: 0 });

// 40 seconds of an instantly-failing sidecar is a handful of starts, not thousands.
let clock = 0;
let starts = 0;
let fast = 0;
while (clock < 40_000 && starts < 100) {
  starts += 1;
  const next = nextRestart({ uptimeMs: 0, fastExits: fast });
  fast = next.fastExits;
  clock += next.delayMs;
}
assert.ok(starts <= 8, `expected at most 8 starts in 40s, saw ${starts}`);

console.log('fleet launch (node lookup + restart backoff): ALL PASS');
