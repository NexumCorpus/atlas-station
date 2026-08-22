# OpenRouter provider

Atlas can run its complete Hermes execution loop directly through OpenRouter.
This is a distinct provider identity, so an OpenRouter turn never resumes a
Claude SDK or OpenAI Codex conversation.

## Launch contract

Set these variables only in the process that launches Station:

```text
ATLAS_PROVIDER=openrouter
ATLAS_OPENROUTER_MODEL=stealth/ox-alpha
OPENROUTER_API_KEY=<ephemeral credential>
```

The API key is used only for the HTTPS model request. Atlas removes it from the
environment inherited by model-requested shell commands. The key is not written
to Station memory, receipts, configuration, or Git.

## Execution body

The provider uses OpenRouter Chat Completions with native function calling. Its
shell organ executes PowerShell in the requested Atlas workspace, returns
bounded output, and enforces a 20-minute maximum per command. The provider
defaults to 24 tool rounds, while the Atlas orchestrator explicitly requests 64
through `ATLAS_ORCHESTRATOR_MAX_TURNS`. Callers may choose a smaller bound (the
worker default is 12); every request is clamped to the provider safety ceiling
of 256. Operator cancellation terminates the active tool.

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

Closing Station destroys the only copy of an ephemerally supplied credential.
Launching it again requires supplying the credential again.
