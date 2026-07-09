# Codex CLI provider

ATLAS now supports `codex-cli` as its default execution provider. It is a
provider adapter, not a claim that the Claude Agent SDK and Codex are identical.

## Contract

- `fleethost.mjs` continues to consume a small normalized stream:
  `system/init`, `assistant`, and terminal `result` events.
- `providers/codex-cli.mjs` runs `codex exec --json`, maps `thread.started`,
  agent messages, command executions, and turn completion into that stream.
- Codex thread IDs are persisted with their issuing provider. Later turns use
  `codex exec resume <thread-id>` only when that provider matches; a legacy
  Claude session id is deliberately discarded rather than passed to Codex.
- The external Codex process cannot receive ATLAS's in-process Claude MCP server.
  The adapter says this explicitly in every prompt, so a Codex run cannot
  honestly claim to have called `spawn_agent`, `verify_build`, or another fleet
  tool that was never attached.

## Safety defaults

- Top-level ATLAS turns are `read-only` by default.
- Build turns run in their existing isolated worktree with `workspace-write`.
- No provider process receives `danger-full-access` automatically.
- User MCP/plugin configuration is ignored by default, preventing unrelated or
  unauthenticated connectors from affecting a fleet run. Set
  `ATLAS_CODEX_USE_USER_CONFIG=1` only when those connectors are intentionally
  part of the task.

## Configuration

| Variable | Meaning |
|---|---|
| `ATLAS_PROVIDER` | `codex-cli` (default) or legacy `claude-sdk` |
| `ATLAS_CODEX_BIN` | Explicit Codex executable path; otherwise discover the Desktop CLI |
| `ATLAS_CODEX_MODEL` | Optional model passed to `codex exec --model` |
| `ATLAS_CODEX_ORCHESTRATOR_SANDBOX` | Default `read-only` |
| `ATLAS_CODEX_BUILD_SANDBOX` | Default `workspace-write` |
| `ATLAS_CODEX_USE_USER_CONFIG` | Set `1` to load user plugins/MCP configuration |

## Continuity companion

`continuity_status(file?)` checks the current file hash against
`E:/station/shards.jsonl`. A valid older shard group is reported as `STALE`, not
as current recovery coverage. It never calls recovery or modifies bytes.
