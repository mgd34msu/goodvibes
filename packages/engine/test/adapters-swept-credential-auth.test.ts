/**
 * adapters-swept-credential-auth.test.ts, inbound auth after the config sweep.
 *
 * `sweepPlaintextCredentials` moves a literal surface credential out of the
 * config file into the secret store and leaves a
 * `goodvibes://secrets/goodvibes/<KEY>` reference behind. Every inbound webhook
 * adapter compares a caller's presented secret against the CONFIG value, so
 * until the adapters resolve that reference a correctly-configured surface
 * answers 401 to every POST.
 *
 * Four cases per adapter family, because three of them pass for reasons that
 * do not generalise:
 *
 *   1. a swept (reference) credential authorises the right caller, the defect;
 *   2. a raw literal still authorises, the un-swept operator and the env-var
 *      operator both still hold literals, and resolution must pass those
 *      through rather than require a reference;
 *   3. a wrong secret is refused, resolution must not weaken the comparison;
 *   4. a reference that resolves to NOTHING refuses rather than authorising,
 *      the failure mode resolution introduces. Seven of these adapters skip the
 *      comparison entirely when the configured credential is empty ("no secret
 *      configured, no check to run"), so a resolution failure that degrades to
 *      an empty string turns a locked surface into an open one.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { handleSignalSurfaceWebhook } from '../platform/src/platform/adapters/signal/index.js';
import { handleIMessageSurfaceWebhook } from '../platform/src/platform/adapters/imessage/index.js';
import { handleMatrixSurfaceWebhook } from '../platform/src/platform/adapters/matrix/index.js';
import { handleMattermostSurfaceWebhook } from '../platform/src/platform/adapters/mattermost/index.js';
import { handleMSTeamsSurfaceWebhook } from '../platform/src/platform/adapters/msteams/index.js';
import { handleBlueBubblesSurfaceWebhook } from '../platform/src/platform/adapters/bluebubbles/index.js';
import { handleGoogleChatSurfaceWebhook } from '../platform/src/platform/adapters/google-chat/index.js';
import { handleNtfySurfaceWebhook } from '../platform/src/platform/adapters/ntfy/index.js';
import { handleTelegramSurfaceWebhook } from '../platform/src/platform/adapters/telegram/index.js';
import { handleTelephonySurfaceWebhook } from '../platform/src/platform/adapters/telephony/index.js';
import { handleWhatsAppSurfaceWebhook } from '../platform/src/platform/adapters/whatsapp/index.js';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.js';
import { secretReferenceFor } from '../platform/src/platform/config/plaintext-credential-sweep.js';
import { daemonSecretKeyFor } from '../platform/src/platform/config/daemon-secret-keys.js';

const SECRET = 'the-real-surface-secret';

/**
 * The exact reference the sweep writes for a config key, derived through the
 * same two functions the sweep uses rather than hand-spelled, a test that
 * hard-codes the reference format keeps passing after the format changes.
 */
function sweptReference(configKey: string): string {
  return secretReferenceFor(daemonSecretKeyFor(configKey));
}

type ConfigShape = 'literal' | 'swept' | 'swept-unresolvable' | 'whitespace';

interface HarnessOptions {
  readonly shape: ConfigShape;
  readonly configKeys: readonly string[];
  readonly extraConfig?: Record<string, unknown>;
}

/**
 * Build the adapter context for one credential shape.
 *
 * `swept` files the secret in the store double and puts the reference in
 * config, which is the production shape after 1.19.1. `swept-unresolvable`
 * writes the same reference and leaves the store EMPTY, an operator who
 * cleared the store, a scope the daemon cannot read, a key renamed by hand.
 */
