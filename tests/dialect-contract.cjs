'use strict';
const assert = require("assert");
const dialect = require("../dialect.cjs");

// 1. memory-only default exists with exactly the memory-family verbs.
const set = dialect.toolSet("memory-only");
assert.equal(set.name, "memory-only");
assert.equal(set.allowed.size, 8);
assert.ok(set.deniedNative, "native tools must be denied");
for (const banned of ['spawn_agent', 'run_script', 'chain_agents', 'auto_build', 'Bash', 'Write', 'Edit']) {
  assert.ok(!set.allowed.has(banned), banned + " must not be allowed");
}

// 2. Gate allows dialect verbs, denies everything else with a reason.
const gate = dialect.makeGate(set);
(async () => {
  const ok = await gate('recall_memory', { query: 'x' });
  assert.equal(ok.behavior, "allow");
  const no = await gate('Bash', { command: 'rm -rf /' });
  assert.equal(no.behavior, "deny");
  assert.ok(no.message.includes('memory-only'));
})();

// 3. Unknown dialects throw (fail closed).
assert.throws(() => dialect.toolSet("no-such-dialect"), /unknown dialect/);

// 4. Compliance: a server missing an allowed verb is rejected.
assert.throws(
  () => dialect.assertCompliance(set, ["recall_memory", "journal_write"]),
  /missing server tools/,
);
assert.equal(dialect.assertCompliance(set, [...set.allowed]), true);

console.log("dialect contract: ALL PASS");