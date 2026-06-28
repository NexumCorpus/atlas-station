#!/usr/bin/env node
// prune.mjs — ATLAS Station sprawl cleanup
//
// Deletes fleet branches and their worktrees that are fully merged to master.
// Unmerged branches (e.g. fleet/G-gui) and the current working directory are
// always skipped. Run with: node prune.mjs
//
// Usage: node E:\atlas-station\prune.mjs

import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(process.cwd());

function git(args) {
  return execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function safeGit(args) {
  try {
    return { ok: true, output: git(args) };
  } catch (e) {
    const msg = (e.stderr || e.message || String(e)).toString().trim().slice(0, 120);
    return { ok: false, error: msg };
  }
}

// ── Collect fleet branches ────────────────────────────────────────────────────
const branches = git(["branch", "--list", "fleet/*"])
  .split("\n")
  .map((b) => b.replace(/^[\s*+]+/, "").trim())  // strip *, +, and leading spaces
  .filter(Boolean);

if (!branches.length) {
  console.log("No fleet/* branches found — nothing to prune.");
  process.exit(0);
}

// ── Parse worktree list (--porcelain emits blank-line-separated blocks) ───────
const wtBlocks = git(["worktree", "list", "--porcelain"]).split(/\n\n+/).filter(Boolean);
/** @type {Map<string, string>} branch → absolute worktree path */
const worktreeByBranch = new Map();
/** @type {Set<string>} master worktree paths to never remove */
const masterPaths = new Set();

for (const block of wtBlocks) {
  let wtPath = null;
  let branch = null;
  let isMaster = false;
  for (const line of block.split("\n")) {
    if (line.startsWith("worktree ")) wtPath = path.resolve(line.slice("worktree ".length).trim());
    if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace("refs/heads/", "");
    if (line === "branch refs/heads/master" || line === "branch (null)") isMaster = true;
  }
  if (wtPath) {
    if (isMaster || !branch || branch === "master") masterPaths.add(wtPath);
    if (branch && branch !== "master") worktreeByBranch.set(branch, wtPath);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let prunedWorktrees = 0;
let deletedBranches = 0;
const skipped = [];

console.log(`Checking ${branches.length} fleet branches against master...\n`);

for (const branch of branches) {
  // Guard: only prune if fully merged to master
  const mergeCheck = safeGit(["merge-base", "--is-ancestor", branch, "master"]);
  if (!mergeCheck.ok) {
    console.log(`  SKIP  ${branch} — not merged to master`);
    skipped.push(`${branch} (not merged)`);
    continue;
  }

  console.log(`  PRUNE ${branch}`);

  const wtPath = worktreeByBranch.get(branch);
  if (wtPath) {
    if (masterPaths.has(wtPath)) {
      console.log(`    · skip worktree ${wtPath} — master tree`);
    } else if (wtPath === CWD) {
      console.log(`    · skip worktree ${wtPath} — current directory; will be cleaned up after merge`);
      skipped.push(`${branch} (current worktree — skip)`);
      continue; // also skip branch deletion — git won't allow it from here
    } else {
      const r = safeGit(["worktree", "remove", "--force", wtPath]);
      if (r.ok) {
        console.log(`    · removed worktree ${wtPath}`);
        prunedWorktrees++;
      } else {
        console.log(`    · worktree remove failed: ${r.error}`);
      }
    }
  } else {
    console.log(`    · no worktree registered for this branch`);
  }

  // Delete branch (try safe delete first, then force)
  let del = safeGit(["branch", "-d", branch]);
  if (!del.ok) {
    del = safeGit(["branch", "-D", branch]);
    if (del.ok) {
      console.log(`    · deleted branch ${branch} (force)`);
      deletedBranches++;
    } else {
      console.log(`    · could not delete branch ${branch}: ${del.error}`);
    }
  } else {
    console.log(`    · deleted branch ${branch}`);
    deletedBranches++;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nPruned ${prunedWorktrees} worktrees, deleted ${deletedBranches} branches`);
if (skipped.length) {
  console.log(`Skipped: ${skipped.join(", ")}`);
}
