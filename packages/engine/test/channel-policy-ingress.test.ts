import { describe, expect, test } from 'bun:test';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.js';
import type { PersistentStore } from '../platform/src/platform/state/persistent-store.js';

function memoryStore(failWrites = false) {
  let saved: unknown = null;
  const store = {
    load: async () => saved,
    persist: async (snapshot: unknown) => {
      if (failWrites) throw new Error('disk full');
      saved = snapshot;
    },
  };
  return { store: store as unknown as PersistentStore<never>, saved: () => saved };
}

async function manager(patch: Record<string, unknown>, failWrites = false) {
  const { store } = memoryStore(failWrites);
  const m = new ChannelPolicyManager({ store });
  await m.start();
  if (!failWrites) await m.upsertPolicy('slack', { allowlistUserIds: ['owner'], ...patch });
  return m;
}

const group = { surface: 'slack', conversationKind: 'group', groupId: 'g', userId: 'owner' } as const;

describe('channel ingress commands', () => {
  test('free text is not a command, so requireMention still holds for ordinary chat', async () => {
    const m = await manager({ requireMention: true, allowTextCommandsWithoutMention: true, allowedCommands: [] });
    const chat = await m.evaluateIngress({ ...group, text: 'random chat', mentioned: false });
    expect(chat.allowed).toBe(false);
    expect(chat.reason).toBe('mention-required');
    const command = await m.evaluateIngress({ ...group, text: '/status', mentioned: false });
    expect(command.allowed).toBe(true);
  });

  test('allowedCommands gates commands only, never ordinary messages', async () => {
    const m = await manager({ allowedCommands: ['/status'] });
    expect((await m.evaluateIngress({ ...group, text: 'hello there' })).allowed).toBe(true);
    expect((await m.evaluateIngress({ ...group, text: '/deploy now' })).reason).toBe('command-not-allowed');
    expect((await m.evaluateIngress({ ...group, text: '/status@goodvibes_bot' })).allowed).toBe(true);
  });
});

describe('owner seeding', () => {
  test('a failed write leaves the scope unseeded so the next sender is not silently adopted', async () => {
    const m = await manager({}, true);
    await expect(m.evaluateIngress({ surface: 'slack', conversationKind: 'direct', userId: 'first', text: 'hi' })).rejects.toThrow('disk full');
    expect(m.getPolicy('slack').allowlistUserIds).toEqual([]);
  });
});
