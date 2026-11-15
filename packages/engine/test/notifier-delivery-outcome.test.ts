/**
 * What the notification fan-out tells its caller, and which settings it obeys.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, HttpStatusError, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { Notifier } from '../platform/src/platform/integrations/notifier.ts';
import type { SlackIntegration } from '../platform/src/platform/integrations/slack.ts';
import type { DiscordIntegration } from '../platform/src/platform/integrations/discord.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
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

describe('Notifier outcome', () => {
  test('a channel that refuses the message for good is reported to the caller, and the other channel is still tried', async () => {
    const discordSent: string[] = [];
    const slack = {
      postWebhook: async () => { throw new HttpStatusError('HTTP 404: webhook revoked', { status: 404 }); },
    } as unknown as SlackIntegration;
    const discord = { postWebhook: async (text: string) => { discordSent.push(text); } } as unknown as DiscordIntegration;
    const notifier = new Notifier({ slack, discord });
    try {
      await expect(notifier.notify('AGENT_COMPLETED', { summary: 'done' })).rejects.toThrow('failed-notification list');
      expect(discordSent).toHaveLength(1);
      expect(notifier.getQueueStatus().find((queue) => queue.channel === 'slack')?.metrics.deadLettered).toBe(1);
    } finally {
      await notifier.close();
    }
  });

  test('a delivery that succeeds resolves', async () => {
    const slack = { postWebhook: async () => undefined } as unknown as SlackIntegration;
    const notifier = new Notifier({ slack });
    try {
      await expect(notifier.notify('AGENT_COMPLETED', { summary: 'done' })).resolves.toBeUndefined();
    } finally {
      await notifier.close();
    }
  });
});

describe('Notifier configuration', () => {
  test('integrations.delivery.maxRetries from config sets how many resends happen before the dead letter', async () => {
    let calls = 0;
    const slack = {
      postWebhook: async () => { calls += 1; throw new HttpStatusError('HTTP 503: unavailable', { status: 503 }); },
    } as unknown as SlackIntegration;
    const settings: Record<string, unknown> = {
      'integrations.delivery.maxRetries': 1,
      'integrations.delivery.initialDelayMs': 1,
      'integrations.delivery.maxDelayMs': 2,
      'integrations.delivery.maxDlqSize': 10,
      'integrations.delivery.sloEnforced': true,
    };
    const notifier = new Notifier({ slack, configManager: { get: (key: string) => settings[key] } as never });
    try {
      await notifier.notify('AGENT_COMPLETED', { summary: 'done' });
      await waitFor(() => notifier.getQueueStatus()[0]!.metrics.deadLettered === 1, 'the dead letter');
      expect(calls).toBe(2);
    } finally {
      await notifier.close();
    }
  });

  test('a bot token stored in config gives a Slack channel only with a default channel; alone it is reported as a gap', async () => {
    const saved = { slack: process.env.SLACK_BOT_TOKEN, hook: process.env.SLACK_WEBHOOK_URL };
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const registry = { resolveSecret: async () => null };
      const without = await Notifier.fromConfig(registry);
      expect(without.getQueueStatus()).toHaveLength(0);
      const tokenOnly = await Notifier.fromConfig(registry, {
        configManager: { get: (key: string) => (key === 'surfaces.slack.botToken' ? 'xoxb-t' : undefined) } as never,
      });
      expect(tokenOnly.getQueueStatus()).toHaveLength(0);
      expect(tokenOnly.channelGaps().map((gap) => gap.channel)).toEqual(['slack']);
      const settings: Record<string, string> = { 'surfaces.slack.botToken': 'xoxb-t', 'surfaces.slack.defaultChannel': '#ops' };
      const notifier = await Notifier.fromConfig(registry, { configManager: { get: (key: string) => settings[key] } as never });
      expect(notifier.getQueueStatus().map((queue) => queue.channel)).toEqual(['slack']);
      expect(notifier.channelGaps()).toHaveLength(0);
    } finally {
      if (saved.slack !== undefined) process.env.SLACK_BOT_TOKEN = saved.slack;
      if (saved.hook !== undefined) process.env.SLACK_WEBHOOK_URL = saved.hook;
    }
  });

  test('fromConfig resolves a stored goodvibes://secrets bot token through the secrets manager and drops it without one', async () => {
    const saved = { slack: process.env.SLACK_BOT_TOKEN, hook: process.env.SLACK_WEBHOOK_URL };
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const registry = { resolveSecret: async () => null };
      const settings: Record<string, string> = {
        'surfaces.slack.botToken': 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN',
        'surfaces.slack.defaultChannel': '#ops',
      };
      const configManager = { get: (key: string) => settings[key] } as never;
      const requested: string[] = [];
      const secretsManager = {
        get: async (key: string) => { requested.push(key); return key === 'SLACK_BOT_TOKEN' ? 'xoxb-stored' : null; },
        getGlobalHome: () => '/nonexistent-home',
      };
      const without = await Notifier.fromConfig(registry, { configManager });
      expect(without.getQueueStatus()).toHaveLength(0);
      const notifier = await Notifier.fromConfig(registry, { configManager, secretsManager });
      expect(requested).toContain('SLACK_BOT_TOKEN');
      expect(notifier.getQueueStatus().map((queue) => queue.channel)).toEqual(['slack']);
    } finally {
      if (saved.slack !== undefined) process.env.SLACK_BOT_TOKEN = saved.slack;
      if (saved.hook !== undefined) process.env.SLACK_WEBHOOK_URL = saved.hook;
    }
  });
});
