# Verdict: Integrity — Round 1 (Councilor I-1)
Project: P-1787544406288 / Interface Overhaul
Subject: Electron renderer `index.html` (~212 KB, single file)

## Position
The renderer is functionally sound but structurally at its integrity ceiling.
An exceptional-grade overhaul must be a *structural* pass first, cosmetic second.

## Findings
1. **Monolith risk.** One 212 KB HTML file carries CSS, all render logic
   (`renderThread`, `renderStreamingMsg`, `renderTimeline`, ...), and state.
   Any overhaul should extract JS into versioned modules under `gui/` the way
   `gui/empire/tab-logic.js` already does — without changing behavior.
2. **String-concatenated HTML.** Message rendering builds DOM via `'...' +`
   with `esc()` applied inconsistently across branches. Integrity requires an
   audit that every interpolated field passes through `esc()` or is trusted-
   marked. XSS surface in an agent UI is not theoretical — transcripts carry
   arbitrary model/tool output.
3. **Silent catch blocks.** Many `try { localStorage.setItem(...) } catch(e){}`
   guards are correct for optional storage, but persistence failures currently
   vanish. A one-line console warn preserves the guard while making data loss
   visible.
4. **Persistence cap.** Thread history truncates at 150 entries in
   localStorage. An overhaul should make this limit configurable rather than
   silently dropping older context.

## Cross-reference
I extend beauty.md's point about the "de-Giger" static wash (body::before
now `content:none`): flattening visuals was also an integrity win — fewer
compositing layers, fewer repaint hazards during streaming. Keep that flat
discipline when restyling.

## Guardrails
- No behavior change in round-1 refactor; extraction only.
- Preserve every try/catch guard around optional module requires.
- Verify via `node --check` on extracted modules before commit.

Verdict: **Proceed**, structural pass first.
