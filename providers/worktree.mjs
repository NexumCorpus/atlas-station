import { execFileSync } from "child_process";
import path from "path";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";

// Default to the checkout this file lives in; the build worktrees sit beside it.
// A checkout at E:\atlas-station therefore keeps E:\atlas-station and E:\atlas-wt.
const REPO = process.env.ATLAS_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WT_BASE = process.env.ATLAS_WT || path.join(path.dirname(REPO), "atlas-wt");

function gitC(args) { return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }
function makeWorktree(id) {
  const dir = path.join(WT_BASE, id); const branch = "fleet/" + id;
  mkdirSync(WT_BASE, { recursive: true });
  try { gitC(["worktree", "remove", "--force", dir]); } catch (_) {}
  try { gitC(["branch", "-D", branch]); } catch (_) {}
  const baseHash = (() => { try { return gitC(["rev-parse", "HEAD"]).trim(); } catch { return null; } })();
  gitC(["worktree", "add", "-f", "-b", branch, dir, "HEAD"]);
  return { dir, branch, baseHash };
}
function branchStat(branch) {
  try { const stat = gitC(["diff", "--shortstat", "master.." + branch]).trim(); const commits = Number(gitC(["rev-list", "--count", "master.." + branch]).trim()) || 0; return { branchStat: stat || "no diff yet", commits }; }
  catch (_) { return { branchStat: "?", commits: 0 }; }
}

const BUILD_NOTE = "\n\n[Working conditions] You are inside an ISOLATED git worktree which IS your current working directory. Edit files only here, via RELATIVE paths; never touch absolute E:\\atlas-station or anything outside this worktree. Keep scope tight, sanity-check, then COMMIT â€” but DO NOT use `git add -A` (it picks up unintended side-effect files). Instead: run `git status` first, then `git add <only the files you intentionally changed>`, then `git commit -m \"...\"`. Do not push.";


export { REPO, WT_BASE, gitC, makeWorktree, branchStat, BUILD_NOTE };