function makeContext(options: HarnessOptions) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const store = new Map<string, string>();
  const config = new Map<string, unknown>(Object.entries(options.extraConfig ?? {}));

  for (const configKey of options.configKeys) {
    if (options.shape === 'literal') {
      config.set(configKey, SECRET);
      continue;
    }
    if (options.shape === 'whitespace') {
      config.set(configKey, '   ');
      continue;
    }
    config.set(configKey, sweptReference(configKey));
    if (options.shape === 'swept') store.set(daemonSecretKeyFor(configKey), SECRET);
  }

  const binding = {
    id: 'binding-1',
    kind: 'channel',
    surfaceKind: 'test',
    surfaceId: 'surface-1',
    externalId: 'external-1',
    channelId: 'channel-1',
    threadId: undefined,
    title: 'title',
    metadata: {},
  };

  return {
    calls,
    context: {
      serviceRegistry: { resolveSecret: async () => null },
      secretsManager: {
        get: async (key: string) => store.get(key) ?? null,
        getGlobalHome: () => '/nonexistent-home',
      },
      configManager: { get: (key: string) => config.get(key) },
      routeBindings: {
        upsertBinding: async (input: unknown) => {
          calls.push({ kind: 'upsertBinding', input });
          return binding;
        },
      },
      sessionBroker: {
        submitMessage: async (input: unknown) => {
          calls.push({ kind: 'submitMessage', input });
          return {
            mode: 'spawn',
            task: { prompt: 'hello' },
            session: { id: 'session-1' },
            routeBinding: binding,
          };
        },
        bindAgent: async () => {},
        findPreferredSession: async () => null,
        listSessions: () => [],
      },
      authorizeSurfaceIngress: async (input: unknown) => {
        calls.push({ kind: 'authorizeSurfaceIngress', input });
        return { allowed: true };
      },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      performInteractiveSurfaceAction: async () => 'ok',
      trySpawnAgent: (input: unknown) => {
        calls.push({ kind: 'trySpawnAgent', input });
        return { id: 'agent-1' };
      },
      queueSurfaceReplyFromBinding: () => {},
      surfaceDeliveryEnabled: () => true,
      signWebhookPayload: (body: string, secret: string) => `sig:${secret}:${body.length}`,
      queueWebhookReply: () => {},
    } as never,
  };
}

for (const signature of [undefined, '', 'sha256=short', `sha256=${'A'.repeat(64)}`,
  `sha256=${'g'.repeat(64)}`, `sha256=${'é'.repeat(64)}`, `sha256=${'a'.repeat(65)}`]) {
  test(`generic webhook refuses an impossible signature without asking for an HMAC (${signature ?? 'missing'})`, async () => {
    const f = makeContext({ shape: 'literal', configKeys: ['surfaces.webhook.secret'], extraConfig: { 'surfaces.webhook.enabled': true } });
    let signs = 0;
    const context = Object.assign(f.context, { signWebhookPayload() { signs += 1; throw new Error('Impossible signature must not reach the signer.'); } });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (signature !== undefined) headers.set('x-goodvibes-signature', signature);
    const response = await handleGenericWebhookSurface(new Request('http://localhost/webhook', { method: 'POST', headers,
      body: JSON.stringify({ task: 'Original webhook task' }) }), context);
    expect(response.status).toBe(401); expect(signs).toBe(0); expect(f.calls).toEqual([]);
  });
}

