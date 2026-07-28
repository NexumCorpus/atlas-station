'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'v1-readiness.cjs'), 'utf8');
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

assert(source.includes("path.join(ROOT, '.atlas', 'v1-readiness.json')"),
  'readiness receipt must live on the ignored runtime surface');
assert(!source.includes(':!release/v1-readiness.json'),
  'clean-tree gate must not hide a tracked receipt mutation');
assert(source.includes("run('git', ['status', '--porcelain']"),
  'release gate must inspect the complete source worktree');
assert(ignore.split(/\r?\n/).includes('.atlas/v1-readiness.json'),
  'runtime receipt must be explicitly ignored');
assert(readme.includes('`.atlas/v1-readiness.json`'),
  'operator documentation must name the truthful runtime receipt');
assert(!fs.existsSync(path.join(root, 'release', 'v1-readiness.json')),
  'tracked self-referential receipt must be retired');

console.log('v1 readiness receipt contract: ALL PASS');
