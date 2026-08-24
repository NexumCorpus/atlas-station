const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');

function fail(error) {
  console.error('renderer harness: FAIL', error && error.stack ? error.stack : error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'renderer-harness-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (event) => {
    const message = event.message || '';
    if (/error|uncaught/i.test(message)) console.error('[renderer]', message);
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const input = document.getElementById('say');
      const send = document.getElementById('sendbtn');
      if (!input || !send) throw new Error('composer controls missing');
      const inputEvent = () => input.dispatchEvent(new Event('input', { bubbles: true }));
      const key = (shiftKey) => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event;
      };
      const calls = () => window.atlas.getCalls();
      const clear = () => window.atlas.clearCalls();
      const lastSubmissionId = () => window.atlas.getLastSubmissionId();
      if (window.clearThread) window.clearThread();

      if (!send.disabled) throw new Error('send must start disabled');

      // A may still be pending in the renderer when the sidecar has already
      // admitted B. Stop must follow the live ATLAS identity, not FIFO.
      input.value = 'turn A'; inputEvent(); key(false);
      const timingASubmissionId = lastSubmissionId();
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'working', submissionId: timingASubmissionId, summary: 'A working' });
      input.value = 'turn B'; inputEvent(); key(false);
      const timingBSubmissionId = lastSubmissionId();
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'working', submissionId: timingBSubmissionId, summary: 'B working' });
      clear();
      window.atlas.emitFleet({ type: 'cancel_reconcile', state: 'done', submissionId: timingASubmissionId, reply: 'A completed before delayed Stop arrived' });
      if (!Array.from(document.querySelectorAll('.msg.atlas .msg-text')).some((el) => el.innerText.includes('A completed before delayed Stop arrived'))) throw new Error('too-late A cancellation did not reconcile A');
      if (send.getAttribute('aria-label') !== 'Stop Atlas turn') throw new Error('A reconciliation disturbed active B');
      send.click();
      if (calls().length !== 1 || calls()[0].type !== 'cancel' || calls()[0].submissionId !== timingBSubmissionId) throw new Error('Stop did not prefer the live B submission over pending A');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'done', submissionId: timingASubmissionId, reply: 'duplicate A completion must be ignored' });
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'interrupted', submissionId: timingBSubmissionId, summary: 'B cancelled' });

      clear();
      input.value = 'hello'; inputEvent();
      if (send.disabled) throw new Error('send did not enable for non-empty input');
      const enter = key(false);
      if (!enter.defaultPrevented) throw new Error('Enter default action was not prevented');
      if (JSON.stringify(calls()) !== JSON.stringify([{ type: 'say', text: 'hello' }])) throw new Error('Enter did not send exactly once');
      if (input.value !== '' || send.disabled || send.getAttribute('aria-label') !== 'Stop Atlas turn') throw new Error('active Atlas turn did not expose Stop');
      const aSubmissionId = lastSubmissionId();
      if (!aSubmissionId) throw new Error('Atlas submission ID was not captured');
      send.click();
      if (calls().length !== 2 || calls()[1].type !== 'cancel' || calls()[1].id !== 'ATLAS' || calls()[1].submissionId !== aSubmissionId) throw new Error('Stop did not cancel the correlated Atlas turn');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'working', partial: true, text: 'late buffered text' });
      if (document.getElementById('streaming-msg')) throw new Error('late partial resurrected streaming text after Stop');
      window.atlas.emitFleet({ id: 'A-unrelated', type: 'agent', state: 'working', mode: 'read', task: 'unrelated render', ts: Date.now() });
      if (getComputedStyle(document.getElementById('typing')).display !== 'none') throw new Error('unrelated render resurrected typing while stopping');
      clear();
      input.value = 'queued B'; inputEvent(); key(false);
      const bSubmissionId = lastSubmissionId();
      if (!bSubmissionId || bSubmissionId === aSubmissionId) throw new Error('queued B did not receive a distinct submission ID');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'done', submissionId: aSubmissionId, reply: 'late A result accepted' });
      const lateA = Array.from(document.querySelectorAll('.msg.atlas .msg-text')).map((el) => el.innerText).filter((text) => text.includes('late A result accepted'));
      if (lateA.length !== 1) throw new Error('correlated late A result was discarded instead of reconciling the cancelled turn');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'interrupted', submissionId: aSubmissionId, summary: 'cancelled by operator' });
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'interrupted', submissionId: aSubmissionId, summary: 'duplicate A interruption' });
      if (!document.querySelector('.msg.atlas.interrupted')) throw new Error('interrupted ATLAS turn was not truthfully rendered');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'done', submissionId: bSubmissionId, reply: 'B result' });
      const atlasText = Array.from(document.querySelectorAll('.msg.atlas .msg-text')).map((el) => el.innerText);
      if (atlasText.filter((text) => text.includes('B result')).length !== 1) throw new Error('B result was not matched to B bubble exactly once');
      if (atlasText.filter((text) => text.includes('late A result accepted')).length !== 1) throw new Error('late A result was rendered more than once');
      if (!send.disabled || send.getAttribute('aria-label') !== 'Send message') throw new Error('interrupted Atlas turn did not restore Send');

      clear();
      input.value = 'late failure'; inputEvent(); key(false);
      const failedSubmissionId = lastSubmissionId();
      send.click();
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'failed', submissionId: failedSubmissionId, reply: 'late correlated failure' });
      const failedTexts = Array.from(document.querySelectorAll('.msg.atlas.error .msg-text')).map((el) => el.innerText);
      if (!failedTexts.some((text) => text.includes('late correlated failure'))) throw new Error('correlated late failure was discarded instead of reconciling the cancelled turn');

      clear();
      input.value = 'ingress scope'; inputEvent(); key(false);
      const ingressSubmissionId = lastSubmissionId();
      const errorsBeforeIngressFailure = document.querySelectorAll('.msg.atlas.error').length;
      window.atlas.emitFleet({ type: 'ingress', state: 'failed', reason: 'unrelated ingress failure' });
      if (document.querySelectorAll('.msg.atlas.error').length !== errorsBeforeIngressFailure) throw new Error('uncorrelated ingress failure wildcard-failed a pending Atlas bubble');
      if (send.getAttribute('aria-label') !== 'Stop Atlas turn') throw new Error('uncorrelated ingress failure stopped the pending Atlas turn');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'done', submissionId: ingressSubmissionId, reply: 'ingress scope recovered' });

      clear();
      input.value = 'execution-only interrupt'; inputEvent(); key(false);
      const cSubmissionId = lastSubmissionId();
      window.atlas.emitFleet({ type: 'execution', state: 'interrupted', lane: 'mouth', submissionId: cSubmissionId, summary: 'execution-only cancellation' });
      if (!Array.from(document.querySelectorAll('.msg.atlas.interrupted .msg-text')).some((el) => el.innerText.includes('execution-only cancellation'))) throw new Error('execution-only interruption did not settle its correlated bubble');

      clear();
      input.value = 'line one'; inputEvent();
      const shift = key(true);
      if (shift.defaultPrevented) throw new Error('Shift+Enter was intercepted');
      if (calls().length !== 0) throw new Error('Shift+Enter dispatched a message');

      input.value = 'clicked'; inputEvent();
      send.click();
      const clickCalls = calls();
      if (clickCalls.length !== 1 || clickCalls[0].type !== 'say' || clickCalls[0].text !== 'clicked') throw new Error('click did not send exactly once');
      if (input.value !== '' || send.disabled || send.getAttribute('aria-label') !== 'Stop Atlas turn') throw new Error('click did not clear and expose Stop');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'interrupted', summary: 'cancelled by operator' });
      if (!send.disabled) throw new Error('click turn did not restore disabled Send after interruption');

      clear();
      input.value = '@build inspect composer'; inputEvent();
      key(false);
      const buildCalls = calls();
      if (buildCalls.length !== 1 || buildCalls[0].type !== 'dispatch' || buildCalls[0].mode !== 'build') throw new Error('@build did not dispatch build mode');
      if (input.value !== '' || !send.disabled) throw new Error('@build did not clear and disable the composer');

      clear();
      input.value = '@read inspect composer'; inputEvent();
      send.click();
      const readCalls = calls();
      if (readCalls.length !== 1 || readCalls[0].type !== 'dispatch' || readCalls[0].mode !== 'read') throw new Error('@read did not dispatch read mode');

      clear();
      input.value = 'escape probe'; inputEvent();
      key(false);
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'working', summary: 'working' });
      clear();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const escapeCalls = calls();
      if (escapeCalls.length !== 1 || escapeCalls[0].type !== 'cancel' || escapeCalls[0].id !== 'ATLAS') throw new Error('Escape did not cancel the Atlas turn');
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'interrupted', summary: 'cancelled by operator' });

      clear();
      window.atlas.emitFleet({ id: 'A-test', type: 'agent', state: 'working', mode: 'build', task: 'cancel me', ts: Date.now() });
      const cancel = document.querySelector('#brood .xcbtn[data-id="A-test"]');
      if (!cancel || cancel.getAttribute('aria-label') !== 'Cancel agent A-test') throw new Error('cancel control is not accessible');
      cancel.click();
      const cancelCalls = calls();
      if (cancelCalls.length !== 1 || cancelCalls[0].type !== 'cancel' || cancelCalls[0].id !== 'A-test') throw new Error('cancel did not route the agent id');

      input.value = 'failure probe'; inputEvent();
      key(false);
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'working', summary: 'working' });
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'failed', reply: 'controlled failure' });
      if (!document.querySelector('.msg.atlas.error')) throw new Error('failed ATLAS turn was not visibly marked');
      if (document.getElementById('status').textContent !== 'overseer · failed') throw new Error('failed ATLAS turn returned to idle status');

      window.atlas.emitFleet({ type: 'autonomy_progress', rested: true, idleStreak: 4, discovery: true, nextDelay: 4000 });
      if (!document.body.innerText.includes('autonomy forced discovery')) throw new Error('autonomy discovery progress was not visible');
      window.atlas.emitFleet({ type: 'fleet_lifecycle', state: 'started', generation: 7, pid: 12345, startedAt: new Date().toISOString() });
      window.atlas.emitFleet({ type: 'ingress', state: 'renewed', directiveId: 'event:test', attemptId: 'attempt:test', seq: 9, expiresAt: Date.now() + 30000 });
      if (document.getElementById('timeline').innerText.includes('claim-renewal')) throw new Error('claim-renewal noise leaked into the operator timeline');
      window.atlas.emitFleet({ type: 'execution', state: 'working', lane: 'mouth', directiveId: 'event:test', elapsedMs: 4200, heartbeatAt: new Date().toISOString() });
      if (!document.getElementById('exec-task').textContent.includes('mouth working · 4s')) throw new Error('live execution heartbeat was not visible');
      if (!document.body.innerText.includes('fleet sidecar started · generation 7 · pid 12345')) throw new Error('fleet generation was not visible');

      return { enterSent: true, shiftEnterPreserved: true, buildMode: 'build', readMode: 'read', cancelRouted: true, failureVisible: true, autonomyProgressVisible: true, executionHeartbeatVisible: true, fleetGenerationVisible: true };
    })()`);
    console.log('renderer harness: ALL PASS', JSON.stringify(result));
    win.destroy();
    app.exit(0);
  } catch (error) {
    try { win.destroy(); } catch (_) {}
    fail(error);
  }
});

app.on('window-all-closed', () => {});