for (const ending of ['\n', '\r', '\r\n']) test('a borrowed raw webhook header with a trailing line ending cannot reach the signer', async () => {
  const f = makeContext({ shape: 'literal', configKeys: ['surfaces.webhook.secret'], extraConfig: { 'surfaces.webhook.enabled': true } });
  let signs = 0;
  const context = Object.assign(f.context, { signWebhookPayload() { signs += 1; throw new Error('Overlong signature must not reach the signer.'); } });
  const original = new Request('http://localhost/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'Original webhook task' }) });
  // Native Headers trims/rejects these values. A borrowed Request facade can
  // expose the exact raw value, so prove the adapter's own length boundary.
  const headers = new Proxy(original.headers, { get(target, property) {
    if (property === 'get') return (name: string) => name.toLowerCase() === 'x-goodvibes-signature' ? `sha256=${'a'.repeat(64)}${ending}` : target.get(name);
    const value: unknown = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const request = new Proxy(original, { get(target, property) {
    if (property === 'headers') return headers;
    const value: unknown = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const response = await handleGenericWebhookSurface(request, context);
  expect(response.status).toBe(401); expect(signs).toBe(0); expect(f.calls).toEqual([]);
});

test('a genuine generic webhook bearer bypasses signing even when an unrelated signature is malformed', async () => {
  const f = makeContext({ shape: 'literal', configKeys: ['surfaces.webhook.secret'], extraConfig: { 'surfaces.webhook.enabled': true } });
  let signs = 0;
  const context = Object.assign(f.context, { signWebhookPayload() { signs += 1; throw new Error('Bearer authentication needs no signature.'); } });
  const response = await handleGenericWebhookSurface(new Request('http://localhost/webhook', { method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'x-goodvibes-signature': `sha256=${'é'.repeat(64)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Original webhook task' }) }), context);
  expect(response.status).toBe(200); expect(signs).toBe(0);
  expect(f.calls.some(call => call.kind === 'authorizeSurfaceIngress')).toBe(true);
});

for (const valid of [false, true]) test(`a viable generic webhook signature performs one actual body HMAC and authenticates only exact bytes (valid=${valid})`, async () => {
  const f = makeContext({ shape: 'literal', configKeys: ['surfaces.webhook.secret'], extraConfig: { 'surfaces.webhook.enabled': true } });
  const body = JSON.stringify({ task: 'Original signed webhook task' });
  const provided = valid ? `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}` : `sha256=${'0'.repeat(64)}`;
  let signs = 0;
  const context = Object.assign(f.context, { signWebhookPayload(raw: string, secret: string) {
    signs += 1; expect(raw).toBe(body); expect(secret).toBe(SECRET);
    return `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  } });
  const response = await handleGenericWebhookSurface(new Request('http://localhost/webhook', { method: 'POST',
    headers: { authorization: 'Bearer wrong-secret', 'x-goodvibes-signature': provided, 'content-type': 'application/json' }, body }), context);
  expect(response.status).toBe(valid ? 200 : 401); expect(signs).toBe(1);
  if (!valid) expect(f.calls).toEqual([]);
});

for (const upperCase of [false, true]) test(`Twilio JSON signature verifies the actual body once across internal and public URLs (uppercase=${upperCase})`, async () => {
  const body = JSON.stringify({ From: '+15555550123', To: '+15555550124' });
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const suffix = `/telephony?bodySHA256=${upperCase ? hash.toUpperCase() : hash}`;
  const signature = crypto.createHmac('sha1', SECRET).update(`https://voice.example.test${suffix}`).digest('base64');
  const f = makeContext({ shape: 'literal', configKeys: ['surfaces.telephony.authToken'],
    extraConfig: { 'web.publicBaseUrl': 'https://voice.example.test' } });
  const hashing = spyOn(crypto, 'createHash');
  try {
    const response = await handleTelephonySurfaceWebhook(new Request(`http://localhost${suffix}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-twilio-signature': signature }, body,
    }), f.context);
    expect(response.status).toBe(200);
    expect(f.calls.some(call => call.kind === 'authorizeSurfaceIngress')).toBe(true);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
  } finally { hashing.mockRestore(); }
});

for (const signature of [undefined, '', 'bad', 'A'.repeat(27), 'A'.repeat(28), `${'A'.repeat(26)}==`, 'é'.repeat(28)]) {
  test('an impossible Twilio signature performs no body SHA or HMAC before refusing', async () => {
    const f = makeContext({ shape: 'literal', configKeys: ['surfaces.telephony.authToken'] });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (signature !== undefined) headers.set('x-twilio-signature', signature);
    const hash = spyOn(crypto, 'createHash'), hmac = spyOn(crypto, 'createHmac');
    try {
      const response = await handleTelephonySurfaceWebhook(new Request(`http://localhost/telephony?bodySHA256=${'0'.repeat(64)}`, {
        method: 'POST', headers, body: JSON.stringify({ From: '+15555550123', To: '+15555550124' }),
      }), f.context);
      expect(response.status).toBe(401); expect(f.calls).toEqual([]);
      expect(hash).not.toHaveBeenCalled(); expect(hmac).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); hmac.mockRestore(); }
  });
}

for (const bodyHash of [undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'é'.repeat(64)]) {
  test('an impossible Twilio JSON body-hash query performs no SHA or HMAC before refusing', async () => {
    const f = makeContext({ shape: 'literal', configKeys: ['surfaces.telephony.authToken'] });
    const suffix = bodyHash === undefined ? '' : `?bodySHA256=${encodeURIComponent(bodyHash)}`;
    const hash = spyOn(crypto, 'createHash'), hmac = spyOn(crypto, 'createHmac');
    try {
      const response = await handleTelephonySurfaceWebhook(new Request(`http://localhost/telephony${suffix}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-twilio-signature': 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        body: JSON.stringify({ From: '+15555550123', To: '+15555550124' }),
      }), f.context);
      expect(response.status).toBe(401); expect(f.calls).toEqual([]);
      expect(hash).not.toHaveBeenCalled(); expect(hmac).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); hmac.mockRestore(); }
  });
}

test('Twilio refuses a modified JSON body before ingress even when its signed URL is unchanged', async () => {
  const original = JSON.stringify({ From: '+15555550123', To: '+15555550124' });
  const hash = crypto.createHash('sha256').update(original).digest('hex');
  const url = `http://localhost/telephony?bodySHA256=${hash}`;
  const signature = crypto.createHmac('sha1', SECRET).update(url).digest('base64');
  const f = makeContext({ shape: 'literal', configKeys: ['surfaces.telephony.authToken'] });
  const response = await handleTelephonySurfaceWebhook(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-twilio-signature': signature }, body: `${original} `,
  }), f.context);
  expect(response.status).toBe(401);
  expect(f.calls).toEqual([]);
});

test('authenticated telephony bridge requests need no Twilio body hashing', async () => {
  const f = makeContext({ shape: 'literal', configKeys: ['surfaces.telephony.webhookSecret', 'surfaces.telephony.authToken'] });
  const hashing = spyOn(crypto, 'createHash');
  try {
    const response = await handleTelephonySurfaceWebhook(new Request('http://localhost/telephony?bodySHA256=unused', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-telephony-token': SECRET,
        'x-twilio-signature': 'Unused alternate authentication' },
      body: JSON.stringify({ From: '+15555550123', To: '+15555550124' }),
    }), f.context);
    expect(response.status).toBe(200);
    expect(f.calls.some(call => call.kind === 'authorizeSurfaceIngress')).toBe(true);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

/**
 * One adapter family's inbound call, parameterised by the secret the caller
 * presents. `authorized` is what "this request got past the credential check"
 * looks like for that adapter, never merely "not 401", because an adapter that
 * skips the check answers 200 for a request it never authenticated, and a test
 * asserting `not 401` would call that a pass.
 */
interface AdapterCase {
  readonly name: string;
  readonly configKeys: readonly string[];
  readonly extraConfig?: Record<string, unknown>;
  readonly call: (presented: string, context: never) => Promise<Response>;
}

const CASES: readonly AdapterCase[] = [
  {
    name: 'signal',
    configKeys: ['surfaces.signal.token'],
    call: (presented, context) => handleSignalSurfaceWebhook(new Request('http://localhost/signal', {
      method: 'POST',
      headers: { 'x-goodvibes-signal-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: '+15551234567', message: 'hello' }),
    }), context),
  },
  {
    name: 'imessage',
    configKeys: ['surfaces.imessage.token'],
    call: (presented, context) => handleIMessageSurfaceWebhook(new Request('http://localhost/imessage', {
      method: 'POST',
      headers: { 'x-goodvibes-imessage-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'chat-1', message: 'hello' }),
    }), context),
  },
  {
    name: 'matrix',
    configKeys: ['surfaces.matrix.accessToken'],
    call: (presented, context) => handleMatrixSurfaceWebhook(new Request('http://localhost/matrix', {
      method: 'POST',
      headers: { 'x-goodvibes-matrix-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ event: { room_id: '!room:example.org', content: { body: 'hello' } } }),
    }), context),
  },
  {
    name: 'mattermost',
    configKeys: ['surfaces.mattermost.botToken'],
    call: (presented, context) => handleMattermostSurfaceWebhook(new Request('http://localhost/mattermost', {
      method: 'POST',
      headers: { 'x-goodvibes-mattermost-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ channel_id: 'channel-1', text: 'hello' }),
    }), context),
  },
  {
    name: 'msteams',
    configKeys: ['surfaces.msteams.appPassword'],
    call: (presented, context) => handleMSTeamsSurfaceWebhook(new Request('http://localhost/msteams', {
      method: 'POST',
      headers: { 'x-goodvibes-msteams-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', text: 'hello', conversation: { id: 'conv-1' } }),
    }), context),
  },
  {
    name: 'bluebubbles',
    configKeys: ['surfaces.bluebubbles.password'],
    call: (presented, context) => handleBlueBubblesSurfaceWebhook(new Request('http://localhost/bluebubbles', {
      method: 'POST',
      headers: { 'x-goodvibes-bluebubbles-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { text: 'hello', chatGuid: 'chat-1', senderId: '+15551234567' } }),
    }), context),
  },
  {
    name: 'google-chat',
    configKeys: ['surfaces.googleChat.verificationToken'],
    call: (presented, context) => handleGoogleChatSurfaceWebhook(new Request('http://localhost/google-chat', {
      method: 'POST',
      headers: { 'x-goog-chat-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'MESSAGE', space: { name: 'spaces/AAA' }, message: { text: 'hello' } }),
    }), context),
  },
  {
    name: 'ntfy',
    configKeys: ['surfaces.ntfy.token'],
    extraConfig: { 'surfaces.ntfy.enabled': true, 'surfaces.ntfy.agentTopic': 'agent-topic' },
    call: (presented, context) => handleNtfySurfaceWebhook(new Request('http://localhost/ntfy', {
      method: 'POST',
      headers: { 'x-ntfy-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'agent-topic', message: 'hello', id: crypto.randomUUID() }),
    }), context),
  },
  {
    name: 'telegram',
    configKeys: ['surfaces.telegram.webhookSecret'],
    call: (presented, context) => handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { text: 'hello', chat: { id: 42, type: 'private' } } }),
    }), context),
  },
  {
    name: 'telephony',
    configKeys: ['surfaces.telephony.webhookSecret'],
    call: (presented, context) => handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
      method: 'POST',
      headers: { 'x-goodvibes-telephony-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ from: '+15551234567', text: 'hello' }),
    }), context),
  },
  {
    name: 'whatsapp',
    configKeys: ['surfaces.whatsapp.signingSecret'],
    extraConfig: { 'surfaces.whatsapp.provider': 'bridge' },
    call: (presented, context) => handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
      method: 'POST',
      headers: { 'x-goodvibes-whatsapp-token': presented, 'content-type': 'application/json' },
      body: JSON.stringify({
        entry: [{ changes: [{ value: { messages: [{ from: '+15551234567', text: { body: 'hello' } }] } }] }],
      }),
    }), context),
  },
  {
    name: 'webhook',
    configKeys: ['surfaces.webhook.secret'],
    extraConfig: { 'surfaces.webhook.enabled': true },
    call: (presented, context) => handleGenericWebhookSurface(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'x-goodvibes-webhook-secret': presented, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    }), context),
  },
];

