// Proves: A provider redelivery starts a second agent run, a message whose handling failed is never run, a refused sender is run, or a webhook caller reaches another caller's callback, the platform's own markers or another surface's session.
// Red when: The shared pipeline runs a refused sender or answers a refusal with a failure, a claim (the shared pipeline's or ntfy's own) is kept after a failed handling or dropped after a success, telephony keys spoken turns by call id, or a webhook caller inherits another's callback, sets platform markers or enters another surface's session.
/**
 * What the webhook adapters do when a provider redelivers, a sender is refused,
 * or a caller supplies more than it should: no second run of a message already
 * handled, a retry for one whose handling failed, an acknowledgement (never a
 * failure status) for an ordinary refusal so the provider does not stall its
 * queue redelivering it, and no stale or foreign callback or session.
 *
 * The adapters, their shared delivery claim and the settings (with the secret
 * store their credentials resolve against) are real; the rest of the daemon
 * context around them only records what the adapter asked it to do.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { ntfyInboundDedup, surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import { handleNtfySurfacePayload } from '../platform/src/platform/adapters/ntfy/index.ts';
import { handleWhatsAppSurfaceWebhook } from '../platform/src/platform/adapters/whatsapp/index.ts';
import { handleTelephonySurfaceWebhook } from '../platform/src/platform/adapters/telephony/index.ts';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.ts';
import { scratchSettings } from './_helpers/scratch-settings.ts';

type Call = { kind: string; input: unknown };

const settingsRoots: string[] = [];
afterEach(() => {
  surfaceInboundDedup.clear(); ntfyInboundDedup.clear();
  for (const root of settingsRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function sharedContext(config: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const { root, configManager, secretsManager } = await scratchSettings(config);
  settingsRoots.push(root);
  const bindings = new Map<string, { id: string; metadata: Record<string, unknown> } & Record<string, unknown>>();
  let agents = 0;
  const context = {
    serviceRegistry: { resolveSecret: async () => null },
    configManager,
    secretsManager,
    // Merges metadata over the previous call's, as the real binding manager does.
    routeBindings: {
      upsertBinding: async (input: { surfaceKind: string; externalId: string; metadata?: Record<string, unknown> }) => {
        calls.push({ kind: 'upsertBinding', input });
        const key = `${input.surfaceKind}:${input.externalId}`;
        const previous = bindings.get(key);
        const binding = { ...input, id: previous?.id ?? `binding-${bindings.size + 1}`, metadata: { ...(previous?.metadata ?? {}), ...(input.metadata ?? {}) } };
        bindings.set(key, binding);
        return binding;
      },
    },
    sessionBroker: {
      getSession: () => null,
      submitMessage: async (input: unknown) => {
        calls.push({ kind: 'submitMessage', input });
        return { mode: 'spawn', task: { prompt: 'task' }, session: { id: 'session-1' }, input: { id: 'input-1' } };
      },
      bindAgent: async () => undefined,
    },
    authorizeSurfaceIngress: async (input: unknown) => { calls.push({ kind: 'authorizeSurfaceIngress', input }); return { allowed: true }; },
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => 'ok',
    performInteractiveSurfaceAction: async () => 'ok',
    trySpawnAgent: (input: unknown) => { calls.push({ kind: 'trySpawnAgent', input }); return { id: `agent-${++agents}` }; },
    queueSurfaceReplyFromBinding: () => undefined,
    surfaceDeliveryEnabled: () => true,
    signWebhookPayload: (body: string, secret: string) => `signed:${secret}:${body.length}`,
    queueWebhookReply: (input: unknown) => { calls.push({ kind: 'queueWebhookReply', input }); },
    ...overrides,
  };
  return { calls, bindings, context: context as never };
}

const spawns = (calls: Call[]) => calls.filter((call) => call.kind === 'trySpawnAgent').length;

describe('whatsapp', () => {
  const config = { 'surfaces.whatsapp.provider': 'bridge', 'surfaces.whatsapp.signingSecret': 'wa-token', 'surfaces.whatsapp.phoneNumberId': 'phone-1' };
  const post = (context: never, messages: unknown[]) => handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
    method: 'POST',
    headers: { 'x-goodvibes-whatsapp-token': 'wa-token' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages } }] }] }),
  }), context);

  test('a refused sender in the same payload does not fail it, and a redelivery does not run the allowed message again', async () => {
    const { context, calls } = await sharedContext(config, {
      authorizeSurfaceIngress: async (input: { userId?: string }) => (input.userId === '222' ? { allowed: false, reason: 'user-not-allowlisted' } : { allowed: true }),
    });
    const messages = [{ id: 'wamid.A', from: '111', text: { body: 'hello' } }, { id: 'wamid.B', from: '222', text: { body: 'hello' } }];
    const first = await post(context, messages);
    expect(first.status).toBe(200);
    expect(spawns(calls)).toBe(1);
    const second = await post(context, messages);
    expect(second.status).toBe(200);
    expect(spawns(calls)).toBe(1);
  });

  test('a message whose handling failed is run again on redelivery while the one already handled is not', async () => {
    let spawnCount = 0;
    const { context, calls } = await sharedContext(config, {
      // The second spawn overall (message B on first delivery) is refused.
      trySpawnAgent: (input: unknown) => {
        calls.push({ kind: 'trySpawnAgent', input });
        return ++spawnCount === 2 ? Response.json({ error: 'busy' }, { status: 503 }) : { id: `agent-${spawnCount}` };
      },
    });
    const messages = [{ id: 'wamid.A', from: '111', text: { body: 'one' } }, { id: 'wamid.B', from: '111', text: { body: 'two' } }];
    const first = await post(context, messages);
    expect(first.status).toBe(503);
    expect(spawns(calls)).toBe(2);
    const second = await post(context, messages);
    expect(second.status).toBe(200);
    expect(spawns(calls)).toBe(3);
    const third = await post(context, messages);
    expect(third.status).toBe(200);
    expect(spawns(calls)).toBe(3);
  });
});

test('ntfy: one message that arrives by both routes starts one agent, and one whose start failed is started when it arrives again', async () => {
  const topic = 'gv-agent-fixture-redelivery';
  let refuseNext = false;
  const { context, calls } = await sharedContext({ 'surfaces.ntfy.agentTopic': topic }, {
    sessionBroker: {
      getSession: () => null,
      findPreferredSession: async () => null,
      listSessions: () => [],
      submitMessage: async (input: unknown) => {
        calls.push({ kind: 'submitMessage', input });
        return { mode: 'spawn', task: { prompt: 'task' }, session: { id: 'session-1' }, input: { id: 'input-1' } };
      },
      bindAgent: async () => undefined,
    },
    trySpawnAgent: (input: unknown) => {
      calls.push({ kind: 'trySpawnAgent', input });
      if (refuseNext) { refuseNext = false; return Response.json({ error: 'busy' }, { status: 503 }); }
      return { id: `agent-${spawns(calls)}` };
    },
  });
  const arrive = (id: string) => handleNtfySurfacePayload({ id, topic, event: 'message', message: `message ${id}` }, context);

  // The subscription and the webhook route both hand over n1.
  await arrive('n1');
  await arrive('n1');
  expect(spawns(calls)).toBe(1);

  // n2's first start finds no free agent; its next arrival starts it, and a third does nothing.
  refuseNext = true;
  expect((await arrive('n2')).status).toBe(503);
  await arrive('n2');
  await arrive('n2');
  expect(spawns(calls)).toBe(3);
});

describe('telephony', () => {
  const config = { 'surfaces.telephony.webhookSecret': 'tel', 'surfaces.telephony.fromNumber': '+1555' };
  const send = (context: never, body: Record<string, unknown>) => handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-telephony-token': 'tel' }, body: JSON.stringify(body),
  }), context);

  test('each spoken turn of one call is its own message; a redelivered text message is run once', async () => {
    const { calls, context } = await sharedContext(config);
    await send(context, { From: '+1999', CallSid: 'CA1', SpeechResult: 'first turn' });
    await send(context, { From: '+1999', CallSid: 'CA1', SpeechResult: 'second turn' });
    await send(context, { From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    await send(context, { From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    const submitted = calls.filter((call) => call.kind === 'submitMessage');
    expect(submitted).toHaveLength(3);
    expect(submitted.map((call) => (call.input as { providerMessageId?: string }).providerMessageId)).toEqual([undefined, undefined, 'SM1']);
  });
});

describe('generic webhook', () => {
  const config = { 'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret' };
  const post = (context: never, body: Record<string, unknown>) => handleGenericWebhookSurface(new Request('http://localhost/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': 'hook-secret' }, body: JSON.stringify(body),
  }), context);

  test('a call without a callback does not inherit the callback, correlation or signature of an earlier call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-webhook-callback-'));
    const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
    const binding = () => routeBindings.listBindings().find((entry) => entry.surfaceKind === 'webhook' && entry.externalId === 'webhook')!;
    try {
      const { context } = await sharedContext(config, { routeBindings });
      await post(context, { task: 'X', callbackUrl: 'https://a.example.com/hook', correlationId: 'c1', callbackSignature: 'shared-secret' });
      expect(binding().metadata.callbackUrl).toBe('https://a.example.com/hook');
      await post(context, { task: 'Y' });
      const afterSecond = binding();
      expect(afterSecond.metadata.callbackUrl).toBeUndefined();
      expect(afterSecond.metadata.correlationId).toBeUndefined();
      expect(afterSecond.metadata.callbackSignature).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('platform markers in caller metadata are dropped, and a session from another surface cannot be entered', async () => {
    const { context, calls } = await sharedContext(config, {
      sessionBroker: {
        getSession: (id: string) => (id === 'telegram-session' ? { id, surfaceKinds: ['telegram'] } : null),
        submitMessage: async (input: unknown) => {
          calls.push({ kind: 'submitMessage', input });
          return { mode: 'spawn', task: { prompt: 'task' }, session: { id: 'session-1' }, input: { id: 'input-1' } };
        },
        bindAgent: async () => undefined,
      },
    });
    await post(context, { task: 'X', metadata: { 'goodvibes.workAuthorized': true, note: 'kept' } });
    const submitted = calls.find((call) => call.kind === 'submitMessage')!.input as { metadata: Record<string, unknown> };
    expect(submitted.metadata['goodvibes.workAuthorized']).toBeUndefined();
    const foreign = await post(context, { task: 'X', sessionId: 'telegram-session' });
    expect(foreign.status).toBe(403);
    expect(calls.filter((call) => call.kind === 'submitMessage')).toHaveLength(1);
  });
});
