'use strict';

// Fail fast, with the exact fix, when a test needs a sibling repository that is
// not checked out. Without this the wing suites wait out a 300 s timeout.
// Usage: node scripts/require-sibling.cjs d2

const fs = require('fs');
const path = require('path');

const SIBLINGS = {
  d2: {
    env: 'D2_HARNESS',
    fallback: 'E:/director2-harness',
    marker: 'director',
    repo: 'NexumCorpus/director2',
    install: 'python -m pip install -e <path>',
  },
};

const name = process.argv[2];
const sibling = SIBLINGS[name];
if (!sibling) {
  process.stderr.write(`require-sibling: unknown sibling '${name}'; known: ${Object.keys(SIBLINGS).join(', ')}\n`);
  process.exit(2);
}

const where = process.env[sibling.env] || sibling.fallback;
if (!fs.existsSync(path.join(where, sibling.marker))) {
  process.stderr.write([
    `MISSING SIBLING REPO: ${sibling.repo} was not found at ${where}.`,
    `Clone it, run \`${sibling.install}\`, and set ${sibling.env} to its path (see docs/TESTING.md, "Full test surface").`,
    '',
  ].join('\n'));
  process.exit(1);
}
