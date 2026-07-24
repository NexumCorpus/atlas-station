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

      if (!send.disabled) throw new Error('send must start disabled');
      input.value = 'hello'; inputEvent();
      if (send.disabled) throw new Error('send did not enable for non-empty input');
      const enter = key(false);
      if (!enter.defaultPrevented) throw new Error('Enter default action was not prevented');
      if (JSON.stringify(calls()) !== JSON.stringify([{ type: 'say', text: 'hello' }])) throw new Error('Enter did not send exactly once');
      if (input.value !== '' || !send.disabled) throw new Error('Enter did not clear and disable the composer');

      clear();
      input.value = 'line one'; inputEvent();
      const shift = key(true);
      if (shift.defaultPrevented) throw new Error('Shift+Enter was intercepted');
      if (calls().length !== 0) throw new Error('Shift+Enter dispatched a message');

      input.value = 'clicked'; inputEvent();
      send.click();
      const clickCalls = calls();
      if (clickCalls.length !== 1 || clickCalls[0].type !== 'say' || clickCalls[0].text !== 'clicked') throw new Error('click did not send exactly once');
      if (input.value !== '' || !send.disabled) throw new Error('click did not clear and disable the composer');

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
      if (!document.getElementById('timeline').innerText.includes('claim-renewal') || !document.getElementById('timeline').innerText.includes('attempt:test')) throw new Error('claim provenance was not visible');
      if (!document.body.innerText.includes('fleet sidecar started · generation 7 · pid 12345')) throw new Error('fleet generation was not visible');

      return { enterSent: true, shiftEnterPreserved: true, buildMode: 'build', readMode: 'read', cancelRouted: true, failureVisible: true, autonomyProgressVisible: true, fleetGenerationVisible: true };
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
