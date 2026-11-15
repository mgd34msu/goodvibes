import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { WorkspaceSwapManager } from '../platform/src/platform/workspace/workspace-swap-manager.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function make(rerootStores: (dir: string) => Promise<void>, runtimeBus: RuntimeEventBus | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'gv-fence-'));
  const home = mkdtempSync(join(tmpdir(), 'gv-fence-home-'));
  dirs.push(root, home);
  return { root, manager: new WorkspaceSwapManager(root, { runtimeBus, daemonHomeDir: home, getBusySessionCount: () => 0, rerootStores }) };
}

test('a throwing fence is reported as a daemon-side failure, not an invalid path', async () => {
  const bus = new RuntimeEventBus();
  const events: unknown[] = [];
  const unsubscribe = bus.onDomain('workspace', (envelope) => { events.push(envelope.payload); });
  const { manager, root } = make(async () => {}, bus);
  manager.subscribeBeforeSwap(() => { throw new Error('boom'); });
  const result = await manager.requestSwap(join(root, 'next'));
  await Promise.resolve();
  unsubscribe();
  expect(result).toMatchObject({ ok: false, code: 'REROOT_FAILED' });
  // The event and the returned result name the same cause.
  expect(events).toEqual([expect.objectContaining({ type: 'WORKSPACE_SWAP_FAILED', code: 'REROOT_FAILED' })]);
  expect(manager.getCurrentWorkingDir()).toBe(root);
});

test('isSwapping is true while stores move and false afterwards', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { manager, root } = make(() => gate);
  expect(manager.isSwapping()).toBe(false);
  const pending = manager.requestSwap(join(root, 'next'));
  expect(manager.isSwapping()).toBe(true);
  release();
  await pending;
  expect(manager.isSwapping()).toBe(false);
});
