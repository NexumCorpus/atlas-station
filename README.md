# ATLAS Station

ATLAS Station is the desktop executive surface of Hermes, a local organism for
evidence-backed autonomous development and discovery. ATLAS speaks and acts;
Station preserves receipts and memory; wings connect external organs; graders
keep generated claims separate from verification.

The v1 executive route is:

```text
Daniel -> ATLAS / Hermes -> authenticated Codex CLI -> gpt-5.6-luna
```

This uses the logged-in Codex subscription, not an OpenAI API key. Other local
tasks are assigned to Codex-family routes according to their purpose and
failure surface.

## v1 capabilities

- Role-aware direct conversation that survives autonomous background work.
- Deadline-bounded autonomy with idle discovery, retry, and stale-timer repair.
- Loss-aware context injection, durable crystals, and byte-exact shard recovery.
- External Wing v1 lifecycle with Director2 felt-state integration.
- Independent claim grading with explicit certified, rejected, and null states.
- An end-to-end discovery mission path with append-only evidence.
- Sidecar-generation-aware Electron UI with transparent provider, model, task,
  failure, and autonomy state.
- One machine-readable release contract and one full readiness command.

## Run

Requirements: Windows, Node.js 24, Python 3, and a logged-in Codex CLI.

```text
npm install
npm start
```

The app starts the fleet sidecar automatically. The bottom composer speaks to
ATLAS; fleet cards expose delegated work. Local execution authority is explicit
through the provider route and remains bounded by the operator's requested
scope.

## Verify v1

```text
npm run v1:status
npm run v1:verify
npm run v1:release
```

- `v1:status` checks contract shape, required organs, provider availability,
  model assignment, and documentation truth.
- `v1:verify` runs the full deterministic/live acceptance surface and Station's
  whole-organism rehearsal, then writes `release/v1-readiness.json`.
- `v1:release` repeats those checks and additionally requires a clean worktree.

The detailed contract and limitations are in [docs/V1.md](docs/V1.md). Testing
coverage is documented in [docs/TESTING.md](docs/TESTING.md), and the Codex
adapter boundary is in [docs/CODEX_PROVIDER.md](docs/CODEX_PROVIDER.md).

## Architecture

- `main.cjs`: Electron lifecycle and renderer/sidecar IPC.
- `fleethost.mjs`: ATLAS orchestration, fleet, autonomy, and organism tools.
- `providers/codex-cli.mjs`: authenticated Codex CLI adapter and model routing.
- `memcontext.cjs`, `session-log.cjs`, `continuity.cjs`: context, direct dialogue,
  and loss-aware circulation.
- `wing-host.cjs`, `wings/director2/`: external organ protocol and discovery wing.
- `grader.cjs`, `mission.cjs`: generator-independent certification and mission
  execution.
- `index.html`, `preload.cjs`: transparent operator cockpit.
- `v1.contract.json`, `scripts/v1-readiness.cjs`: release truth and evidence.

## Safety

Hermes v1 does not autonomously publish, spend money, contact third parties, or
promote its own hypotheses to verified claims. Those actions require explicit
operator authority and independent evidence where applicable.
