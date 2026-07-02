// Standalone shim server — run detached so sessions can die without killing it.
//   node scripts/shim-serve.mjs [port]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startShim } = require('../shims/openai-claude.cjs');
const port = Number(process.argv[2] || 8399);
const s = await startShim({ port });
console.log(`shim listening on ${s.port} (timeout ${process.env.SHIM_TIMEOUT_MS || 180000}ms)`);
setInterval(() => {}, 1 << 30);
