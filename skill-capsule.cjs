'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const skillFitness = require('./skill-fitness.cjs');

const ROOT = path.join(__dirname, 'skills');
const ADMITTED_ROOT = path.join(__dirname, 'memory', 'skill-variants');
const MAX_BODY_BYTES = 12_000;
const REQUIRED = ['name', 'version', 'description', 'triggers', 'exclusions', 'accepts', 'produces', 'evidenceRoute', 'falsifier', 'tokenEstimate'];

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function words(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9-]{3,}/g) || []);
}

function validateCapsule(capsule, body, folder) {
  if (!capsule || capsule.schema !== 1) throw new Error(`${folder}: capsule schema must be 1`);
  for (const field of REQUIRED) if (capsule[field] === undefined) throw new Error(`${folder}: missing ${field}`);
  if (!/^atlas-[a-z0-9-]{2,50}$/.test(capsule.name)) throw new Error(`${folder}: invalid skill name`);
  if (capsule.inputMode !== 'any') throw new Error(`${folder}: inputMode must be any`);
  if (!/^\d+\.\d+\.\d+$/.test(capsule.version)) throw new Error(`${folder}: invalid version`);
  for (const field of ['triggers', 'exclusions', 'accepts', 'produces']) {
    if (!Array.isArray(capsule[field]) || !capsule[field].length || capsule[field].length > 16 || capsule[field].some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) throw new Error(`${folder}: invalid ${field}`);
  }
  for (const field of ['description', 'evidenceRoute', 'falsifier']) if (typeof capsule[field] !== 'string' || !capsule[field].trim() || capsule[field].length > 600) throw new Error(`${folder}: invalid ${field}`);
  if (!Number.isInteger(capsule.tokenEstimate) || capsule.tokenEstimate < 40 || capsule.tokenEstimate > 4000) throw new Error(`${folder}: invalid tokenEstimate`);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error(`${folder}: SKILL.md exceeds ${MAX_BODY_BYTES} bytes`);
  const measuredTokenEstimate = Math.ceil(Buffer.byteLength(body) / 4);
  if (capsule.tokenEstimate < measuredTokenEstimate) throw new Error(`${folder}: tokenEstimate understates body size; minimum ${measuredTokenEstimate}`);
  const frontmatterName = body.match(/^---\s*[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?---/);
  if (!frontmatterName || frontmatterName[1].trim() !== capsule.name) throw new Error(`${folder}: SKILL.md name mismatch`);
  return Object.freeze({ ...capsule, measuredTokenEstimate, bodyHash: sha(body), folder });
}

function versionOrder(a, b) {
  const left = a.version.split('.').map(Number);
  const right = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return a.bodyHash.localeCompare(b.bodyHash);
}

function scan(root, depth = 0, requireAdmission = false) {
  if (!fs.existsSync(root) || depth > 3) return [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`symbolic links are not valid skill roots: ${root}`);
  const capsulePath = path.join(root, 'capsule.json');
  const bodyPath = path.join(root, 'SKILL.md');
  if (fs.existsSync(capsulePath) && fs.existsSync(bodyPath)) {
    if (fs.lstatSync(capsulePath).isSymbolicLink() || fs.lstatSync(bodyPath).isSymbolicLink()) throw new Error(`${root}: symbolic links are not valid skill files`);
    if (fs.statSync(capsulePath).size > 16_384 || fs.statSync(bodyPath).size > MAX_BODY_BYTES) throw new Error(`${root}: skill file exceeds byte limit`);
    const body = fs.readFileSync(bodyPath, 'utf8');
    const skill = validateCapsule(JSON.parse(fs.readFileSync(capsulePath, 'utf8')), body, root);
    if (requireAdmission) {
      const admissionPath = path.join(root, 'admission.json');
      if (!fs.existsSync(admissionPath) || fs.lstatSync(admissionPath).isSymbolicLink() || fs.statSync(admissionPath).size > 4096) return [];
      const admission = JSON.parse(fs.readFileSync(admissionPath, 'utf8'));
      if (admission.bodyHash !== skill.bodyHash || !/^[a-f0-9]{64}$/.test(admission.receiptHash || '')) return [];
      const receipt = skillFitness.verify().find(row => row.kind === 'variant-admitted' && row.recordHash === admission.receiptHash && row.bodyHash === skill.bodyHash && row.name === skill.name && row.version === skill.version);
      if (!receipt) return [];
    }
    return [skill];
  }
  return fs.readdirSync(root).sort().flatMap(name => {
    const folder = path.join(root, name);
    return inside(root, folder) && !fs.lstatSync(folder).isSymbolicLink() && fs.statSync(folder).isDirectory() ? scan(folder, depth + 1, requireAdmission) : [];
  });
}

function index(root = ROOT) {
  if (!inside(ROOT, root)) throw new Error('skill root escapes repository skill root');
  const candidates = scan(root).concat(root === ROOT ? scan(ADMITTED_ROOT, 0, true) : []);
  const latest = new Map();
  for (const skill of candidates) if (!latest.has(skill.name) || versionOrder(latest.get(skill.name), skill) < 0) latest.set(skill.name, skill);
  const skills = [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
  const summary = skills.map(({ folder, ...skill }) => skill);
  return { schema: 1, root, indexHash: sha(JSON.stringify(summary)), skills };
}

function affinity(candidate, taskWords, taskText) {
  const excluded = candidate.exclusions.some(term => taskText.includes(term.toLowerCase()));
  if (excluded) return -Infinity;
  let score = 0;
  for (const trigger of candidate.triggers) {
    const normalized = trigger.toLowerCase();
    if (taskText.includes(normalized)) score += 5;
    for (const word of words(normalized)) if (taskWords.has(word)) score += 1;
  }
  return score;
}

function select(task, options = {}) {
  const library = index(options.root || ROOT);
  const taskText = String(task || '').toLowerCase();
  const taskWords = words(taskText);
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 8));
  const budget = Math.max(100, Math.min(Number(options.tokenBudget || 1800), 8000));
  const ranked = library.skills.map(skill => ({ skill, score: affinity(skill, taskWords, taskText) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  const chosen = [];
  const roots = [];
  const edges = [];
  let tokens = 0;
  for (const row of ranked.slice(0, Math.min(3, limit))) {
    if (tokens + row.skill.tokenEstimate > budget) continue;
    chosen.push(row.skill);
    roots.push(row.skill.name);
    tokens += row.skill.tokenEstimate;
  }
  while (chosen.length && chosen.length < limit) {
    const candidates = [];
    for (const producer of chosen) for (const produced of producer.produces) for (const consumer of library.skills) {
      if (chosen.includes(consumer) || !consumer.accepts.includes(produced) || tokens + consumer.tokenEstimate > budget) continue;
      candidates.push({ producer, produced, consumer, score: affinity(consumer, taskWords, taskText) });
    }
    candidates.sort((a, b) => b.score - a.score || a.consumer.tokenEstimate - b.consumer.tokenEstimate || a.consumer.name.localeCompare(b.consumer.name));
    const next = candidates[0];
    if (!next) break;
    chosen.push(next.consumer);
    tokens += next.consumer.tokenEstimate;
    edges.push({ from: next.producer.name, output: next.produced, to: next.consumer.name });
  }
  const selected = chosen.slice(0, limit);
  return {
    schema: 1,
    taskHash: sha(String(task || '')),
    indexHash: library.indexHash,
    roots,
    edges,
    selected: selected.map(skill => ({ name: skill.name, version: skill.version, bodyHash: skill.bodyHash, accepts: skill.accepts, produces: skill.produces, tokenEstimate: skill.tokenEstimate })),
    tokenEstimate: selected.reduce((total, skill) => total + skill.tokenEstimate, 0),
    bodies: options.loadBodies === false ? undefined : selected.map(skill => fs.readFileSync(path.join(skill.folder, 'SKILL.md'), 'utf8')),
  };
}

module.exports = { ADMITTED_ROOT, ROOT, index, inside, select, sha, validateCapsule };
