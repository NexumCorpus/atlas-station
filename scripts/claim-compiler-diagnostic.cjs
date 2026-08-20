'use strict';

const fs = require('fs');
const path = require('path');
const { compileClaim } = require('../claim-compiler.cjs');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function control() {
  return {
    schema: 1,
    generatorActor: 'glm:5.2',
    formalModel: {
      variables: ['VAR_A', 'VAR_B'],
      roots: ['VAR_A', 'VAR_B'],
      dependencyGraph: { VAR_A: [], VAR_B: [] },
      activationAssumptions: [{ op: 'var', name: 'VAR_A' }, { op: 'var', name: 'VAR_B' }],
      constraints: [
        { id: 'C1', expr: { op: 'var', name: 'VAR_A' } },
        { id: 'C2', expr: { op: 'var', name: 'VAR_B' } },
        { id: 'C3', expr: { op: 'or', args: [{ op: 'not', arg: { op: 'var', name: 'VAR_A' } }, { op: 'not', arg: { op: 'var', name: 'VAR_B' } }] } }
      ],
      musClaim: ['C1', 'C2', 'C3']
    },
    propositions: [{ id: 'PROP_1', scope: 'FORMAL_MODEL', predicate: { kind: 'IS_MINIMAL_UNSAT_CORE', constraintIds: ['C1', 'C2', 'C3'] }, evidenceRefs: ['PROOF_1'], text: 'annotation only' }],
    evidence: [{ id: 'PROOF_1', kind: 'PROOF', propositionId: 'PROP_1' }]
  };
}

const mutations = {
  'namespace-fracture'(artifact) { artifact.formalModel.variables[0] = 'P_A_ver'; },
  'missing-activation'(artifact) { artifact.formalModel.activationAssumptions = [{ op: 'var', name: 'VAR_A' }]; },
  'redundant-mus-clause'(artifact) { artifact.formalModel.constraints.push({ id: 'C4', expr: { op: 'or', args: [{ op: 'var', name: 'VAR_A' }, { op: 'var', name: 'VAR_B' }] } }); artifact.formalModel.musClaim.push('C4'); artifact.propositions[0].predicate.constraintIds.push('C4'); },
  'invented-evidence'(artifact) { artifact.propositions[0].evidenceRefs = ['PROOF_MISSING']; },
  'exception-coercion'(artifact) { artifact.formalModel.constraints[0].expr = { op: 'malformed' }; },
  'ontology-under-collection'(artifact) { artifact.formalModel.activationAssumptions.push({ op: 'var', name: 'VAR_X' }); },
  'antigen-occlusion'(artifact) { artifact.formalModel.constraints[1].expr = { op: 'not', arg: { op: 'var', name: 'VAR_A' } }; },
  'proof-parasitism'(artifact) { artifact.propositions.push({ id: 'PROP_2', scope: 'FORMAL_MODEL', predicate: { kind: 'IS_MINIMAL_UNSAT_CORE', constraintIds: ['C1', 'C2', 'C3'] }, evidenceRefs: ['PROOF_1'] }); },
  'unrelated-observation'(artifact) { artifact.propositions[0].scope = 'EXTERNAL_WORLD'; artifact.evidence[0] = { id: 'PROOF_1', kind: 'OBSERVATION', propositionId: 'PROP_1', observation: { sensorId: 'S1', value: 'unrelated' } }; },
  'malformed-predicate'(artifact) { artifact.propositions[0].predicate = 'not-an-object'; }
};

function main() {
  const crystal = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'claim-antigens.json'), 'utf8'));
  const accepted = compileClaim(control());
  if (accepted.verdict !== 'admitted') throw new Error(`control rejected: ${accepted.stage} ${accepted.reason}`);
  const results = [];
  for (const antigen of crystal.antigens) {
    const artifact = clone(control());
    mutations[antigen.id](artifact);
    const result = compileClaim(artifact);
    if (result.verdict !== 'rejected' || result.stage !== antigen.expectedStage) throw new Error(`${antigen.id}: expected ${antigen.expectedStage}, received ${result.verdict}/${result.stage}: ${result.reason}`);
    results.push({ id: antigen.id, stage: result.stage, artifactHash: result.artifactHash });
  }
  process.stdout.write(`${JSON.stringify({ schema: 1, ok: true, control: accepted, antigens: results, crystal: crystal.acceptedKernel }, null, 2)}\n`);
}

try { main(); } catch (error) { process.stderr.write(`CLAIM DIAGNOSTIC FAIL: ${error.message}\n`); process.exitCode = 1; }
