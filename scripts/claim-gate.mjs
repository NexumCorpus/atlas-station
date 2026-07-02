// Station gate driver for a pre-built audit bundle: put an existing bundle
// through grader.cjs and record the outcome in CLAIMS.json. The claim is born
// unverified; only certifyClaim can change that. Usage:
//   node scripts/claim-gate.mjs <bundleDir> [holdoutSeed ...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { certifyClaim } = require('../grader.cjs');

const bundle = process.argv[2];
const holdoutSeeds = process.argv.slice(3).map(Number);
if (!bundle || !fs.existsSync(bundle)) {
  console.error('usage: node scripts/claim-gate.mjs <bundleDir> [holdoutSeed ...]');
  process.exit(1);
}
if (!holdoutSeeds.length) holdoutSeeds.push(101, 202);

const claimJson = JSON.parse(fs.readFileSync(path.join(bundle, 'claim.json'), 'utf8'));
const claim = {
  t: 'claim',
  id: claimJson.id || path.basename(path.dirname(path.resolve(bundle))),
  bundle: path.resolve(bundle),
  statement: claimJson.statement,
  verified: false,
};
console.log('[gate] claim (born unverified):', claim.statement);
console.log(`[gate] holdout=[${holdoutSeeds}]`);

const verdict = await certifyClaim(claim, { holdoutSeeds });
console.log('[gate]', verdict.verified ? 'CERTIFIED' : 'REJECTED',
  '—', verdict.certification || verdict.rejection);

const claimsPath = path.resolve(import.meta.dirname, '../CLAIMS.json');
const list = fs.existsSync(claimsPath)
  ? JSON.parse(fs.readFileSync(claimsPath, 'utf8')) : [];
list.push({ ...verdict, gatedAt: new Date().toISOString() });
fs.writeFileSync(claimsPath, JSON.stringify(list, null, 1));
console.log('[gate] recorded ->', claimsPath);
process.exit(verdict.verified ? 0 : 2);
