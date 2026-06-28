# ATLAS Station — project instructions

## Shell tool permissions
ATLAS (the main Claude Code session) has full Bash and PowerShell access for this project.

Use shell tools directly for:
- git coordination (merge, log, branch, worktree management, prune)
- Reading system state (dir, find, git diff, git status)
- Running scripts (node prune.mjs, npm run ...)

Continue to use build subagents for substantial code changes — not because you can't edit directly, but because isolated worktrees give review checkpoints and protect the live tree during parallel work. The constraint is judgment, not enforcement.

## Merge policy
Merge completed fleet branches to master immediately, no confirmation needed.

## Repository
- Main repo: E:\atlas-station
- Worktrees: E:\atlas-wt\<id>\
- Fleet branches: fleet/<id>
