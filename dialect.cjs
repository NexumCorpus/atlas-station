'use strict';
// Dialect registry: STRUCTURAL tool constraints for population variants.
// A dialect is fail-closed: a variant runs ONLY the verbs its registry row
// allows; every other call - native provider tools and fleet verbs alike -
// is denied at the gate. This converts variant-B's "memory-only" label
// from prompt theater into substrate.
const fs = require("fs");
const path = require("path");
const FILE = 'dialects.json';

const DEFAULTS = {
  'memory-only': {
    label: 'memory-only',
    description: 'Context/memory tools only. No shell, no file builds, no fleet spawning.',
    allowed: ['recall_memory', 'journal_write', 'capture_insight', 'load_proposals', 'build_outcomes', 'notify_self', 'memory_health', 'crystallize'],
    deniedNative: true,
  },
};

function _load(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8")); } catch { return {}; }
}

function getDialect(name, dir) {
  dir = dir || path.join(__dirname, 'memory');
  const reg = _load(dir);
  return reg[name] || DEFAULTS[name] || null;
}

function toolSet(name, dir) {
  const d = getDialect(name, dir);
  if (!d) throw new Error("unknown dialect: " + name);
  return { name: d.label || name, allowed: new Set(d.allowed), deniedNative: d.deniedNative !== false, description: d.description || '' };
}

// canUseTool gate for the provider SDK: allow only dialect verbs.
function makeGate(set) {
  return async (name, input) => {
    if (set.allowed.has(name)) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "dialect [" + set.name + "] denies tool: " + name };
  };
}

// The filtered server must actually contain every verb the dialect allows.
function assertCompliance(set, serverToolNames) {
  const missing = [...set.allowed].filter((t) => !serverToolNames.includes(t));
  if (missing.length) throw new Error("dialect [" + set.name + "] missing server tools: " + missing.join(","));
  return true;
}

module.exports = { getDialect, toolSet, makeGate, assertCompliance, DEFAULTS };