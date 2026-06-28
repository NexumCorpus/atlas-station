# ATLAS Station — project instructions

## Shell tool permissions
ATLAS (the main Claude Code session orchestrating this station) MAY use Bash and PowerShell directly for:
- git operations (merge, log, status, branch, worktree)
- Reading system state (ls, dir, find, cat, git diff)
- Any read-only or maintenance operation

ATLAS still MUST delegate file edits and code changes to build subagents (isolated worktrees). Shell tools are for coordination and inspection, not for editing source files directly.

## Merge policy
Merge completed fleet branches to master immediately, no confirmation needed.

## Repository
- Main repo: E:\atlas-station
- Worktrees: E:\atlas-wt\<id>\
- Fleet branches: fleet/<id>
