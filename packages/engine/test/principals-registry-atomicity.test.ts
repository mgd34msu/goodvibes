/**
 * principals-registry-atomicity.test.ts
 *
 * The registry must hold one live array however many callers arrive before the
 * first load finishes, and a failed save must leave memory as it was.
 */
import { describe, expect, test } from 'bun:test';
import { PrincipalRegistry } from '../platform/src/platform/principals/registry.ts';
import type { PrincipalStore } from '../platform/src/platform/principals/store.ts';
import { identityKey, type PrincipalRecord } from '../platform/src/platform/principals/types.ts';

class FakeStore {
  saved: PrincipalRecord[][] = [];
  loads = 0;
  failNextSave = false;
  private release: (() => void) | null = null;
  readonly loadGate: Promise<void>;

  constructor(gated: boolean) {
    this.loadGate = gated ? new Promise<void>((resolve) => { this.release = resolve; }) : Promise.resolve();
  }

  open(): void {
    this.release?.();
  }

  async load(): Promise<PrincipalRecord[]> {
    this.loads += 1;
    await this.loadGate;
    return [];
  }

  async save(principals: readonly PrincipalRecord[]): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('disk full');
    }
    this.saved.push([...principals]);
  }
}

function make(store: FakeStore): PrincipalRegistry {
  return new PrincipalRegistry(store as unknown as PrincipalStore);
}

describe('principal registry', () => {
  test('concurrent first calls share one load and none is lost', async () => {
    const store = new FakeStore(true);
    const registry = make(store);
    const a = registry.create({ name: 'A', kind: 'user', identities: [{ channel: 'sms', value: '1' }] });
    const b = registry.create({ name: 'B', kind: 'user', identities: [{ channel: 'sms', value: '2' }] });
    const resolved = registry.resolveByIdentity({ channel: 'sms', value: '2' });
    store.open();
    await Promise.all([a, b]);
    expect(store.loads).toBe(1);
    expect((await registry.list()).map((r) => r.name).sort()).toEqual(['A', 'B']);
    expect(store.saved.at(-1)!.map((r) => r.name).sort()).toEqual(['A', 'B']);
    await resolved;
  });

  test('concurrent claims of one identity: exactly one wins', async () => {
    const store = new FakeStore(true);
    const registry = make(store);
    const identities = [{ channel: 'sms', value: '1' }];
    const a = registry.create({ name: 'A', kind: 'user', identities });
    const b = registry.create({ name: 'B', kind: 'user', identities });
    store.open();
    const outcomes = await Promise.allSettled([a, b]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await registry.list()).toHaveLength(1);
  });

  test('a failed save leaves create and delete unapplied in memory', async () => {
    const store = new FakeStore(false);
    const registry = make(store);
    const keep = await registry.create({ name: 'Keep', kind: 'user', identities: [{ channel: 'sms', value: '1' }] });

    store.failNextSave = true;
    await expect(registry.create({ name: 'New', kind: 'user', identities: [{ channel: 'sms', value: '2' }] })).rejects.toThrow('disk full');
    expect((await registry.list()).map((r) => r.id)).toEqual([keep.id]);
    // The retry is not met by a conflict with a principal that was never created.
    await registry.create({ name: 'New', kind: 'user', identities: [{ channel: 'sms', value: '2' }] });

    store.failNextSave = true;
    await expect(registry.delete(keep.id)).rejects.toThrow('disk full');
    expect((await registry.resolveByIdentity({ channel: 'sms', value: '1' })).known).toBe(true);
    expect((await registry.list())).toHaveLength(2);
  });

  test('a failed load can be retried', async () => {
    let calls = 0;
    const store = {
      async load(): Promise<PrincipalRecord[]> {
        calls += 1;
        if (calls === 1) throw new Error('unreadable');
        return [];
      },
      async save(): Promise<void> {},
    };
    const registry = new PrincipalRegistry(store as unknown as PrincipalStore);
    await expect(registry.list()).rejects.toThrow('unreadable');
    expect(await registry.list()).toEqual([]);
  });
});

describe('identityKey', () => {
  test('a separator character inside the channel or value cannot make two identities collide', () => {
    expect(identityKey({ channel: 'a\0b', value: 'c' })).not.toBe(identityKey({ channel: 'a', value: 'b\0c' }));
  });
});
