import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurabilityServices, type DurabilityServicesInput } from '../platform/src/platform/runtime/durability-services.ts';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'durability-refresh-'));
  const listeners = new Set<(key: string) => void>();
  const gates: Array<() => void> = [];
  const events: string[] = [];
  let calls = 0;
  const input = {
    configManager: { getControlPlaneConfigDir: () => root, get: () => undefined, watchConfigFiles: () => () => undefined },
    secretsManager: { onDidChange: (listener: (key: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    providerRegistry: {
      refreshProviderCredentials: () => new Promise<void>((resolve) => {
        const n = ++calls;
        events.push(`start ${n}`);
        gates.push(() => { events.push(`end ${n}`); resolve(); });
      }),
    },
    memoryDbPath: join(root, 'memory.sqlite'),
    codeIndexDbPath: join(root, 'code.sqlite'),
    surface: { workingDirectory: root, surfaceRoot: undefined, homeDirectory: root },
    shellPaths: { resolveUserPath: (...segments: string[]) => join(root, ...segments) },
  } as unknown as DurabilityServicesInput;
  return { root, listeners, gates, events, input, calls: () => calls };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('a secrets change during the boot refresh waits for it instead of running alongside it', async () => {
  const h = harness();
  const services = createDurabilityServices(h.input);
  try {
    await tick();
    for (const listener of h.listeners) listener('KEY');
    await tick();
    expect(h.events).toEqual(['start 1']);
    h.gates.shift()!();
    await tick();
    expect(h.events).toEqual(['start 1', 'end 1', 'start 2']);
  } finally {
    h.gates.splice(0).forEach((open) => open());
    services.stopConfigWatch(); services.stopDurabilityHousekeeping();
    services.storeSnapshotScheduler.stop(); services.appendOnlyRetentionScheduler.stop();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('stopping the watches releases the secrets listener and skips refreshes still queued', async () => {
  const h = harness();
  const services = createDurabilityServices(h.input);
  try {
    await tick();
    for (const listener of h.listeners) listener('KEY');
    services.stopConfigWatch();
    expect(h.listeners.size).toBe(0);
    h.gates.shift()!();
    await tick();
    expect(h.calls()).toBe(1);
  } finally {
    services.stopDurabilityHousekeeping();
    services.storeSnapshotScheduler.stop(); services.appendOnlyRetentionScheduler.stop();
    rmSync(h.root, { recursive: true, force: true });
  }
});
