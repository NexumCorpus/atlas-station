'use strict';
// Ingress text classifier: deterministic regex/keyword rules over operator
// messages. Pure functions; never throws on any input string.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INTENT_CLASSES = ['dialogue', 'build-directive', 'question', 'correction', 'continuation', 'meta-instruction'];

const QUESTION_STARTERS = /^(what|why|how|when|where|who|which|can|could|should|would|is|are|does|do|did|will)\b/i;
const IMPERATIVE_VERBS = /\b(fix|add|build|create|make|write|implement|remove|delete|update|refactor|change|set|wire|run|test|commit|rename|move|replace|extract|split|merge|install|configure|enable|disable|ensure|verify|check|clean|port|migrate|extend|support|handle|prevent|guard|log)\b/i;
const CONTINUATION_WORDS = /^(continue|go on|keep going|carry on|resume|next|proceed|again|more)\b/i;
const CORRECTION_MARKERS = /(actually|no[,.]|that's wrong|thats wrong|incorrect|you broke|you missed|revert|regression|mistake|wrong file|not what i (asked|meant)|instead of)/i;
const META_MARKERS = /^(always|never|from now on|whenever|henceforth|remember( that)?\b|rule:|policy:|directive:)/i;

function splitSentences(text) {
  return String(text || '')
    .replace(/\r?\n/g, '. ')
    .split(/(?<=[.!?])\s+|\s*\n+\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

function extractScope(text) {
  const deliverables = [];
  const constraints = [];
  const refs = [];
  for (const m of String(text || '').matchAll(/\b([A-Za-z][\w.-]*\.(?:js|cjs|mjs|ts|json|md|ndjson))\b/g)) {
    if (!refs.includes(m[1])) refs.push(m[1]);
  }
  for (const m of String(text || '').matchAll(/\b(?:must|should|don't|do not|never|always|without|only|no more than|max(?:imum)?)[^.;]{0,120}/gi)) {
    constraints.push(m[0].trim().slice(0, 160));
  }
  for (const s of splitSentences(text)) {
    if (IMPERATIVE_VERBS.test(s) && !QUESTION_STARTERS.test(s) && deliverables.length < 8) {
      deliverables.push(s.slice(0, 200));
    }
  }
  return { deliverables, constraints, refs };
}

function classifyIngress(text) {
  try {
    const raw = text == null ? '' : String(text);
    const trimmed = raw.trim();
    if (!trimmed) {
      return { intentClass: 'dialogue', scope: { deliverables: [], constraints: [], refs: [] }, confidence: 1.0 };
    }
    const first = splitSentences(trimmed)[0] || trimmed;
    let intentClass = 'dialogue';
    let confidence = 0.5;
    if (CONTINUATION_WORDS.test(first)) {
      intentClass = 'continuation';
      confidence = 0.9;
    } else if (META_MARKERS.test(first)) {
      intentClass = 'meta-instruction';
      confidence = 0.85;
    } else if (/\?\s*$/.test(trimmed) || QUESTION_STARTERS.test(first)) {
      intentClass = 'question';
      confidence = 0.85;
    } else if (CORRECTION_MARKERS.test(trimmed)) {
      intentClass = 'correction';
      confidence = 0.7;
    } else if (IMPERATIVE_VERBS.test(first)) {
      intentClass = 'build-directive';
      confidence = 0.8;
    }
    return { intentClass, scope: extractScope(trimmed), confidence };
  } catch (_) {
    return { intentClass: 'dialogue', scope: { deliverables: [], constraints: [], refs: [] }, confidence: 0 };
  }
}

function appendDirective(memDir, directive) {
  const dir = memDir && typeof memDir === 'string' ? memDir : path.join(process.cwd(), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const text = directive && directive.text != null ? String(directive.text) : '';
  const record = { ts: new Date().toISOString(), hash: crypto.createHash('sha256').update(text).digest('hex'), text };
  fs.appendFileSync(path.join(dir, 'directives.ndjson'), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

module.exports = { classifyIngress, appendDirective, INTENT_CLASSES };
