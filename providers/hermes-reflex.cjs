const crypto = require("node:crypto");
const fs = require("node:fs");

const END_MEMORY = "--- END MEMORY ---";
const INPUT_BYTES = 512;
const INSPECTED_ENTRIES = 1024;
const EMITTED_FILES = 80;
const OUTPUT_BYTES = 4000;
const LIST_DIRECTORY = /^(?:please\s+)?(?:list|show|name)(?:\s+all)?\s+(?:the\s+)?(?:files|entries)(?:\s+(?:here|in\s+(?:this|the current)\s+directory))?(?:\s+in\s+one\s+sentence)?[.!?]*$/i;

let reflexSequence = 0;

function taskTail(prompt) {
  const raw = String(prompt ?? "");
  const marker = raw.lastIndexOf(END_MEMORY);
  return (marker >= 0 ? raw.slice(marker + END_MEMORY.length) : raw).trim();
}

function classifyReflex(prompt, mode = "read") {
  const normalizedMode = String(mode || "").toLowerCase();
  if (!["", "read", "analysis"].includes(normalizedMode)) {
    return { kind: "declined", reason: "mode" };
  }
  const task = taskTail(prompt);
  if (Buffer.byteLength(task, "utf8") > INPUT_BYTES) {
    return { kind: "declined", reason: "input-limit" };
  }
  if (!LIST_DIRECTORY.test(task)) {
    return { kind: "declined", reason: "grammar" };
  }
  return { kind: "list-directory", task };
}

function safeName(value) {
  return JSON.stringify(String(value).slice(0, 240)).slice(1, -1);
}

function runReflex(prompt, { cwd, mode } = {}) {
  const operation = classifyReflex(prompt, mode);
  if (operation.kind === "declined") return { handled: false, reason: operation.reason };

  let directory;
  let directoryHandle;
  const entries = [];
  let entryOverflow = false;
  let closeError = null;
  try {
    directory = fs.realpathSync(cwd || process.cwd());
    if (!fs.statSync(directory).isDirectory()) return { handled: false, reason: "cwd-not-directory" };
    directoryHandle = fs.opendirSync(directory);
    while (entries.length < INSPECTED_ENTRIES) {
      const entry = directoryHandle.readSync();
      if (!entry) break;
      entries.push(entry);
    }
    entryOverflow = entries.length === INSPECTED_ENTRIES && directoryHandle.readSync() !== null;
  } catch (error) {
    return { handled: false, reason: `cwd:${error.code || error.message}` };
  } finally {
    try {
      directoryHandle?.closeSync();
    } catch (error) {
      closeError = error;
    }
  }
  if (closeError) return { handled: false, reason: `cwd-close:${closeError.code || closeError.message}` };

  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const files = entries.filter((entry) => entry.isFile());
  let text = files.length ? "Files here: " : "There are no files here";
  let emitted = 0;

  for (const entry of files) {
    if (emitted >= EMITTED_FILES) break;
    const addition = `${emitted ? ", " : ""}${safeName(entry.name)}`;
    if (Buffer.byteLength(`${text}${addition}, and more.`, "utf8") > OUTPUT_BYTES) break;
    text += addition;
    emitted += 1;
  }

  const truncated = entryOverflow || emitted < files.length;
  text += truncated ? ", and more." : ".";
  const digest = crypto.createHash("sha256")
    .update(directory)
    .update("\0")
    .update(entries.map((entry) => entry.name).join("\0"))
    .digest("hex");

  return {
    handled: true,
    text,
    evidence: {
      operation: operation.kind,
      cwd: directory,
      totalEntries: entryOverflow ? null : entries.length,
      observedEntries: entries.length + Number(entryOverflow),
      inspectedEntries: entries.length,
      emittedFiles: emitted,
      truncated,
      sha256: digest,
    },
  };
}

async function* reflexQuery({ prompt, options = {} } = {}, { cause } = {}) {
  const result = runReflex(prompt, { cwd: options.cwd, mode: options.atlasMode });
  if (!result.handled) {
    yield {
      type: "result",
      subtype: "error",
      result: `${cause || "Codex unavailable"}; Hermes reflex declined (${result.reason})`,
      total_cost_usd: null,
    };
    return;
  }

  try {
    reflexSequence += 1;
    options.onProviderSpawn?.({
      pid: process.pid,
      startIdentity: `${process.pid}:hermes-reflex`,
      providerSessionId: `hermes-reflex:${process.pid}:${reflexSequence}`,
      providerModel: "deterministic/list-directory-v1",
      provider: "hermes-reflex",
    });
  } catch (error) {
    yield {
      type: "result",
      subtype: "error",
      result: `Reflex authority binding failed: ${error.message}`,
      total_cost_usd: null,
    };
    return;
  }

  yield {
    type: "assistant",
    message: { content: [{ type: "text", text: result.text }] },
    provider: "hermes-reflex",
    reflex: result.evidence,
  };
  yield {
    type: "result",
    subtype: "success",
    result: result.text,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    provider: "hermes-reflex",
    reflex: result.evidence,
  };
}

module.exports = { classifyReflex, runReflex, reflexQuery };
