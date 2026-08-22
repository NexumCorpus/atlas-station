'use strict';

const assert = require("assert");
const dream = require("../dream.cjs");

// Contract for the validated dream parser and journal inheritance.
// The old inline greedy brace-match + silent catch{} stubbed every parse
// failure into an empty "processing" reflection with no trace (23 rows
// accumulated before diagnosis). These cases pin the replacement.

// 1. Clean JSON object parses directly.
const r1 = dream.parseDreamReport(
  '{"patterns":["a"],"insights":["b"],"proposals":[{"title":"t","priority":"high"}],"mood":"focused"}');
assert.equal(r1.ok, true);
assert.equal(r1.report.mood, "focused");
assert.deepEqual(r1.report.patterns, ["a"]);

// 2. Fenced block wins over surrounding prose and [PROPOSALS] tail.
const r2 = dream.parseDreamReport('Preamble.\n```json\n{"patterns":["x"],"insights":[],"proposals":[],"mood":"calm"}\n```\n[PROPOSALS]\nPROPOSAL [HIGH]: act');
assert.equal(r2.ok, true);
assert.equal(r2.report.mood, "calm");
assert.ok(r2.attempts.some((a) => a.via === "fenced"));

// 3. Braces inside strings must not desync the scanner.
const r3 = dream.parseDreamReport('The station {"status": "ok"} is fine.\n{"patterns":["p1"],"insights":["i1"],"proposals":[{"title":"T","description":"desc with } brace"}],"mood":"sharp"}\nTrailing words.');
assert.equal(r3.ok, true);
assert.equal(r3.report.proposals[0].description, "desc with } brace");

// 4. Garbage fails with a structured, inspectable reason - not silence.
const r4 = dream.parseDreamReport('no json here at all');
assert.equal(r4.ok, false);
assert.ok(r4.attempts.length >= 1 && r4.attempts[0].reason);

// 5. Wrong shape is rejected with the missing fields named.
const r5 = dream.parseDreamReport('{"patterns":"not-an-array"}');
assert.equal(r5.ok, false);
assert.ok(/mistyped fields/.test(r5.attempts[0].reason));

// 6. inheritJournal merges real reflections, skips stubs, keeps journal rows.
const merged = dream.inheritJournal(
  [{ ts: "2026-08-22", note: "journal row" }],
  [
    { ts: "2026-08-21", mood: "processing", patterns: ["stub"] },
    { ts: "2026-08-20", mood: "focused", patterns: ["pat A", "pat B"], insights: ["ins C"] },
  ],
);
assert.equal(merged.length, 2);
assert.equal(merged[0].note, "journal row");
assert.ok(merged[1].note.startsWith("[dream]"));

console.log("dream-parser contract: ALL PASS");