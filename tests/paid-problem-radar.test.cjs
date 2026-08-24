'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertAlgoraOpenSource,
  parseAlgoraOpenBounties,
  mergeListings,
  scanPaidProblems,
  hash,
} = require('../paid-problem-radar.cjs');

const SOURCE = 'https://algora.io/testorg/bounties?status=open';
const repoRoot = path.join(__dirname, '..');
const fleetSource = fs.readFileSync(path.join(repoRoot, 'fleethost.mjs'), 'utf8');
const codexSource = fs.readFileSync(path.join(repoRoot, 'providers', 'codex-cli.mjs'), 'utf8');
assert.match(fleetSource, /const economicRadarTool = tool\(/, 'native fleet tool is defined');
assert.match(fleetSource, /abolishWorkTool, economicRadarTool, revertBuildTool/, 'native fleet tool is registered');
assert.match(codexSource, /atlas-tool\.cjs economic_radar --min-usd=100 --limit=20/, 'provider-neutral Codex bridge advertises the same organ');

function row({ amount, issue, title, age = '2 days ago', claims = 0, id = `listing-${issue}` }) {
  return `<tr>
    <td><div>$${amount}</div><a href="https://github.com/acme/tool/issues/${issue}"><p>tool#${issue}</p><p class="line-clamp-2">${title}</p></a><p>${age}</p></td>
    <td><div phx-click="toggle-claims" phx-value-id="${id}"><div>${claims} claims</div></div></td>
  </tr>`;
}

const html = `<html><table>
  ${row({ amount: '150', issue: 1, title: 'Add deterministic API contract tests', claims: 1, id: 'one-a' })}
  ${row({ amount: '25', issue: 1, title: 'Add deterministic API contract tests', claims: 1, id: 'one-b' })}
  ${row({ amount: '500', issue: 2, title: 'Closed but lucrative-looking task', claims: 0 })}
  ${row({ amount: '200', issue: 3, title: 'Exploit authentication vulnerability', claims: 0 })}
  ${row({ amount: '50', issue: 4, title: 'Tiny documentation fix', claims: 0 })}
  ${row({ amount: '100', issue: 5, title: 'Assigned TypeScript task', claims: 0 })}
</table></html>`;

assert.equal(assertAlgoraOpenSource('https://algora.io/testorg/bounties'), SOURCE);
assert.throws(() => assertAlgoraOpenSource('http://algora.io/testorg/bounties'), /https/);
assert.throws(() => assertAlgoraOpenSource('https://example.com/testorg/bounties'), /algora\.io/);
assert.throws(() => assertAlgoraOpenSource('https://algora.io/testorg/bounties?status=completed'), /open/);
assert.throws(() => assertAlgoraOpenSource('https://algora.io/testorg/bounties?status=open&next=https://evil.test'), /only the status/);

const parsed = parseAlgoraOpenBounties(html, SOURCE);
assert.equal(parsed.length, 6);
assert.deepEqual(parsed.slice(0, 2).map(item => item.amountUsd), [150, 25]);
assert.equal(parsed[0].title, 'Add deterministic API contract tests');
assert.equal(parsed[0].claimCount, 1);
assert.equal(parsed[0].approximateAgeDays, 2);

const merged = mergeListings(parsed);
assert.equal(merged.length, 5);
assert.equal(merged[0].advertisedUsd, 150, 'duplicate listings use the conservative maximum as the advertised amount');
assert.equal(merged[0].possibleAdditionalUsd, 25, 'possible additional funds stay separately qualified');
assert.match(merged[0].listingEvidenceRoot, /^sha256:[a-f0-9]{64}$/);

const issue = (n, overrides = {}) => ({
  state: 'open',
  title: `Issue ${n}`,
  body: 'Changes required. Add tests. Success criteria: npm test passes.',
  labels: [{ name: n === 1 ? 'typescript' : 'enhancement' }],
  html_url: `https://github.com/acme/tool/issues/${n}`,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-20T00:00:00Z',
  comments: 2,
  locked: false,
  assignees: [],
  repository_url: 'https://api.github.com/repos/acme/tool',
  ...overrides,
});
const repository = {
  full_name: 'acme/tool', html_url: 'https://github.com/acme/tool', language: 'TypeScript',
  license: { spdx_id: 'MIT' }, archived: false, fork: false,
  pushed_at: '2026-08-23T00:00:00Z', default_branch: 'main',
};

function createFetch(sourceBody = html) {
  const calls = [];
  const responses = new Map([
    [SOURCE, { body: sourceBody, type: 'text/html' }],
    ['https://api.github.com/repos/acme/tool/issues/1', { body: issue(1), type: 'application/json' }],
    ['https://api.github.com/repos/acme/tool/issues/2', { body: issue(2, { state: 'closed' }), type: 'application/json' }],
    ['https://api.github.com/repos/acme/tool/issues/3', { body: issue(3, { title: 'Exploit authentication vulnerability' }), type: 'application/json' }],
    ['https://api.github.com/repos/acme/tool/issues/4', { body: issue(4), type: 'application/json' }],
    ['https://api.github.com/repos/acme/tool/issues/5', { body: issue(5, { assignees: [{ login: 'claimed' }] }), type: 'application/json' }],
    ['https://api.github.com/repos/acme/tool', { body: repository, type: 'application/json' }],
  ]);
  const fetchImpl = async url => {
    calls.push(String(url));
    const found = responses.get(String(url));
    if (!found) return new Response('not found', { status: 404 });
    const body = found.type === 'application/json' ? JSON.stringify(found.body) : found.body;
    return new Response(body, { status: 200, headers: { 'content-type': found.type } });
  };
  return { fetchImpl, calls };
}

(async () => {
  const { fetchImpl, calls } = createFetch();
  const result = await scanPaidProblems({
    sources: [SOURCE],
    fetchImpl,
    cache: false,
    now: new Date('2026-08-24T12:00:00Z'),
    limit: 5,
    minUsd: 100,
    capabilities: ['typescript', 'testing', 'api'],
  });

  assert.equal(result.protocol.frozenBeforeFetch, true);
  assert.equal(result.protocol.sampleRule, 'first 5 unique GitHub issues in supplied source order before ranking');
  assert.equal(result.sample.length, 5);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].issueUrl, 'https://github.com/acme/tool/issues/1');
  assert.equal(result.opportunities[0].advertisedUsd, 150);
  assert.equal(result.opportunities[0].fit.languageMatch, true);
  assert.equal(result.opportunities[0].claimCeiling, 'E0: live advertised listing; no demand for Atlas, acceptance, or revenue yet');
  assert.match(result.sample.find(item => item.issueUrl.endsWith('/2')).hardExclusions.join(' '), /closed/);
  assert.match(result.sample.find(item => item.issueUrl.endsWith('/3')).hardExclusions.join(' '), /sensitive/);
  assert.match(result.sample.find(item => item.issueUrl.endsWith('/4')).hardExclusions.join(' '), /below \$100/);
  assert.match(result.sample.find(item => item.issueUrl.endsWith('/5')).hardExclusions.join(' '), /assignee/);

  assert.equal(result.workPacket.kind, 'unapproved-paid-problem-preflight');
  assert.equal(result.workPacket.currentEvidenceLevel, 'E0');
  assert.match(result.workPacket.operatorGate, new RegExp(result.opportunities[0].candidateHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(result.authority.externalActionsPerformed, []);
  assert.deepEqual(result.authority.mutationsPerformed, []);
  assert.match(result.workPacket.learningRule, /Only E3 may update revenue/);
  assert.equal(result.workPacket.packetHash, hash(Object.fromEntries(Object.entries(result.workPacket).filter(([key]) => key !== 'packetHash'))));
  assert.equal(calls.filter(url => url === 'https://api.github.com/repos/acme/tool').length, 1, 'repository metadata is fetched once per scan');

  const fixed = await scanPaidProblems({ sources: [SOURCE], fetchImpl: createFetch().fetchImpl, cache: false, now: new Date('2026-08-24T12:00:00Z'), limit: 2, minUsd: 100 });
  assert.equal(fixed.sample.length, 2, 'the sample is frozen before ranking');
  assert.ok(!fixed.sample.some(item => item.issueUrl.endsWith('/3')), 'later high-dollar records cannot enter a fixed two-item sample');

  let escaped = false;
  const redirectingFetch = async url => {
    if (String(url) === SOURCE) return new Response(null, { status: 302, headers: { location: 'https://evil.test/prompt' } });
    escaped = true;
    return new Response('bad', { status: 200 });
  };
  const redirected = await scanPaidProblems({ sources: [SOURCE], fetchImpl: redirectingFetch, cache: false, now: new Date('2026-08-24T12:00:00Z') });
  assert.equal(escaped, false, 'redirect target outside the allowlist is never fetched');
  assert.match(redirected.sourceReceipts[0].error, /allowlist/);
  assert.equal(redirected.opportunities.length, 0);

  let repositoryEscapeFetched = false;
  const oneRow = `<table>${row({ amount: '150', issue: 1, title: 'Bounded API task' })}</table>`;
  const maliciousRepositoryFetch = async url => {
    if (String(url) === SOURCE) return new Response(oneRow, { status: 200 });
    if (String(url) === 'https://api.github.com/repos/acme/tool/issues/1') {
      return new Response(JSON.stringify(issue(1, { repository_url: 'https://evil.test/repos/acme/tool' })), { status: 200 });
    }
    repositoryEscapeFetched = true;
    return new Response('{}', { status: 200 });
  };
  const maliciousRepository = await scanPaidProblems({ sources: [SOURCE], fetchImpl: maliciousRepositoryFetch, cache: false, now: new Date('2026-08-24T12:00:00Z'), limit: 1 });
  assert.equal(repositoryEscapeFetched, false, 'GitHub-controlled repository URLs are checked before any request');
  assert.match(maliciousRepository.sample[0].hardExclusions.join(' '), /allowlist/);

  console.log('paid-problem radar: ALL PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
