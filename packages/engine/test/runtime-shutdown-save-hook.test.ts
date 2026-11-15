import { describe, expect, test } from 'bun:test';
import { shutdownRuntime } from '../platform/src/platform/runtime/lifecycle.ts';

function run(saveFails: boolean): Promise<string[]> {
  const fired: string[] = [];
  return shutdownRuntime(
    'session-1',
    { messages: [{ role: 'user', content: 'hello' }] },
    'model',
    'provider',
    'Title',
    null,
    { fire: async (event: { specific: string }) => { fired.push(event.specific); return { ok: true }; } } as never,
    null,
    null,
    {
      sessionManager: {
        save: () => { if (saveFails) throw new Error('disk full'); },
      } as never,
    },
  ).then(() => fired, () => fired);
}

describe('shutdownRuntime lifecycle hooks', () => {
  test('a successful save fires the end and save hooks', async () => {
    expect(await run(false)).toEqual(['end', 'save']);
  });

  test('a failed save does not tell subscribers the session was saved', async () => {
    expect(await run(true)).toEqual(['end']);
  });
});
