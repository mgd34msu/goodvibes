// Proves: A channel stops receiving or keeps skipping messages and nothing tells the owner.
// Red when: The health watcher stops announcing a failure, repeats it every sweep, or never announces recovery.
/**
 * A channel whose arriving messages are being skipped reaches the owner as
 * news: one announcement when it starts failing, a retry after the spacing
 * when nothing could carry it, nothing on the sweeps in between, and one
 * recovery notice once it works again, owed only when the owner was told.
 *
 * Real health watcher, real ingress alarm and the real health rule turning
 * the alarm's failure into the surface state. The clock, the schedule, the
 * registry listing and the announcer are stand-ins.
 */
import { expect, test } from 'bun:test';
import { ChannelHealthWatcher, type ChannelHealthAlert } from '../platform/src/platform/channels/health-watcher.ts';
import { ChannelIngressAlarm, describeIngressFailure } from '../platform/src/platform/channels/ingress-alarm.ts';
import { observedRuntime, resolveChannelHealthState } from '../platform/src/platform/channels/health.ts';
import type { ChannelStatusSnapshot, ChannelSurface } from '../platform/src/platform/channels/types.ts';

const MINUTE = 60_000;

test('a failing channel is announced once, offered again after the spacing when nobody carried it, and its recovery is announced once', async () => {
  let now = 1_000_000;
  const alarm = new ChannelIngressAlarm({ now: () => now });
  // The registry listing: each surface's state from the real rule, fed the alarm's failure as the runtime's last error.
  const snapshot = (surface: ChannelSurface, label: string): ChannelStatusSnapshot => {
    const runtime = observedRuntime(true, 'polling and receiving', describeIngressFailure(alarm.failure(surface)));
    return { id: surface, surface, label, enabled: true, configured: true, metadata: {},
      state: resolveChannelHealthState({ enabled: true, configured: true, runtime }), runtime };
  };
  const offered: string[] = [];
  const watcher = new ChannelHealthWatcher({
    listStatus: async () => [snapshot('telegram', 'Telegram'), snapshot('slack', 'Slack')],
    // Nothing can carry an alert about Slack.
    announce: (alert: ChannelHealthAlert) => { offered.push(`${alert.surface} ${alert.kind}: ${alert.reason}`); return alert.surface !== 'slack'; },
    repeatMs: 6 * 60 * MINUTE,
    retryMs: 5 * MINUTE,
    now: () => now,
    schedule: () => () => undefined,
  });
  const sweepAt = async (minutes: number) => {
    now = 1_000_000 + minutes * MINUTE;
    offered.length = 0;
    await watcher.sweep();
    return [...offered];
  };

  const working = await sweepAt(0);
  alarm.recordFailure('telegram', 'the agent runtime refused the message');
  alarm.recordFailure('slack', 'the session store could not be written');
  const failing = await sweepAt(1);
  const telegramReason = describeIngressFailure(alarm.failure('telegram'));
  const slackReason = describeIngressFailure(alarm.failure('slack'));
  const quiet = await sweepAt(2);
  const retried = await sweepAt(6);
  const quietAgain = await sweepAt(7);
  alarm.recordSuccess('telegram');
  alarm.recordSuccess('slack');
  const recovered = await sweepAt(8);
  const afterRecovery = await sweepAt(9);

  expect(telegramReason).toContain('skipped');
  expect({ working, failing, quiet, retried, quietAgain, recovered, afterRecovery }).toEqual({
    working: [],
    failing: [`telegram failed: ${telegramReason}`, `slack failed: ${slackReason}`],
    quiet: [],
    retried: [`slack failed: ${slackReason}`],
    quietAgain: [],
    recovered: ['telegram recovered: polling and receiving'],
    afterRecovery: [],
  });
});
