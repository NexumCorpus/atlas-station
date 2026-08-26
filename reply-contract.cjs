'use strict';
// reply-contract.cjs — mouth-lane reply contract checker.
// checkReply(text, context) -> { pass, violations[] }
// Rules:
//  1. First non-empty line must be a direct answer/status sentence, not boilerplate preamble.
//  2. State claims ("is done" etc.) require an evidence token in the same message
//     (file:line pattern or 7-40 char hex hash).
//  3. "tool(s) named X" mentions must reference names present in context.tools registry.
//  4. Handoff statements ('next turn', 'will continue') appear at most once.

const BOILERPLATE_RE = /^(I|Let me|Sure|Certainly|As an)\b/i;
const STATE_CLAIM_RE = /\b(is|are|was)\s+(done|fixed|merged|shipped|complete)\b/i;
const FILE_LINE_RE = /\b[\w.-]+\.(mjs|cjs|js):\d+/;
const HEX_RE = /\b[0-9a-f]{7,40}\b/i;
const TOOL_MENTION_RE = /\btools?\s+named?\s+(\w+)/gi;
const HANDOFF_RE = /\b(next turn|will continue)\b/gi;

function checkReply(text, context = {}) {
  const violations = [];
  const msg = String(text == null ? '' : text);
  if (!msg.trim()) return { pass: false, violations: ['empty-reply'] };

  // Rule 1: direct answer opener.
  const firstLine = msg.split('\n').find((l) => l.trim()) || '';
  const trimmed = firstLine.trim();
  if (BOILERPLATE_RE.test(trimmed)) {
    const stripped = trimmed.replace(BOILERPLATE_RE, '').replace(/^[!,.:; -]+/, '').trim();
    // Substantive = concrete detail: evidence token in message, or a longer clause with a past/prog verb.
    const substantive = stripped.length >= 40 && (FILE_LINE_RE.test(msg) || HEX_RE.test(msg) || /[a-z]+ed\b|[a-z]+ing\b/i.test(stripped));
    if (!substantive) {
      violations.push('boilerplate-opener: first line starts with preamble "' + trimmed.slice(0, 60) + '" instead of a direct answer');
    }
  }

  // Rule 2: state claims need evidence tokens.
  if (STATE_CLAIM_RE.test(msg)) {
    const hasFileLine = FILE_LINE_RE.test(msg);
    const hasHex = HEX_RE.test(msg);
    if (!hasFileLine && !hasHex) {
      violations.push('unsupported-state-claim: "' + STATE_CLAIM_RE.exec(msg)[0] + '" without evidence token (file:line or hex hash)');
    }
  }

  // Rule 3: tool-name mentions must exist in registry.
  const registry = Array.isArray(context.tools) ? context.tools.map(String) : null;
  let m;
  TOOL_MENTION_RE.lastIndex = 0;
  while ((m = TOOL_MENTION_RE.exec(msg)) !== null) {
    const name = m[1];
    if (registry && !registry.includes(name)) {
      violations.push('unknown-tool-mention: "' + name + '" absent from tool registry');
    }
  }

  // Rule 4: handoff statements at most once.
  // Collapse compound statements ('will continue next turn') into one before counting.
  const normalized = msg.replace(/\bwill\s+continue\s+next\s+turn\b/gi, 'handoff');
  const handoffs = normalized.match(HANDOFF_RE) || [];
  if (handoffs.length > 1) {
    violations.push('handoff-repetition: ' + handoffs.length + ' handoff statements (max 1)');
  }

  return { pass: violations.length === 0, violations };
}

module.exports = { checkReply };

