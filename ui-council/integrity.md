<<<<<<< HEAD
﻿# integrity.md — Councilor of Integrity (A-210-R), P-1787544406288

## Live inspection of E:\atlas-station\index.html (measured this session)
- 212,559 bytes, 3,677 lines. Single `<style>` block: braces balanced (521/521). Three `<script>` blocks: main inline script 142,303 bytes, braces balanced (739/739); one empty external; one tiny inline.
- 153 static `id=` attributes; **89 `getElementById` references** in JS. Cross-check result: every statically referenced id resolves EXCEPT six that are intentionally created at runtime with null-guards (`inp` falls back to `$('say')`; `memfsearch`, `streaming-msg`, `vestate`, `vfacts`, `vpulse` are lazily created by the handler that looks them up). These null-guarded lookups are a load-bearing pattern — see "must not break" below.
- JS references ~19 classList-managed classes (`active, booted, sel, match, match-active, new-msg, dz-active, dragging, gdone, stopping, vwave-active, ...`) and structural selectors like `#thread .msg`, `#brood .arow`, `.tab[data-tab=...]`. Style block defines 234 unique classes.
- Only localStorage key: `atlas_thread` — the persisted conversation history. Renderer contract from merge 5f98ebe: orchestrator tool/toolresult transcript lines render inside the streaming bubble and persist via `msg.tools`.

## What must not break
1. **Every existing id, class, and data attribute the JS touches.** The overhaul may restyle anything but must not rename/delete any of the 153 ids or the JS-referenced classes/selectors above. Renames require simultaneous JS+HTML+CSS edit in ONE commit, never split across agents.
2. **The lazy-create + null-guard pattern.** Six getElementById calls intentionally tolerate absence and build their own nodes. A refactor that "fixes" these to assume presence will throw on first message of each type. Preserve either the guards or hoist creation to init explicitly (preferred for the overhaul).
3. **Streaming pipeline DOM contract**: elements `stream-text`, `stream-think`, `stream-ts`, `stream-otl`, `typing`, plus the per-turn reset and the last-12-lines `msg.tools` capture. This is CLI-parity visibility Daniel demanded — cosmetic rewrites of the streaming bubble have broken replies twice already (commits 7afddf8 lineage).
4. **`atlas_thread` localStorage schema.** Thread history shape is shared with fleethost persistence; changing message object shape without a migration silently eats history.
5. **Brace/tag balance.** Any agent editing must leave style/script brace counts equal and HTML well-formed. Current baselines: 521/521 CSS braces, 739/739 JS braces.
6. **Keyboard shortcuts & drag-drop hooks** (kboverlay, dz-active/dragging, say-image-tray) — recently shipped screenshot pipeline (10b3c15); easy to orphan during layout rewrites.

## Why B-173/B-174 failed, and the merge-order plan
Root cause: two builders were handed the SAME single-file target with no partition. index.html is one 212KB file containing CSS + HTML + one giant JS blob — any two non-trivial edits overlap textually even when logically independent, so "merge" meant hand-reconciliation and conflict risk was structural, not carelessness.

Merge-order plan (rounds, not free-for-all):
1. **Round 0 (done)**: B-205..B-209 build against SEPARATE scratch files, never index.html directly: `css/<area>.css`, `js/<area>.js`, and an HTML skeleton patch.
2. **Round 1 — structure owner first**: one designated agent lands the HTML restructure alone (ids preserved, sections extracted into partials or clearly delimited comment bands). Everything else rebases on that commit.
3. **Round 2 — parallel leaf merges**: CSS-only changes merge in area-banded order (tabs → vitals → thread/streaming → panels) because CSS cascade order matters; each merge runs the verification checklist before the next. JS changes land one-area-per-commit, appended/moved wholesale, never interleaved line edits.
4. **Rule**: no two agents ever hold write access to the same file band in the same round. Sequentialize by band; parallelize across bands only after Round 1 freezes anchors.

## Verification checklist (run after EVERY merge into index.html)
- [ ] Brace balance: style block open==close; each script block open==close.
- [ ] Tag balance: count(`<div`)==count(`</div>`) etc., or run an HTML parser check.
- [ ] All 89 `getElementById` targets resolve to a static id OR sit inside a preserved null-guard/lazy-create pattern (diff the six known runtime ids explicitly).
- [ ] All classList/querySelector class names still exist in CSS or are created in JS.
- [ ] localStorage `atlas_thread` read/write code paths unchanged; old thread loads without error.
- [ ] Streaming render smoke test: send one message, confirm tool lines appear in bubble, finalize captures msg.tools, reload restores history.
- [ ] Keyboard shortcut 'g' focus and image attach still work.
- [ ] Size delta sane (< ±30% per commit) — catches accidental deletion of whole bands.
=======
# Verdict: Integrity � Round 1 (Councilor I-1)
Project: P-1787544406288 / Interface Overhaul
Subject: Electron renderer `index.html` (~212 KB, single file)

## Position
The renderer is functionally sound but structurally at its integrity ceiling.
An exceptional-grade overhaul must be a *structural* pass first, cosmetic second.

## Findings
1. **Monolith risk.** One 212 KB HTML file carries CSS, all render logic
   (`renderThread`, `renderStreamingMsg`, `renderTimeline`, ...), and state.
   Any overhaul should extract JS into versioned modules under `gui/` the way
   `gui/empire/tab-logic.js` already does � without changing behavior.
2. **String-concatenated HTML.** Message rendering builds DOM via `'...' +`
   with `esc()` applied inconsistently across branches. Integrity requires an
   audit that every interpolated field passes through `esc()` or is trusted-
   marked. XSS surface in an agent UI is not theoretical � transcripts carry
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
now `content:none`): flattening visuals was also an integrity win � fewer
compositing layers, fewer repaint hazards during streaming. Keep that flat
discipline when restyling.

## Guardrails
- No behavior change in round-1 refactor; extraction only.
- Preserve every try/catch guard around optional module requires.
- Verify via `node --check` on extracted modules before commit.

Verdict: **Proceed**, structural pass first.
>>>>>>> fleet/B-218
