'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Create a logger that appends a fleet agent's events to `<dir>/<agentId>.jsonl`.
 *
 * @param {string} agentId  Identifier used as the log file's base name.
 * @param {string} dir      Directory to hold the log file (created if absent).
 * @returns {{ event: (obj: any) => void, close: () => void }}
 */
function createLogger(agentId, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentId}.jsonl`);
  // Append mode keeps every event durable on disk the moment it is written,
  // so an agent crash never loses already-logged events.
  let fd = fs.openSync(file, 'a');

  return {
    event(obj) {
      if (fd === null) throw new Error('cannot log event: logger is closed');
      fs.writeSync(fd, JSON.stringify(obj) + '\n');
    },
    close() {
      if (fd === null) return; // idempotent
      try {
        fs.fsyncSync(fd); // flush OS buffers to disk
      } catch {
        /* fsync may be unsupported on some FDs; closing still flushes */
      }
      fs.closeSync(fd);
      fd = null;
    },
  };
}

module.exports = { createLogger };

// --- Self-test: `node agentlog.cjs` ---------------------------------------
if (require.main === module) {
  const os = require('os');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlog-'));
  const agentId = 'agent-selftest';
  const file = path.join(testDir, `${agentId}.jsonl`);
  let ok = false;

  try {
    const log = createLogger(agentId, testDir);
    log.event({ seq: 1, type: 'start' });
    log.event({ seq: 2, type: 'stop' });
    log.close();

    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);

    if (lines.length !== 2) {
      throw new Error(`expected 2 lines, got ${lines.length}`);
    }
    const parsed = lines.map((l) => JSON.parse(l));
    if (parsed[0].seq !== 1 || parsed[1].seq !== 2) {
      throw new Error('event payloads did not round-trip');
    }
    ok = true;
  } catch (err) {
    console.error('self-test error:', err.message);
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
