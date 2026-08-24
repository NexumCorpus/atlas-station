# OpenRouter provider

Atlas can run the Hermes mouth and metabolism loops directly through OpenRouter.
This is a distinct provider identity, so an OpenRouter turn never resumes a
Claude SDK or OpenAI Codex conversation.

## Launch contract

Set these variables in the launch environment or in the local, gitignored
`E:\atlas-station\.env`. The current workstation uses `.env` so Electron-supervised
sidecar restarts preserve the one-week route:

```text
ATLAS_PROVIDER=openrouter
ATLAS_OPENROUTER_MODEL=stealth/ox-alpha
ATLAS_OPENROUTER_TRANSPORT=native
ATLAS_OPENROUTER_STREAM=1
ATLAS_OPENROUTER_REASONING=low
ATLAS_OPENROUTER_MAX_TOKENS=2048
ATLAS_OPENROUTER_PROVIDER_SORT=latency
ATLAS_OPENROUTER_PREFERRED_MAX_LATENCY=15
ATLAS_MOUTH_CONTEXT_CHARS=2500
ATLAS_MOUTH_TIMEOUT_MS=0
ATLAS_NO_BRIEFING=1
OPENROUTER_API_KEY=<credential>
```

The API key is used only for the HTTPS model request. Atlas removes it from the
environment inherited by model-requested shell commands. The key is not written
to Station memory, receipts, command lines, or Git. A key placed in `.env` does
persist on this workstation; rotate or remove it when the one-week route ends.

## Execution body

The provider uses OpenRouter Chat Completions with native function calling. Its
shell organ executes PowerShell in the requested Atlas workspace, returns
bounded output, and enforces a 20-minute maximum per command. The provider
defaults to 24 tool rounds. The conversational mouth and metabolism each request
64 rounds by default through `ATLAS_MOUTH_MAX_TURNS` and
`ATLAS_ORCHESTRATOR_MAX_TURNS`; workers default to 12. Every request is clamped
to the provider safety ceiling of 256. The active workstation sets
`ATLAS_MOUTH_TIMEOUT_MS=0`, so no wall-clock fuse truncates direct dialogue; a
positive value enables a bounded 5-second through 20-minute fuse. OpenRouter
shell calls keep their own bounded, cancellable timeout.
If either mouth bound is exhausted, it releases speech with a bounded
acknowledgement and queues exactly one continuation on metabolism. Operator
cancellation terminates the active tool.

Atlas has two independent serialized execution lanes. The **mouth** owns live
operator conversation and its own provider session. **Metabolism** owns startup,
deferred, autonomy, and retry work in a separate session. Work remains FIFO
inside each lane, but metabolism cannot head-of-line block speech. Deep-context
swarm readers receive the
already hashed corpus directly instead of passing it through the ordinary 6K
memory envelope; their fleet receipts bind each worker to the corpus root.
Operator ingress is selected before older background ingress, and claims, renewals, and
terminal receipts preserve the selected lane as provenance.

Stop is bound to the active submission id, not merely the shared `ATLAS` agent
name. A delayed Stop therefore cannot kill the next queued turn. Stops that
arrive before provider admission are fsync'd to a hash-chained, append-only
cancellation ledger and survive a sidecar restart; admission consumes one
durable receipt before constructing a remote request. Nested consolidation,
research, fan-research, variant, shell, shard, and verification organs inherit
the parent abort signal. If a Stop arrives after a turn has already settled,
the sidecar replays that authoritative terminal to the correlated bubble rather
than leaving the composer in a permanent stopping state.

OpenRouter mouth calls are intentionally provider-stateless across operator
turns. Context Mycelium supplies the bounded hot context and authenticated
recovery root on every turn; retaining those enriched prompts again in the
provider session would recursively grow the request until ordinary dialogue
timed out. Tool-call rounds within one turn still share their local message
history. Metabolism retains its resumable session for long-running work.

The direct adapter enforces caller policy rather than merely documenting it:
`maxTurns` is honored, `disallowedTools` removes denied tools from the request,
`permissionMode: plan` advertises no tools, and `canUseTool` gates shell and
native calls. Function arguments are validated against their schemas at runtime.
Parallel calls execute concurrently and their tool receipts retain model order.
Native execution shares the caller's timeout and abort signal. Direct OpenRouter
MCP servers are not supported and the provider declares that limitation through
its capabilities object.

Before every provider round, Atlas measures the complete JSON request and stops
with a typed context-budget terminal if it exceeds
`ATLAS_OPENROUTER_MAX_REQUEST_BYTES` (3,500,000 bytes by default). This prevents
repeated bounded tool outputs from silently growing into an unbounded request.
Read-only parallel organs are time-bounded; serial mutation organs must settle
before the model advances so a timeout cannot leave an unaudited background
write.