/**
 * Did this request get past the credential check?
 *
 * Measured by whether it reached `authorizeSurfaceIngress`, the first thing
 * every one of these adapters does once the caller is authenticated, and NOT
 * by the status code. "Not 401" is the tempting definition and it is wrong in
 * both directions: an adapter that refuses a broken credential answers 503, and
 * a test reading 503 as "authorised" reports a surface that rejects everything
 * as working. That mistake made the raw-literal case here pass under a mutation
 * that rejected every literal.
 */
function reachedHandler(calls: ReadonlyArray<{ kind: string }>): boolean {
  return calls.some((call) => call.kind === 'authorizeSurfaceIngress');
}

describe('inbound surface adapters: a swept credential reference', () => {
  for (const adapter of CASES) {
    describe(adapter.name, () => {
      const build = (shape: ConfigShape) => makeContext({
        shape,
        configKeys: adapter.configKeys,
        ...(adapter.extraConfig ? { extraConfig: adapter.extraConfig } : {}),
      });

      test('authorises the right caller when config holds a swept reference', async () => {
        const harness = build('swept');
        const res = await adapter.call(SECRET, harness.context);
        expect(res.status).not.toBe(401);
        expect(reachedHandler(harness.calls)).toBe(true);
      });

      test('still authorises the right caller when config holds a raw literal', async () => {
        const harness = build('literal');
        const res = await adapter.call(SECRET, harness.context);
        expect(res.status).not.toBe(401);
        expect(reachedHandler(harness.calls)).toBe(true);
      });

      test('refuses a wrong secret against a swept reference', async () => {
        const harness = build('swept');
        const res = await adapter.call('not-the-secret', harness.context);
        expect(res.status).toBe(401);
        expect(reachedHandler(harness.calls)).toBe(false);
      });

      test('refuses rather than authorising when the credential is only whitespace', async () => {
        // A whitespace-only setting is a misconfiguration, not an unconfigured
        // surface. It must not be trimmed into indistinguishability from "no
        // credential set", which on the skip-when-empty adapters would mean no
        // check ran at all.
        const harness = build('whitespace');
        const res = await adapter.call('   ', harness.context);
        expect(res.status).toBe(503);
        expect(reachedHandler(harness.calls)).toBe(false);
      });

      test('refuses rather than authorising when the reference resolves to nothing', async () => {
        const context = build('swept-unresolvable');
        // Both the right secret and an empty one, because the bypass this
        // guards is an empty configured credential matched against an empty
        // presented one, which no "wrong secret" case would ever catch.
        const withSecret = await adapter.call(SECRET, context.context);
        const withNothing = await adapter.call('', build('swept-unresolvable').context);
        // 503, and specifically not 200: a broken credential is a
        // configuration fault, and the request must not reach anything behind
        // the check. Asserting "not 401" here would pass for an adapter that
        // skipped the comparison and answered 200.
        expect(withSecret.status).toBe(503);
        expect(withNothing.status).toBe(503);
        expect(await withSecret.json()).toMatchObject({ reason: 'credential-unresolvable' });
        // And nothing behind the credential check ran.
        expect(context.calls).toEqual([]);
      });
    });
  }
});

