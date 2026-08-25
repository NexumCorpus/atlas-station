import { spawn as spawnChild } from "child_process";
import { REPO } from "./worktree.mjs";

// Provider-facing organs run in this sidecar, so synchronous subprocess APIs
// freeze IPC cancellation, ingress renewal, and execution heartbeats. Keep all
// potentially slow organ subprocesses on this single bounded async path.
function runBoundedChild(command, args = [], options = {}) {
  const timeoutMs = Math.max(250, Math.min(1_200_000, Number(options.timeoutMs) || 30_000));
  const maxOutputBytes = Math.max(1_024, Math.min(4 * 1024 * 1024, Number(options.maxOutputBytes) || 64 * 1024));
  const signal = options.signal || null;
  const makeCollector = () => {
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    return {
      push(chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const remaining = maxOutputBytes - bytes;
        if (remaining <= 0) { truncated = true; return; }
        if (buf.length > remaining) { chunks.push(buf.subarray(0, remaining)); bytes += remaining; truncated = true; }
        else { chunks.push(buf); bytes += buf.length; }
      },
      text() { return Buffer.concat(chunks, bytes).toString('utf8') + (truncated ? '\n[output truncated]' : ''); },
      get truncated() { return truncated; },
    };
  };
  return new Promise(resolve => {
    const stdout = makeCollector();
    const stderr = makeCollector();
    let child = null;
    let timer = null;
    let killFallback = null;
    let settled = false;
    let termination = null;
    let terminationUnconfirmed = false;
    let spawnError = null;
    const finish = (status = null, closeSignal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killFallback);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        status,
        signal: closeSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        cancelled: termination === 'cancelled',
        timedOut: termination === 'timeout',
        terminationConfirmed: termination ? !terminationUnconfirmed : null,
        truncated: stdout.truncated || stderr.truncated,
        error: spawnError,
      });
    };
    const pidAlive = pid => {
      if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1) return false;
      try { process.kill(Number(pid), 0); return true; } catch { return false; }
    };
    const confirmTreeTermination = (reason, deadlineAt = Date.now() + 3_000) => {
      if (settled) return;
      if (!child?.pid || !pidAlive(child.pid)) { finish(null, reason); return; }
      try { child.kill('SIGKILL'); } catch {}
      if (Date.now() >= deadlineAt) {
        terminationUnconfirmed = true;
        finish(null, reason);
        return;
      }
      clearTimeout(killFallback);
      killFallback = setTimeout(() => confirmTreeTermination(reason, deadlineAt), 100);
      killFallback.unref?.();
    };
    const terminateTree = reason => {
      if (termination || settled) return;
      termination = reason;
      if (child?.pid) {
        if (process.platform === 'win32') {
          try {
            const killer = spawnChild('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', () => { try { child.kill(); } catch {} confirmTreeTermination(reason); });
            killer.once('close', () => confirmTreeTermination(reason));
          } catch { try { child.kill(); } catch {} }
        } else {
          try { child.kill('SIGTERM'); } catch {}
        }
      }
      // Await the OS tree-kill and confirm that the root PID disappeared. If
      // Windows cannot confirm within the bounded fallback, report that fact
      // explicitly instead of laundering a kill request into completion.
      killFallback = setTimeout(() => confirmTreeTermination(reason), 3_000);
      killFallback.unref?.();
    };
    const onAbort = () => terminateTree('cancelled');
    if (signal?.aborted) { termination = 'cancelled'; finish(null, 'cancelled'); return; }
    try {
      child = spawnChild(command, args, {
        cwd: options.cwd || REPO,
        env: options.env || process.env,
        shell: options.shell === true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error;
      finish(null, null);
      return;
    }
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stderr?.on('data', chunk => stderr.push(chunk));
    child.once('error', error => { spawnError = error; if (!child?.pid) finish(null, null); });
    child.once('close', (code, closeSignal) => finish(code, closeSignal));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => terminateTree('timeout'), timeoutMs);
    timer.unref?.();
  });
}

export { runBoundedChild };
