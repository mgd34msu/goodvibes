// Proves: A channel webhook with no credential, a wrong one, a forged signature or a replayed old one starts work; or a sender the policy refuses starts work at an adapter that asks the policy itself.
// Red when: An adapter's own credential check or its own policy call is dropped or inverted.
// Proves: A Teams token issued for another bot, expired, signed by an unpublished key or unsigned is accepted.
// Red when: verifyBotFrameworkToken stops checking audience, issuer, expiry, key or algorithm.
/**
 * Every webhook adapter checks its caller before anything else runs. Each row
 * sends one adapter the same message three times: with the right credential
 * (it must reach the channel policy, which refuses the sender, so nothing
 * starts), with none and with a wrong one (401, and the daemon is asked
 * nothing). Signature surfaces are signed in the test with keys made here.
 *
 * The adapters and the Teams token verifier are real; the daemon context only
 * records what an adapter asked of it, and Microsoft's key server is the
 * injected fetch.
 */
import { afterEach, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync, sign, webcrypto, type KeyObject } from 'node:crypto';
import { ntfyInboundDedup, surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import { handleBlueBubblesSurfaceWebhook } from '../platform/src/platform/adapters/bluebubbles/index.ts';
import { handleDiscordSurfaceWebhook } from '../platform/src/platform/adapters/discord/index.ts';
import { handleGitHubAutomationWebhook } from '../platform/src/platform/adapters/github/index.ts';
import { handleGoogleChatSurfaceWebhook } from '../platform/src/platform/adapters/google-chat/index.ts';
import { handleHomeAssistantSurfaceWebhook } from '../platform/src/platform/adapters/homeassistant/index.ts';
import { handleIMessageSurfaceWebhook } from '../platform/src/platform/adapters/imessage/index.ts';
import { handleMatrixSurfaceWebhook } from '../platform/src/platform/adapters/matrix/index.ts';
import { handleMattermostSurfaceWebhook } from '../platform/src/platform/adapters/mattermost/index.ts';
import { handleMSTeamsSurfaceWebhook } from '../platform/src/platform/adapters/msteams/index.ts';
import { verifyBotFrameworkToken, BOT_FRAMEWORK_ISSUER, type BotFrameworkFetch } from '../platform/src/platform/adapters/msteams/bot-framework-auth.ts';
import { handleNtfySurfaceWebhook } from '../platform/src/platform/adapters/ntfy/index.ts';
import { handleSignalSurfaceWebhook } from '../platform/src/platform/adapters/signal/index.ts';
import { handleSlackSurfaceWebhook } from '../platform/src/platform/adapters/slack/index.ts';
import { handleTelegramSurfaceWebhook } from '../platform/src/platform/adapters/telegram/index.ts';
import { handleTelephonySurfaceWebhook } from '../platform/src/platform/adapters/telephony/index.ts';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.ts';
import { handleWhatsAppSurfaceWebhook } from '../platform/src/platform/adapters/whatsapp/index.ts';

type Call = { kind: string; input: unknown };
type Credential = 'right' | 'wrong' | 'none';

afterEach(() => { surfaceInboundDedup.clear(); ntfyInboundDedup.clear(); });

/** A daemon context that records what the adapter asked of it; the channel policy refuses every sender. */
function recordingContext(config: Record<string, unknown>, secrets: Record<string, string> = {}) {
  const calls: Call[] = [];
  const record = (kind: string) => (input: unknown) => { calls.push({ kind, input }); };
  const context = {
    serviceRegistry: { resolveSecret: async (service: string, field: string) => secrets[`${service}.${field}`] ?? null },
    configManager: { get: (key: string) => config[key] },
    routeBindings: {
      upsertBinding: async (input: { surfaceKind: string; externalId: string; metadata?: Record<string, unknown> }) => {
        record('upsertBinding')(input);
        return { ...input, id: 'binding-1', metadata: input.metadata ?? {} };
      },
    },
    sessionBroker: {
      getSession: () => null,
      findPreferredSession: async () => null,
      listSessions: () => [],
      submitMessage: async (input: unknown) => {
        record('submitMessage')(input);
        return { mode: 'spawn', task: { prompt: 'task' }, session: { id: 'session-1' }, input: { id: 'input-1' } };
      },
      bindAgent: async () => undefined,
    },
    authorizeSurfaceIngress: async (input: unknown) => {
      record('authorizeSurfaceIngress')(input);
      return { allowed: false, reason: 'user-not-allowlisted' };
    },
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => 'ok',
    performInteractiveSurfaceAction: async () => 'ok',
    trySpawnAgent: (input: unknown) => { record('trySpawnAgent')(input); return { id: 'agent-1' }; },
    queueSurfaceReplyFromBinding: () => undefined,
    surfaceDeliveryEnabled: () => true,
    signWebhookPayload: (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    queueWebhookReply: record('queueWebhookReply'),
    githubWebhookSecret: (config['github.secret'] as string | undefined) ?? null,
  };
  return { calls, context: context as never };
}

const hmacHex = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');
const json = (body: unknown) => JSON.stringify(body);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function post(url: string, body: string, headers: Record<string, string>): Request {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
}
/** A header carrying the right token, a wrong one, or nothing. */
const tokenHeader = (name: string, token: string, credential: Credential): Record<string, string> =>
  credential === 'none' ? {} : { [name]: credential === 'right' ? token : `${token}-wrong` };

// Discord signs with Ed25519; the daemon holds the public key in hex.
const discordKeys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
const discordForgerKeys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
const discordPublicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', discordKeys.publicKey)).toString('hex');
async function discordRequest(body: string, credential: Credential, timestamp = String(nowSeconds())): Promise<Request> {
  if (credential === 'none') return post('http://localhost/webhook/discord', body, { 'x-signature-timestamp': timestamp });
  const key = credential === 'right' ? discordKeys.privateKey : discordForgerKeys.privateKey;
  const signature = Buffer.from(await webcrypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + body))).toString('hex');
  return post('http://localhost/webhook/discord', body, { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp });
}

