import { describe, expect, test } from 'bun:test';
import * as pairingModule from '../platform/src/platform/runtime/remote/distributed-runtime-pairing.js';
import { DistributedRuntimeManager } from '../platform/src/platform/runtime/remote/distributed-runtime-manager.js';
import { makeControllableStore } from './_helpers/controllable-store.js';

async function withManager(run: (m: DistributedRuntimeManager) => Promise<void>): Promise<void> {
  const { store, cleanup } = makeControllableStore<Record<string, unknown>>('pair-reject', 'distributed.json');
  try {
    const manager = new DistributedRuntimeManager(store as never);
    await manager.start();
    await run(manager);
  } finally {
    cleanup();
  }
}

describe('rejecting a pair request', () => {
  test('a verified request is not overwritten with rejected', async () => {
    await withManager(async (manager) => {
      const { request, challenge } = await manager.requestPairing({ peerKind: 'node', label: 'n1' });
      await manager.approvePairRequest(request.id, {});
      const verified = await manager.verifyPairRequest(request.id, challenge, {});
      expect(verified).not.toBeNull();
      const result = await manager.rejectPairRequest(request.id, {});
      expect(result?.status).toBe('verified');
      expect(manager.listPairRequests().find((r) => r.id === request.id)?.status).toBe('verified');
    });
  });

  test('a rejected request stays rejected and pending/approved can still be rejected', async () => {
    await withManager(async (manager) => {
      const a = await manager.requestPairing({ peerKind: 'node', label: 'a' });
      expect((await manager.rejectPairRequest(a.request.id, {}))?.status).toBe('rejected');
      const b = await manager.requestPairing({ peerKind: 'node', label: 'b' });
      await manager.approvePairRequest(b.request.id, {});
      expect((await manager.rejectPairRequest(b.request.id, {}))?.status).toBe('rejected');
    });
  });

  test('an expired request is not overwritten with rejected', async () => {
    await withManager(async (manager) => {
      const { request } = await manager.requestPairing({ peerKind: 'node', label: 'e', ttlMs: 30_000 });
      const realNow = Date.now;
      Date.now = () => realNow() + 10 * 60_000;
      try {
        expect((await manager.rejectPairRequest(request.id, {}))?.status).toBe('expired');
      } finally {
        Date.now = realNow;
      }
    });
  });

  test('declares the table', () => {
    const lifecycle = (pairingModule as unknown as { pairRequestLifecycle?: { isTerminal(s: string): boolean } }).pairRequestLifecycle;
    expect(lifecycle?.isTerminal('verified')).toBe(true);
  });
});
