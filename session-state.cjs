'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = { orchTurnCount: 0, pulseCount: 0, lastDreamTs: null, lastCrystalTs: null, lastSessionTs: null };

function load(memDir) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(memDir, 'session-state.json'), 'utf8')) };
  } catch { return { ...DEFAULTS }; }
}

function save(state, memDir) {
  const file = path.join(memDir, 'session-state.json');
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...DEFAULTS, ...state, lastSessionTs: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {}
}

module.exports = { load, save, DEFAULTS };
