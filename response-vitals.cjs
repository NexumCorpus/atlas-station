'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function finiteTime(value, fallback = Date.now()) {
  const n = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function createResponseVitals(root, options = {}) {
  const file = options.file || path.join(root, '.atlas', 'telemetry', 'response-vitals.ndjson');
  const active = new Map();

  function begin({ submissionId, directiveId, ingressAt, claimAt = Date.now() } = {}) {
    const id = String(submissionId || directiveId || `response:${crypto.randomUUID()}`);
    active.set(id, {
      schema: 1, id, submissionId: submissionId || null, directiveId: directiveId || null,
      ingressAt: finiteTime(ingressAt, finiteTime(claimAt)), claimAt: finiteTime(claimAt),
      providerAt: null, firstOutputAt: null,
    });
    return id;
  }

  function mark(id, phase, at = Date.now()) {
    const trace = active.get(id);
    if (!trace || !['providerAt', 'firstOutputAt'].includes(phase)) return false;
    if (trace[phase] == null) trace[phase] = finiteTime(at);
    return true;
  }

  function settle(id, { state = 'done', at = Date.now(), provider = null, model = null } = {}) {
    const trace = active.get(id);
    if (!trace) return null;
    active.delete(id);
    const settledAt = finiteTime(at);
    const record = {
      ...trace, settledAt, state, provider, model,
      queueMs: Math.max(0, trace.claimAt - trace.ingressAt),
      admissionMs: trace.providerAt == null ? null : Math.max(0, trace.providerAt - trace.claimAt),
      firstOutputMs: trace.firstOutputAt == null ? null : Math.max(0, trace.firstOutputAt - trace.ingressAt),
      settleMs: Math.max(0, settledAt - trace.ingressAt),
      recordedAt: new Date(settledAt).toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  function recent(limit = 50) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit)).map(line => JSON.parse(line));
  }

  function summary(limit = 50) {
    const rows = recent(limit);
    const metric = key => rows.map(row => row[key]).filter(Number.isFinite);
    return {
      samples: rows.length,
      active: active.size,
      firstOutputP50Ms: percentile(metric('firstOutputMs'), 0.5),
      firstOutputP95Ms: percentile(metric('firstOutputMs'), 0.95),
      queueP95Ms: percentile(metric('queueMs'), 0.95),
      settleP50Ms: percentile(metric('settleMs'), 0.5),
      latest: rows.at(-1) || null,
    };
  }

  return { begin, mark, settle, recent, summary, file };
}

module.exports = { createResponseVitals, percentile };
