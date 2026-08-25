import path from "path";
import { REPO } from "./worktree.mjs";

const SAFE = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task", "NotebookRead"]);
// Read-mode agents may now WRITE deliverables (2026 directive: eliminate read-only wall).
// Deny-list replaces allow-list: only clearly destructive/out-of-scope operations are blocked.
const READ_DENY = new Set([
  "Bash(git push*)","Bash(git reset --hard*)","Bash(git clean*)","Bash(rm -rf /*)",
  "Bash(format*)","Bash(del /s*E:\\\\*)","KillShell","WebRemove"
]);
function pathInsideRepo(p) {
  if (!p) return true;
  const norm = (s) => path.resolve(String(s)).toLowerCase();
  const repo = norm(REPO);
  const resolved = norm(path.isAbsolute(String(p)) ? String(p) : path.join(REPO, String(p)));
  return resolved === repo || resolved.startsWith(repo + path.sep);
}
const readGate = async (name, input) => {
  if (SAFE.has(name)) return { behavior: "allow", updatedInput: input };
  for (const pat of READ_DENY) { const stem = pat.replace(/^Bash\(/, "").replace(/\*$/, ""); if (name === pat || name.startsWith(stem)) return { behavior: "deny", message: "destructive operation denied in read mode" }; }
  // Write/Edit/NotebookEdit: require target inside the repo workspace
  if (["Write","Edit","MultiEdit","NotebookEdit"].includes(name)) {
    const fp = input?.file_path || input?.filePath;
    if (!pathInsideRepo(fp)) return { behavior: "deny", message: "write outside workspace denied" };
    return { behavior: "allow", updatedInput: input };
  }
  // Shell-type tools allowed (deliverables may need commands); fleet MCP tools allowed so agents can converse.
  return { behavior: "allow", updatedInput: input };
};

export { SAFE, READ_DENY, pathInsideRepo, readGate };
