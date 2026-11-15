/**
 * A delivery the queue reported as `retrying` is accounted for until it is
 * delivered or dead-lettered, and what the queue reports per channel is that
 * channel's own share.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, HttpStatusError, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DeliveryQueue, type DeadLetterEntry } from '../platform/src/platform/integrations/delivery.ts';
import { Notifier } from '../platform/src/platform/integrations/notifier.ts';
import type { SlackIntegration } from '../platform/src/platform/integrations/slack.ts';
import type { DiscordIntegration } from '../platform/src/platform/integrations/discord.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
  // No reading port: a failure whose wording would need one cannot be decided.
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
  forgetFailureReadings();
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5_000) throw new Error(`${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('DeliveryQueue accounting', () => {
  test('a retry whose failure cannot be classified is dead-lettered, not dropped', async () => {
    const queue = new DeliveryQueue({ initialDelayMs: 1, maxDelayMs: 2, maxRetries: 3 });
    const dead: DeadLetterEntry[] = [];
    queue.onDeadLetter((entry) => { dead.push(entry); });
    let calls = 0;
    const outcome = await queue.enqueue('slack', 'event', 'payload', async () => {
      calls += 1;
      if (calls === 1) throw new HttpStatusError('HTTP 503: upstream unavailable', { status: 503 });
      throw new Error('something nobody has seen before');
    });
    expect(outcome).toBe('retrying');
    await waitFor(() => dead.length === 1, 'the dead-letter record');
    expect(calls).toBe(2);
    expect(queue.getDlq()).toHaveLength(1);
    expect(queue.getMetrics()).toMatchObject({ retrying: 0, deadLettered: 1, dlqSize: 1 });
  });

  test('metrics and dead letters are reported per channel, and clearing resets the count', async () => {
    const queue = new DeliveryQueue({ maxRetries: 0 });
    await queue.enqueue('slack', 'event', 'a', async () => { throw new HttpStatusError('HTTP 404: gone', { status: 404 }); });
    await queue.enqueue('discord', 'event', 'b', async () => undefined);
    expect(queue.getMetrics('slack')).toMatchObject({ delivered: 0, deadLettered: 1, dlqSize: 1 });
    expect(queue.getMetrics('discord')).toMatchObject({ delivered: 1, deadLettered: 0, dlqSize: 0 });
    expect(queue.clearDlq()).toBe(1);
    expect(queue.getMetrics()).toMatchObject({ deadLettered: 0, dlqSize: 0 });
    expect(queue.getMetrics('slack').deadLettered).toBe(0);
  });
});

describe('Notifier', () => {
  test('a Slack failure does not cost the Discord copy, and the caller still hears about it', async () => {
    const discordSent: string[] = [];
    const slack = { postWebhook: async () => { throw new Error('something nobody has seen before'); } } as unknown as SlackIntegration;
    const discord = { postWebhook: async (text: string) => { discordSent.push(text); } } as unknown as DiscordIntegration;
    const notifier = new Notifier({ slack, discord, delivery: { maxRetries: 0 } });
    try {
      await expect(notifier.notify('AGENT_COMPLETED', { summary: 'done' })).rejects.toBeDefined();
      expect(discordSent).toHaveLength(1);
      const channels = notifier.getQueueStatus();
      expect(channels.find((entry) => entry.channel === 'discord')?.metrics.delivered).toBe(1);
      expect(channels.find((entry) => entry.channel === 'slack')?.metrics.delivered).toBe(0);
    } finally {
      await notifier.close();
    }
  });
});
