import { describe, expect, test } from 'bun:test';
import { PhasedToolExecutor } from './_helpers/runtime-seam.ts';
import type { ToolRuntimeContext } from './_helpers/runtime-seam.ts';
import type { Tool, ToolCall } from '@goodvibes-jev/engine/platform/platform/types';

function ctx(): ToolRuntimeContext {
  return {
    runtime: { getState: () => ({}), subscribe: () => () => {} },
    ids: { sessionId: 's', conversationId: 'c', turnId: 't', toolCallId: 'x', traceId: 'tr' },
    tasks: {},
    resources: { fileCache: {} as never, projectIndex: {} as never },
    provider: { providerId: 'mock', modelId: 'm', contextWindow: 8192 },
    cancellation: { signal: new AbortController().signal },
    executionMode: 'interactive',
  } as unknown as ToolRuntimeContext;
}

describe('phased executor: first terminal outcome wins', () => {
  test('a call cancelled mid-phase whose phase then fails ends cancelled, never cancelled+failed', async () => {
    const executor = new PhasedToolExecutor({ enableHooks: false, enablePermissions: false, enableEvents: false });
    const call: ToolCall = { id: 'c1', name: 'slow', arguments: {} };
    const tool = {
      name: 'slow',
      definition: { name: 'slow', description: '', parameters: {} },
      execute: async () => {
        executor.cancel('c1', 'user stop');
        throw new Error('tool blew up after cancel');
      },
    } as unknown as Tool;
    const result = await executor.execute(call, tool, ctx());
    const record = executor.getRecord('c1')!;
    expect(record.cancelled).toBe(true);
    expect(record.currentPhase).toBe('cancelled');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cancelled');
  });

  test('an ordinary failure stays failed and not cancelled', async () => {
    const executor = new PhasedToolExecutor({ enableHooks: false, enablePermissions: false, enableEvents: false });
    const call: ToolCall = { id: 'c2', name: 'bad', arguments: {} };
    const tool = {
      name: 'bad',
      definition: { name: 'bad', description: '', parameters: {} },
      execute: async () => { throw new Error('plain failure'); },
    } as unknown as Tool;
    await executor.execute(call, tool, ctx());
    const record = executor.getRecord('c2')!;
    expect(record.cancelled).toBe(false);
    expect(record.currentPhase).toBe('failed');
  });
});
