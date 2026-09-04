# Colibri cold cortex

Atlas can route Long Mind cycles to a local [Colibri](https://github.com/JustVugg/colibri) server without putting that slow, disk-streamed model in the conversational path. The mouth retains the configured `ATLAS_PROVIDER`; Colibri is separate optional tissue selected only by `ATLAS_COLD_PROVIDER=colibri`.

## Configuration

```dotenv
ATLAS_COLD_PROVIDER=colibri
ATLAS_COLIBRI_API_URL=http://127.0.0.1:8000/v1
ATLAS_COLIBRI_MODEL=glm-5.2-colibri
ATLAS_COLIBRI_CACHE_SLOT=1
ATLAS_COLIBRI_HEALTH_TIMEOUT_MS=1500
ATLAS_COLIBRI_REQUEST_TIMEOUT_MS=1200000
```

`ATLAS_COLIBRI_API_KEY` is optional and should match `COLI_API_KEY` only when the server enables authentication. Atlas uses Colibri's OpenAI-compatible chat endpoint, persistent KV slot, thinking mode, and leading-stop guard. It probes `/health` before each cold cycle and defers when the server is offline, active, or queued; this keeps local prefill and FIFO pressure out of the mouth lane.

## Claim boundary

This integration makes Atlas Colibri-ready; it does not install Colibri or a model. The current workstation does not have enough free disk for the large GLM-5.2/5.3 model artifacts, and a disk-streamed model can spend a long time in silent prefill. Validate the server independently with a tiny request before enabling the cold provider.

Long Mind results remain observations. They enter the existing hash-chained ledger and cannot promote their own mutations. The desktop execution rail reports the cold cortex as `off`, `offline`, `busy`, or `ready` independently of the current Atlas turn.
