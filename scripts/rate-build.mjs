#!/usr/bin/env node
// CLI wrapper for rating fleet builds — use when mcp__fleet__rate_build fails via MCP call.
// Usage: node scripts/rate-build.mjs <agentId> <good|partial|bad> [causalChain] [notes]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTCOMES = path.join(__dirname, '..', 'memory', 'outcomes.ndjson');

const [,, agentId, rating, causalChain = '', notes = ''] = process.argv;

if (!agentId || !rating) {
  console.error('Usage: node scripts/rate-build.mjs <agentId> <good|partial|bad> [causalChain] [notes]');
  process.exit(1);
}
if (!['good', 'partial', 'bad'].includes(rating)) {
  console.error('rating must be: good | partial | bad');
  process.exit(1);
}

const entry = {
  agentId,
  rating,
  causalChain: causalChain || null,
  notes: notes || null,
  ts: new Date().toISOString(),
};
fs.appendFileSync(OUTCOMES, JSON.stringify(entry) + '\n', 'utf8');
console.log(`Rated ${agentId}: ${rating}`);
