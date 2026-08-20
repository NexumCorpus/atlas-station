'use strict';

const { createHash } = require('crypto');

const MAX_DOCUMENT_BYTES = 800_000;
const SOURCES = Object.freeze([
  {
    id: 'executed-tpa',
    url: 'https://www.sec.gov/Archives/edgar/data/810332/000119312525075908/d944548dex101.htm',
    markers: ['Execution Version', 'THREE PARTY AGREEMENT', 'Primary Issuance', 'United will reimburse NewCo'],
  },
  {
    id: 'closing-8k',
    url: 'https://www.sec.gov/Archives/edgar/data/810332/000119312525303961/d937766d8k.htm',
    markers: ['2,853,454 Escrow Shares', 'estimated at $54.2 million', 'CPA Term', 'has the right to subsequently assume'],
  },
  {
    id: 'settlement-8k',
    url: 'https://www.sec.gov/Archives/edgar/data/810332/000119312526043297/d18334d8k.htm',
    markers: ['2,744,348 shares', '$18.84 per share', '$51,703,516', '109,106 shares'],
  },
  {
    id: 'active-cpa',
    url: 'https://www.sec.gov/Archives/edgar/data/810332/000119312525303961/d937766dex103.htm',
    markers: ['CAPACITY PURCHASE AGREEMENT', 'NOVEMBER 25, 2025', 'United Expenses', 'Net Monthly Payment Amount'],
  },
]);

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function visibleText(bytes) {
  return bytes.toString('utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function integer(text, pattern, name) {
  const match = text.match(pattern);
  if (!match) throw new Error(`SEC corpus missing ${name}`);
  return Number(match[1].replaceAll(',', ''));
}

function moneyCents(text, pattern, name) {
  const match = text.match(pattern);
  if (!match) throw new Error(`SEC corpus missing ${name}`);
  const [whole, fraction = ''] = match[1].replaceAll(',', '').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

async function readSource(source) {
  const response = await fetch(source.url, {
    headers: { 'user-agent': process.env.ATLAS_SEC_USER_AGENT || 'AtlasStation/1.0 public-contract-research' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`${source.id} SEC response ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new Error(`${source.id} exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`${source.id} exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  const text = visibleText(bytes);
  for (const marker of source.markers) {
    if (!text.toLowerCase().includes(marker.toLowerCase())) throw new Error(`${source.id} missing required marker: ${marker}`);
  }
  return { id: source.id, url: source.url, bytes: bytes.length, sha256: sha256(bytes), text };
}

async function runSecContractProof() {
  const documents = [];
  for (const source of SOURCES) documents.push(await readSource(source));
  const closing = documents.find((row) => row.id === 'closing-8k').text;
  const settlement = documents.find((row) => row.id === 'settlement-8k').text;
  const facts = {
    parties: ['Mesa Air Group, Inc.', 'Mesa Airlines, Inc.', 'United Airlines, Inc.', 'Republic Airways Holdings Inc.', 'Mesa Shareholder Representative, LLC'],
    escrowShares: integer(closing, /allocation of the ([\d,]+) Escrow Shares/i, 'escrow share count'),
    closingEstimateCents: moneyCents(closing, /estimated at \$([\d,.]+) million/i, 'closing estimate') * 1_000_000,
    settledShares: integer(settlement, /([\d,]+) shares of the Company.{0,160}?released from escrow/i, 'settled share count'),
    sharePriceCents: moneyCents(settlement, /valued at \$([\d,.]+) per share/i, 'share price'),
    exchangeValueCents: moneyCents(settlement, /total value of approximately \$([\d,.]+)/i, 'exchange value'),
    returnedShares: integer(settlement, /remaining ([\d,]+) shares.{0,80}?returned/i, 'returned share count'),
  };
  if (facts.settledShares + facts.returnedShares !== facts.escrowShares) throw new Error('SEC share conservation invariant failed');
  const evidence = {
    corpus: documents.map(({ id, url, bytes, sha256 }) => ({ id, url, bytes, sha256 })),
    facts,
    observedMechanism: 'escrowed equity exchanged for forgiveness and repayment of pre-closing debt and obligations',
    activeOption: 'United may assume responsibility for specified pass-through purchases as direct charges under the active ten-year CPA.',
  };
  return {
    schema: 1,
    engine: 'atlas-obligation-compiler',
    proof: 'real-sec-executed-contract',
    authority: 'read-only-evidence',
    observedAt: new Date().toISOString(),
    evidenceReceiptHash: sha256(Buffer.from(JSON.stringify(evidence))),
    ...evidence,
    mechanismObserved: true,
    activeContractOptionObserved: true,
    realizedExchangeValueCents: facts.exchangeValueCents,
    verifiedSavingsCents: null,
    atlasFeeCents: null,
    executable: false,
    marketValidated: false,
    legalReviewRequired: true,
    claimCeiling: 'The filings prove a real obligation rewrite and its exchange value. They do not disclose an independent counterfactual cost baseline, current unclaimed savings, or authority for Atlas to transact.',
  };
}

module.exports = { runSecContractProof };
