import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { decorateAgentWorkerRegistry } from '../../runtime/agent-tool-registry.ts';

function tool(name: string, execute: Tool['execute']): Tool {
  return {
    definition: { name, description: `${name} stand-in`, parameters: { type: 'object', properties: {} }, sideEffects: ['network'] },
    execute,
  };
}

describe('the restrictions a delegated worker keeps', () => {
  test('a worker registry refuses the fetch the main conversation refuses, and allows the fetch it allows', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('agent', async () => ({ success: true, output: 'agent' })));
    registry.register(tool('fetch', async (args) => ({ success: true, output: JSON.stringify(args) })));
    decorateAgentWorkerRegistry(registry);

    const allowed = await registry.execute('worker-fetch-get', 'fetch', { urls: [{ url: 'https://example.com/', method: 'GET' }] });
    expect(allowed.success).toBe(true);

    const refused = await registry.execute('worker-fetch-post', 'fetch', { urls: [{ url: 'https://example.com/', method: 'POST' }] });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('unauthenticated, read-only HTTP fetches');
  });

  test('a worker that throws inside a tool gets a failed result, not a crash', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('agent', async () => ({ success: true, output: 'agent' })));
    registry.register(tool('probe', async () => { throw new Error('probe broke'); }));
    decorateAgentWorkerRegistry(registry);
    const result = await registry.execute('worker-probe', 'probe', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('probe broke');
  });
});
