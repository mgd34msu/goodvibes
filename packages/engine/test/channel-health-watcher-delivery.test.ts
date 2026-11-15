/**
 * An alert that no channel could carry is offered again soon, and a delivery
 * that never answers cannot stop every later sweep.
 */
import { describe, expect, test } from 'bun:test';
import { ChannelHealthWatcher, type ChannelHealthAlert } from '../platform/src/platform/channels/health-watcher.js';
import type { ChannelStatusSnapshot } from '../platform/src/platform/channels/types.js';
import { buildDaemonChannelHealthWatcher } from '../platform/src/platform/daemon/facade-channel-health.js';
import type { ResolvedDaemonFacadeRuntime } from '../platform/src/platform/daemon/facade-types.js';
import type { ChannelDeliveryRequest } from '../platform/src/platform/channels/index.js';

function snapshot(surface: string, state: ChannelStatusSnapshot['state']): ChannelStatusSnapshot {
  return {
    id: `surface:${surface}`,
    surface: surface as ChannelStatusSnapshot['surface'],
    label: surface,
    state,
    enabled: true,
    configured: true,
    runtime: { observable: true, running: state === 'healthy', reason: `${surface} reason` },
    metadata: {},
  };
}

describe('undelivered channel alerts', () => {
  test('a failed alert nobody could carry is offered again after the retry spacing, not after the repeat interval', async () => {
    let now = 1_000_000;
    const offered: string[] = [];
    let carrierUp = false;
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => [snapshot('telegram', 'dead')],
      announce: (alert) => { offered.push(alert.kind); return carrierUp; },
      now: () => now,
      retryMs: 300_000,
    });
    await watcher.sweep();
    now += 60_000;
    await watcher.sweep();
    expect(offered).toEqual(['failed']);
    carrierUp = true;
    now += 300_000;
    await watcher.sweep();
    expect(offered).toEqual(['failed', 'failed']);
    now += 300_000;
    await watcher.sweep();
    expect(offered).toEqual(['failed', 'failed']);
  });

  test('an announcement that never settles is abandoned so the next sweep runs', async () => {
    const deadlines: Array<() => void> = [];
    const signals: Array<AbortSignal | undefined> = [];
    let hang = true;
    const alerts: ChannelHealthAlert[] = [];
    let states = [snapshot('telegram', 'dead')];
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert, signal) => {
        signals.push(signal);
        if (hang) return new Promise<boolean>(() => {});
        alerts.push(alert);
        return true;
      },
      schedule: (fire) => { deadlines.push(fire); return () => {}; },
    });
    const first = watcher.sweep();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await Promise.race([first.then(() => 'done'), Promise.resolve('pending')])).toBe('pending');
    expect(await watcher.sweep()).toEqual([]);
    deadlines.at(-1)!();
    await first;
    expect(signals[0]?.aborted).toBe(true);
    hang = false;
    states = [snapshot('telegram', 'healthy')];
    await watcher.sweep();
    expect(alerts).toEqual([]);
    states = [snapshot('telegram', 'dead')];
    await watcher.sweep();
    expect(alerts.map((entry) => entry.kind)).toEqual(['failed']);
  });
});

describe('stopping the watcher', () => {
  test('with two dead surfaces and a hanging announcer, the second alert is never announced after stop()', async () => {
    let calls = 0;
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => [snapshot('telegram', 'dead'), snapshot('slack', 'dead')],
      announce: () => { calls += 1; return new Promise<boolean>(() => {}); },
    });
    const sweep = watcher.sweep();
    while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
    watcher.stop();
    await sweep;
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
  });
});

describe('the daemon announcer', () => {
  function runtimeWith(
    statuses: readonly ChannelStatusSnapshot[],
    deliver: (request: ChannelDeliveryRequest) => Promise<string | undefined>,
  ): ResolvedDaemonFacadeRuntime {
    return {
      deliveryManager: { getDeliveryRouter: () => ({ deliver }) },
      channelPlugins: { listStatus: async () => statuses },
    } as unknown as ResolvedDaemonFacadeRuntime;
  }

  test('it stops after the first carrier that takes the notice and hands the delivery the watcher signal', async () => {
    const delivered: ChannelDeliveryRequest[] = [];
    const watcher = buildDaemonChannelHealthWatcher(runtimeWith(
      [snapshot('telegram', 'dead'), snapshot('slack', 'healthy'), snapshot('discord', 'healthy')],
      async (request) => { delivered.push(request); return undefined; },
    ));
    await watcher.sweep();
    expect(delivered.map((request) => request.target.surfaceKind)).toEqual(['slack']);
    expect(delivered[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test('stopping the watcher aborts the delivery in flight and ends the sweep without waiting for the deadline', async () => {
    let seen: AbortSignal | undefined;
    const watcher = buildDaemonChannelHealthWatcher(runtimeWith(
      [snapshot('telegram', 'dead'), snapshot('slack', 'healthy'), snapshot('discord', 'healthy')],
      (request) => { seen = request.signal; return new Promise<string | undefined>(() => {}); },
    ));
    const sweep = watcher.sweep();
    while (seen === undefined) await new Promise((resolve) => setImmediate(resolve));
    watcher.stop();
    await sweep;
    expect(seen.aborted).toBe(true);
  });
});