function slackRequest(body: string, credential: Credential, timestamp = String(nowSeconds())): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': timestamp };
  if (credential !== 'none') headers['x-slack-signature'] = `v0=${hmacHex(credential === 'right' ? 'slack-secret' : 'not-the-secret', `v0:${timestamp}:${body}`)}`;
  return new Request('http://localhost/webhook/slack', { method: 'POST', headers, body });
}

/** Twilio's signature: HMAC-SHA1 over the URL and the form fields sorted by name, base64. */
function twilioRequest(credential: Credential): Request {
  const url = 'http://localhost/webhook/telephony';
  const fields = { From: '+15550001', Body: 'hello', MessageSid: 'SM1' };
  const body = new URLSearchParams(fields).toString();
  const base = url + Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}${v}`).join('');
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (credential !== 'none') headers['x-twilio-signature'] = createHmac('sha1', credential === 'right' ? 'twilio-token' : 'not-the-token').update(base).digest('base64');
  return new Request(url, { method: 'POST', headers, body });
}

interface AdapterRow {
  readonly surface: string;
  /**
   * What the right credential is answered once the policy refused the sender: a provider that
   * redelivers on a failure (Telegram, Slack, Discord, WhatsApp, Twilio, Google Chat) is acknowledged,
   * a caller that reads the status is told 403. GitHub, with no policy, acknowledges the ping.
   */
  readonly answer: number;
  readonly config: Record<string, unknown>;
  readonly secrets?: Record<string, string>;
  readonly request: (credential: Credential) => Request | Promise<Request>;
  readonly handle: (request: Request, context: never) => Promise<Response>;
  /** GitHub has no channel policy: the right signature must get past authentication instead. */
  readonly noPolicy?: true;
}

const whatsappBody = json({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ id: 'wamid.1', from: '111', text: { body: 'hello' } }] } }] }] });
const githubBody = json({ zen: 'Keep it logically awesome.', hook_id: 1 });
const ntfyTopic = 'gv-agent-fixture-7f3c';

const ADAPTERS: readonly AdapterRow[] = [
  {
    surface: 'webhook', answer: 403, config: { 'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret' },
    request: (c) => post('http://localhost/webhook', json({ task: 'hello', userId: 'u1' }), tokenHeader('x-goodvibes-webhook-secret', 'hook-secret', c)),
    handle: (r, ctx) => handleGenericWebhookSurface(r, ctx),
  },
  {
    surface: 'telegram', answer: 200, config: { 'surfaces.telegram.webhookSecret': 'tg-secret' },
    request: (c) => post('http://localhost/webhook/telegram', json({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: 'group' }, from: { id: 9 }, text: 'lunch anyone?' } }),
      tokenHeader('x-telegram-bot-api-secret-token', 'tg-secret', c)),
    handle: (r, ctx) => handleTelegramSurfaceWebhook(r, ctx, {}),
  },
  {
    surface: 'slack', answer: 200, config: { 'surfaces.slack.signingSecret': 'slack-secret' },
    request: (c) => slackRequest('command=%2Fgoodvibes&text=hello&user_id=U1&channel_id=C1&team_id=T1', c),
    handle: (r, ctx) => handleSlackSurfaceWebhook(r, ctx),
  },
  {
    surface: 'discord', answer: 200, config: {}, secrets: { 'discord.publicKey': discordPublicKey },
    // An application command with no prompt: authorised and refused by the policy, no follow-up work.
    request: (c) => discordRequest(json({ id: 'i1', application_id: 'app-1', type: 2, token: 't', channel_id: 'c1', member: { user: { id: 'u1' } }, data: { name: 'goodvibes' } }), c),
    handle: (r, ctx) => handleDiscordSurfaceWebhook(r, ctx),
  },
  {
    surface: 'whatsapp', answer: 200, config: { 'surfaces.whatsapp.provider': 'meta-cloud', 'surfaces.whatsapp.signingSecret': 'wa-secret', 'surfaces.whatsapp.phoneNumberId': 'phone-1' },
    request: (c) => post('http://localhost/webhook/whatsapp', whatsappBody,
      c === 'none' ? {} : { 'x-hub-signature-256': `sha256=${hmacHex(c === 'right' ? 'wa-secret' : 'not-the-secret', whatsappBody)}` }),
    handle: (r, ctx) => handleWhatsAppSurfaceWebhook(r, ctx),
  },
  {
    surface: 'telephony', answer: 200, config: { 'surfaces.telephony.authToken': 'twilio-token' },
    request: (c) => twilioRequest(c),
    handle: (r, ctx) => handleTelephonySurfaceWebhook(r, ctx),
  },
  {
    surface: 'signal', answer: 403, config: { 'surfaces.signal.token': 'signal-token' },
    request: (c) => post('http://localhost/webhook/signal', json({ source: '+15550002', message: 'hello', timestamp: 1 }), tokenHeader('x-goodvibes-signal-token', 'signal-token', c)),
    handle: (r, ctx) => handleSignalSurfaceWebhook(r, ctx),
  },
  {
    surface: 'imessage', answer: 403, config: { 'surfaces.imessage.token': 'imessage-token' },
    request: (c) => post('http://localhost/webhook/imessage', json({ chatId: 'chat-1', message: 'hello', guid: 'g1' }), tokenHeader('x-goodvibes-imessage-token', 'imessage-token', c)),
    handle: (r, ctx) => handleIMessageSurfaceWebhook(r, ctx),
  },
  {
    surface: 'bluebubbles', answer: 403, config: { 'surfaces.bluebubbles.password': 'bb-password' },
    request: (c) => post('http://localhost/webhook/bluebubbles', json({ message: { text: 'hello', chatGuid: 'iMessage;-;+15550003', senderId: '+15550003', guid: 'g2' } }),
      tokenHeader('x-goodvibes-bluebubbles-token', 'bb-password', c)),
    handle: (r, ctx) => handleBlueBubblesSurfaceWebhook(r, ctx),
  },
  {
    surface: 'matrix', answer: 403, config: { 'surfaces.matrix.webhookSecret': 'matrix-secret' },
    request: (c) => post('http://localhost/webhook/matrix', json({ event: { room_id: '!room:example.test', sender: '@u:example.test', event_id: '$e1', content: { body: 'hello', msgtype: 'm.text' } } }),
      tokenHeader('x-goodvibes-matrix-token', 'matrix-secret', c)),
    handle: (r, ctx) => handleMatrixSurfaceWebhook(r, ctx),
  },
  {
    surface: 'mattermost', answer: 403, config: { 'surfaces.mattermost.webhookSecret': 'mm-secret' },
    request: (c) => post('http://localhost/webhook/mattermost', json({ channel_id: 'c1', channel_type: 'D', user_id: 'u1', post_id: 'p1', text: 'hello' }),
      tokenHeader('x-goodvibes-mattermost-token', 'mm-secret', c)),
    handle: (r, ctx) => handleMattermostSurfaceWebhook(r, ctx),
  },
  {
    surface: 'google-chat', answer: 200, config: { 'surfaces.googleChat.verificationToken': 'gchat-token' },
    request: (c) => post('http://localhost/webhook/google-chat', json({
      type: 'MESSAGE', ...(c === 'none' ? {} : { token: c === 'right' ? 'gchat-token' : 'gchat-token-wrong' }),
      message: { name: 'spaces/s/messages/m', text: 'hello', sender: { name: 'users/1' } }, space: { name: 'spaces/s', type: 'DM' }, user: { name: 'users/1' },
    }), {}),
    handle: (r, ctx) => handleGoogleChatSurfaceWebhook(r, ctx),
  },
  {
    surface: 'msteams', answer: 403, config: { 'surfaces.msteams.webhookSecret': 'teams-secret' },
    request: (c) => post('http://localhost/webhook/msteams', json({ type: 'message', id: 'a1', text: 'hello', conversation: { id: 'conv-1', conversationType: 'personal' }, from: { id: 'u1' }, serviceUrl: 'https://smba.example.test/' }),
      tokenHeader('x-goodvibes-msteams-token', 'teams-secret', c)),
    handle: (r, ctx) => handleMSTeamsSurfaceWebhook(r, ctx),
  },
  {
    surface: 'ntfy', answer: 403, config: { 'surfaces.ntfy.enabled': true, 'surfaces.ntfy.token': 'ntfy-token', 'surfaces.ntfy.agentTopic': ntfyTopic },
    request: (c) => post('http://localhost/webhook/ntfy', json({ id: 'n1', topic: ntfyTopic, message: 'hello' }), tokenHeader('x-ntfy-token', 'ntfy-token', c)),
    handle: (r, ctx) => handleNtfySurfaceWebhook(r, ctx),
  },
  {
    surface: 'homeassistant', answer: 403, config: { 'surfaces.homeassistant.enabled': true, 'surfaces.homeassistant.webhookSecret': 'ha-secret' },
    request: (c) => post('http://localhost/webhook/homeassistant', json({ message: 'hello', conversationId: 'c1' }), tokenHeader('x-goodvibes-homeassistant-secret', 'ha-secret', c)),
    handle: (r, ctx) => handleHomeAssistantSurfaceWebhook(r, ctx),
  },
  {
    surface: 'github', answer: 200, config: { 'github.secret': 'gh-secret' }, noPolicy: true,
    request: (c) => post('http://localhost/webhook/github', githubBody, {
      'x-github-event': 'ping', 'x-github-delivery': 'd1',
      ...(c === 'none' ? {} : { 'x-hub-signature-256': `sha256=${hmacHex(c === 'right' ? 'gh-secret' : 'not-the-secret', githubBody)}` }),
    }),
    handle: (r, ctx) => handleGitHubAutomationWebhook(r, ctx),
  },
];

test('every webhook adapter answers 401 to a missing, wrong or replayed credential and asks nothing; with the right one a refused sender starts nothing', async () => {
  const outcomes: Array<Record<string, unknown>> = [];
  for (const row of ADAPTERS) {
    for (const credential of ['right', 'wrong', 'none'] as const) {
      const { calls, context } = recordingContext(row.config, row.secrets);
      const response = await row.handle(await row.request(credential), context);
      const asked = calls.map((call) => call.kind);
      outcomes.push({
        surface: row.surface, credential,
        status: response.status,
        // The right credential reaches the policy (or, with no policy, passes authentication); the
        // policy refuses the sender, so no message is stored and no agent starts. Nothing else reaches anything.
        reached: credential === 'right'
          ? (row.noPolicy ? response.status !== 401 && response.status !== 503 : asked.includes('authorizeSurfaceIngress'))
            && !asked.includes('submitMessage') && !asked.includes('trySpawnAgent')
          : asked.length === 0,
      });
    }
  }

  // A correctly signed request replayed ten minutes later, and a credential reference that resolves to nothing
  // while an environment variable for the same surface holds a value the caller sends.
  const stale = String(nowSeconds() - 600);
  const previousSignalEnv = process.env.SIGNAL_BRIDGE_TOKEN;
  process.env.SIGNAL_BRIDGE_TOKEN = 'env-token';
  try {
    const extra: Array<{ name: string; config: Record<string, unknown>; secrets?: Record<string, string>; send: (context: never) => Promise<Response> }> = [
      { name: 'slack replayed', config: { 'surfaces.slack.signingSecret': 'slack-secret' },
        send: (ctx) => handleSlackSurfaceWebhook(slackRequest('command=%2Fgoodvibes&text=hello&user_id=U1&channel_id=C1&team_id=T1', 'right', stale), ctx) },
      { name: 'discord replayed', config: {}, secrets: { 'discord.publicKey': discordPublicKey },
        send: async (ctx) => handleDiscordSurfaceWebhook(await discordRequest(json({ id: 'i2', application_id: 'app-1', type: 2, token: 't', channel_id: 'c1', member: { user: { id: 'u1' } }, data: { name: 'goodvibes' } }), 'right', stale), ctx) },
      { name: 'signal unresolvable reference', config: { 'surfaces.signal.token': 'goodvibes://secrets/goodvibes/SIGNAL_TOKEN_THAT_IS_GONE' },
        send: (ctx) => handleSignalSurfaceWebhook(post('http://localhost/webhook/signal', json({ source: '+15550002', message: 'hello' }), { 'x-goodvibes-signal-token': 'env-token' }), ctx) },
    ];
    for (const row of extra) {
      const { calls, context } = recordingContext(row.config, row.secrets);
      const response = await row.send(context);
      outcomes.push({ surface: row.name, credential: 'right', status: response.status, reached: calls.length === 0 });
    }
  } finally {
    if (previousSignalEnv === undefined) delete process.env.SIGNAL_BRIDGE_TOKEN;
    else process.env.SIGNAL_BRIDGE_TOKEN = previousSignalEnv;
  }

  expect(outcomes).toEqual([
    ...ADAPTERS.flatMap((row) => [
      { surface: row.surface, credential: 'right', status: row.answer, reached: true },
      { surface: row.surface, credential: 'wrong', status: 401, reached: true },
      { surface: row.surface, credential: 'none', status: 401, reached: true },
    ]),
    { surface: 'slack replayed', credential: 'right', status: 401, reached: true },
    { surface: 'discord replayed', credential: 'right', status: 401, reached: true },
    { surface: 'signal unresolvable reference', credential: 'right', status: 503, reached: true },
  ]);
});

test('a Teams token is accepted only when signed by a published key, issued by the Bot Framework for this bot and not expired', async () => {
  const appId = 'app-0001';
  const published = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const unpublished = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = published.publicKey.export({ format: 'jwk' });
  // Microsoft's metadata and key set, as the injected fetch serves them.
  const keyServer: BotFrameworkFetch = async (url) => (url.includes('openidconfiguration')
    ? Response.json({ jwks_uri: 'https://keys.botframework.test/keys' })
    : Response.json({ keys: [{ kty: 'RSA', kid: 'published', n: jwk.n, e: jwk.e, endorsements: ['msteams'] }] }));
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);
  const seconds = Math.floor(now / 1000);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (claims: Record<string, unknown>, options: { key?: KeyObject; kid?: string; alg?: string } = {}) => {
    const head = `${b64({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'published', typ: 'JWT' })}.${b64({
      iss: BOT_FRAMEWORK_ISSUER, aud: appId, exp: seconds + 3600, nbf: seconds - 60, serviceurl: 'https://smba.example.test/', ...claims,
    })}`;
    if (options.alg === 'none') return `${head}.`;
    return `${head}.${sign('RSA-SHA256', Buffer.from(head), options.key ?? published.privateKey).toString('base64url')}`;
  };
  const verify = async (presented: string) => {
    const result = await verifyBotFrameworkToken(presented, { appId, fetch: keyServer, now: () => now });
    return result.ok;
  };

  expect({
    valid: await verify(token({})),
    otherBot: await verify(token({ aud: 'app-of-another-bot' })),
    otherIssuer: await verify(token({ iss: 'https://login.example.test' })),
    expired: await verify(token({ exp: seconds - 6 * 60 })),
    unpublishedKeyId: await verify(token({}, { key: unpublished.privateKey, kid: 'unpublished' })),
    forgedUnderPublishedId: await verify(token({}, { key: unpublished.privateKey })),
    unsigned: await verify(token({}, { alg: 'none' })),
  }).toEqual({
    valid: true, otherBot: false, otherIssuer: false, expired: false, unpublishedKeyId: false, forgedUnderPublishedId: false, unsigned: false,
  });
});
