# BUILD SPEC: Paste-image analysis for ATLAS (operator -> seat vision)

## Feasibility: PROVEN LIVE 2026-08-22
stealth/ox-alpha accepts OpenAI-style image_url blocks via OpenRouter
(vision_probe3.js: 1x1 PNG -> "Maroon", finish=stop, usage accounted).
CRITICAL OPERATING PARAMETER: max_tokens must be generous (>=800); small
budgets are consumed by reasoning tokens -> content:null with NO error.

## The four seams

1. RENDERER (index.html): paste handler on chat input
   - window.addEventListener('paste') -> clipboardData.items -> image types
   - FileReader -> dataURL -> preview chip row above input (max 4/img turn,
     cap ~4MB each) -> attached to say payload as images:[dataURL,...]
   - Enter sends {text, images}; chips clear after send.

2. RELAY (main.cjs:174 ipcMain.on("say")):
   - if p.images?.length: write each dataURL to .atlas/say-inbox-media/
     <ts>-<n>.<ext>, pass PATHS (not blobs) downstream:
     fleet.send({t:"say", text:p.text, images:[paths]})
   - media dir gitignored; files referenced by ingress records.

3. INGRESS (ingress-journal.cjs + fleethost say handler :4228):
   - appendIngress gains optional attachments param -> persisted as
     attachments:[{path,mime,bytes}] on the directive record (additive,
     append-only contract intact; old records lack the field = valid).
   - pollSayInbox passes claim item attachments through enqueueOrchestrate.

4. SEAT QUERY (orchestrate -> provider call):
   - orchestrate(userText, source, hooks, attachments)
   - on the own-model route, load attachment files -> base64 dataURLs ->
     user message becomes content blocks:
     [{type:"text",text},...{type:"image_url",image_url:{url}}]
   - raise this route max_tokens to >=2000 (reasoning-budget lesson).

## Validation gate
- End-to-end: paste a screenshot into GUI -> ATLAS describes it accurately;
  ingress record carries attachments; thread shows the exchange.
- Regression: text-only say path byte-identical behavior; behavioral suite
  78/78 still green; no credential ever in payloads/logs.

Estimated scope: ~120 lines across 4 files. Execute as next build item.
