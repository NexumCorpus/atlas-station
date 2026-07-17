import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-async-context-"));
try {
  const { appendFact } = require(path.join(root, "memstore.cjs"));
  const { buildContextStats, injectAsync } = require(path.join(root, "memcontext.cjs"));
  appendFact({ topic: "context", fact: "semantic memory telemetry survives async injection", source: "test", confidence: "verified" }, dir);
  const result = await injectAsync("semantic memory telemetry", {
    memDir: dir,
    journalPath: path.join(dir, "missing-journal.md"),
    returnStats: true,
  });
  assert.equal(typeof result, "object");
  assert.match(result.context, /semantic memory telemetry/);
  assert.ok(result.stats && Array.isArray(result.stats.sections));

  const longJournalPath = path.join(dir, "long-journal.md");
  fs.writeFileSync(longJournalPath, "journal continuity evidence ".repeat(200), "utf8");
  const trimmed = await injectAsync("trim accounting", {
    memDir: dir,
    journalPath: longJournalPath,
    maxJournalChars: 5000,
    maxContextChars: 600,
    returnStats: true,
  });
  assert.ok(Array.isArray(trimmed.stats.trimmedSections));
  assert.ok(trimmed.stats.trimmedSections.some(section => section.startsWith("[Station Journal ")));

  const syncStats = buildContextStats("trim accounting", {
    memDir: dir,
    journalPath: longJournalPath,
    maxJournalChars: 5000,
    maxContextChars: 600,
  });
  assert.deepEqual(syncStats.trimmedSections, trimmed.stats.trimmedSections);
  assert.equal(syncStats.budget, 600);

  const emptyShape = buildContextStats("empty-shape", { maxContextChars: 0, memDir: dir, journalPath: path.join(dir, "missing.md") });
  assert.ok(Array.isArray(emptyShape.sections));
  assert.ok(Array.isArray(emptyShape.trimmedSections));
  assert.equal(emptyShape.budget, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("memcontext async contract: ALL PASS");
