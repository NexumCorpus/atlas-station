'use strict';
// selfloop.cjs — structured self-improvement trigger for ATLAS.
// When ATLAS calls trigger_selfloop(), this chains: assess → identify gaps → set goals → queue proposals.
// The result is a summary of what ATLAS decided to work on next.
const SELFLOOP_PROMPT = `You are ATLAS, auditing your own capabilities.

Use these tools in sequence:
1. self_assess() — get current state snapshot
2. list_goals() — see active goals
3. load_proposals() — see pending proposals
4. capability_manifest("full") — see all tools and modules

Then, based on gaps you notice:
- For each significant gap: set_goal(goal, priority, area)
- For each buildable improvement: propose_improvement(description, priority, area)
- For key insights: journal_write(observation, topic)

6. Call write_doc with filename="SELF_STATE.md" and write a concise status document:
   - Current capability summary (bullet list of your major tool groups)
   - Active goals (from list_goals)
   - Top 2-3 improvement proposals (from load_proposals)
   - What the last self-assess found
   Keep it under 400 words. This is your persistent self-model document.

End with a brief summary of what you found and what you've queued.
Focus on: tool gaps, memory hygiene, GUI improvements, reliability, new capabilities.
Be selective — 2-4 high-quality actions, not a flood.`;

module.exports = { SELFLOOP_PROMPT };
