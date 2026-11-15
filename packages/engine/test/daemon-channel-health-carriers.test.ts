import { expect, test } from 'bun:test';
import { buildDaemonChannelHealthWatcher } from '../platform/src/platform/daemon/facade-channel-health.js';
import type { ChannelStatusSnapshot } from '../platform/src/platform/channels/types.js';
import type { ResolvedDaemonFacadeRuntime } from '../platform/src/platform/daemon/facade-types.js';

const status = (surface: string, state: ChannelStatusSnapshot['state'], enabled = true) => ({ id: `surface:${surface}`, surface, label: surface, state, enabled, configured: true,
  runtime: { observable: state === 'healthy' || state === 'dead', running: state === 'healthy', reason: '' }, metadata: {} }) as unknown as ChannelStatusSnapshot;

async function alertWith(statuses: ChannelStatusSnapshot[], failing: string[] = []) {
  const delivered: string[] = [];
  const runtime = { channelPlugins: { listStatus: async () => statuses },
    deliveryManager: { getDeliveryRouter: () => ({ deliver: async (input: { target: { surfaceKind: string } }) => {
      if (failing.includes(input.target.surfaceKind)) throw new Error('send failed');
      delivered.push(input.target.surfaceKind);
    } }) } } as unknown as ResolvedDaemonFacadeRuntime;
  await buildDaemonChannelHealthWatcher(runtime).sweep();
  return delivered;
}

test('a dead channel is reported over a configured surface whose state cannot be observed', async () => {
  expect(await alertWith([status('telegram', 'dead'), status('signal', 'unknown')])).toEqual(['signal']);
});

test('a confirmed-working carrier is used first and the unobserved one is only a fallback', async () => {
  expect(await alertWith([status('telegram', 'dead'), status('signal', 'unknown'), status('slack', 'healthy')])).toEqual(['slack']);
  expect(await alertWith([status('telegram', 'dead'), status('signal', 'unknown'), status('slack', 'healthy')], ['slack'])).toEqual(['signal']);
});

test('a disabled, failing or unconfigured surface never carries an alert', async () => {
  expect(await alertWith([status('telegram', 'dead'), status('signal', 'unknown', false), status('matrix', 'unconfigured'), status('slack', 'dead')])).toEqual([]);
});