OpenRouter cannot consume the in-process Claude MCP server directly. Station now
generates strict OpenRouter functions from the same SDK tool registry used by the
fleet server, so memory, shards, crystals, spirals, research, verification,
projects, skill evolution, and the other fleet organs remain executable on the
Ox Alpha route. Mutation-capable organs are serialized; only an explicit
read-only allowlist may execute concurrently. `spawn_agent` and `check_fleet`
retain purpose-built OpenRouter implementations, and `deep_context_swarm` remains
the explicit large-context path. Spawn calls return a visible fleet id
immediately; workers run as the same configured Ox Alpha model, and build workers
retain isolated-worktree behavior.

`deep_context_swarm` is the explicit large-context path. It deterministically
packs allowlisted repository text under character and UTF-8 byte ceilings. Each
byte is charged as one conservative token, a tokenizer-independent upper bound,
reserving at least 248,000 tokens of the
supplied 1,048,576-token window for trusted instructions, reasoning, tool calls,
and output. It excludes case variants of `.env`, credential and private-key
files, runtime memory, `.git`, `.gm`, `.atlas`, dependencies, generated output,
lock files, binary content, content containing credential signatures, and
oversized files before allocation. Directory entries and admitted files are
bounded. Directory enumeration is incremental; rejected-file reads have byte and
wall-time ceilings; packing stops once saturated instead of hashing the repository tail. Every launch
returns the corpus and manifest hashes, included/omitted counts, byte/character/
token measurements, worker ids, angles, model, and packing time. The exact user
payload is hash-verified at worker entry; mission and angle occupy the trusted
system role, while repository contents remain explicitly untrusted data. Deep
readers receive no shell tool: the authenticated corpus is their complete evidence
surface, eliminating a contradictory read gate and preventing repository text from
acquiring tool authority.

One through eight distinct read workers can examine the same corpus concurrently.
Atomic reservations limit the organism to eight active deep readers and 8,000,000 aggregate
context characters, reducing the per-worker corpus when necessary or returning a
typed rejection. Identical active swarms are rejected. Retry records retain the
authenticated execution receipt, and `check_fleet` exposes bounded cursor pages
rather than serializing the entire historical fleet.

Ox Alpha is the default OpenRouter model. Override it with
`ATLAS_OPENROUTER_MODEL`. Reasoning defaults to `max` and can be set with
`ATLAS_OPENROUTER_REASONING`; response output defaults to 32,768 tokens and can
be bounded with `ATLAS_OPENROUTER_MAX_TOKENS`. Remote requests time out after
five minutes by default; `ATLAS_OPENROUTER_REQUEST_TIMEOUT_MS` can set a bound
from one second through 20 minutes.

## Failure visibility

The provider card reports `active: openrouter`, the exact model, credential
presence as a boolean, and the `chat-completions` API route. Remote errors are
bounded before reaching the UI and never include the authorization header.

Reply publication is fail-closed: the outbox record must be durably written
before ingress can ACK or FAIL. If later adjudication replaces a historical
terminal, repair appends an explicitly proven superseding publication; readers
follow that chain while the rejected row remains immutable. Electron supervises
the sidecar by both child-process events and a one-second owned-PID watchdog, so
a lost Windows exit notification cannot leave a living desktop with a dead
Atlas body.

A transport rejection is terminal because process death can hide whether remote
admission occurred. Operator aborts and failures after response admission are
also terminal. Pre-admission HTTP 408, 429, 500, 502, 503, and 504 responses have
two abort-aware retries at three and six seconds by default on both streaming and
non-streaming routes.
`ATLAS_OPENROUTER_HTTP_RETRIES` bounds attempts from zero
through three, and `ATLAS_OPENROUTER_RETRY_BASE_MS` bounds the base delay.

The active workstation uses `ATLAS_OPENROUTER_TRANSPORT=native` with streaming
enabled. It exposes SSE text and reasoning deltas immediately to the renderer and
has a live provider probe in the acceptance evidence. The PowerShell transport
remains a buffered fallback: `ATLAS_OPENROUTER_TRANSPORT=powershell` sends the request through Windows
`HttpClient`, avoiding the supervised sidecar's unreliable Node socket path. The
credential crosses only the helper's standard input; it is never placed on the
command line or written by the transport. The helper streams response bytes into
a 16 MiB bounded buffer before Base64 framing them for Node. `isolated`, `native`,
and the default process-global fetch remain available as diagnostic alternatives.

The mouth carries a 2,500-character hot context selected by Context Mycelium.
Anything omitted is not summarized away: it is content-addressed, Reed-Solomon
sharded, and represented by an authenticated recovery root. Background
metabolism retains the wider 6,000-character context and can rehydrate exact
bytes on demand. The mouth also receives a compact role; provider-exposed tool
schemas travel separately, so the long orchestrator tool catalog is not repeated
in every system prompt.

Atlas defaults OpenRouter provider selection to `latency`, keeps fallbacks on,
requires support for the parameters it sends, and prefers endpoints whose
recent latency is below 15 seconds. Override the sort with
`ATLAS_OPENROUTER_PROVIDER_SORT` and the soft latency preference with
`ATLAS_OPENROUTER_PREFERRED_MAX_LATENCY`.

When the credential is supplied only through the launch environment, closing
Station destroys that process-local copy. When supplied through `.env`, it
survives restarts until the operator rotates or removes it.
