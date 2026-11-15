import { expect, test } from 'bun:test';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { Tool } from '../platform/src/platform/types/tools.js';

test('a tool\'s progress reports reach the caller that supplied onProgress, and only that caller', async () => {
  const tool: Tool = {
    definition: { name: 'slow', description: 'x', parameters: { type: 'object', properties: {} } },
    async execute(_args, options) { options?.onProgress?.('step 1'); options?.onProgress?.('step 2'); return { success: true, output: 'done' }; },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const notes: Array<string | undefined> = [];
  const result = await registry.execute('c1', 'slow', {}, { onProgress: (note) => { notes.push(note); } });
  expect(result.success).toBe(true);
  expect(notes).toEqual(['step 1', 'step 2']);
  // A caller with no listener costs the tool nothing and changes nothing.
  expect((await registry.execute('c2', 'slow', {})).success).toBe(true);
  expect(notes).toHaveLength(2);
});
