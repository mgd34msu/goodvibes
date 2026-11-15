/**
 * `mentioned` means THIS bot was mentioned, not that the message mentions
 * someone. Slack's plain `message` events and Discord's gateway messages used
 * to set it for a mention of any user, so a channel policy that only answers
 * when the bot is addressed answered a message addressed to a colleague.
 */
import { describe, expect, test } from 'bun:test';
import { handleSlackSurfacePayload } from '../platform/src/platform/adapters/slack/index.js';
import { handleDiscordGatewayDispatchPayload } from '../platform/src/platform/adapters/discord/index.js';
import { handleIMessageSurfaceWebhook, handleBlueBubblesSurfaceWebhook, handleHomeAssistantSurfaceWebhook, handleNtfySurfacePayload } from '../platform/src/platform/adapters/index.js';
import { handleMatrixSurfaceWebhook, handleSignalSurfaceWebhook, handleMattermostSurfaceWebhook } from '../platform/src/platform/adapters/index.js';
import type { SurfaceAdapterContext } from '../platform/src/platform/adapters/index.js';

/** A context that records the ingress input and stops there (the policy refuses). */
function capturingContext(config: Record<string, unknown> = {}) {
  const ingress: Array<{ readonly mentioned?: boolean }> = [];
  const context = {
    configManager: { get: (key: string) => config[key] },
    authorizeSurfaceIngress: async (input: { readonly mentioned?: boolean }) => {
      ingress.push(input);
      return { allowed: false, reason: 'test stops here' };
    },
    parseSurfaceControlCommand: () => null,
  } as unknown as SurfaceAdapterContext;
  return { context, ingress };
}

function slackMessage(text: string) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    authorizations: [{ team_id: 'T1', user_id: 'UBOT', is_bot: true }],
    event: { type: 'message', text, user: 'UALICE', channel: 'C1', ts: '1.0' },
  };
}

