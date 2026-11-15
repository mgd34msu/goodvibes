/**
 * The secret an inbound webhook caller must hold: a surface's own webhook secret
 * is checked first, so the account credential used for delivery is not the value
 * a caller needs, and Telegram checks the same secret its registration hands out.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { handleMatrixSurfaceWebhook } from '../platform/src/platform/adapters/matrix/index.js';
import { handleMattermostSurfaceWebhook } from '../platform/src/platform/adapters/mattermost/index.js';
import { handleMSTeamsSurfaceWebhook } from '../platform/src/platform/adapters/msteams/index.js';
import { handleTelegramSurfaceWebhook, processTelegramUpdate } from '../platform/src/platform/adapters/telegram/index.js';

type Handler = (req: Request, context: never) => Promise<Response>;

function context(config: Record<string, string>, registry: Record<string, string> = {}) {
  return {
    configManager: { get: (key: string) => config[key] },
    serviceRegistry: { resolveSecret: async (service: string, field: string) => registry[`${service}:${field}`] ?? null },
  } as never;
}

const SURFACES: ReadonlyArray<{ name: string; handler: Handler; header: string; credentialKey: string; secretKey: string }> = [
  { name: 'matrix', handler: handleMatrixSurfaceWebhook, header: 'x-goodvibes-matrix-token', credentialKey: 'surfaces.matrix.accessToken', secretKey: 'surfaces.matrix.webhookSecret' },
  { name: 'mattermost', handler: handleMattermostSurfaceWebhook, header: 'x-goodvibes-mattermost-token', credentialKey: 'surfaces.mattermost.botToken', secretKey: 'surfaces.mattermost.webhookSecret' },
];

const post = (header: string, token: string): Request => new Request('http://localhost/webhook', {
  method: 'POST', headers: { [header]: token, 'content-type': 'application/json' }, body: '{}',
});

for (const surface of SURFACES) {
  describe(`${surface.name} inbound secret`, () => {
    test('a webhook secret is required of the caller, and the delivery credential no longer is', async () => {
      const ctx = context({ [surface.credentialKey]: 'delivery-credential', [surface.secretKey]: 'inbound-secret' });
      expect((await surface.handler(post(surface.header, 'delivery-credential'), ctx)).status).toBe(401);
      expect((await surface.handler(post(surface.header, 'inbound-secret'), ctx)).status).not.toBe(401);
    });

    test('a registered signing secret counts as the inbound secret', async () => {
      const ctx = context({ [surface.credentialKey]: 'delivery-credential' }, { [`${surface.name}:signingSecret`]: 'registry-secret' });
      expect((await surface.handler(post(surface.header, 'delivery-credential'), ctx)).status).toBe(401);
      expect((await surface.handler(post(surface.header, 'registry-secret'), ctx)).status).not.toBe(401);
    });

    test('with no webhook secret set, the delivery credential still authenticates the caller', async () => {
      const ctx = context({ [surface.credentialKey]: 'delivery-credential' });
      expect((await surface.handler(post(surface.header, 'delivery-credential'), ctx)).status).not.toBe(401);
    });
  });
}

describe('msteams inbound authentication', () => {
  // No conversation: an admitted request stops at the 400 that follows the
  // authentication step, so the status says only whether it was admitted.
  const activity = { type: 'message', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/teams/' };
  const teamsPost = (headers: Record<string, string>): Request => new Request('http://localhost/msteams', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(activity),
  });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', endorsements: ['msteams'] };
  const sign = (claims: Record<string, unknown>): string => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://api.botframework.com', aud: 'teams-app', exp: now + 600, nbf: now - 60, serviceurl: activity.serviceUrl };

  test('the app password is never accepted as a bearer', async () => {
    const ctx = context({ 'surfaces.msteams.appId': 'teams-app', 'surfaces.msteams.appPassword': 'delivery-credential' });
    expect((await handleMSTeamsSurfaceWebhook(teamsPost({ authorization: 'Bearer delivery-credential' }), ctx)).status).toBe(401);
    expect((await handleMSTeamsSurfaceWebhook(teamsPost({ 'x-goodvibes-msteams-token': 'delivery-credential' }), ctx)).status).toBe(401);
  });

  test('a relay secret, when set, is accepted', async () => {
    const ctx = context({ 'surfaces.msteams.webhookSecret': 'relay-secret' });
    expect((await handleMSTeamsSurfaceWebhook(teamsPost({ 'x-goodvibes-msteams-token': 'relay-secret' }), ctx)).status).not.toBe(401);
  });

  test('a Bot Framework token for this app is accepted; one for another app, issuer or connector is not', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('openidconfiguration')) return Response.json({ jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' });
      return Response.json({ keys: [jwk] });
    }) as typeof fetch);
    try {
      const ctx = context({ 'surfaces.msteams.appId': 'teams-app' });
      const call = (token: string) => handleMSTeamsSurfaceWebhook(teamsPost({ authorization: `Bearer ${token}` }), ctx);
      expect((await call(sign(claims))).status).not.toBe(401);
      expect((await call(sign({ ...claims, aud: 'another-app' }))).status).toBe(401);
      expect((await call(sign({ ...claims, iss: 'https://example.test' }))).status).toBe(401);
      expect((await call(sign({ ...claims, serviceurl: 'https://elsewhere.example.test/' }))).status).toBe(401);
      expect((await call(sign({ ...claims, exp: now - 3600 }))).status).toBe(401);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('telegram inbound secret', () => {
  const telegramPost = (secret: string): Request => new Request('http://localhost/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' }, body: '{}',
  });

  test('the registry secret wins over the config secret when no registration is current, as at registration', async () => {
    const ctx = context({ 'surfaces.telegram.webhookSecret': 'config-secret' }, { 'telegram:signingSecret': 'registry-secret' });
    expect((await handleTelegramSurfaceWebhook(telegramPost('registry-secret'), ctx)).status).toBe(200);
    expect((await handleTelegramSurfaceWebhook(telegramPost('config-secret'), ctx)).status).toBe(401);
  });

  test('the config secret is used when the registry holds none', async () => {
    const ctx = context({ 'surfaces.telegram.webhookSecret': 'config-secret' });
    expect((await handleTelegramSurfaceWebhook(telegramPost('config-secret'), ctx)).status).toBe(200);
  });
});

describe('edits and reactions are not new messages', () => {
  function counting(config: Record<string, string>) {
    const calls: string[] = [];
    const binding = { id: 'binding-1', kind: 'channel', surfaceKind: 'x', surfaceId: 'x', externalId: 'c', channelId: 'c', title: 'c', metadata: {} };
    const ctx = {
      configManager: { get: (key: string) => config[key] },
      serviceRegistry: { resolveSecret: async () => null },
      routeBindings: { upsertBinding: async () => { calls.push('upsertBinding'); return binding; } },
      sessionBroker: {
        submitMessage: async () => { calls.push('submitMessage'); return { mode: 'spawn', task: { prompt: 'p' }, session: { id: 's' }, input: { id: 'i' }, routeBinding: binding }; },
        bindAgent: async () => { calls.push('bindAgent'); },
      },
      authorizeSurfaceIngress: async () => { calls.push('authorizeSurfaceIngress'); return { allowed: true }; },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      trySpawnAgent: () => { calls.push('trySpawnAgent'); return { id: 'a' }; },
      queueSurfaceReplyFromBinding: () => { calls.push('queueSurfaceReplyFromBinding'); },
    } as never;
    return { calls, ctx };
  }

  const matrixEvent = (eventId: string, content: Record<string, unknown>) => new Request('http://localhost/matrix', {
    method: 'POST',
    headers: { 'x-goodvibes-matrix-token': 'tok', 'content-type': 'application/json' },
    body: JSON.stringify({ event: { event_id: eventId, room_id: '!r:x', sender: '@u:x', content } }),
  });

  test('a matrix edit and a matrix reaction reach no policy, binding or session; the original does', async () => {
    const { calls, ctx } = counting({ 'surfaces.matrix.accessToken': 'tok' });
    const original = await handleMatrixSurfaceWebhook(matrixEvent('$1', { body: 'do the thing' }), ctx);
    expect((await original.json() as { queued?: boolean }).queued).toBe(true);
    expect(calls.filter((c) => c === 'trySpawnAgent')).toHaveLength(1);
    calls.length = 0;
    for (const [id, relation] of [['$2', 'm.replace'], ['$3', 'm.annotation']] as const) {
      const response = await handleMatrixSurfaceWebhook(matrixEvent(id, { body: '* do the thing', 'm.relates_to': { rel_type: relation, event_id: '$1' } }), ctx);
      expect((await response.json() as { outcome?: string }).outcome).toBe('ignored');
    }
    expect(calls).toEqual([]);
  });

  test('a telegram edited_message after the original produces no second submission', async () => {
    const { calls, ctx } = counting({ 'surfaces.telegram.botUsername': 'bot' });
    const update = (key: 'message' | 'edited_message', id: number) => ({
      update_id: id,
      [key]: { message_id: 7, date: 1_700_000_000, chat: { id: 55, type: 'private' }, from: { id: 9 }, text: 'do the thing' },
    });
    const first = await processTelegramUpdate(update('message', 1), ctx);
    expect((await first.json() as { queued?: boolean }).queued).toBe(true);
    expect(calls.filter((c) => c === 'submitMessage')).toHaveLength(1);
    calls.length = 0;
    const edited = await processTelegramUpdate(update('edited_message', 2), ctx);
    expect(await edited.json()).toMatchObject({ outcome: 'ignored', reason: 'edited-message' });
    expect(calls).not.toContain('submitMessage');
    expect(calls).not.toContain('upsertBinding');
    expect(calls).not.toContain('trySpawnAgent');
  });
});
