import assert from "node:assert/strict";
import { additionalGoodNeeded } from "../scripts/quality-metrics.mjs";

assert.equal(additionalGoodNeeded(14, 18, 0.8), 3);
assert.equal(additionalGoodNeeded(0, 0, 0.8), 1);
assert.equal(additionalGoodNeeded(9, 10, 0.8), 0);
assert.throws(() => additionalGoodNeeded(2, 1), /total must contain/);

console.log("quality metrics: ALL PASS");
