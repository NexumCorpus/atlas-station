const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Wing Protocol v1: launch from manifest, JSONL events out, spooled JSON commands in.
// Every claim is verified:false until an independent grader exists (Phase 3).
function startWing(manifestPath, { spoolDir, onEvent }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.mkdirSync(spoolDir, { recursive: true });
  const [cmd, ...args] = manifest.launch;
  const child = spawn(cmd, args, {
    cwd: path.dirname(manifestPath),
    env: { ...process.env, WING_SPOOL: spoolDir },
  });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { ev = { t: 'garbled', raw: line }; }
      if (ev.t === 'claim') ev.verified = false;
      onEvent(ev);
    }
  });
  let seq = 0;
  return {
    manifest,
    send(obj) {
      const f = path.join(spoolDir, `${Date.now()}-${String(seq++).padStart(4, '0')}.json`);
      fs.writeFileSync(f + '.tmp', JSON.stringify(obj));
      fs.renameSync(f + '.tmp', f);
    },
    stop() { child.kill(); },
    process: child,
  };
}
module.exports = { startWing };
