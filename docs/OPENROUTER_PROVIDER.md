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
ATLAS_OPENROUTER_TRANSPORT=powershell
ATLAS_OPENROUTER_STREAM=0
ATLAS_OPENROUTER_REASONING=low
ATLAS_OPENROUTER_MAX_TOKENS=2048
ATLAS_OPENROUTER_PROVIDER_SORT=latency
ATLAS_OPENROUTER_PREFERRED_MAX_LATENCY=15
ATLAS_MOUTH_CONTEXT_CHARS=2500
ATLAS_MOUTH_TIMEOUT_MS=120000
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
defaults to 24 tool rounds. The conversational mouth requests 6 through
`ATLAS_MOUTH_MAX_TURNS`; metabolism requests 64 through
`ATLAS_ORCHESTRATOR_MAX_TURNS`; and workers default to 12. Every request is
clamped to the provider safety ceiling of 256. The mouth also has a 45-second
wall-clock fuse, configurable with `ATLAS_MOUTH_TIMEOUT_MS` from 5 through 120
seconds. If either mouth bound is exhausted, it releases speech with a bounded
acknowledgement and queues exactly one continuation on metabolism. Operator
cancellation terminates the active tool.

Atlas has two independent serialized execution lanes. The **mouth** owns live
operator conversation and its own provider session. **Metabolism** owns startup,
deferred, autonomy, and retry work in a separate session. Work remains FIFO
inside each lane, but metabolism cannot head-of-line block speech. Operator
ingress is selected before older background ingress, and claims, renewals, and
terminal receipts preserve the selected lane as provenance.

The direct adapter enforces caller policy rather than merely documenting it:
`maxTurns` is honored, `disallowedTools` removes denied tools from the request,
`permissionMode: plan` advertises no shell, and `canUseTool` gates every admitted
shell call. Direct OpenRouter MCP servers are not supported and the provider
declares that limitation through its capabilities object.

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

A transport rejection before response admission is retried once. HTTP errors,
operator aborts, and failures after response admission are terminal, so the
recovery path cannot duplicate a completed model response.

`ATLAS_OPENROUTER_TRANSPORT=powershell` sends the request through Windows
`HttpClient`, avoiding the supervised sidecar's unreliable Node socket path. The
credential crosses only the helper's standard input; it is never placed on the
command line or written by the transport. `isolated`, `native`, and the default
process-global fetch remain available as diagnostic alternatives.

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
