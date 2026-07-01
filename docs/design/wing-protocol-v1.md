# Wing Protocol v1

A **wing** is an external organ process (any language) mounted into the station.
File-based and CLI-native: no server, no ports. Host implementation: `wing-host.cjs`;
reference wing: `wings/echo/`; acceptance: `npm run test:wing`.

## Manifest (`wing.json`)

| Field | Meaning |
|---|---|
| `name` | wing identity |
| `version` | protocol version (1) |
| `launch` | argv array; spawned with cwd = manifest's directory |
| `capabilities` | string list, informational in v1 |

## Events — JSONL on the wing's stdout

One JSON object per line, field `t` discriminates:

- `status` — `{t, state: "ready"|"stopped"|..., ...}`; first `ready` doubles as the health signal
- `felt-state` — reserved in v1 (parsed, unused); Phase 2 carries nervous-system state here
- `need` — reserved in v1; escalations/requests for the station
- `claim` — `{t, id, bundle: <audit-bundle path>|null}`. **The host force-tags every claim
  `verified:false`.** Nothing renders as certified until an independent grader (Phase 3)
  validates the referenced bundle. A claim without a bundle can never certify.

Unparseable lines become `{t:"garbled", raw}` — surfaced, not swallowed.

## Commands — spooled JSON files

The host passes `WING_SPOOL` (a directory) in the wing's env. Commands are single JSON
objects written atomically (`.tmp` + rename), named `<timestamp>-<seq>.json`, consumed in
sorted order and deleted after processing (gm's proven spool pattern).

## v1 scope (YAGNI)

No restart policy, no multiplexed wings, no stderr protocol, no capability negotiation.
Phase 1 (mounting director2-harness) adds only what that wing actually needs.
