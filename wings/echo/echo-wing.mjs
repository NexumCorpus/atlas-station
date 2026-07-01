import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
const spool = process.env.WING_SPOOL;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ t: 'status', state: 'ready' });
const tick = async () => {
  for (const f of (await readdir(spool)).filter(f => f.endsWith('.json')).sort()) {
    const p = path.join(spool, f);
    const cmd = JSON.parse(await readFile(p, 'utf8'));
    await unlink(p);
    if (cmd.op === 'echo') emit({ t: 'status', state: 'ready', echo: cmd.payload });
    else if (cmd.op === 'claim') emit({ t: 'claim', id: cmd.id, bundle: cmd.bundle ?? null });
    else if (cmd.op === 'stop') { emit({ t: 'status', state: 'stopped' }); process.exit(0); }
  }
  setTimeout(tick, 50);
};
tick();
