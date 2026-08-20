'use strict';

const { createHash } = require('crypto');

const MAX_PARTIES = 32;
const MAX_OBLIGATIONS = 64;
const MAX_CENTS = 1_000_000_000_000;
const MAX_CYCLE = 8;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function text(value, name, limit = 160) {
  if (typeof value !== 'string' || value.length < 1 || value.length > limit) throw new Error(`${name} must be a non-empty string of at most ${limit} characters`);
  return value;
}

function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${name} must match ${ID}`);
  return value;
}

function cents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) throw new Error(`${name} must be a safe integer from 0 through ${MAX_CENTS}`);
  return value;
}

function evidenceFact(obligation) {
  return {
    id: obligation.id,
    debtor: obligation.debtor,
    creditor: obligation.creditor,
    kind: obligation.kind,
    faceCents: obligation.faceCents,
    avoidableFulfillmentCostCents: obligation.avoidableFulfillmentCostCents,
    source: obligation.source,
  };
}

function evidenceHash(obligation) {
  return hash(evidenceFact(obligation));
}

function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('scenario must be an object');
  if (input.schema !== 1) throw new Error('scenario schema must equal 1');
  const scenarioId = id(input.scenarioId, 'scenarioId');
  const asOf = text(input.asOf, 'asOf', 40);
  if (!Number.isFinite(Date.parse(asOf))) throw new Error('asOf must be an ISO-8601 timestamp');
  const evidenceClass = text(input.evidenceClass, 'evidenceClass', 80);
  const novationCostCents = cents(input.novationCostCents, 'novationCostCents');
  const feeBps = input.feeBps === undefined ? 2000 : cents(input.feeBps, 'feeBps');
  if (feeBps > 5000) throw new Error('feeBps must not exceed 5000');
  if (!Array.isArray(input.participants) || input.participants.length < 3 || input.participants.length > MAX_PARTIES) throw new Error(`participants must contain 3 through ${MAX_PARTIES} rows`);
  if (!Array.isArray(input.obligations) || input.obligations.length < 3 || input.obligations.length > MAX_OBLIGATIONS) throw new Error(`obligations must contain 3 through ${MAX_OBLIGATIONS} rows`);

  const parties = new Map();
  for (const row of input.participants) {
    const partyId = id(row?.id, 'participant.id');
    if (parties.has(partyId)) throw new Error(`duplicate participant: ${partyId}`);
    if (!Array.isArray(row.consentObligationIds)) throw new Error(`participant ${partyId} must declare consentObligationIds`);
    parties.set(partyId, { id: partyId, tolerance: cents(row.residualToleranceCents, `${partyId}.residualToleranceCents`), consent: new Set(row.consentObligationIds.map((value) => id(value, `${partyId}.consentObligationIds`))) });
  }

  const obligations = [];
  const obligationIds = new Set();
  for (const raw of input.obligations) {
    const obligation = {
      id: id(raw?.id, 'obligation.id'),
      debtor: id(raw?.debtor, 'obligation.debtor'),
      creditor: id(raw?.creditor, 'obligation.creditor'),
      kind: id(raw?.kind, 'obligation.kind'),
      faceCents: cents(raw?.faceCents, 'obligation.faceCents'),
      avoidableFulfillmentCostCents: cents(raw?.avoidableFulfillmentCostCents, 'obligation.avoidableFulfillmentCostCents'),
      source: text(raw?.source, 'obligation.source', 240),
      evidenceHash: text(raw?.evidenceHash, 'obligation.evidenceHash', 80),
    };
    if (obligationIds.has(obligation.id)) throw new Error(`duplicate obligation: ${obligation.id}`);
    if (!parties.has(obligation.debtor) || !parties.has(obligation.creditor) || obligation.debtor === obligation.creditor) throw new Error(`obligation ${obligation.id} must connect two declared, distinct participants`);
    if (obligation.evidenceHash !== evidenceHash(obligation)) throw new Error(`obligation ${obligation.id} evidence hash mismatch`);
    obligationIds.add(obligation.id);
    obligations.push(obligation);
  }
  obligations.sort((a, b) => a.id.localeCompare(b.id));
  return { scenarioId, asOf, evidenceClass, novationCostCents, feeBps, parties, obligations };
}

function evaluate(state, edges, nodes) {
  for (const edge of edges) {
    if (!state.parties.get(edge.debtor).consent.has(edge.id) || !state.parties.get(edge.creditor).consent.has(edge.id)) return null;
  }
  const balances = nodes.map((partyId, index) => {
    const incoming = edges[(index + edges.length - 1) % edges.length].faceCents;
    const outgoing = edges[index].faceCents;
    return { partyId, cashDeltaCents: incoming - outgoing };
  });
  if (balances.some((row) => Math.abs(row.cashDeltaCents) > state.parties.get(row.partyId).tolerance)) return null;
  const grossAvoidedCostCents = edges.reduce((sum, edge) => sum + edge.avoidableFulfillmentCostCents, 0);
  const preFeeSavingsCents = grossAvoidedCostCents - state.novationCostCents;
  if (preFeeSavingsCents <= 0) return null;
  const atlasFeeCents = Math.floor(preFeeSavingsCents * state.feeBps / 10_000);
  const netSavingsCents = preFeeSavingsCents - atlasFeeCents;
  const body = { scenarioId: state.scenarioId, obligationIds: edges.map((edge) => edge.id), balances, grossAvoidedCostCents, novationCostCents: state.novationCostCents, atlasFeeCents, netSavingsCents };
  return {
    planId: hash(body),
    obligationIds: body.obligationIds,
    participantIds: nodes,
    kinds: edges.map((edge) => edge.kind),
    grossFaceCents: edges.reduce((sum, edge) => sum + edge.faceCents, 0),
    grossAvoidedCostCents,
    novationCostCents: state.novationCostCents,
    atlasFeeCents,
    netSavingsCents,
    residualSettlements: balances,
    consentVerified: true,
    facePositionPreserved: balances.reduce((sum, row) => sum + row.cashDeltaCents, 0) === 0,
  };
}

function compile(input) {
  const state = parse(input);
  const outgoing = new Map();
  for (const edge of state.obligations) {
    if (!outgoing.has(edge.debtor)) outgoing.set(edge.debtor, []);
    outgoing.get(edge.debtor).push(edge);
  }
  const plans = [];
  const partyIds = [...state.parties.keys()].sort();
  for (const start of partyIds) {
    const walk = (current, nodes, edges) => {
      for (const edge of outgoing.get(current) || []) {
        if (edge.creditor === start && nodes.length >= 3) {
          const plan = evaluate(state, [...edges, edge], nodes);
          if (plan) plans.push(plan);
        } else if (nodes.length < MAX_CYCLE && edge.creditor > start && !nodes.includes(edge.creditor)) {
          walk(edge.creditor, [...nodes, edge.creditor], [...edges, edge]);
        }
      }
    };
    walk(start, [start], []);
  }
  plans.sort((a, b) => b.netSavingsCents - a.netSavingsCents || a.planId.localeCompare(b.planId));
  const result = {
    schema: 1,
    engine: 'atlas-obligation-compiler',
    authority: 'proposal-only',
    scenarioId: state.scenarioId,
    asOf: state.asOf,
    evidenceClass: state.evidenceClass,
    marketValidated: false,
    candidateCount: plans.length,
    plans,
    epistemicCeiling: 'Evidence hashes prove byte consistency, not contractual truth, consent identity, legal enforceability, or realized savings.',
  };
  return { ...result, receiptHash: hash(result) };
}

module.exports = { compile, evidenceHash };
