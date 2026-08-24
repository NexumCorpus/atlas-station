import { z } from 'zod';

function resultText(result) {
  if (typeof result === 'string') return result;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks.map(block => {
    if (block?.type === 'text') return String(block.text || '');
    if (block?.type === 'resource') return JSON.stringify(block.resource || {});
    if (block?.type === 'resource_link') return JSON.stringify({ name: block.name, uri: block.uri, description: block.description });
    if (block?.type === 'image') return `[image result: ${block.mimeType || 'unknown'}]`;
    if (block?.type === 'audio') return `[audio result: ${block.mimeType || 'unknown'}]`;
    return block == null ? '' : JSON.stringify(block);
  }).filter(Boolean).join('\n');
  if (text) return text;
  if (result?.structuredContent != null) return JSON.stringify(result.structuredContent);
  return result == null ? '' : JSON.stringify(result);
}

function parametersFor(inputSchema) {
  const parser = z.object(inputSchema || {}).strict();
  // Fail closed: the provider must never see a schema broader than the one the
  // organ actually executes. An unserializable organ is a startup error, not a
  // permissive function surface that wastes rounds or bypasses intent.
  const parameters = z.toJSONSchema(parser);
  delete parameters.$schema;
  return { parser, parameters };
}

export function adaptSdkTool(sdkTool, { parallelSafe = false } = {}) {
  if (!sdkTool?.name || typeof sdkTool.handler !== 'function') throw new TypeError('invalid SDK tool');
  const { parser, parameters } = parametersFor(sdkTool.inputSchema);
  return {
    definition: {
      type: 'function',
      function: {
        name: sdkTool.name,
        description: String(sdkTool.description || `Atlas organ: ${sdkTool.name}`),
        parameters,
      },
    },
    parallelSafe,
    execute: async (input, context = {}) => {
      const parsed = await parser.parseAsync(input || {});
      const result = await sdkTool.handler(parsed, { signal: context.signal });
      const text = resultText(result);
      if (result?.isError) throw new Error(text || `${sdkTool.name} failed`);
      return text;
    },
  };
}

export function adaptSdkTools(sdkTools, { excludeNames = [], parallelSafeNames = [] } = {}) {
  const excluded = new Set(excludeNames);
  const parallel = new Set(parallelSafeNames);
  const seen = new Set();
  return (sdkTools || [])
    .filter(tool => tool?.name && !excluded.has(tool.name))
    .map(tool => {
      if (seen.has(tool.name)) throw new Error(`duplicate SDK tool name: ${tool.name}`);
      seen.add(tool.name);
      return adaptSdkTool(tool, { parallelSafe: parallel.has(tool.name) });
    });
}

export { resultText };
