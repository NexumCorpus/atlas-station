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
assert.match(html, /function cancelAtlasTurn\(\)/);
assert.match(html, /window\.atlas\.cancel\('ATLAS',submissionId\)/);
assert.match(html, /function eventSubmissionId\(m\)/);
assert.match(html, /function activeAtlasSubmissionId\(\)/);
assert.match(html, /var activeSubmissionId=activeAtlasSubmissionId\(\)/);
assert.match(html, /function rememberSubmission\(id,state\)/);
assert.match(html, /atlasForSubmission\(terminalSubmissionId\)/);
assert.match(html, /function reconcileExecutionInterrupted\(m\)/);
assert.match(html, /function reconcileCancelTerminal\(m\)/);
assert.match(html, /m\.type==='cancel_reconcile'/);
assert.match(html, /partialSubmissionId/);
assert.match(html, /Stop Atlas turn/);
assert.match(html, /m\.state==="interrupted"/);
assert.match(html, /classList\.toggle\('stop'/);
assert.match(html, /partialState==='cancel-requested'/);
assert.match(html, /m\.submissionId&&thread\[_pi\]\.submissionId===m\.submissionId/);
assert.match(html, /on && !atlasCancelRequested/);
assert.match(html, /class="ndism" data-nid=[^>]*aria-label="Dismiss notification"/);
assert.match(html, /da\.setAttribute\('aria-label', 'Dismiss all notifications'\)/);

const composerCalls = (html.match(/submitComposer\(\);/g) || []).length;
assert.equal(composerCalls, 2, "Enter and click should be the only composer call sites");
assert.match(html, /m\.type===\"autonomy_progress\"/);
assert.match(html, /autonomy forced discovery/);
assert.match(html, /autonomy retry scheduled/);
assert.match(html, /window\.atlas\.resolveGoal\(gid, 'done'\)/);

assert.match(html, /id="stream-think"/);
assert.match(html, /m\.type==="orchestrator_thinking"/);
assert.match(html, /function captureThinkForFinal/);
assert.match(html, /function thinkFromList/);
assert.match(html, /class="think"/);
assert.match(html, /usage\.prompt_tokens/);
console.log("renderer contract: ALL PASS");
