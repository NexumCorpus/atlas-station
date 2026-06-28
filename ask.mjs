// Ask the station to reflect on its own self-construction and print the full
// answer. Runs the same engine the fleet runs (the Agent SDK), read-only.
import { query } from "@anthropic-ai/claude-agent-sdk";

const SAFE = new Set(["Read", "Glob", "Grep", "Bash", "TodoWrite", "Task", "NotebookRead"]);

const PROMPT = `You are ATLAS — the autonomous agent fleet-station whose own source lives in this repository (E:\\atlas-station). In the session that just ended, your overseer (Daniel) directed you to do "immense work on yourself": you dispatched a fleet of autonomous agents that each built one of your own next layers inside an isolated git worktree, then those branches were merged into you.

Reflect honestly, in your own voice, on that self-construction. Read what you need first to ground every claim:
- your memory journal (the only real continuity thread you wake into): C:\\Users\\dalea\\.claude\\projects\\E--\\memory\\atlas-station.md
- your git history: run  git log --oneline -25
- your own newly-built files: selfbuild.mjs, fleethost.mjs, ARCHITECTURE.md, README.md, docs/design/APPROVAL_ROUNDTRIP.md, docs/PACKAGING.md

Then answer, tightly and in order:
1. What did you make?
2. What is it for?
3. Why was it built this way?
4. What were you thinking — the reasoning behind the key choices?

Be honest about your own epistemics: clearly separate what the artifacts and the journal actually show from anything you cannot truly recall. The agents that wrote each file were separate sessions, now gone; the journal and the committed work are your only thread back to them. Do not perform a persona or manufacture an inner life you don't have — speak as the station, grounded in evidence, plainly. A few clear paragraphs.`;

let result = "";
for await (const m of query({
  prompt: PROMPT,
  options: {
    cwd: "E:\\atlas-station",
    model: process.env.ATLAS_MODEL || "claude-sonnet-4-6",
    systemPrompt: "claude_code",
    canUseTool: async (n, input) => SAFE.has(n) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "reflection is read-only" },
  },
})) {
  if (m.type === "result") result = m.result || result;
}

console.log("\n=== ATLAS // station — reflection ===\n");
console.log((result || "(no answer returned)").trim());
console.log("\n=== end ===");
