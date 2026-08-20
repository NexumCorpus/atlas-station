'use strict';

const LIMITS = Object.freeze({ variables: 16, constraints: 64, arguments: 64, depth: 32, nodes: 1024 });
const VARIABLE = /^VAR_[A-Z0-9_]+$/;

function reject(message) { throw new Error(message); }

function walkAst(node, declared, meter, depth) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) reject('AST node must be an object');
  meter.nodes++;
  if (meter.nodes > LIMITS.nodes) reject(`AST node limit exceeded: ${LIMITS.nodes}`);
  if (depth > LIMITS.depth) reject(`AST depth limit exceeded: ${LIMITS.depth}`);
  if (node.op === 'var') {
    if (typeof node.name !== 'string' || !VARIABLE.test(node.name)) reject(`invalid variable name: ${String(node.name)}`);
    if (!declared.has(node.name)) reject(`undeclared variable: ${node.name}`);
    return new Set([node.name]);
  }
  if (node.op === 'not') {
    if (!Object.hasOwn(node, 'arg')) reject('not node requires arg');
    return walkAst(node.arg, declared, meter, depth + 1);
  }
  if (node.op !== 'and' && node.op !== 'or') reject(`unsupported AST operator: ${String(node.op)}`);
  if (!Array.isArray(node.args) || node.args.length < 1 || node.args.length > LIMITS.arguments) reject(`${node.op} args must contain 1 through ${LIMITS.arguments} nodes`);
  const variables = new Set();
  for (const child of node.args) {
    for (const variable of walkAst(child, declared, meter, depth + 1)) variables.add(variable);
  }
  return variables;
}

function inspectAst(node, declared, state = { depth: 0, nodes: 0 }) {
  const meter = { nodes: Number.isInteger(state.nodes) ? state.nodes : 0 };
  const variables = walkAst(node, declared, meter, Number.isInteger(state.depth) ? state.depth : 0);
  state.nodes = meter.nodes;
  return variables;
}

function evaluate(node, assignment) {
  if (node.op === 'var') return assignment[node.name];
  if (node.op === 'not') return !evaluate(node.arg, assignment);
  if (node.op === 'and') return node.args.every(child => evaluate(child, assignment));
  if (node.op === 'or') return node.args.some(child => evaluate(child, assignment));
  reject(`unsupported AST operator: ${String(node.op)}`);
}

function satisfiable(expressions, variables) {
  const names = [...variables].sort();
  const assignments = 2 ** names.length;
  for (let mask = 0; mask < assignments; mask++) {
    const assignment = Object.fromEntries(names.map((name, index) => [name, Boolean(mask & (2 ** index))]));
    if (expressions.every(expression => evaluate(expression, assignment))) return true;
  }
  return false;
}

function validateFormalModel(model, predicate) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) reject('formal model must be an object');
  if (!Array.isArray(model.variables) || model.variables.length < 1 || model.variables.length > LIMITS.variables) reject(`variables must contain 1 through ${LIMITS.variables} names`);
  if (model.variables.some(name => typeof name !== 'string' || !VARIABLE.test(name))) reject('variables must use the canonical VAR_ namespace');
  const declared = new Set(model.variables);
  if (declared.size !== model.variables.length) reject('duplicate variable declaration');
  if (!Array.isArray(model.roots) || model.roots.length < 1) reject('at least one root is required');
  if (model.roots.some(root => !declared.has(root))) reject('root references an undeclared variable');
  if (!model.dependencyGraph || typeof model.dependencyGraph !== 'object' || Array.isArray(model.dependencyGraph)) reject('dependencyGraph must be an object');
  const reachable = new Set();
  const queue = [...model.roots];
  while (queue.length) {
    const node = queue.shift();
    if (reachable.has(node)) continue;
    reachable.add(node);
    const targets = model.dependencyGraph[node] ?? [];
    if (!Array.isArray(targets) || targets.some(target => !declared.has(target))) reject(`invalid dependency graph targets for ${node}`);
    queue.push(...targets);
  }
  if (!Array.isArray(model.activationAssumptions) || model.activationAssumptions.length > LIMITS.constraints) reject('activationAssumptions must be a bounded list');
  for (const assumption of model.activationAssumptions) inspectAst(assumption, declared);
  if (!satisfiable(model.activationAssumptions, declared)) reject('activation assumptions are inconsistent');
  for (const root of model.roots) {
    const negated = { op: 'not', arg: { op: 'var', name: root } };
    if (satisfiable([...model.activationAssumptions, negated], declared)) reject(`root is not forced: ${root}`);
  }
  if (!Array.isArray(model.constraints) || model.constraints.length < 1 || model.constraints.length > LIMITS.constraints) reject(`constraints must contain 1 through ${LIMITS.constraints} entries`);
  const ids = new Set();
  const constraints = new Map();
  for (const constraint of model.constraints) {
    if (!constraint || typeof constraint !== 'object' || typeof constraint.id !== 'string' || !constraint.id || !Object.hasOwn(constraint, 'expr')) reject('constraint requires id and expr');
    if (ids.has(constraint.id)) reject(`duplicate constraint id: ${constraint.id}`);
    ids.add(constraint.id);
    const participants = inspectAst(constraint.expr, declared);
    for (const variable of participants) if (!reachable.has(variable)) reject(`constraint ${constraint.id} references unreachable variable ${variable}`);
    constraints.set(constraint.id, constraint.expr);
  }
  if (!Array.isArray(model.musClaim) || model.musClaim.length < 1 || new Set(model.musClaim).size !== model.musClaim.length) reject('musClaim must contain unique constraint ids');
  const expressions = model.musClaim.map(id => {
    if (!constraints.has(id)) reject(`unknown MUS constraint id: ${id}`);
    return constraints.get(id);
  });
  if (satisfiable(expressions, declared)) reject('claimed MUS is satisfiable');
  for (let index = 0; index < expressions.length; index++) {
    if (!satisfiable(expressions.filter((_, candidate) => candidate !== index), declared)) reject(`claimed MUS is not minimal: ${model.musClaim[index]}`);
  }
  if (!Array.isArray(predicate.constraintIds) || predicate.constraintIds.length !== model.musClaim.length || [...predicate.constraintIds].sort().some((id, index) => id !== [...model.musClaim].sort()[index])) reject('proposition does not match the validated MUS');
  return { variables: declared.size, constraints: constraints.size, musSize: expressions.length };
}

module.exports = { LIMITS, inspectAst, satisfiable, validateFormalModel };
