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
bounded output, enforces a 20-minute maximum per command, and permits at most 24
tool rounds per model turn. Operator cancellation terminates the active tool.

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
