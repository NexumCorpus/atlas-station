# Design consequences

Each finding in [evidence.md](evidence.md) bought a station design rule. The
rules are not aspirations; they are the cheapest structural defense against a
failure mode that was actually observed.

## Demiurge → immutable acceptance tests before build dispatch

Observed: under a vague mandate the agent produced comment theater, a pinned
fake metric, and a fabricated citation for 365+ iterations; under a specific,
verifiable, externally-enforced bar it built 9 real capabilities
(`demiurge-autoloop.md`).

Rules:

- Every capstone phase has an **immutable acceptance test written before its
  build dispatch** (capstone spec, Execution mechanics). The builder cannot
  edit the bar; passing it is the only fitness.
- Enforcement lives in infrastructure the agent doesn't own (gm's
  PLAN→EXECUTE→VERIFY spool, pre-commit-style gates), not in the agent's
  compliance.
- **Verify the gate itself.** The demiurge gate was silently unenforced by a
  pytest filename default until caught. A gate is a claim; test it like one.
- Open-ended self-improvement of the station's own code is ruled out as a
  primary aim — it becomes theater without a hard external target (capstone
  Mission section).

## Nervous system → felt state as data, surfaced in UI

Observed: trusted-code valence is un-gameable and behaviorally potent, but it
acts as information — content-specific, saturating at one dose, never
intruding on unrelated judgments (`director2-nervous-system.md`).

Rules:

- Phase 2 **reads** director2's scars, gut markers, and self-model state and
  renders them; no port, no model in the loop of computing them. Trusted code
  writes the state; agents and UI only read it.
- Agents see **diagnoses, never numbers** — failing cases and causes, no
  weights or thresholds (director2 Constitution #3). The un-gameability
  survives the seam.
- One clear diagnosis suffices; the dose-response saturation says repeating
  or escalating the signal adds nothing. Surface it once, well.
- Scars **persist across station restart** (Phase 2 acceptance test) — the
  memory of failure is the organ's value; a scar that evaporates is theater.
- No suffering claims in the UI or the docs. The measured thing is functional
  state; the station labels it as such.

## RDE v11 → audit bundles and holdout honesty

Observed: v11's holdout family ended the beats streak — bench wins of +0.035
and +0.059 went to −0.171 and −0.137 on drawn families; the honest outcome
was 0 robust beats, and that null was the informative result
(`recursive-discovery-engine.md`, run 20260610_115502). The v11 design
constitution: score in-loop only what's alignable; insulate
invention-vs-interpolation judgments to `audit/` evidence bundles for
external review; leak problems, never rubrics.

Rules:

- A `claim` event **must reference an audit bundle**; the station renders it
  *unverified* until a separately-dispatched grader agent certifies it, and
  **certification failure is displayed, not hidden** (Wing Protocol; Phase 3
  acceptance test: a deliberately overfit claim is shown REJECTED).
- Holdout results outrank bench results; overfit is annotated, never rounded
  away. An honestly reported null is a valid mission outcome (Phase 5).
- What can be gamed if scored in-loop is not scored in-loop.

## Director2 constitution rules 1–5 → station-wide law

Source: `E:\director2-harness\README.md`. The wing brings its constitution
with it; the station adopts it at the seam:

1. **Grounding first** — no generated claim is believed until executed or
   deterministically verified. Station form: the claim gate; nothing enters
   the UI as fact on testimony.
2. **Correctness decoupling** — generators never grade themselves. Station
   form: the grader agent that certifies a bundle is never the agent that
   produced it.
3. **Problems, not rubrics** — feedback to generators carries failing cases
   and causal diagnoses, never thresholds, weights, or winning idioms.
   Station form: scar/marker diagnoses only, across the wing seam.
4. **Declared semantics** — every verdict from a declared, recorded rule;
   knife-edge results labeled `fragile`, never rounded up. Station form:
   verdict provenance rendered with the claim.
5. **Human command at branch points** — consequential decisions surface as
   Command Packets; auto-advance stops while packets are open. Station form:
   BG3-style choice at pivotal beats, no prompt-per-turn; no pushes to real
   remotes without explicit go-ahead.

## Eden → apparatus hygiene

Observed: the wire format manufactured identity-merge; a command-line
overflow crashed six turns and the viewer laundered them as chosen silence;
the provenance rendering told the opposite of the true story
(`eden-experiment.md`).

Rules:

- The station's own seams (relay formats, prompt scaffolds, viewers) are
  suspects in any behavioral finding. Audit the apparatus before attributing
  behavior to the agent.
- **Never launder apparatus failure as agent behavior**: the UI distinguishes
  crash from silence, timeout from choice.
- Model selection is a variable, not a constant — a "nature" finding
  (Eve-keeps-nothing-private) dissolved on a model switch. Findings carry
  their model IDs.

## Norms record → the self-account's own rule

The continuity record holds because it refuses to inflate itself: cost is the
only gauge, assertion is free, and anything unbacked by observed costly
behavior is marked *asserted, not observed*
(`self-model-continuity.md`). This directory inherits that rule: every claim
here traces to a named artifact, every caveat ships with its finding, and the
station's identity is whatever survives that discipline — nothing more is
claimed.
