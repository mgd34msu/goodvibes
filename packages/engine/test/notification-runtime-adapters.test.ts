/**
 * Every notification transport hears the same runtime events and says the same
 * thing about them: one dispatcher owns the event list and the wording.
 */
import { expect, spyOn, test } from 'bun:test';
import { Notifier } from '../platform/src/platform/integrations/notifier.ts';
import { WebhookNotifier } from '../platform/src/platform/integrations/webhooks.ts';
import { SlackIntegration } from '../platform/src/platform/integrations/slack.ts';
import { DiscordIntegration } from '../platform/src/platform/integrations/discord.ts';
import { RuntimeEventBus, createEventEnvelope } from '../platform/src/platform/runtime/events/index.ts';
import { waitFor } from './_helpers/test-timeout.ts';

const SLACK_URL = 'https://example.com/runtime-slack';
const DISCORD_URL = 'https://example.com/runtime-discord';
// A public literal keeps DNS pinning deterministic; fetch itself is intercepted.
const WEBHOOK_URL = 'https://93.184.216.34/runtime-webhook';
const REASON = 'synthetic failure reason';

for (const metadataOnly of [false, true]) {
  test(`an agent failure reaches Slack, Discord and a generic webhook with one wording (metadataOnly=${metadataOnly})`, async () => {
    const sent: Array<{ url: string; text: string }> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const body = String(init?.body);
      const text = url === SLACK_URL ? (JSON.parse(body) as { text: string }).text
        : url === DISCORD_URL ? (JSON.parse(body) as { content: string }).content : body;
      sent.push({ url, text });
      return new Response('ok');
    }, { preconnect() {} }));
    const privacy = () => metadataOnly;
    const chat = new Notifier({ slack: new SlackIntegration(SLACK_URL), discord: new DiscordIntegration(DISCORD_URL), metadataOnly: privacy });
    const webhook = new WebhookNotifier([WEBHOOK_URL], { force: true, metadataOnly: privacy });
    const bus = new RuntimeEventBus();
    try {
      chat.attachToRuntimeBus(bus);
      webhook.attachToRuntimeBus(bus);
      const context = { sessionId: 'fixture-session', source: 'notification-adapter-test' };
      bus.emit('agents', createEventEnvelope('AGENT_SPAWNING', { type: 'AGENT_SPAWNING', agentId: 'a1', task: 'Fix the login redirect' }, context));
      bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'a1', error: REASON, durationMs: 12_000 }, context));
      await waitFor(() => sent.length === 3);
      expect(sent.map((entry) => entry.url).sort()).toEqual([DISCORD_URL, SLACK_URL, WEBHOOK_URL].sort());
      expect(new Set(sent.map((entry) => entry.text)).size).toBe(1);
      const text = sent[0]!.text;
      expect(text).toContain('Failed after 12s');
      if (metadataOnly) {
        expect(text).not.toContain(REASON);
        expect(text).not.toContain('Fix the login redirect');
      } else {
        expect(text).toContain(REASON);
        expect(text).toContain('Fix the login redirect');
      }
      expect(text).not.toContain('a1');
    } finally {
      await chat.close();
      await webhook.close();
      fetchSpy.mockRestore();
    }
  });
}
