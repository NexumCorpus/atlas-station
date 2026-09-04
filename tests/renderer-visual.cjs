const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

const output = path.join(__dirname, '..', 'artifacts', 'ui', 'atlas-shell-v2.png');

function fail(error) {
  console.error('renderer visual: FAIL', error && error.stack ? error.stack : error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1000,
    backgroundColor: '#090b10',
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'renderer-harness-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    const state = await win.webContents.executeJavaScript(`(async () => {
      const boot = document.getElementById('bootscreen');
      if (boot) boot.remove();
      localStorage.setItem('atlas.inspector.collapsed', '0');
      document.body.classList.remove('inspector-collapsed');
      if (window.clearThread) window.clearThread();
      const input = document.getElementById('say');
      const send = document.getElementById('sendbtn');
      const inputEvent = () => input.dispatchEvent(new Event('input', { bubbles: true }));

      input.value = 'Map the memory ingestion bottleneck and preserve exact provenance.';
      inputEvent(); send.click();
      const first = window.atlas.getLastSubmissionId();
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'done', submissionId: first,
        reply: 'The bottleneck is now isolated. I separated retrieval from admission, preserved the source bytes, and left the failed hypothesis visible.' });

      input.value = 'Turn that into a durable background task without blocking this conversation.';
      inputEvent(); send.click();
      const second = window.atlas.getLastSubmissionId();
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'working', submissionId: second,
        summary: 'Designing the non-blocking continuity path' });
      window.atlas.emitFleet({ id: 'ATLAS', type: 'agent', state: 'working', submissionId: second,
        partial: true, text: 'I am binding the task to a recoverable receipt while the conversation remains available.' });

      window.atlas.emitFleet({ id: 'A-241', type: 'agent', state: 'working', mode: 'build',
        task: 'Implement resumable memory admission', summary: 'Running focused verification', ts: Date.now() });
      window.atlas.emitFleet({ id: 'A-240', type: 'agent', state: 'done', mode: 'read',
        task: 'Audit continuity invariants', summary: '3 invariants verified', ts: Date.now() - 180000 });
      window.atlas.emitFleet({ type: 'execution', state: 'working', lane: 'mouth',
        directiveId: 'visual:continuity', elapsedMs: 8200, heartbeatAt: new Date().toISOString() });

      document.getElementById('thread').scrollTop = document.getElementById('thread').scrollHeight;
      await new Promise(resolve => setTimeout(resolve, 1800));
      const main = document.getElementById('main');
      const composer = document.getElementById('composer-shell');
      const scanVisibleMojibake = () => {
        const found = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const text = node.nodeValue.trim();
          const parent = node.parentElement;
          if (text && /[ÂÃâ]/.test(text) && parent && parent.offsetParent !== null) {
            found.push({ tag: parent.tagName, id: parent.id || '', text: text.slice(0, 100) });
          }
        }
        return found;
      };
      const tabMojibake = {};
      for (const tab of document.querySelectorAll('.tab[data-tab]')) {
        tab.click();
        await new Promise(resolve => setTimeout(resolve, 20));
        tabMojibake[tab.dataset.tab] = scanVisibleMojibake();
      }
      document.querySelector('.tab[data-tab="fleet"]')?.click();
      const mojibake = Object.entries(tabMojibake).flatMap(([tab, rows]) => rows.map(row => ({ tab, ...row })));
      return {
        bodyText: document.body.innerText.slice(0, 180),
        bodyClass: document.body.className,
        viewport: [innerWidth, innerHeight],
        main: main ? [getComputedStyle(main).display, main.offsetWidth, main.offsetHeight] : null,
        composer: composer ? [getComputedStyle(composer).display, composer.offsetWidth, composer.offsetHeight] : null,
        mojibake, tabMojibake,
      };
    })()`);
    console.log('renderer visual state:', JSON.stringify(state));
    if (state.mojibake.length) {
      throw new Error(`visible mojibake detected: ${JSON.stringify(state.mojibake)}`);
    }
    if (!state.main || state.main[0] !== 'flex' || state.main[1] < 1200) {
      throw new Error(`desktop shell did not render at the requested width: ${JSON.stringify(state.main)}`);
    }
    if (!state.composer || state.composer[0] !== 'block' || state.composer[1] < 700) {
      throw new Error(`conversation composer is not a usable primary surface: ${JSON.stringify(state.composer)}`);
    }
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 100));

    if (process.env.ATLAS_VISUAL_CAPTURE === '1') {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const image = await win.webContents.capturePage();
      fs.writeFileSync(output, image.toPNG());
      console.log(`renderer visual: wrote ${output}`);
    } else {
      console.log('renderer visual: all tabs passed (capture skipped)');
    }
    win.destroy();
    app.exit(0);
  } catch (error) {
    try { win.destroy(); } catch (_) {}
    fail(error);
  }
});

app.on('window-all-closed', () => {});
