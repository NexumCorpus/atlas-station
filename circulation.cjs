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

    // Recursive memory admission is the first place where an observation can
    // change future routing. Make the loss/staleness/falsifier boundary
    // executable instead of trusting a model-produced receipt to describe it.
    if (packet.stage === 'memory-write' && packet.confidence) {
      if (execution.model !== 'gpt-5.6-luna') {
        throw new Error('organism memory admission requires gpt-5.6-luna');
      }
      if (!Array.isArray(packet.provenance) || !packet.provenance.some(p => p && typeof p.sha256 === 'string' && p.sha256.startsWith('sha256:'))) {
        throw new Error('organism memory admission requires an exact source anchor');
      }
      if (c.scope !== 'selected' || c.status !== 'complete' || c.unread_bytes !== 0) {
        throw new Error('organism memory admission requires complete selected context');
      }
      const admission = packet.admission || {};
      if (admission.stale_status !== 'fresh') {
        throw new Error('organism memory admission requires fresh source status');
      }
      if (typeof admission.falsifier_ref !== 'string' || !admission.falsifier_ref ||
          typeof admission.selector !== 'string' || !admission.selector ||
          ['source-self-confirmation', 'same-source'].includes(admission.selector)) {
        throw new Error('organism memory admission requires an independent falsifier selector');
      }
      const selected = (packet.falsifiers || []).find(f => f && f.ref === admission.falsifier_ref);
      if (!selected || selected.independent !== true) {
        throw new Error('organism memory admission requires a selected independent falsifier');
      }
      if (packet.confidence === 'verified' && selected.status !== 'pass') {
        throw new Error('verified organism memory requires a passing selected falsifier');
      }
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