describe('slack: a message mentions the bot only when it names the bot user', () => {
  test('a mention of another user is not a mention of the bot', async () => {
    const { context, ingress } = capturingContext();
    await handleSlackSurfacePayload(slackMessage('<@UBOB> can you look at this?'), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });

  test("a mention of the bot's user id is", async () => {
    const { context, ingress } = capturingContext();
    await handleSlackSurfacePayload(slackMessage('<@UBOT|goodvibes> can you look at this?'), context);
    expect(ingress[0]?.mentioned).toBe(true);
  });

  test('an app_mention event is always a mention', async () => {
    const { context, ingress } = capturingContext();
    const body = slackMessage('hello');
    await handleSlackSurfacePayload({ ...body, event: { ...body.event, type: 'app_mention' } }, context);
    expect(ingress[0]?.mentioned).toBe(true);
  });
});

function discordMessage(mentions: readonly { readonly id: string }[]) {
  return {
    t: 'MESSAGE_CREATE',
    d: { id: 'm1', channel_id: 'c1', guild_id: 'g1', content: 'can you look at this?', author: { id: 'alice' }, mentions },
  };
}

describe('discord: a message mentions the bot only when a mention carries its application id', () => {
  const config = { 'surfaces.discord.applicationId': '111' };

  test('a mention of another user is not a mention of the bot', async () => {
    const { context, ingress } = capturingContext(config);
    await handleDiscordGatewayDispatchPayload(discordMessage([{ id: '222' }]), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });

  test("a mention of the bot's id is", async () => {
    const { context, ingress } = capturingContext(config);
    await handleDiscordGatewayDispatchPayload(discordMessage([{ id: '222' }, { id: '111' }]), context);
    expect(ingress[0]?.mentioned).toBe(true);
  });

  test('with no application id configured, no mention can be matched to the bot', async () => {
    const { context, ingress } = capturingContext();
    await handleDiscordGatewayDispatchPayload(discordMessage([{ id: '111' }]), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });
});

/**
 * Matrix, Signal and Mattermost take the bridge's own `mentioned` flag first.
 * Matrix also reads `m.mentions` against the configured bot user id, so a room
 * message addressed to someone else does not satisfy `requireMention`.
 */
function bridgeContext(config: Record<string, unknown>) {
  const { context, ingress } = capturingContext(config);
  const withRegistry = { ...(context as unknown as Record<string, unknown>), serviceRegistry: { resolveSecret: async () => null } } as unknown as SurfaceAdapterContext;
  return { context: withRegistry, ingress };
}

function post(path: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(`http://localhost/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('matrix: a room event mentions the bot only when it names the bot user', () => {
  const config = { 'surfaces.matrix.webhookSecret': 'secret', 'surfaces.matrix.userId': '@bot:example.org' };
  const headers = { 'x-goodvibes-matrix-token': 'secret' };
  const event = (content: Record<string, unknown>) => ({ event: { room_id: '!r:example.org', sender: '@alice:example.org', event_id: '$e', content: { msgtype: 'm.text', body: 'hi', ...content } } });

  test('m.mentions that name another user is not a mention of the bot', async () => {
    const { context, ingress } = bridgeContext(config);
    await handleMatrixSurfaceWebhook(post('matrix', headers, event({ 'm.mentions': { user_ids: ['@bob:example.org'] } })), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });

  test('m.mentions that names the bot is a mention', async () => {
    const { context, ingress } = bridgeContext(config);
    await handleMatrixSurfaceWebhook(post('matrix', headers, event({ 'm.mentions': { user_ids: ['@bot:example.org'] } })), context);
    expect(ingress[0]?.mentioned).toBe(true);
  });

  test('an event with no m.mentions is a mention only when its text names the bot user', async () => {
    const { context, ingress } = bridgeContext(config);
    await handleMatrixSurfaceWebhook(post('matrix', headers, event({ body: 'hello everyone' })), context);
    await handleMatrixSurfaceWebhook(post('matrix', { ...headers }, { event: { room_id: '!r:example.org', sender: '@alice:example.org', event_id: '$e2', content: { msgtype: 'm.text', body: '@bot:example.org look' } } }), context);
    expect(ingress.map(entry => entry.mentioned)).toEqual([false, true]);
  });

  test('with no bot user id configured, no event is a mention of the bot', async () => {
    const { context, ingress } = bridgeContext({ 'surfaces.matrix.webhookSecret': 'secret' });
    await handleMatrixSurfaceWebhook(post('matrix', headers, event({ 'm.mentions': { user_ids: ['@bob:example.org'] } })), context);
    await handleMatrixSurfaceWebhook(post('matrix', headers, { event: { room_id: '!r:example.org', sender: '@alice:example.org', event_id: '$e3', content: { msgtype: 'm.text', body: 'hi' } } }), context);
    expect(ingress.map(entry => entry.mentioned)).toEqual([false, false]);
  });

  test("the bridge's own flag wins over m.mentions", async () => {
    const { context, ingress } = bridgeContext(config);
    const body = event({ 'm.mentions': { user_ids: ['@bot:example.org'] } });
    await handleMatrixSurfaceWebhook(post('matrix', headers, { ...body, mentioned: false }), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });
});

describe('signal and mattermost: the bridge declares whether the bot was addressed', () => {
  test('a Signal message the bridge marks as not addressed is not a mention', async () => {
    const { context, ingress } = bridgeContext({ 'surfaces.signal.token': 'secret' });
    await handleSignalSurfaceWebhook(post('signal', { 'x-goodvibes-signal-token': 'secret' }, { recipient: '+15551234567', message: 'hi', mentioned: false }), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });

  test('a Mattermost post the bridge marks as not addressed is not a mention', async () => {
    const { context, ingress } = bridgeContext({ 'surfaces.mattermost.webhookSecret': 'secret' });
    await handleMattermostSurfaceWebhook(post('mattermost', { 'x-goodvibes-mattermost-token': 'secret' }, { channel_id: 'c1', user_id: 'u1', text: 'hi', mentioned: false }), context);
    expect(ingress[0]?.mentioned).toBe(false);
  });

  test('a Mattermost post that declares a mention is one', async () => {
    const { context, ingress } = bridgeContext({ 'surfaces.mattermost.webhookSecret': 'secret' });
    await handleMattermostSurfaceWebhook(post('mattermost', { 'x-goodvibes-mattermost-token': 'secret' }, { channel_id: 'c1', user_id: 'u1', text: 'hi', mentioned: true }), context);
    expect(ingress[0]?.mentioned).toBe(true);
  });

  test('a real Signal message that does not name the bot is not a mention, and one that does is', async () => {
    const { context, ingress } = bridgeContext({ 'surfaces.signal.token': 'secret', 'surfaces.signal.account': '+15550001111' });
    const headers = { 'x-goodvibes-signal-token': 'secret' };
    await handleSignalSurfaceWebhook(post('signal', headers, { recipient: '+15551234567', groupId: 'g1', message: 'lunch?', messageId: '1' }), context);
    await handleSignalSurfaceWebhook(post('signal', headers, { recipient: '+15551234567', groupId: 'g1', message: 'hey', messageId: '2', mentions: [{ number: '+15559998888' }] }), context);
    await handleSignalSurfaceWebhook(post('signal', headers, { recipient: '+15551234567', groupId: 'g1', message: 'hey', messageId: '3', mentions: [{ number: '+15550001111' }] }), context);
    expect(ingress.map(entry => entry.mentioned)).toEqual([false, false, true]);
  });

  test('a Signal 1:1 message and a Mattermost direct message are addressed to the bot', async () => {
    const signal = bridgeContext({ 'surfaces.signal.token': 'secret', 'surfaces.signal.account': '+15550001111' });
    await handleSignalSurfaceWebhook(post('signal', { 'x-goodvibes-signal-token': 'secret' }, { recipient: '+15551234567', message: 'hi', messageId: 'd1' }), signal.context);
    expect(signal.ingress[0]?.mentioned).toBe(true);
    const mattermost = bridgeContext({ 'surfaces.mattermost.webhookSecret': 'secret' });
    await handleMattermostSurfaceWebhook(post('mattermost', { 'x-goodvibes-mattermost-token': 'secret' }, { channel_id: 'c1', user_id: 'u1', text: 'hi', channel_type: 'D', post_id: 'd2' }), mattermost.context);
    expect(mattermost.ingress[0]?.mentioned).toBe(true);
  });

  test('a Mattermost post without the trigger word is not a mention, and one with it is', async () => {
    const { context, ingress } = bridgeContext({ 'surfaces.mattermost.webhookSecret': 'secret' });
    const headers = { 'x-goodvibes-mattermost-token': 'secret' };
    await handleMattermostSurfaceWebhook(post('mattermost', headers, { channel_id: 'c1', user_id: 'u1', text: 'hi', post_id: 'p1' }), context);
    await handleMattermostSurfaceWebhook(post('mattermost', headers, { channel_id: 'c1', user_id: 'u1', text: 'bot hi', trigger_word: 'bot', post_id: 'p2' }), context);
    expect(ingress.map(entry => entry.mentioned)).toEqual([false, true]);
  });

  test('iMessage and BlueBubbles 1:1 messages, Home Assistant and ntfy are addressed to the bot; groups and threads are not', async () => {
    const im = bridgeContext({ 'surfaces.imessage.token': 'secret' });
    const imHeaders = { 'x-goodvibes-imessage-token': 'secret' };
    await handleIMessageSurfaceWebhook(post('imessage', imHeaders, { chatId: 'c1', message: 'hi', guid: 'i1' }), im.context);
    await handleIMessageSurfaceWebhook(post('imessage', imHeaders, { chatId: 'c1', threadId: 't1', message: 'hi', guid: 'i2' }), im.context);
    await handleIMessageSurfaceWebhook(post('imessage', imHeaders, { chatId: 'c1', threadId: 't1', message: 'hi', guid: 'i3', mentioned: true }), im.context);
    expect(im.ingress.map(entry => entry.mentioned)).toEqual([true, false, true]);

    const bb = bridgeContext({ 'surfaces.bluebubbles.password': 'secret' });
    const bbHeaders = { 'x-goodvibes-bluebubbles-token': 'secret' };
    await handleBlueBubblesSurfaceWebhook(post('bluebubbles', bbHeaders, { chatGuid: 'iMessage;-;+15551234567', senderId: 'a', text: 'hi', guid: 'b1' }), bb.context);
    await handleBlueBubblesSurfaceWebhook(post('bluebubbles', bbHeaders, { chatGuid: 'iMessage;+;chat1', senderId: 'a', text: 'hi', guid: 'b2' }), bb.context);
    expect(bb.ingress.map(entry => entry.mentioned)).toEqual([true, false]);

    const ha = bridgeContext({ 'surfaces.homeassistant.enabled': true, 'surfaces.homeassistant.webhookSecret': 'secret' });
    await handleHomeAssistantSurfaceWebhook(post('homeassistant', { 'x-goodvibes-homeassistant-token': 'secret', authorization: 'Bearer secret', 'content-type': 'application/json' }, { message: 'hi', messageId: 'h1' }), ha.context);
    expect(ha.ingress[0]?.mentioned).toBe(true);

    const ntfy = bridgeContext({ 'surfaces.ntfy.chatTopic': 'alerts' });
    await handleNtfySurfacePayload({ topic: 'alerts', message: 'hi', id: 'n1' }, ntfy.context);
    expect(ntfy.ingress[0]?.mentioned).toBe(true);
  });
});
