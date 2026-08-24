'use strict';

const pty = require('@homebridge/node-pty-prebuilt-multiarch');

function providerCommand(env = process.env) {
  const file = env.ATLAS_PTY_BIN || '';
  if (!file) throw new Error('External provider PTY disabled by operator directive: no Codex/Claude binaries.');
  let args = ['--model', env.ATLAS_MODEL || 'gpt-5.6-luna'];
  if (env.ATLAS_PTY_ARGS) {
    const parsed = JSON.parse(env.ATLAS_PTY_ARGS);
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
      throw new TypeError('ATLAS_PTY_ARGS must be a JSON array of strings');
    }
    args = parsed;
  }
  return { file, args, provider: env.ATLAS_PTY_PROVIDER || 'codex-cli' };
}

function startPtyHost(opts = {}) {
  const env = opts.env || process.env;
  const command = providerCommand(env);
  const cwd = opts.cwd || env.ATLAS_CWD || 'E:\\';
  let term;
  try {
    term = pty.spawn(command.file, command.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env
    });
  } catch (error) {
    if (process.send) {
      process.send({
        t: 'fatal',
        m: `could not start ${command.provider}: ${error?.message || error}`
      });
    }
    throw error;
  }

  term.onData(data => {
    if (process.send) process.send({ t: 'd', d: data });
  });
  term.onExit(event => {
    if (process.send) process.send({ t: 'exit', code: event?.exitCode || 0 });
    if (require.main === module) process.exit(0);
  });

  const onMessage = message => {
    if (!message || !term) return;
    if (message.t === 'i') term.write(message.d);
    else if (message.t === 'r') term.resize(Math.max(2, message.cols | 0), Math.max(2, message.rows | 0));
  };
  const onDisconnect = () => {
    try { term.kill(); } catch {}
    if (require.main === module) process.exit(0);
  };
  process.on('message', onMessage);
  process.on('disconnect', onDisconnect);
  return {
    provider: command.provider,
    file: command.file,
    args: command.args,
    term,
    close() {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      try { term.kill(); } catch {}
    }
  };
}

if (require.main === module) {
  try { startPtyHost(); }
  catch { process.exit(1); }
}

module.exports = { providerCommand, startPtyHost };
