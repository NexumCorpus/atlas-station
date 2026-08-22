'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { index, sha } = require('../skill-capsule.cjs');

function sync(destination = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills')) {
  const library = index();
  const installed = [];
  const conflicts = [];
  fs.mkdirSync(destination, { recursive: true });
  for (const skill of library.skills) {
    if (!skill.name.startsWith('atlas-')) throw new Error('refusing to sync a non-Atlas skill');
    const target = path.join(destination, skill.name);
    const markerPath = path.join(target, '.atlas-source.json');
    if (fs.existsSync(target) && !fs.existsSync(markerPath)) { conflicts.push(skill.name); continue; }
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (marker.source !== path.resolve(path.join(__dirname, '..')) || marker.name !== skill.name) { conflicts.push(skill.name); continue; }
    }
  }
  if (conflicts.length) throw new Error(`refusing to overwrite unrelated skills: ${conflicts.join(', ')}`);
  const pendingPath = path.join(destination, '.atlas-skill-sync.pending.json');
  const pending = { schema: 1, sourceIndexHash: library.indexHash, planned: library.skills.map(skill => skill.name), installed: [], startedAt: new Date().toISOString() };
  fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  for (const skill of library.skills) {
    const target = path.join(destination, skill.name);
    const markerPath = path.join(target, '.atlas-source.json');
    fs.mkdirSync(target, { recursive: true });
    const body = fs.readFileSync(path.join(skill.folder, 'SKILL.md'), 'utf8');
    const capsule = fs.readFileSync(path.join(skill.folder, 'capsule.json'), 'utf8');
    fs.writeFileSync(path.join(target, 'SKILL.md'), body, 'utf8');
    fs.writeFileSync(path.join(target, 'capsule.json'), capsule, 'utf8');
    fs.writeFileSync(markerPath, `${JSON.stringify({ schema: 1, source: path.resolve(path.join(__dirname, '..')), name: skill.name }, null, 2)}\n`, 'utf8');
    installed.push({ name: skill.name, bodyHash: sha(body) });
    pending.installed = installed;
    fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  }
  const receipt = { schema: 1, sourceIndexHash: library.indexHash, installed, conflicts, ts: new Date().toISOString() };
  fs.writeFileSync(path.join(destination, '.atlas-skill-sync.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  fs.rmSync(pendingPath, { force: true });
  return receipt;
}

if (require.main === module) process.stdout.write(`${JSON.stringify(sync(), null, 2)}\n`);
module.exports = { sync };
