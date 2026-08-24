import assert from 'node:assert/strict';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { adaptSdkTool, adaptSdkTools, resultText } from '../providers/openrouter-tools.mjs';

const echo = {
  name: 'echo_organ',
  description: 'Echo a typed value.',
  inputSchema: { value: z.string().min(1), count: z.number().int().optional() },
  handler: async ({ value, count = 1 }) => ({ content: [{ type: 'text', text: value.repeat(count) }] }),
};

const adapted = adaptSdkTool(echo, { parallelSafe: true });
assert.equal(adapted.definition.function.name, 'echo_organ');
assert.deepEqual(adapted.definition.function.parameters.required, ['value']);
assert.equal(adapted.parallelSafe, true);
assert.equal(await adapted.execute({ value: 'x', count: 3 }), 'xxx');
await assert.rejects(adapted.execute({ value: '', unknown: true }), /too_small|Too small|Unrecognized key/);

const list = adaptSdkTools([echo, { ...echo, name: 'hidden' }], { excludeNames: ['hidden'], parallelSafeNames: ['echo_organ'] });
assert.deepEqual(list.map(tool => tool.definition.function.name), ['echo_organ']);
assert.throws(() => adaptSdkTools([echo, echo]), /duplicate SDK tool name/);
assert.throws(() => adaptSdkTool({ ...echo, name: 'opaque', inputSchema: { value: z.string().transform(value => value) } }), /transform|represent/i);
assert.equal(resultText({ structuredContent: { ok: true } }), '{"ok":true}');
await assert.rejects(adaptSdkTool({ ...echo, handler: async () => ({ isError: true, content: [{ type: 'text', text: 'bounded failure' }] }) }).execute({ value: 'x' }), /bounded failure/);

// Keep the bridge anchored to the SDK's actual tool() return shape rather than
// a hand-written lookalike. This is the shape fleethost passes to OpenRouter.
let realToolCalls = 0;
const realSdkTool = tool(
  'real_sdk_echo',
  'Echo a value from a real Claude Agent SDK tool.',
  { value: z.string().min(1) },
  async ({ value }) => {
    realToolCalls++;
    return { content: [{ type: 'text', text: `sdk:${value}` }] };
  },
);
const realAdapted = adaptSdkTool(realSdkTool);
assert.equal(realAdapted.definition.function.name, 'real_sdk_echo');
assert.deepEqual(realAdapted.definition.function.parameters.required, ['value']);
assert.equal(await realAdapted.execute({ value: 'bridge' }), 'sdk:bridge');
assert.equal(realToolCalls, 1);

console.log('openrouter SDK-tool bridge: ALL PASS');
