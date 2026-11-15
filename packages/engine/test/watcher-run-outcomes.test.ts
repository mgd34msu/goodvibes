/**
 * What a watcher run reports: a source that answers with an error or stalls
 * is a failed run, published with whether a retry can clear it; a watcher
 * with nothing to run is refused at registration; and a watcher that was not
 * armed by its owner is not reported healthy.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatcherRegistry, type WatcherRegistryOptions } from '../platform/src/platform/watchers/registry.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import type { WatcherRecord } from '../platform/src/platform/runtime/store/domains/watchers.js';
import type { AutomationSourceRecord } from '../platform/src/platform/automation/sources.js';

const roots: string[] = [];
const registries: WatcherRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const source = {
  id: 'source-1', kind: 'watcher', label: 'Source 1', enabled: true, createdAt: 1, updatedAt: 1, metadata: {},
} as AutomationSourceRecord;
const flagsOn = { isEnabled: (id: string): boolean => id === 'watcher-framework' };

function make(options: Partial<WatcherRegistryOptions> = {}, storeRoot?: string): { registry: WatcherRegistry; events: string[]; failed: Array<{ retryable: boolean; error: string }>; root: string } {
  const root = storeRoot ?? mkdtempSync(join(tmpdir(), 'gv-watcher-outcome-'));
  if (!storeRoot) roots.push(root);
  const registry = new WatcherRegistry({ storePath: join(root, 'watchers.json'), featureFlags: flagsOn, ...options });
  registries.push(registry);
  const bus = new RuntimeEventBus();
  const events: string[] = [];
  const failed: Array<{ retryable: boolean; error: string }> = [];
  bus.on('WATCHER_FAILED', (e) => { events.push('failed'); failed.push(e.payload as { retryable: boolean; error: string }); });
  bus.on('WATCHER_STOPPED', () => { events.push('stopped'); });
  registry.attachRuntime({ runtimeBus: bus });
  return { registry, events, failed, root };
}

/** Lets a fire-and-forget run that has no asynchronous work of its own finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const answer = (status: number, body = 'body'): Promise<Response> => Promise.resolve(new Response(body, { status }));

function refusalCode(act: () => unknown): string | undefined {
  try { act(); } catch (error) { return (error as { readonly code?: string }).code; }
  return undefined;
}

describe('url and webhook runs', () => {
  test.each(['webhook', 'polling'] as const)('a %s watcher whose url answers 500 is failed and published as failed', async (kind) => {
    const { registry, failed } = make({ fetchUrl: () => answer(500) });
    registry.registerWatcher({ id: 'w1', label: 'W1', kind, source, metadata: { url: 'https://example.test/health' } });
    const record = await registry.runWatcherNow('w1');
    expect(record?.state).toBe('failed');
    expect(record?.lastError).toContain('HTTP 500');
    expect(failed).toHaveLength(1);
  });

  test('a 200 answer is healthy', async () => {
    const { registry } = make({ fetchUrl: () => answer(200, 'ok') });
    registry.registerWatcher({ id: 'w1', label: 'W1', kind: 'webhook', source, metadata: { url: 'https://example.test/health' } });
    registry.startWatcher('w1');
    const record = await registry.runWatcherNow('w1');
    expect(record?.state).toBe('running');
    expect(record?.lastCheckpoint).toBe('200:ok');
  });

  test('a stalled endpoint fails the run and frees the watcher for the next one', async () => {
    let stall = true;
    const { registry } = make({
      runTimeoutMs: 1,
      fetchUrl: (_url, init) => stall
        ? new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        })
        : answer(200),
    });
    registry.registerWatcher({ id: 'w1', label: 'W1', kind: 'webhook', source, metadata: { url: 'https://example.test/slow' } });
    const first = await registry.runWatcherNow('w1');
    expect(first?.state).toBe('failed');
    stall = false;
    const second = await registry.runWatcherNow('w1');
    // It was never started, so the good run records its result without claiming it is running.
    expect(second?.state).toBe('stopped');
    expect(second?.lastError).toBeUndefined();
    expect(second?.lastCheckpoint).toBe('200:body');
  });

  test('the default request refuses a loopback address without opening a connection', async () => {
    // A listener that records every connection: the old plain fetch reached it, the guarded request must not.
    let connections = 0;
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
      open(socket) { connections++; socket.end(); },
      data() {},
    } });
    try {
      const { registry } = make();
      registry.registerWatcher({ id: 'w1', label: 'W1', kind: 'webhook', source, metadata: { url: `http://127.0.0.1:${server.port}/` } });
      const record = await registry.runWatcherNow('w1');
      expect(record?.state).toBe('failed');
      expect(connections).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test('a header that is a secret reference is resolved for the request, and an unreadable one fails the run unsent', async () => {
    const sent: Array<Record<string, string> | undefined> = [];
    const { registry } = make({
      fetchUrl: (_url, init) => { sent.push(init.headers as Record<string, string> | undefined); return answer(200); },
      resolveHeaderValue: async (value) => (value === 'goodvibes://secrets/GOOD' ? 'Bearer resolved' : null),
    });
    registry.registerWatcher({ id: 'ok', label: 'Ok', kind: 'webhook', source, metadata: { url: 'https://example.test/', headers: { Authorization: 'goodvibes://secrets/GOOD' } } });
    registry.registerWatcher({ id: 'gone', label: 'Gone', kind: 'webhook', source, metadata: { url: 'https://example.test/', headers: { Authorization: 'goodvibes://secrets/MISSING' } } });
    expect((await registry.runWatcherNow('ok'))?.state).toBe('stopped');
    expect(sent).toEqual([{ Authorization: 'Bearer resolved' }]);
    const gone = await registry.runWatcherNow('gone');
    expect(gone?.state).toBe('failed');
    expect(gone?.lastError).toContain('could not be read');
    expect(sent).toHaveLength(1);
    // The stored record keeps the reference, never the secret.
    expect(JSON.stringify(registry.getWatcher('ok'))).not.toContain('Bearer resolved');
  });

  test('a watcher with nothing to run is refused at registration and nothing is stored', () => {
    const { registry } = make();
    for (const kind of ['webhook', 'polling', 'filesystem', 'socket', 'integration'] as const) {
      expect(refusalCode(() => registry.registerWatcher({ id: kind, label: kind, kind, source }))).toBe('WATCHER_NOTHING_TO_RUN');
      expect(registry.getWatcher(kind)).toBeNull();
    }
  });
});

describe('publishing a failure', () => {
  test('whether a retry can clear it comes from the answer status', async () => {
    let status = 401;
    const { registry, failed } = make({ fetchUrl: () => answer(status) });
    registry.registerWatcher({ id: 'w1', label: 'W1', kind: 'webhook', source, metadata: { url: 'https://example.test/feed' } });
    await registry.runWatcherNow('w1');
    status = 503;
    await registry.runWatcherNow('w1');
    expect(failed.map((f) => f.retryable)).toEqual([false, true]);
  });
});

describe('run-now on a stopped watcher', () => {
  test('runs once and leaves it stopped', async () => {
    let runs = 0;
    const { registry } = make();
    registry.registerWatcher({ id: 'w1', label: 'W1', source, intervalMs: 60_000, run: () => { runs++; return 'cp'; } });
    const record = await registry.runWatcherNow('w1');
    expect(runs).toBe(1);
    expect(record?.state).toBe('stopped');
    expect(record?.lastCheckpoint).toBe('cp');
  });

  test('a failed run-now followed by a good one still leaves it stopped, with nothing driving it', async () => {
    let fail = true;
    const { registry } = make();
    registry.registerWatcher({ id: 'w1', label: 'W1', source, intervalMs: 60_000, run: () => { if (fail) throw new Error('source down'); return 'cp'; } });
    expect((await registry.runWatcherNow('w1'))?.state).toBe('failed');
    fail = false;
    const record = await registry.runWatcherNow('w1');
    expect(record?.state).toBe('stopped');
    expect(record?.lastCheckpoint).toBe('cp');
    expect(record?.lastError).toBeUndefined();
  });
});

describe('arming', () => {
  test('a restored watcher whose work only its owner holds is not run until it is registered again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-watcher-restore-'));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const record: WatcherRecord = {
      id: 'poller-1', kind: 'polling', label: 'Poller 1', state: 'running', source, intervalMs: 600_000,
      lastHeartbeatAt: Date.now() - 1_000, lastCheckpoint: 'before-restart', metadata: { runMode: 'polling' },
    };
    writeFileSync(join(root, 'watchers.json'), `${JSON.stringify({ version: 1, watchers: [record] })}\n`, 'utf-8');
    const { registry } = make({}, root);
    registry.list();
    await Promise.resolve();
    expect(registry.getWatcher('poller-1')?.lastCheckpoint).toBe('before-restart');
    expect(registry.getWatcher('poller-1')?.lastHeartbeatAt).toBe(record.lastHeartbeatAt);

    let runs = 0;
    registry.registerPollingWatcher({ id: 'poller-1', label: 'Poller 1', source, intervalMs: 600_000, run: () => { runs++; return 'owner-run'; } });
    await settle();
    expect(runs).toBe(1);
    expect(registry.getWatcher('poller-1')?.lastCheckpoint).toBe('owner-run');
  });

  test('a restored watcher whose work only its owner holds cannot be started or run now, and nothing is recorded for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-watcher-restore-'));
    roots.push(root);
    const record: WatcherRecord = {
      id: 'poller-2', kind: 'polling', label: 'Poller 2', state: 'running', source, intervalMs: 600_000,
      lastHeartbeatAt: 1_000, lastCheckpoint: 'before-restart', metadata: { runMode: 'polling' },
    };
    writeFileSync(join(root, 'watchers.json'), `${JSON.stringify({ version: 1, watchers: [record] })}\n`, 'utf-8');
    const { registry } = make({}, root);
    await expect(registry.runWatcherNow('poller-2')).rejects.toMatchObject({ code: 'WATCHER_AWAITING_OWNER' });
    expect(refusalCode(() => registry.startWatcher('poller-2'))).toBe('WATCHER_AWAITING_OWNER');
    await settle();
    expect(registry.getWatcher('poller-2')?.lastCheckpoint).toBe('before-restart');
    expect(registry.getWatcher('poller-2')?.lastHeartbeatAt).toBe(1_000);
  });

  test('a restored integration watcher stays refused when it is updated without a run, and runs once its owner registers it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-watcher-restore-'));
    roots.push(root);
    const record: WatcherRecord = {
      id: 'i', kind: 'integration', label: 'I', state: 'running', source, intervalMs: 600_000,
      lastHeartbeatAt: 1_000, lastCheckpoint: 'before-restart', metadata: {},
    };
    writeFileSync(join(root, 'watchers.json'), `${JSON.stringify({ version: 1, watchers: [record] })}\n`, 'utf-8');
    const { registry } = make({}, root);
    registry.registerWatcher({ id: 'i', kind: 'integration', label: 'I renamed', source });
    await expect(registry.runWatcherNow('i')).rejects.toMatchObject({ code: 'WATCHER_AWAITING_OWNER' });
    expect(registry.getWatcher('i')?.lastCheckpoint).toBe('before-restart');
    let runs = 0;
    registry.registerWatcher({ id: 'i', kind: 'integration', label: 'I', source, run: () => { runs++; return 'owner'; } });
    await registry.runWatcherNow('i');
    expect(runs).toBeGreaterThan(0);
    expect(registry.getWatcher('i')?.lastCheckpoint).toBe('owner');
  });

  test('turning the watcher framework off and on again arms the running watchers again', async () => {
    let on = true;
    let runs = 0;
    const { registry } = make({ featureFlags: { isEnabled: (id: string): boolean => id === 'watcher-framework' && on } });
    registry.registerPollingWatcher({ id: 'p1', label: 'P1', source, intervalMs: 600_000, run: () => { runs++; return 'x'; } });
    registry.startWatcher('p1');
    await settle();
    expect(runs).toBe(1);
    on = false;
    expect(registry.list()).toEqual([]);
    on = true;
    expect(registry.list()).toHaveLength(1);
    await settle();
    // The re-arm takes the same catch-up run a restart does, with the owner's closure.
    expect(runs).toBe(2);
  });
});

describe('checkpoint advance', () => {
  test('is published only when the checkpoint moves, and a manual run has no checkpoint to move', async () => {
    let body = 'one';
    const { registry } = make({ fetchUrl: () => answer(200, body) });
    const bus = new RuntimeEventBus();
    const advanced: string[] = [];
    let heartbeats = 0;
    bus.on('WATCHER_CHECKPOINT_ADVANCED', (e) => { advanced.push((e.payload as { checkpoint: string }).checkpoint); });
    bus.on('WATCHER_HEARTBEAT', () => { heartbeats++; });
    registry.attachRuntime({ runtimeBus: bus });
    registry.registerWatcher({ id: 'w1', label: 'W1', kind: 'webhook', source, metadata: { url: 'https://example.test/s' } });
    registry.registerWatcher({ id: 'm1', label: 'M1', kind: 'manual', source });
    await registry.runWatcherNow('w1');
    await registry.runWatcherNow('w1');
    body = 'two';
    await registry.runWatcherNow('w1');
    expect(advanced).toEqual(['200:one', '200:two']);
    const manual = await registry.runWatcherNow('m1');
    await registry.runWatcherNow('m1');
    expect(manual?.lastCheckpoint).toBeUndefined();
    expect(advanced).toHaveLength(2);
    expect(heartbeats).toBe(5);
  });
});
