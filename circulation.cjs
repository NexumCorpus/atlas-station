'use strict';
const crypto = require('crypto');

// Hermes circulation is deliberately an envelope, not an authority grant.
// Unknown legacy provenance remains visible and cannot be upgraded by this module.
const STAGES = new Set(['ingress', 'transform', 'decision', 'proposal', 'verification', 'memory-write']);
const AUTHORITIES = new Set(['observe', 'derive', 'propose', 'verify', 'write']);
const COMPLETENESS = new Set(['complete', 'partial', 'unknown']);

function legacy(stage = 'transform', actor = 'legacy') {
  return {
    v: 1, flow_id: null, parent_flow_id: null, stage, actor,
    provenance: [],
    completeness: { scope: 'unknown', read_bytes: 0, unread_bytes: 0, status: 'unknown' },
    authority: { level: 'observe', human_grant: null, mutation_allowed: false },
    loss: { kind: 'unknown', input_bytes: 0, output_bytes: 0, status: 'unmeasured' },
    falsifiers: [], legacy: true,
  };
}

function validate(packet, { requireFlow = false } = {}) {
  if (!packet || typeof packet !== 'object') throw new TypeError('circulation packet must be an object');
  if (packet.v !== 1) throw new Error('circulation packet requires v=1');
  if (!STAGES.has(packet.stage)) throw new Error('invalid circulation stage');
  if (requireFlow && (!packet.flow_id || typeof packet.flow_id !== 'string')) throw new Error('flow_id required');
  const c = packet.completeness || {};
  if (!COMPLETENESS.has(c.status) || !['source', 'selected', 'unknown'].includes(c.scope)) throw new Error('invalid completeness');
  if (!Number.isFinite(c.read_bytes) || !Number.isFinite(c.unread_bytes) || c.read_bytes < 0 || c.unread_bytes < 0) throw new Error('invalid byte coverage');
  if (c.status === 'complete' && c.unread_bytes !== 0) throw new Error('complete packet cannot have unread bytes');
  const a = packet.authority || {};
  if (!AUTHORITIES.has(a.level) || typeof a.mutation_allowed !== 'boolean') throw new Error('invalid authority');
  if (a.mutation_allowed && a.level !== 'write') throw new Error('mutation authority requires write level');
  if (packet.stage === 'memory-write' && packet.confidence === 'verified' && !(packet.falsifiers || []).some(f => f && f.status === 'pass')) {
    throw new Error('verified memory requires a passing falsifier');
  }
  if (packet.organism) {
    const execution = packet.execution || {};
    if (typeof execution.provider !== 'string' || !execution.provider || typeof execution.model !== 'string' || !execution.model || typeof execution.route !== 'string' || !execution.route) {
      throw new Error('organism receipt requires executing provider, model, and route');
    }
  }
  return packet;
}

function envelope(packet, fallbackStage, actor) {
  const out = packet || legacy(fallbackStage, actor);
  return validate(out);
}

function textAnchor(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

function anchorMatches(text, anchor) {
  return typeof anchor === 'string' && textAnchor(text) === anchor;
}

module.exports = { legacy, validate, envelope, textAnchor, anchorMatches };
