/**
 * The channel profile registry keeps memory and disk in
 * agreement, and the inbound intake binds a channel's permission mode even
 * when the first attempt to bind failed.
 */

import { describe, expect, test } from 'bun:test';
import { ChannelProfileRegistry } from '../platform/src/platform/channel-profiles/registry.ts';
import type { ChannelProfileStore } from '../platform/src/platform/channel-profiles/store.ts';
import type { ChannelProfileBinding } from '../platform/src/platform/channel-profiles/types.ts';
import { installInboundIntakeEnrichment, type InboundIntakeBroker } from '../platform/src/platform/channel-profiles/install-inbound-intake.ts';
import type { PrincipalRegistry } from '../platform/src/platform/principals/index.ts';

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

class FakeProfileStore {
  saved: ChannelProfileBinding[][] = [];
  loads = 0;
  failNextSave = false;
  constructor(private readonly loadGate?: Promise<void>) {}
  async load(): Promise<ChannelProfileBinding[]> {
    this.loads += 1;
    await this.loadGate;
    return [];
  }
  async save(bindings: readonly ChannelProfileBinding[]): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('disk full');
    }
    this.saved.push([...bindings]);
  }
}

const profileRegistry = (store: FakeProfileStore) => new ChannelProfileRegistry(store as unknown as ChannelProfileStore);

describe('channel profile registry', () => {
  test('two first calls during a slow load both keep their binding', async () => {
    const loadGate = gate();
    const store = new FakeProfileStore(loadGate.promise);
    const registry = profileRegistry(store);
    const first = registry.set({ surfaceKind: 'slack', channelId: 'a', model: 'm1' });
    const second = registry.set({ surfaceKind: 'slack', channelId: 'b', model: 'm2' });
    loadGate.open();
    await Promise.all([first, second]);
    expect(store.loads).toBe(1);
    expect((await registry.list()).map((binding) => binding.id).sort()).toEqual(['slack:a', 'slack:b']);
    expect(store.saved.at(-1)?.map((binding) => binding.id).sort()).toEqual(['slack:a', 'slack:b']);
  });

  test('a save that fails leaves the live bindings unchanged', async () => {
    const store = new FakeProfileStore();
    const registry = profileRegistry(store);
    await registry.set({ surfaceKind: 'slack', channelId: 'a', model: 'm1' });
    store.failNextSave = true;
    await expect(registry.set({ surfaceKind: 'slack', channelId: 'b', model: 'm2' })).rejects.toThrow('disk full');
    expect((await registry.list()).map((binding) => binding.id)).toEqual(['slack:a']);
    store.failNextSave = true;
    await expect(registry.delete('slack', 'a')).rejects.toThrow('disk full');
    expect((await registry.list()).map((binding) => binding.id)).toEqual(['slack:a']);
    expect(await registry.resolve('slack', 'b')).toBeNull();
  });

  test('a failed first load is retried by the next call', async () => {
    let attempts = 0;
    const store = {
      async load(): Promise<ChannelProfileBinding[]> {
        attempts += 1;
        if (attempts === 1) throw new Error('unreadable');
        return [];
      },
      async save(): Promise<void> {},
    };
    const registry = profileRegistry(store as unknown as FakeProfileStore);
    await expect(registry.list()).rejects.toThrow('unreadable');
    expect(await registry.list()).toEqual([]);
  });
});

describe('inbound intake permission mode', () => {
  function brokerWith(options: { readonly failFirstBind: boolean }) {
    const sessions = new Map<string, { status: string; channelPermissionMode?: string | undefined }>();
    let binds = 0;
    let submitted = 0;
    const broker: InboundIntakeBroker = {
      async submitMessage() {
        submitted += 1;
        const created = !sessions.has('s1');
        if (created) sessions.set('s1', { status: 'active' });
        return { session: { id: 's1' }, created } as never;
      },
      getSession: (id) => (sessions.get(id) ?? null) as never,
      async bindChannelExecutionMode(id, mode) {
        binds += 1;
        if (options.failFirstBind && binds === 1) throw new Error('persist failed');
        sessions.get(id)!.channelPermissionMode = mode;
      },
    };
    return { broker, sessions, binds: () => binds, submitted: () => submitted };
  }

  const deps = {
    principals: { resolveByIdentity: async () => null } as unknown as PrincipalRegistry,
    channelProfiles: { resolve: async () => ({ permissionMode: 'safe-jev' as const }) },
  };

  test('a bind that failed on the first message is made on the next one', async () => {
    const harness = brokerWith({ failFirstBind: true });
    installInboundIntakeEnrichment(harness.broker, deps);
    await expect(harness.broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'first' })).rejects.toThrow('persist failed');
    expect(harness.sessions.get('s1')?.channelPermissionMode).toBeUndefined();
    await harness.broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'again' });
    expect(harness.sessions.get('s1')?.channelPermissionMode).toBe('safe-jev');
  });

  test('a session that is already bound is not bound again', async () => {
    const harness = brokerWith({ failFirstBind: false });
    installInboundIntakeEnrichment(harness.broker, deps);
    await harness.broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'first' });
    await harness.broker.submitMessage({ surfaceKind: 'slack', surfaceId: 'T1', body: 'second' });
    expect(harness.submitted()).toBe(2);
    expect(harness.binds()).toBe(1);
  });
});
