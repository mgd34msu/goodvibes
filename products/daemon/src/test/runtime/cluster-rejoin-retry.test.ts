import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { FakeClusterClock } from '@goodvibes-jev/engine/platform/platform/cluster';
import type { ShellPathService } from '../../runtime/index.js';
import { createClusterGroupComposition } from '../../runtime/cluster-group-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

async function turns() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function fixture(retryDelays: readonly number[]) {
  const root = makeOwnedTempDir('daemon-cluster-rejoin');
  const values = new Map<string, string>();
  const clock = new FakeClusterClock();
  let rejoins = 0;
  const composition = createClusterGroupComposition({
    configManager: { get: () => undefined, set() {}, getCategory: () => ({ enabled: true }) } as unknown as ConfigManager,
    shellPaths: { resolveProjectPath: (...parts: string[]) => join(root, ...parts) } as unknown as ShellPathService,
    secretsManager: { async get(key) { return values.get(key) ?? null; }, async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } },
    clock, rejoinRetryDelaysMs: retryDelays,
    transport: {
      async start() {}, async stop() {},
      async send(raw) { if (JSON.parse(raw).type === 'REJOIN') rejoins++; },
      describe: () => ({ mode: 'in-memory', group: 'fixture', port: 0, peers: [] }),
    },
  });
  return { composition, clock, get rejoins() { return rejoins; } };
}

/** Moves the fake clock in small steps so every timer the group layer arms gets to fire. */
async function run(clock: FakeClusterClock, totalMs: number) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 1_000) { clock.advance(1_000); await turns(); }
}

test('a member that came up before its group asks to rejoin again, a bounded number of times', async () => {
  const f = fixture([5_000, 10_000]);
  // Dummy cryptographic material lives only in this in-memory store and owned state root.
  expect((await f.composition.verbs.create({ name: 'fixture', passphrase: 'dummy fixture passphrase' })).ok).toBe(true);
  const starting = f.composition.start();
  await run(f.clock, 120_000);
  await starting;
  expect(f.rejoins).toBe(3);
  await run(f.clock, 120_000);
  expect(f.rejoins).toBe(3);
  await f.composition.stop();
});

test('stopping cancels a pending repeat announcement', async () => {
  const f = fixture([5_000]);
  expect((await f.composition.verbs.create({ name: 'fixture', passphrase: 'dummy fixture passphrase' })).ok).toBe(true);
  const starting = f.composition.start();
  await run(f.clock, 60_000);
  await starting;
  const before = f.rejoins;
  await f.composition.stop();
  await run(f.clock, 60_000);
  expect(f.rejoins).toBe(before);
  expect(f.clock.pendingTimers).toBe(0);
});

test('a prompt that the group key moved on asks again at once, at most once a minute, and stops with the daemon', async () => {
  const f = fixture([]);
  expect((await f.composition.verbs.create({ name: 'fixture', passphrase: 'dummy fixture passphrase' })).ok).toBe(true);
  const starting = f.composition.start();
  await run(f.clock, 120_000);
  await starting;
  const afterStart = f.rejoins;
  f.composition.rejoin();
  f.composition.rejoin();
  await run(f.clock, 5_000);
  expect(f.rejoins).toBe(afterStart + 1);
  // The first is finished, so only the minute's gap holds this one back.
  await run(f.clock, 25_000);
  f.composition.rejoin();
  await run(f.clock, 5_000);
  expect(f.rejoins).toBe(afterStart + 1);
  await run(f.clock, 40_000);
  f.composition.rejoin();
  await run(f.clock, 5_000);
  expect(f.rejoins).toBe(afterStart + 2);
  await f.composition.stop();
  await run(f.clock, 70_000);
  f.composition.rejoin();
  await run(f.clock, 120_000);
  expect(f.rejoins).toBe(afterStart + 2);
  expect(f.clock.pendingTimers).toBe(0);
});
