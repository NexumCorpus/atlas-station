# Approval Round-Trip — the opened egg

Human-in-the-loop tool approval for the ATLAS fleet. A build agent reaches for a
risky tool (write, exec, anything outside the read-only `SAFE` set); the call
**pauses mid-flight**; the overseer sees it surface in the UI as the "opened
egg" and clicks **allow** or **deny**; the agent **resumes** with that verdict.

This document specifies the exact mechanism and the precise code changes per
file. It is the build spec for wiring the gate that `fleethost.mjs` currently
leaves as a TODO (`// future: m.t === "decision"`).

---

## 1. Why this works — the pending Promise *is* the pause

The Agent SDK's `canUseTool(name, input, opts)` callback is `async`: the SDK
**awaits its return value** before executing the tool. Today fleethost resolves
it synchronously — allow `SAFE`, deny everything else — so the agent never
blocks.

The round-trip changes one thing: for a risky tool, `canUseTool` returns a
Promise we **deliberately do not resolve yet**. We stash its `resolve` function
in a registry keyed by an approval id, emit an `approval` event up to the UI, and
return. The agent's `for await (const m of query(...))` loop is now parked inside
the SDK, awaiting our Promise — the agent is genuinely suspended, not polled.

When the overseer decides, the decision travels back down to fleethost, which
looks up the stored `resolve` by id and calls it with a `PermissionResult`.
That settles the awaited Promise; the SDK either runs the tool (`allow`) or tells
the model it was refused (`deny`); the agent's loop ticks forward. No threads, no
queues, no busy-wait — just one Promise held open across a UI round-trip.

```
  build agent (SDK query loop)
        │ wants tool "Edit"
        ▼
  canUseTool() ── SAFE? ──no──► make approvalId, store resolve(), send "approval" ─┐
        ▲                                                                          │
        │  Promise stays pending … agent parked …                                 │
        │                                                                          ▼
        │                                            main.cjs relay ──► renderer (opened egg)
        │                                                                          │
        │                                                          overseer clicks allow/deny
        │                                                                          ▼
        │                                            preload decide() ──► main.cjs ──► fleet.send
        │                                                                          │
        └──────── resolve(PermissionResult) ◄── pending.get(id).resolve ◄── "decision" message
                  (allow → tool runs;  deny → model told no)
```

---

## 2. Message protocol

Two new message shapes are added; both ride the existing IPC channels.

| Direction | Channel | Message | Added / existing |
|---|---|---|---|
| sidecar → main → renderer | `process.send` → `"fleet"` | `{ type:"approval", id, agent, tool, input }` | **new** (outbound path already relays verbatim) |
| renderer → main | `ipcRenderer.send("decide", …)` | `{ id, allow }` | **new channel** |
| main → sidecar | `fleet.send` | `{ t:"decision", id, allow }` | **new** (`t`-keyed, matches `dispatch`) |

Convention preserved: **child→parent keys on `type`** (`ready`, `agent`, now
`approval`); **parent→child keys on `t`** (`dispatch`, now `decision`).

`id` is the **approval id** (e.g. `"A-3#1"` — agent id `#` sequence), globally
unique across the brood so concurrent eggs never collide. `agent` is the agent
id so the UI can attribute the egg. `input` is the tool's argument object, shown
to the overseer so the decision is informed (the egg is *opened* — you see what's
inside).

---

## 3. Code changes

### 3.1 `fleethost.mjs` — pend, emit, match, resolve

This is where the round-trip lives: a registry of pending approvals, a
`canUseTool` that pends on risky tools, and a `decision` handler that matches a
verdict back to its Promise.

**(a) Add the approval registry** next to the `agents` map (after line 13):

```js
const agents = new Map(); // id -> state record
const pending = new Map(); // approvalId -> { resolve, agentId, input }
let approvalSeq = 0;
```

**(b) Replace the `canUseTool` callback** inside `runAgent`'s `query({ options })`.
Today (lines 31–33):