describe('mattermost: an outgoing webhook token in the body', () => {
  // Mattermost's outgoing webhooks put the token in the form body, not a header.
  // The body token was never read (a `??` after a helper that returns '' rather
  // than null), so a configured Mattermost webhook refused every such call.
  function formRequest(token: string): Request {
    const body = new URLSearchParams({ token, channel_id: 'c1', user_id: 'u1', text: 'hello' });
    return new Request('http://localhost/mattermost', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }

  test('the right token in the body authorises the call', async () => {
    const { context, calls } = makeContext({ shape: 'literal', configKeys: ['surfaces.mattermost.botToken'] });
    const response = await handleMattermostSurfaceWebhook(formRequest(SECRET), context as never);
    expect(response.status).not.toBe(401);
    expect(calls.some((call) => call.kind === 'authorizeSurfaceIngress')).toBe(true);
  });

  test('a wrong token in the body is refused', async () => {
    const { context, calls } = makeContext({ shape: 'literal', configKeys: ['surfaces.mattermost.botToken'] });
    const response = await handleMattermostSurfaceWebhook(formRequest('not-the-secret'), context as never);
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

test('unconfigured inbound webhooks do not authorize or queue caller input', async () => {
  for (const adapter of CASES.filter(c => ['google-chat','signal','imessage','matrix','mattermost','bluebubbles','telegram'].includes(c.name))) {
    const f = makeContext({ shape: 'whitespace', configKeys: adapter.configKeys, ...(adapter.extraConfig ? { extraConfig: adapter.extraConfig } : {}) });
    expect((await adapter.call('', f.context)).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  }
});

test('WhatsApp processes every message across entries and changes', async () => {
  const f = makeContext({ shape: 'literal', configKeys: ['surfaces.whatsapp.signingSecret'], extraConfig: { 'surfaces.whatsapp.provider': 'bridge' } });
  const message = (id: string) => ({ id, from: 'sender', text: { body: id } });
  const response = await handleWhatsAppSurfaceWebhook(new Request('https://test/whatsapp', { method: 'POST',
    headers: { 'x-goodvibes-whatsapp-token': SECRET }, body: JSON.stringify({ entry: [
      { changes: [{ value: { statuses: [] } }, { value: { messages: [message('one'), message('two')] } }] },
      { changes: [{ value: { messages: [message('three')] } }] },
    ] }) }), f.context);
  expect(response.status).toBe(200);
  expect(f.calls.filter(call => call.kind === 'submitMessage').map(call => (call.input as { body: string }).body)).toEqual(['one', 'two', 'three']);
});
