import { describe, expect, test } from 'bun:test';
import { SlackIntegration } from '../platform/src/platform/integrations/slack.js';
import { ChannelProviderRuntimeManager } from '../platform/src/platform/channels/provider-runtime.js';

type Deps = ConstructorParameters<typeof ChannelProviderRuntimeManager>[0];

function manager(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const alarm: string[] = [];
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  const instance = new ChannelProviderRuntimeManager({
    configManager: { get: (key: string) => config[key] ?? '' },
    serviceRegistry: { resolveSecret: async () => null, get: () => undefined },
    buildSurfaceAdapterContext: () => ({
      authorizeSurfaceIngress: async () => ({ allowed: false, reason: 'user-not-allowlisted' }),
    }),
    ingressAlarm: {
      recordSuccess: (surface: string) => { alarm.push(`ok:${surface}`); },
      recordFailure: (surface: string) => { alarm.push(`fail:${surface}`); },
    },
    postSlackResponse: async (url: string, body: Record<string, unknown>) => { posted.push({ url, body }); },
    ...overrides,
  } as unknown as Deps);
  return { instance, alarm, posted };
}

const slackFake = new SlackIntegration();
const handle = (instance: ChannelProviderRuntimeManager, payload: Record<string, unknown>, slack = slackFake) =>
  (instance as unknown as { handleSlackEnvelope(e: unknown, s: unknown): Promise<void> }).handleSlackEnvelope({ envelope_id: 'e', payload }, slack);

describe('ntfy start outcome', () => {
  test('start reports failure when no topic could subscribe', async () => {
    const { instance } = manager(
      { serviceRegistry: { resolveSecret: async () => { throw new Error('vault locked'); }, get: () => undefined } },
      { 'surfaces.ntfy.chatTopic': 'chat-topic' },
    );
    const result = await instance.start('ntfy');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('chat-topic');
    expect(result.message).toContain('vault locked');
  });
});

describe('ntfy token reference', () => {
  test('a secret reference in config is resolved, not sent as the bearer token', async () => {
    const { instance } = manager(
      { secretsManager: { get: async (key: string) => key === 'NTFY_TOKEN' ? 'resolved-secret' : null, getGlobalHome: () => undefined } },
      { 'surfaces.ntfy.token': 'goodvibes://secrets/goodvibes/NTFY_TOKEN' },
    );
    const resolve = (instance as unknown as { resolveNtfyToken(): Promise<string | null> }).resolveNtfyToken.bind(instance);
    expect(await resolve()).toBe('resolved-secret');
  });
});

describe('Discord configured state', () => {
  test('a token held by the service registry counts as configured', () => {
    const { instance } = manager({ serviceRegistry: { resolveSecret: async () => null, get: (name: string) => name === 'discord' ? { tokenKey: 'DISCORD_BOT_TOKEN' } : undefined } });
    expect(instance.status('discord').configured).toBe(true);
  });
});

describe('Slack Socket Mode answers', () => {
  const blockedSlash = { type: 'slash_command', command: '/goodvibes', text: 'cancel x', user_id: 'U1', channel_id: 'C1', response_url: 'https://hooks.slack.com/commands/T/1/abc' };

  test('a policy refusal is answered privately through response_url and is not an ingress failure', async () => {
    const { instance, alarm, posted } = manager();
    await handle(instance, blockedSlash);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.response_type).toBe('ephemeral');
    expect(String(posted[0]!.body.text).length).toBeGreaterThan(0);
    expect(alarm).toEqual(['ok:slack']);
  });

  test('a response_url that is not Slack is never posted to', async () => {
    const { instance, posted } = manager();
    await handle(instance, { ...blockedSlash, response_url: 'https://evil.example/x' });
    expect(posted).toEqual([]);
  });
});