```js
        canUseTool: async (name) => SAFE.has(name)
          ? { behavior: "allow" }
          : { behavior: "deny", message: "fleet MVP: read-only until the approval panel" },
```

becomes:

```js
        canUseTool: (name, input, { signal } = {}) => {
          // Read-only tools clear instantly — the fleet keeps moving.
          if (SAFE.has(name)) return Promise.resolve({ behavior: "allow", updatedInput: input });
          // Risky tool: open the egg. Pend until the overseer decides.
          const approvalId = `${id}#${++approvalSeq}`;
          set(id, { state: "needs-you", pendingTool: name });
          send("approval", { id: approvalId, agent: id, tool: name, input });
          return new Promise((resolve) => {
            pending.set(approvalId, { resolve, agentId: id, input });
            // If the agent is aborted while parked, don't leak the Promise.
            if (signal) signal.addEventListener("abort", () => {
              if (!pending.has(approvalId)) return;
              pending.delete(approvalId);
              resolve({ behavior: "deny", message: "aborted before decision" });
            }, { once: true });
          });
        },
```

Notes:
- `canUseTool` now takes `input` (the tool args) and the SDK `opts` (we use its
  `signal`). It closes over `id`, so each agent's eggs are self-attributing.
- `updatedInput: input` is included on the allow branch — that is the correct
  `PermissionResult` shape for the SDK (the current code omits it; we fix it here
  so an approved tool runs with its arguments intact).
- `set(id, { state: "needs-you", ... })` emits the existing `agent` message, so
  the brood row flips to the dead-but-defined `needs-you` color/sigil *before*
  the `approval` event arrives. The two messages are ordered: state first, egg
  second.

**(c) Handle the decision** in `process.on("message")`. Today (lines 59–63):

```js
process.on("message", (m) => {
  if (!m) return;
  if (m.t === "dispatch") runAgent(m.id, m.task, m.cwd);
  // future: m.t === "decision" for the human-approval round-trip
});
```

becomes:

```js
process.on("message", (m) => {
  if (!m) return;
  if (m.t === "dispatch") { runAgent(m.id, m.task, m.cwd); return; }
  if (m.t === "decision") {
    const p = pending.get(m.id);
    if (!p) return;                 // unknown/stale id — ignore
    pending.delete(m.id);           // one decision per egg
    set(p.agentId, { state: "working", pendingTool: null });
    p.resolve(m.allow
      ? { behavior: "allow", updatedInput: p.input }
      : { behavior: "deny", message: "denied by overseer" });
    return;
  }
});
```

This is the **match-and-resolve**: `pending.get(m.id)` finds the parked Promise
by approval id, `p.resolve(...)` settles it, and the agent resumes. We flip the
agent back to `working` immediately so the UI updates without waiting for the
next assistant turn. `pending.delete` first guarantees idempotency — a duplicate
decision is a no-op.

---

### 3.2 `main.cjs` — route the decision down

The **outbound** path needs no change: `fleet.on("message", m => win.webContents.send("fleet", m))`
already forwards the new `approval` message verbatim to the renderer.

Add one **inbound** handler next to the existing `dispatch` one (after line 44):

```js
ipcMain.on("decide", (_e, p) => {
  if (!fleet || !p || !p.id) return;
  try { fleet.send({ t: "decision", id: p.id, allow: !!p.allow }); } catch (_) {}
});
```

It mirrors the `dispatch` handler exactly: guard the sidecar is alive, coerce the
payload, forward as a `t`-keyed message. `!!p.allow` normalizes the verdict to a
boolean.

---

### 3.3 `preload.cjs` — expose the `decide` bridge

Add `decide` to the `atlas` bridge (the renderer has no Node access; this is its
only door to the decision channel):

```js
contextBridge.exposeInMainWorld("atlas", {
  dispatch: (task, cwd) => ipcRenderer.send("dispatch", { task, cwd }),
  decide: (id, allow) => ipcRenderer.send("decide", { id, allow }),
  onFleet: (cb) => ipcRenderer.on("fleet", (_e, m) => cb(m)),
});
```

`window.atlas.decide(id, allow)` is the call the UI makes when the overseer
clicks. `onFleet` already delivers the inbound `approval` events — no change.

---

### 3.4 `index.html` — surface the egg, take the verdict

The renderer (1) catches `approval` events into an `approvals` map, (2) renders
each as an actionable row in a dedicated **opened-egg** panel above the brood,
and (3) on click calls `window.atlas.decide(id, allow)` and clears the egg.

**(a) CSS** — add to the `<style>` block (after the `.hint` rule, line 35):

```css
#egg{margin:0 16px 8px;border:0.5px solid #5c3a2e;background:#160f0c;display:none}
.egg-hd{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#cd5a38;padding:6px 12px;border-bottom:0.5px solid #3a241c}
.egg-row{display:flex;align-items:center;gap:11px;padding:8px 12px;border-bottom:0.5px solid #2a1b15}
.egg-row:last-child{border-bottom:none}
.egg-tool{font-size:11px;width:90px;flex:none}
.egg-in{flex:1;font-size:11px}
.egg-btn{font-family:inherit;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:4px 12px;border:0.5px solid #3a352d;background:transparent;cursor:pointer}
.egg-btn.allow{color:#93b094;border-color:#3f5a40}
.egg-btn.deny{color:#cd5a38;border-color:#5c3a2e}
```

**(b) Markup** — insert the egg container between the hero and the brood label
(between line 62's closing `</div>` of `.hero` and `<div class="lab">⟦ the brood ⟧</div>`):

```html
  <div id="egg"></div>
```

**(c) Script** — three edits inside the IIFE.

Declare the approvals map next to `var agents=new Map();` (line 79):

```js
  var agents=new Map();
  var approvals=new Map();
```

Extend the `onFleet` dispatch to catch `approval` events (lines 83–86):

```js
  window.atlas.onFleet(function(m){
    if(!m) return;
    if(m.type==="agent"){ agents.set(m.id, m); render(); }
    else if(m.type==="approval"){ approvals.set(m.id, m); renderEgg(); }
  });
```

Add `renderEgg()` plus a delegated click handler. Place after `render()`'s
definition (after line 101) and call `renderEgg()` once on init beside the
existing `render();` (line 102):

```js
  function renderEgg(){
    var list=Array.from(approvals.values());
    var egg=$('egg');
    if(!list.length){ egg.style.display='none'; egg.innerHTML=''; return; }
    egg.style.display='block';
    egg.innerHTML='<div class="egg-hd">⟐ the opened egg — '+list.length+' awaiting your call</div>'+list.map(function(a){
      var inp; try{ inp=JSON.stringify(a.input); }catch(_){ inp=String(a.input); }
      if(inp&&inp.length>200) inp=inp.slice(0,200)+'…';
      return '<div class="egg-row">'
        +'<span class="sig" style="color:#cd5a38">◉</span>'
        +'<span class="aid">'+esc(a.agent)+'</span>'
        +'<span class="egg-tool em ell">'+esc(a.tool)+'</span>'
        +'<span class="egg-in dim ell">'+esc(inp)+'</span>'
        +'<button class="egg-btn allow" data-decide="allow" data-id="'+esc(a.id)+'">allow</button>'
        +'<button class="egg-btn deny" data-decide="deny" data-id="'+esc(a.id)+'">deny</button>'
        +'</div>';
    }).join('');
  }
  $('egg').addEventListener('click',function(e){
    var btn=e.target.closest('[data-decide]'); if(!btn) return;
    var id=btn.getAttribute('data-id');
    var allow=btn.getAttribute('data-decide')==='allow';
    window.atlas.decide(id, allow);   // → preload → main → sidecar
    approvals.delete(id); renderEgg(); // egg consumed; agent flips back via its next "agent" msg
  });
```

```js
  render();
  renderEgg();
```

Notes:
- **Event delegation**, not inline `onclick`: under `contextIsolation` the IIFE's
  functions are not global, so inline handlers can't reach them. One listener on
  `#egg` reads `data-decide`/`data-id` off the clicked button — robust against
  re-renders.
- `esc(...)` (already defined) sanitizes the tool name and the JSON-stringified
  input before injection; input is truncated to 200 chars so a large diff can't
  blow out the row.
- The brood row for that agent already shows `needs-you` (from the `agent`
  message fleethost sent first), and `render()`'s need-first ordering floats it to
  the top — the egg panel is the *actionable* surface, the brood row is the
  *status*. They stay coherent because fleethost flips the agent back to
  `working` on decision.

---

## 4. End-to-end sequence

1. Agent `A-3` calls `Edit`. `SAFE` does not contain it.
2. fleethost: `approvalId = "A-3#1"`; `set(A-3, {state:"needs-you"})` → `agent`
   msg; `send("approval", {id:"A-3#1", agent:"A-3", tool:"Edit", input:{…}})`;
   returns a pending Promise (stored in `pending`). **Agent A-3 parks.**
3. main relays both messages to the renderer.
4. renderer: brood row A-3 turns amber-red `◉ needs-you`; egg panel shows the
   `Edit` row with its input and **allow / deny**.
5. Overseer clicks **allow** → `window.atlas.decide("A-3#1", true)`.
6. preload → `ipcRenderer.send("decide", {id:"A-3#1", allow:true})` → main →
   `fleet.send({t:"decision", id:"A-3#1", allow:true})`.
7. fleethost: `p = pending.get("A-3#1")`; delete it; `set(A-3,{state:"working"})`;
   `p.resolve({behavior:"allow", updatedInput:input})`.
8. SDK runs `Edit`; **agent A-3 resumes**; its next assistant turn re-emits
   `working` and updates `lastTool`. Egg cleared on click; brood reflects live
   state. Deny is identical except step 7 resolves `{behavior:"deny", message}`
   and the model is told it was refused.

---

## 5. Edge cases & robustness

- **Concurrent eggs:** `approvalId` is per-agent-sequenced and globally unique, so
  N agents pending at once each get their own row and resolve independently. The
  single `pending` map keys on that id.
- **Aborted agent:** the `signal.addEventListener("abort", …)` in `canUseTool`
  resolves the parked Promise as a deny and drops it from `pending`, so a killed
  agent never leaks a held resolver (and the SDK won't hang on shutdown).
- **Duplicate / stale decision:** `pending.delete` before `resolve` makes a second
  decision for the same id a no-op (the `pending.get` returns undefined).
- **Stale egg if an agent dies between pending and decision (MVP gap):** the egg
  row clears on click, not on agent death, so a failed-while-parked agent could
  leave a dangling row. Acceptable for the MVP; the clean follow-up is to drop any
  egg whose `agent` is no longer `needs-you` inside `render()`, or to have
  fleethost emit an `approval-cancel` on abort that the renderer deletes by id.
- **Trust the gate, not the model:** approval is enforced in fleethost's
  `canUseTool` (the SDK boundary the agent cannot bypass), not in the renderer.
  The UI only *carries* the verdict; it can't grant a tool on its own.

---

## 6. Manual test plan

1. Dispatch an agent with a task that forces a write/exec (e.g. "create a file
   `note.txt` with one line").
2. Confirm: agent flips to `needs-you`, an egg row appears naming the tool with
   its input, brood floats it to the top.
3. Click **deny** → agent reports it was refused and continues/finishes; egg
   clears.
4. Repeat, click **allow** → the tool executes (file appears), agent resumes,
   `lastTool` updates, cost ticks.
5. Dispatch two writers at once → two eggs, each resolves independently.
```