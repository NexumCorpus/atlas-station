const fs = require('fs');
let s = fs.readFileSync('fleethost.mjs','utf8');
const NL = s.includes('\r\n') ? '\r\n' : '\n';
function lit(x){ return x.split('\n').join(NL); }

// 1) scheduleAgentRetry: signature + hypothesis
let a1 = lit('function scheduleAgentRetry(task, mode, agentTimeout, model, projectId, dialectName, priorId, reason, execution = {}) {\n  const rid = priorId + "-R";\n  const retryAt = Date.now() + AGENT_RETRY_DELAY_MS;');
if (!s.includes(a1)) throw new Error('anchor1 miss');
s = s.replace(a1, a1 + lit('\n  // Diagnostic retry: capture why the parent died so the retry can be reasoned about, not just rerun.\n  let parentFailureSignature = null;\n  try { const __parent = agents.get(priorId) || {};\n    parentFailureSignature = (__parent.failSubtype ? "[" + __parent.failSubtype + "] " : "") + String(__parent.summary || __parent.reply || "").slice(0, 200);\n  } catch (_) {}\n  const retryHypothesis = "transient tool-round exhaustion under load; same brief expected to fit within RETRY_TURN_BOUND";'));

let a2 = lit('swarmKey: execution.swarmKey || null });');
if (!s.includes(a2)) throw new Error('anchor2 miss');
s = s.replace(a2, lit('swarmKey: execution.swarmKey || null,\n    ...(parentFailureSignature ? { parentFailureSignature, retryHypothesis } : {}) });'));

// 2) armAgentRetry dispatch wrap
let a3 = lit('await runSubagent(record.task, record.retryMode, record.agentTimeout, record.requestedModel, record.projectId, record.dialectName, { retried: true }, record.id, record.execution || {});');
if (!s.includes(a3)) throw new Error('anchor3 miss');
s = s.replace(a3, lit([
'let __retryTask = record.task;',
'      if (record.parentFailureSignature) {',
'        __retryTask = "RETRY of " + record.id + ", which failed with " + record.parentFailureSignature + ". Your job includes explaining what conditions changed vs the failed attempt." + String(record.task || "");',
'        send("agent_retry_diagnostic", { id: record.id, parentFailureSignature: record.parentFailureSignature });',
'      }',
'      await runSubagent(__retryTask, record.retryMode, record.agentTimeout, record.requestedModel, record.projectId, record.dialectName, { retried: true }, record.id, record.execution || {});'
].join('\n')));

// 3) retry-success fact append at terminalization
let a4 = lit("if (_memstore && _memstore.recordTerminalOnce(id)) try { _memstore.appendRun({ agentId: id, task: agents.get(id)?.task,");
if (!s.includes(a4)) throw new Error('anchor4 miss');
s = s = s.replace(a4, lit([
'try {',
'        const __rec = agents.get(id) || {};',
'        if (__rec.retryOf && done && _memstore) {',
'          try {',
"            _memstore.appendFact({ topic: 'retry-outcome', fact: `Retry success: ${__rec.retryOf} failed (${__rec.parentFailureSignature || 'unknown'}), but ${id} succeeded on same brief class; outcome=done`, source: `ATLAS:${new Date().toISOString().slice(0, 10)}`, confidence: 'observed' }, path.join(REPO, 'memory'));",
"            send('retry_success_logged', { id, retryOf: __rec.retryOf });",
'          } catch (_) {}',
'        } // on repeat failure, failSubtype is already recorded via set() above',
'      } catch (_) {}').join(NL) + NL + '      ' + a4);

fs.writeFileSync('fleethost.mjs', s);
console.log('patched ok');
