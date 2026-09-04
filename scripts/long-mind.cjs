#!/usr/bin/env node
const path = require('path');
const { createLongMind } = require('../long-mind.cjs');
const root = path.resolve(__dirname, '..');
const mind = createLongMind(root);
const command = process.argv[2] || 'status';
if (command === 'status') console.log(JSON.stringify(mind.status(), null, 2));
else if (command === 'verify') { const result = mind.verify(); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.valid ? 0 : 1; }
else { console.error('usage: node scripts/long-mind.cjs [status|verify]'); process.exitCode = 2; }
