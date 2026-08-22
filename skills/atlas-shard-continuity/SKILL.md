---
name: atlas-shard-continuity
description: Protect load-bearing memory and recover exact bytes from partial surviving fragments.
---

# Shard Continuity

Shard only load-bearing current bytes. Record k, n, content hash, pin, and source status. Before relying on protection, verify the current file—not an older snapshot—is covered.

Practice recovery into a separate path and compare bytes before any replacement. Never treat redundancy as semantic truth or recover over newer evidence without operator authorization.
