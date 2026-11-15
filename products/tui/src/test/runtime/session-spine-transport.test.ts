import { describe, expect, test } from 'bun:test';
import type { SharedSessionRecord } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { createTuiSpineTransport } from '../../runtime/session-spine-transport.ts';

const INPUT = { sessionId: 'a', project: '/p', participant: { surfaceKind: 'tui', surfaceId: 's', displayName: 'T' } } as Parameters<ReturnType<typeof createTuiSpineTransport>['register']>[0];
const RECORD = { id: 'a' } as unknown as SharedSessionRecord;

describe('TUI spine transport', () => {
  test('a register the daemon answers with a closed conflict is a rejection, not ok', async () => {
    const transport = createTuiSpineTransport({
      register: async () => ({ record: RECORD, reopened: false, conflict: { status: 'closed' } }),
      close: async () => null,
    });
    const result = await transport.register(INPUT);
    expect(result.outcome).toBe('rejected');
    expect(result.conflict).toBe('closed');
  });

  test('a plain register is ok and a throw is offline', async () => {
    const ok = createTuiSpineTransport({ register: async () => ({ record: RECORD, reopened: false }), close: async () => null });
    expect((await ok.register(INPUT)).outcome).toBe('ok');
    const down = createTuiSpineTransport({ register: async () => { throw new Error('down'); }, close: async () => null });
    expect((await down.register(INPUT)).outcome).toBe('offline');
  });
});
