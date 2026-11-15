/**
 * The Slack and Discord notifier the agent attaches to its runtime bus names the
 * agent's or workstream's task, and follows behavior.notificationsMetadataOnly
 * (default off), read at send time so a settings change applies without a
 * restart (owner rulings 2026-09-29).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SlackIntegration } from '@goodvibes-jev/engine/platform/platform/integrations';
import { createEventEnvelope, RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeNotifier } from '../../runtime/bootstrap-notifier.ts';

const ctx = { sessionId: 's1', traceId: 't', source: 'test' };

describe('the agent Slack/Discord notifier', () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => { spy?.mockRestore(); spy = null; });

  test('keeps the task and reason out under both metadata-only settings', async () => {
    const sent: string[] = [];
    let onSend: (() => void) | null = null;
    const nextSend = (): Promise<void> => new Promise<void>((resolve) => { onSend = resolve; });
    spy = spyOn(SlackIntegration.prototype, 'postWebhook').mockImplementation(async (text: string) => { sent.push(text); onSend?.(); });
    const settings: Record<string, unknown> = {};
    const registry = { resolveSecret: async (service: string, key: string) => (service === 'slack' && key === 'webhookUrl' ? 'https://hooks.slack.example/x' : null) };
    const notifier = await createRuntimeNotifier(registry as never, (key) => settings[key]);
    const bus = new RuntimeEventBus();
    notifier.attachToRuntimeBus(bus);
    try {
      const first = nextSend();
      bus.emit('contracts', createEventEnvelope('CONTRACT_CREATED', { type: 'CONTRACT_CREATED', contractId: 'c1', sessionId: 's1', origin: 'turn', ask: 'private task one', ownerAgentId: 'o1' }, ctx));
      bus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', { type: 'CONTRACT_FAILED', contractId: 'c1', reason: 'review score 4/10', failureKind: 'other', membersSettled: true }, ctx));
      await first;
      settings['behavior.notificationsMetadataOnly'] = true;
      const second = nextSend();
      bus.emit('contracts', createEventEnvelope('CONTRACT_CREATED', { type: 'CONTRACT_CREATED', contractId: 'c2', sessionId: 's1', origin: 'turn', ask: 'private task two', ownerAgentId: 'o1' }, ctx));
      bus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', { type: 'CONTRACT_FAILED', contractId: 'c2', reason: 'private reason', failureKind: 'other', membersSettled: true }, ctx));
      await second;
    } finally {
      notifier.detach();
      await notifier.close();
    }
    expect(sent).toHaveLength(2);
    for (const text of sent) {
      expect(text).not.toContain('private task');
      expect(text).not.toContain('review score');
      expect(text).not.toContain('private reason');
    }
  });
  test('the configured Slack bot token reaches the notifier when it has a default channel to post in', async () => {
    const saved = { slack: process.env.SLACK_BOT_TOKEN, hook: process.env.SLACK_WEBHOOK_URL };
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const registry = { resolveSecret: async () => null };
      const tokenOnly = { get: (key: string) => (key === 'surfaces.slack.botToken' ? 'xoxb-t' : undefined) } as never;
      const config = { get: (key: string) => (key === 'surfaces.slack.botToken' ? 'xoxb-t' : key === 'surfaces.slack.defaultChannel' ? 'C0FIXTURE' : undefined) } as never;
      const without = await createRuntimeNotifier(registry as never, () => false);
      expect(without.getQueueStatus()).toHaveLength(0);
      // A token alone connects chat, not notifications: no channel, and a gap that says what to add.
      const gap = await createRuntimeNotifier(registry as never, () => false, tokenOnly);
      expect(gap.getQueueStatus()).toHaveLength(0);
      expect(gap.channelGaps().map((entry) => entry.channel)).toEqual(['slack']);
      const notifier = await createRuntimeNotifier(registry as never, () => false, config);
      expect(notifier.getQueueStatus().map((queue) => queue.channel)).toEqual(['slack']);
      await without.close();
      await gap.close();
      await notifier.close();
    } finally {
      if (saved.slack !== undefined) process.env.SLACK_BOT_TOKEN = saved.slack;
      if (saved.hook !== undefined) process.env.SLACK_WEBHOOK_URL = saved.hook;
    }
  });
});
