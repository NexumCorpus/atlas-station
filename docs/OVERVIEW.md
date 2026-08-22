# ATLAS Station architecture overview

ATLAS Station is the desktop executive surface of Hermes: a local organism for
evidence-backed autonomous development and discovery. Hermes is the whole
runtime, not a wrapper around any one model vendor. ATLAS is its executive and
speaking surface; Station is its lifecycle, memory, and receipt spine.

## Runtime body

```text
Daniel
  -> Electron renderer and preload bridge
  -> main.cjs lifecycle supervisor
  -> fleethost.mjs Atlas/fleet sidecar
  -> selected provider adapter
  -> model
```

`main.cjs` owns the Electron window and sidecar generation. It relays operator
ingress and state events but does not run model calls. `fleethost.mjs` owns
orchestration, fleet state, autonomy, tools, and provider sessions. Keeping the
sidecar in plain Node isolates model execution and native dependencies from the
Electron runtime. The renderer presents dialogue, active work, proposals,
memory, costs, failures, and provenance without owning authoritative state.

Provider identity is explicit and replaceable:

- `providers/codex-cli.mjs` uses the authenticated Codex CLI subscription and
  is the normal v1 executive route.
- `providers/openrouter.mjs` runs the same Hermes loop directly through
  OpenRouter Chat Completions and native function calling.
- The Anthropic Claude Agent SDK remains a compatibility adapter; it is not the
  identity of Hermes and its availability is not required by other providers.

## Mouth and metabolism

The sidecar maintains two independent serialized lanes with distinct provider
sessions and agent records:

- **Mouth** carries live Daniel/ATLAS dialogue.
- **Metabolism** carries startup, deferred, retry, and autonomous work.

Turns remain FIFO within their own lane. A long or failed metabolism turn cannot
head-of-line block the mouth. Operator ingress is selected before older
background ingress, and claim, renewal, execution, and terminal receipts retain
the lane identity. This makes conversation a continuously available organ of
the same Hermes process rather than a second worker call.

## Execution and fleet

An operator message crosses the preload bridge into the main process, enters the
append-only ingress journal, receives a fenced claim, and is scheduled on the
mouth lane. The selected provider resumes the mouth session, streams Atlas state
to the renderer, and appends the terminal result and publication receipt.

Atlas can delegate bounded tasks to visible fleet agents. Read and build routes
are chosen by the active provider and task policy; build work uses isolated git
worktrees where required. The fleet is an organ managed by Atlas, not a second
Hermes identity. Provider capability declarations and caller policy decide which
tools can be advertised or admitted on each route.

## Persistence and context circulation

- `persist.cjs` and session state restore agents, counters, and the independent
  mouth/metabolism provider sessions across sidecar generations.
- `session-log.cjs` preserves role-aware direct dialogue separately from system
  and autonomous turns.
- `memcontext.cjs` injects a bounded selection of dialogue, facts, crystals,
  current state, and evidence pointers.
- Crystals are compressed navigation units, not substitutes for source truth.
- Reed-Solomon shards preserve recoverable source/context tissue when compact
  navigation alone would be lossy.
- The ingress journal, sidecar lease, claim renewals, terminal receipts, and
  outbox repair provide append-only execution provenance across restarts.

Memory is delivered as evidence, with explicit budgets and source pointers. A
load-bearing claim still requires current source or a recoverable shard; inherited
prose does not become truth merely because it was retrieved.

## Verification boundary

Generated claims default to unverified. Independent graders, deterministic
contracts, outcome audits, falsifiers, and kill conditions separate proposal
from evidence. Autonomous work remains within the operator-authorized scope;
publishing, spending, contacting third parties, and external deployment require
explicit authority.

See `ARCHITECTURE.md` for the compact system map and
`docs/OPENROUTER_PROVIDER.md` or `docs/CODEX_PROVIDER.md` for provider-specific
contracts.