describe('Slack mention that could not be started', () => {
  test('is an ingress failure and the channel is told', async () => {
    const sent: Array<{ channel: string; text: string }> = [];
    const slack = new SlackIntegration();
    slack.postMessage = async (channel: string, text: string) => { sent.push({ channel, text }); };
    const { instance, alarm } = manager({
      buildSurfaceAdapterContext: () => ({
        authorizeSurfaceIngress: async () => ({ allowed: true, reason: 'allowed' }),
        routeBindings: { upsertBinding: async () => ({ id: 'b1', surfaceId: 'T1', externalId: 'C1', channelId: 'C1' }) },
        sessionBroker: { submitMessage: async () => ({ mode: 'new', session: { id: 's1' }, task: 'do it', input: { id: 'i1' } }) },
        trySpawnAgent: async () => Response.json({ error: 'at capacity' }, { status: 503 }),
      }),
    });
    await handle(instance, {
      type: 'event_callback', team_id: 'T1',
      event: { type: 'app_mention', text: 'do it', user: 'U1', channel: 'C1', ts: '1700000000.000100' },
    }, slack);
    expect(alarm).toEqual(['fail:slack']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe('C1');
  });
});

describe('requests refused for capacity or failure', () => {
  const mention = { type: 'event_callback', team_id: 'T1', event: { type: 'app_mention', text: 'do it', user: 'U1', channel: 'C1', ts: '1700000000.000100' } };
  const refusing = (status: number, body: Record<string, unknown>) => ({
    buildSurfaceAdapterContext: () => ({
      configManager: { get: () => '' },
      authorizeSurfaceIngress: async () => ({ allowed: true, reason: 'allowed' }),
      routeBindings: { upsertBinding: async () => ({ id: 'b1', surfaceId: 'T1', externalId: 'C1', channelId: 'C1' }) },
      sessionBroker: { submitMessage: async () => ({ mode: 'new', session: { id: 's1' }, task: 'do it', input: { id: 'i1' } }) },
      trySpawnAgent: async () => Response.json(body, { status }),
    }),
  });

  test('a Slack mention refused with 429 is an ingress failure and the channel is told', async () => {
    const sent: string[] = [];
    const slack = new SlackIntegration();
    slack.postMessage = async (_channel: string, text: string) => { sent.push(text); };
    const { instance, alarm } = manager(refusing(429, { error: 'at capacity' }));
    await handle(instance, mention, slack);
    expect(alarm).toEqual(['fail:slack']);
    expect(sent).toHaveLength(1);
  });

  test('a refused interactive answer with no text is answered through response_url with a generic notice', async () => {
    const { instance, posted } = manager();
    const answer = (instance as unknown as { answerSlackEnvelope(p: unknown, r: Response, s: unknown): Promise<void> }).answerSlackEnvelope.bind(instance);
    await answer({ type: 'block_actions', response_url: 'https://hooks.slack.com/actions/T/1/abc' }, Response.json({ error: 'at capacity' }, { status: 503 }), slackFake);
    expect(posted).toHaveLength(1);
    expect(String(posted[0]!.body.text)).toContain('could not start');
    await answer({ type: 'block_actions', response_url: 'https://hooks.slack.com/actions/T/1/abc' }, Response.json({ error: 'not allowed' }, { status: 403 }), slackFake);
    expect(posted).toHaveLength(1);
  });

  test.each([[503, 'fail:discord'], [429, 'fail:discord'], [403, 'ok:discord']])('a Discord message answered with HTTP %i records %s', async (status, expected) => {
    const { instance, alarm } = manager(refusing(status, { error: 'refused' }), { 'surfaces.discord.applicationId': 'app' });
    const dispatch = { t: 'MESSAGE_CREATE', d: { id: 'm1', channel_id: 'C1', guild_id: 'G1', content: 'hello', author: { id: 'U1', username: 'u' } } };
    await (instance as unknown as { handleDiscordDispatch(d: unknown, i: unknown): Promise<void> }).handleDiscordDispatch(dispatch, {});
    expect(alarm).toEqual([expected]);
  });
});
