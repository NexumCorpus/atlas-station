# Long Mind

Long Mind is Atlas's continuous local learning metabolism. It does not pretend that repeatedly asking a model to improve itself creates intelligence. It turns each cycle into one falsifiable experiment and preserves the search boundary: the surviving candidate, its nearest rejected sibling, and the discriminator between them.

The append-only hash chain lives in `.atlas/long-mind/ledger.ndjson`; compact scheduling state lives beside it. A summary is only a navigation aid. It cannot promote a change or replace byte-exact evidence.

Each cycle is a temporal committee executed by the available cortex: compiler, historian, minimal constructor, radical constructor, attacker, verifier, adjudicator. Mutations occur in isolated worktrees. Long Mind may stage candidates and negative knowledge, but it cannot merge, push, publish, spend, contact outsiders, or alter credentials.

## Cortex slots

Local, zero marginal token cost:

```env
ATLAS_PROVIDER=ollama
ATLAS_OLLAMA_API_URL=http://127.0.0.1:11434/api/chat
ATLAS_OLLAMA_MODEL=qwen3.5:9b
ATLAS_OLLAMA_CONTEXT_LENGTH=32768
```

Frontier OpenRouter upgrade, without changing the organism:

```env
ATLAS_PROVIDER=openrouter
OPENROUTER_API_KEY=...
ATLAS_OPENROUTER_MODEL=<current-frontier-model>
```

More local hardware is equally uneventful: pull a stronger Ollama model and change only `ATLAS_OLLAMA_MODEL`. The memory, tools, gauntlets, worktree isolation, and admission contract remain stable. Expensive cognition is best spent on adjudication, new curriculum, and hard cases; the local cortex handles retrieval, construction, attack, testing, and compression.

Run `npm run test:long-mind` and `npm run long-mind:status` to inspect the durable substrate.
