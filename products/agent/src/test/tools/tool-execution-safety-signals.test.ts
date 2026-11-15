import { describe, expect, test } from 'bun:test';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { wrapToolExecutionSafety } from '../../tools/tool-execution-safety.ts';

function throwing(error: unknown): Tool {
  return {
    definition: { name: 'thrower', description: 'throws', parameters: { type: 'object', properties: {} } },
    execute: async () => { throw error; },
  };
}

describe('tool execution safety leaves cancellation and holds to the tool runtime', () => {
  test('a cancelled call is rethrown so the host reports it as cancelled', async () => {
    const tool = throwing(new ToolInputProjectionError('cancelled'));
    wrapToolExecutionSafety(tool);
    await expect(tool.execute({})).rejects.toThrow('Tool input projection cancelled.');
  });

  test('a held or stale call is rethrown so the tool runtime words it once', async () => {
    for (const problem of ['held', 'stale'] as const) {
      const tool = throwing(new ToolInputProjectionError(problem));
      wrapToolExecutionSafety(tool);
      await expect(tool.execute({})).rejects.toBeInstanceOf(ToolInputProjectionError);
    }
  });

  test('a call whose signal was aborted is rethrown, not reported as an ordinary failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = throwing(new Error('stopped midway'));
    wrapToolExecutionSafety(tool);
    await expect(tool.execute({}, { signal: controller.signal })).rejects.toThrow('stopped midway');
  });

  test('an ordinary throw is still a failed result carrying its message', async () => {
    const tool = throwing(new Error('disk full'));
    wrapToolExecutionSafety(tool);
    expect(await tool.execute({})).toEqual({ success: false, error: 'disk full' });
  });
});
