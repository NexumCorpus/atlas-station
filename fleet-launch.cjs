'use strict';

// Where the Electron shell finds Node for the fleet sidecar, and how fast it
// retries when the sidecar keeps dying. Kept separate from main.cjs so both
// rules can be tested without launching Electron.

const fs = require('fs');
const path = require('path');

const WINDOWS_DEFAULT_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 60 * 1000;
const HEALTHY_UPTIME_MS = 30 * 1000;

// Order: NODE_BIN, the standard Windows install, then the first node on PATH
// (nvm, Volta, Scoop, per-user installs, Linux and macOS). The bare name is the
// last resort so a missing Node surfaces as a spawn error instead of a guess.
function resolveNodeBin({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.NODE_BIN) return env.NODE_BIN;
  if (platform === 'win32' && exists(WINDOWS_DEFAULT_NODE)) return WINDOWS_DEFAULT_NODE;
  const win = platform === 'win32';
  const exe = win ? 'node.exe' : 'node';
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = (win ? path.win32 : path.posix).join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  return exe;
}

// The first quick exit restarts at once; every further quick exit in a row
// doubles the wait (1s, 2s, 4s ... capped at 60s). A sidecar that stayed up
// for HEALTHY_UPTIME_MS resets the count.
function nextRestart({ uptimeMs, fastExits }) {
  const fast = uptimeMs >= HEALTHY_UPTIME_MS ? 0 : fastExits + 1;
  const delayMs = fast <= 1 ? 0 : Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (fast - 2));
  return { fastExits: fast, delayMs };
}

module.exports = { resolveNodeBin, nextRestart, WINDOWS_DEFAULT_NODE, RESTART_BASE_MS, RESTART_MAX_MS, HEALTHY_UPTIME_MS };
