import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

assert.match(html, /function submitComposer\(\)/);
assert.match(html, /e\.preventDefault\(\);\s*submitComposer\(\);/);
assert.match(html, /sendbtn[^>]*aria-label="Send message"[^>]*disabled/);
assert.match(html, /id="say"[^>]*title="Enter sends\. Shift\+Enter adds a line break/);
assert.match(html, /id="typing" role="status" aria-live="polite"/);
assert.match(html, /class="msg-copy" aria-label="Copy message"/);
assert.match(html, /class="xcbtn"[^>]*aria-label="Cancel agent/);
assert.match(html, /class="ndism" data-nid=[^>]*aria-label="Dismiss notification"/);
assert.match(html, /da\.setAttribute\('aria-label', 'Dismiss all notifications'\)/);

const composerCalls = (html.match(/submitComposer\(\);/g) || []).length;
assert.equal(composerCalls, 2, "Enter and click should be the only composer call sites");
assert.match(html, /m\.type===\"autonomy_progress\"/);
assert.match(html, /autonomy forced discovery/);
assert.match(html, /autonomy retry scheduled/);
assert.match(html, /window\.atlas\.resolveGoal\(gid, 'done'\)/);

console.log("renderer contract: ALL PASS");
