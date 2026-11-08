import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBotApi } from '../sdk/src/platform/channels/telegram/api.js';
import { TelegramIngressSupervisor } from '../sdk/src/platform/channels/telegram/ingress.js';
import { BuiltinChannelRuntime } from '../sdk/src/platform/channels/builtin-runtime.js';
import { ChannelPluginRegistry } from '../sdk/src/platform/channels/plugin-registry.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { channelBackedPaymentNotifier } from '../sdk/src/platform/payments/host/notifier.js';
import { tryResolvePaymentReplyFromChannel } from '../sdk/src/platform/daemon/payment-reply.js';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/types.js';
import type { ChannelIngressPolicyInput, ChannelPolicyDecision } from '../sdk/src/platform/channels/types.js';
import { withPaymentsReadings } from './helpers/payments-readings.ts';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import {
  createTelegramSourceAccountOwner,
  type TelegramSourceAccountHandle,
  type TelegramSourceAccountOwner,
} from '../sdk/src/platform/channels/telegram/source-account.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const ok = (result: unknown): Response => Response.json({ ok: true, result });
const bot = (id = 123, username = 'verified_bot') => ({ id, username, is_bot: true, first_name: 'Synthetic bot' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
function attach(owner: TelegramSourceAccountOwner, id = '123', username = 'verified_bot') {
  const lifetime = new AbortController();
  const lease = owner.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true, readIdentity: async () => ({ id, username }) });
  return { lifetime, lease };
}
async function snapshot(owner: TelegramSourceAccountOwner) {
  const handle = await owner.reader.acquire();
  expect(handle).not.toBeNull();
  return (await owner.reader.read(handle!))!;
}

describe('strict Telegram getMe provenance', () => {
  test('requires the provider identity and passes the exact lifetime signal', async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    const api = new TelegramBotApi('123:synthetic-secret', async (url, init) => {
      calls.push(url.split('/').pop()!);
      expect(init.signal).toBe(abort.signal);
      return ok(bot());
    });
    expect(await api.getVerifiedIdentity(abort.signal)).toEqual({ id: '123', username: 'verified_bot', displayName: 'Synthetic bot' });
    expect(calls).toEqual(['getMe']);
  });

  test.each([
    { label: 'missing id', result: { username: 'verified_bot', is_bot: true } },
    { label: 'string id', result: { ...bot(), id: '123' } },
    { label: 'non-numeric id', result: { ...bot(), id: 'unknown' } },
    { label: 'zero id', result: bot(0) },
    { label: 'fractional id', result: bot(123.1) },
    { label: 'unsafe id', result: bot(Number.MAX_SAFE_INTEGER + 1) },
    { label: 'mismatched id', result: bot(456) },
    { label: 'empty username', result: bot(123, ' ') },
    { label: 'display name as username', result: bot(123, '@configured alias') },
    { label: 'missing bot proof', result: { id: 123, username: 'verified_bot' } },
    { label: 'human proof', result: { ...bot(), is_bot: false } },
  ])('rejects $label without token-prefix fallback', async ({ result }) => {
    const api = new TelegramBotApi('123:synthetic-secret', async () => ok(result));
    expect(await api.getVerifiedIdentity()).toBeNull();
  });

  test('unknown token prefix cannot establish a verified identity', async () => {
    const api = new TelegramBotApi('unknown:synthetic-secret', async () => ok(bot()));
    expect(await api.getVerifiedIdentity()).toBeNull();
  });
});

describe('opaque session-bound source accounts', () => {
  test('startup acquisition waits for ingress without provider I/O and verifies the first attached session', async () => {
    const owner = createTelegramSourceAccountOwner(), abort = new AbortController();
    if (!owner.reader.acquireWhenAvailable) throw new Error('Missing native startup acquisition');
    let reads = 0, settled = false;
    const pending = owner.reader.acquireWhenAvailable(abort.signal).then(handle => { settled = true; return handle; });
    await Promise.resolve(); expect(settled).toBe(false); expect(reads).toBe(0);
    owner.attach({ lifetime: abort.signal, isCurrent: async () => true, isCurrentSync: () => true,
      readIdentity: async () => { reads++; return { id: '123', username: 'verified_bot' }; } });
    const handle = await pending; if (!handle) throw new Error('Missing original handle');
    expect(await owner.reader.read(handle)).toMatchObject({ id: '123' }); expect(reads).toBe(1);
    abort.abort(); expect(() => owner.reader.assertCurrent(handle)).toThrow();
  });

  test('startup acquisition cannot switch to a same-bot replacement in the attachment await gap', async () => {
    const owner = createTelegramSourceAccountOwner(), abort = new AbortController();
    if (!owner.reader.acquireWhenAvailable) throw new Error('Missing native startup acquisition');
    const pending = owner.reader.acquireWhenAvailable(abort.signal);
    attach(owner); attach(owner);
    expect(await pending).toBeNull();
    // The replacement is usable for a new admission, never for the old wait.
    expect(await owner.reader.acquire()).not.toBeNull(); abort.abort();
  });

  test('cancelled startup acquisition retires its listener and never reads a later attachment', async () => {
    const owner = createTelegramSourceAccountOwner(), abort = new AbortController();
    if (!owner.reader.acquireWhenAvailable) throw new Error('Missing native startup acquisition');
    const pending = owner.reader.acquireWhenAvailable(abort.signal); abort.abort();
    await expect(pending).rejects.toThrow(); let reads = 0;
    owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => true, isCurrentSync: () => true,
      readIdentity: async () => { reads++; return { id: '123', username: 'verified_bot' }; } });
    await Promise.resolve(); expect(reads).toBe(0); owner.invalidate();
  });

  test('installation is lazy, success is cached only inside the current session, and handles do not serialize', async () => {
    const owner = createTelegramSourceAccountOwner(); let reads = 0;
    owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => true, isCurrentSync: () => true,
      readIdentity: async () => { reads++; return { id: '123', username: 'verified_bot' }; } });
    expect(reads).toBe(0); expect(owner.reader.current()).toBeNull();
    const handle = (await owner.reader.acquire())!;
    const account = await owner.reader.read(handle);
    expect(account).toMatchObject({ id: '123', username: 'verified_bot' });
    expect(Object.keys(account!)).toEqual(['id', 'username', 'revision']);
    expect(JSON.stringify(handle)).toBe('{}');
    expect(await owner.reader.read(JSON.parse(JSON.stringify(handle)) as TelegramSourceAccountHandle)).toBeNull();
    expect(await createTelegramSourceAccountOwner().reader.read(handle)).toBeNull();
    expect(() => createTelegramSourceAccountOwner().reader.assertCurrent(handle)).toThrow('unavailable');
    expect(() => owner.reader.assertCurrent(handle)).not.toThrow();
    await owner.reader.acquire(); expect(reads).toBe(1);
  });

  test('same-bot transport replacement preserves revision while A→B→A gets distinct revisions', async () => {
    const owner = createTelegramSourceAccountOwner();
    const first = attach(owner); const handle = (await first.lease.acquire())!;
    const a = (await owner.reader.read(handle))!;
    owner.invalidate(); expect(owner.reader.current()).toBeNull(); expect(await owner.reader.read(handle)).toBeNull();
    expect(() => owner.reader.assertCurrent(handle)).toThrow('unavailable');
    attach(owner); const rotated = await snapshot(owner);
    expect(rotated.revision).toBe(a.revision);
    expect(await first.lease.acquire()).toBeNull();
    attach(owner, '456', 'verified_bot'); const b = await snapshot(owner);
    expect(b.revision).not.toBe(a.revision);
    attach(owner); const backToA = await snapshot(owner);
    expect(backToA.revision).not.toBe(a.revision); expect(backToA.revision).not.toBe(b.revision);
    // An independently retained public value is not erased by admission loss.
    expect(a.id).toBe('123');
  });

  test('a late getMe response cannot revive an invalidated session or replace its successor', async () => {
    const owner = createTelegramSourceAccountOwner(); const gate = deferred<{ id: string; username: string }>();
    const started = deferred<void>();
    const old = owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => true, isCurrentSync: () => true,
      readIdentity: async () => { started.resolve(); return gate.promise; } });
    const pending = old.acquire(); await started.promise;
    attach(owner, '456', 'next_bot'); const replacement = await snapshot(owner);
    gate.resolve({ id: '123', username: 'old_bot' });
    expect(await pending).toBeNull(); expect(owner.reader.current()).toEqual(replacement);
    expect(await old.acquire()).toBeNull();
  });

  test('a post-await credential change prevents snapshot publication and permanently retires the lease', async () => {
    const owner = createTelegramSourceAccountOwner(); let current = true;
    const lease = owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => current, isCurrentSync: () => current,
      readIdentity: async () => { current = false; return { id: '123', username: 'verified_bot' }; } });
    expect(await lease.acquire()).toBeNull(); expect(owner.reader.current()).toBeNull();
    current = true; expect(await lease.acquire()).toBeNull();
  });

  test('read fences in-flight currentness checks against replacement and revoked lifetime', async () => {
    const owner = createTelegramSourceAccountOwner(); const gate = deferred<boolean>();
    let delayed = false;
    const lifetime = new AbortController();
    owner.attach({ lifetime: lifetime.signal, isCurrent: async () => delayed ? gate.promise : true, isCurrentSync: () => true,
      readIdentity: async () => ({ id: '123', username: 'verified_bot' }) });
    const handle = (await owner.reader.acquire())!;
    delayed = true; const pending = owner.reader.read(handle);
    lifetime.abort(); attach(owner, '456', 'next_bot'); const replacement = await snapshot(owner);
    gate.resolve(true); expect(await pending).toBeNull(); expect(owner.reader.current()).toEqual(replacement);
  });

  test.each(['unknown', '', '1.1', '0', '-5', '00123'])('refuses invalid numeric identity %s at the owner boundary', async (id) => {
    const owner = createTelegramSourceAccountOwner(); attach(owner, id);
    expect(await owner.reader.acquire()).toBeNull(); expect(owner.reader.current()).toBeNull();
  });

  test('already-aborted lifetimes and currentness failures never acquire', async () => {
    const owner = createTelegramSourceAccountOwner(); const lifetime = new AbortController(); lifetime.abort(); let reads = 0;
    owner.attach({ lifetime: lifetime.signal, isCurrent: async () => true, isCurrentSync: () => true, readIdentity: async () => { reads++; return null; } });
    expect(await owner.reader.acquire()).toBeNull(); expect(reads).toBe(0);
    owner.attach({ lifetime: new AbortController().signal, isCurrent: async () => { throw new Error('unavailable'); }, isCurrentSync: () => true, readIdentity: async () => { reads++; return null; } });
    expect(await owner.reader.acquire()).toBeNull(); expect(reads).toBe(0);
  });
});

function pollingHarness(options: { readonly secrets?: SecretsManager; readonly registry?: ServiceRegistry; readonly config?: Record<string, unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-source-account-'));
  const owner = createTelegramSourceAccountOwner();
  const config: Record<string, unknown> = { 'surfaces.telegram.enabled': true, 'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123:synthetic-one', 'surfaces.telegram.botUsername': 'configured_stale_bot', ...options.config };
  let registryToken: string | null = null;
  const secretListeners = new Set<(key: string) => void>();
  let result: Record<string, unknown> = bot();
  let pendingIdentity: Promise<Record<string, unknown>> | null = null;
  let registrationResult: unknown = true;
  let pendingRegistration: Promise<unknown> | null = null;
  const registrationStarted = deferred<void>();
  const registrations: Array<{ readonly secret: string; readonly signal: RequestInit['signal'] }> = [];
  const calls: string[] = [];
  const pollOffsets: unknown[] = [];
  const supervisor = new TelegramIngressSupervisor({
    configManager: { get: (key: string) => config[key], set: (key: string, value: unknown) => { config[key] = value; } } as never,
    secretsManager: options.secrets ?? { get: () => null, getGlobalHome: () => undefined,
      resolveLocalSecretSync: () => registryToken === null ? { state: 'absent' } : { state: 'resolved', value: registryToken },
      onDidChange: (listener: (key: string) => void) => { secretListeners.add(listener); return () => { secretListeners.delete(listener); }; },
    } as never,
    serviceRegistry: options.registry ?? { resolveSecret: async () => registryToken,
      get: () => registryToken === null ? null : { name: 'telegram', authType: 'bearer', tokenKey: 'SYNTHETIC_TELEGRAM_TOKEN' },
    } as never,
    offsetFilePath: join(directory, 'offset.json'), telegramSourceAccounts: owner,
    buildSurfaceAdapterContext: () => ({}) as never,
    createApi: (token) => new TelegramBotApi(token, async (url, init) => {
      const method = url.split('/').pop()!; calls.push(method);
      if (method === 'getMe') return ok(pendingIdentity ? await pendingIdentity : result);
      if (method === 'setWebhook') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        registrations.push({ secret: String(body['secret_token'] ?? ''), signal: init.signal });
        registrationStarted.resolve();
        return ok(pendingRegistration ? await pendingRegistration : registrationResult);
      }
      if (method === 'getUpdates') {
        pollOffsets.push((JSON.parse(String(init.body)) as Record<string, unknown>)['offset']);
        return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return ok(true);
    }),
  });
  cleanups.push(async () => { await supervisor.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { owner, supervisor, config, calls, pollOffsets, registrations, directory, registrationStarted: registrationStarted.promise,
    setRegistrationResult: (value: unknown) => { registrationResult = value; },
    setPendingRegistration: (value: Promise<unknown> | null) => { pendingRegistration = value; },
    setIdentity: (value: Record<string, unknown>) => { result = value; },
    setPendingIdentity: (value: Promise<Record<string, unknown>> | null) => { pendingIdentity = value; },
    setRegistryToken: (value: string | null) => { registryToken = value; for (const listener of secretListeners) listener('SYNTHETIC_TELEGRAM_TOKEN'); } };
}

test('actual polling migration verifies the bot, keeps the saved offset and restarts from that offset', async () => {
  const f = pollingHarness(), path = join(f.directory, 'offset.json');
  const original = JSON.stringify({ version: 1, offset: 501, updatedAt: '2026-11-08T12:00:00.000Z' });
  writeFileSync(path, original);
  expect((await f.supervisor.start()).mode).toBe('inactive'); expect(f.pollOffsets).toEqual([]);
  const preview = await f.supervisor.previewCursorMigration(); if (preview.state !== 'unbound') throw new Error();
  expect(preview).toMatchObject({ accountId: '123', username: 'verified_bot', offset: 501 });
  expect(readFileSync(path, 'utf8')).toBe(original);
  // The migration's getMe read establishes only which queue is selected;
  // it cannot manufacture the native ingress account capability.
  expect(f.owner.reader.current()).toBeNull();
  const result = await f.supervisor.commitCursorMigration({ previewId: preview.previewId, confirm: true });
  expect(result).toMatchObject({ state: 'migrated', accountId: '123', offset: 501, running: true });
  expect(f.pollOffsets).toEqual([501]);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, accounts: [{ accountId: '123', offset: 501 }] });
});

test('a changed actual bot credential cannot adopt an older cursor preview', async () => {
  const f = pollingHarness(), path = join(f.directory, 'offset.json');
  const original = JSON.stringify({ version: 1, offset: 501, updatedAt: '2026-11-08T12:00:00.000Z' }); writeFileSync(path, original);
  await f.supervisor.start();
  const preview = await f.supervisor.previewCursorMigration(); if (preview.state !== 'unbound') throw new Error();
  f.config['surfaces.telegram.botToken'] = '456:replacement-credential';
  await expect(f.supervisor.commitCursorMigration({ previewId: preview.previewId, confirm: true })).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe(original); expect(f.pollOffsets).toEqual([]);
});

function localCredentials() {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-local-credentials-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const secrets = new SecretsManager({ projectRoot: join(directory, 'project'), globalHome: join(directory, 'home'),
    surfaceRoot: 'synthetic-fixture', policy: 'plaintext_allowed' });
  const registryPath = join(directory, 'services.json');
  const registry = new ServiceRegistry(registryPath, { secretsManager: secrets, subscriptionManager: {} as never });
  return { secrets, registry, registryPath };
}

describe('acknowledged webhook source ownership', () => {
  const webhookConfig = { 'surfaces.telegram.mode': 'webhook', 'web.publicBaseUrl': 'https://synthetic.example',
    'surfaces.telegram.webhookSecret': 'configured-compatibility-secret' };

  test('actual registration acknowledgement gates the built-in HTTP route through native receipt correlation', async () => {
    await withPaymentsReadings({}, async requests => {
      const f = pollingHarness({ config: webhookConfig }), gate = deferred<unknown>();
      cleanups.push(() => gate.resolve(true)); f.setPendingRegistration(gate.promise);
      const inbox = new PaymentReplyInbox(); cleanups.push(() => inbox.close());
      const notifier = channelBackedPaymentNotifier({ get: () => 'telegram' }, {
        async deliver() { throw new Error('No duplicate notice'); },
        async deliverWithReceipt() { return { receipt: { surfaceKind: 'telegram', conversationId: '-100123',
          threadId: '7', messageId: '51', accountId: '123' } }; },
      }, inbox);
      if (!notifier.prepareWindow) throw new Error('Missing native reply preparation');
      const prepared = notifier.prepareWindow({ purchaseId: 'registered-purchase', kind: 'approval', notice: 'Approve the original purchase?' });
      await prepared.deliveries; const waiting = prepared.awaitAnswer(Date.now() + 60_000);
      const decision = { allowed: true, reason: 'owner', policy: { allowlistUserIds: ['42'] } } as unknown as ChannelPolicyDecision;
      let admissions = 0;
      const context = {
        configManager: { get: (key: string) => f.config[key] }, serviceRegistry: { resolveSecret: async () => null },
        hasPaymentReplyWindow: () => inbox.pending > 0,
        async authorizeSurfaceIngress(input: ChannelIngressPolicyInput) {
          admissions++;
          const result = await tryResolvePaymentReplyFromChannel(input, decision, inbox, f.owner.reader);
          return { ...decision, allowed: false, reason: result.consumed ? `payment-reply-${result.answer}` : 'no-payment-reply' };
        },
      } as unknown as SurfaceAdapterContext;
      const plugins = new ChannelPluginRegistry();
      new BuiltinChannelRuntime({ configManager: context.configManager, channelPlugins: plugins, telegramSourceAccounts: f.owner,
        buildSurfaceAdapterContext: () => context } as never).registerPlugins();
      const starting = f.supervisor.start(); await f.registrationStarted;
      const registration = f.registrations[0]; if (!registration) throw new Error('Missing provider registration');
      const reply = () => new Request('https://synthetic.example/webhook/telegram', { method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': registration.secret },
        body: JSON.stringify({ update_id: 81, message: { message_id: 52, message_thread_id: 7, from: { id: 42 },
          chat: { id: -100123, type: 'supergroup' }, reply_to_message: { message_id: 51 }, text: 'yes' } }),
      });
      expect((await plugins.handleInbound('/webhook/telegram', reply()))?.status).toBe(401);
      expect(admissions).toBe(0); expect(requests).toEqual([]);
      gate.resolve(true); expect((await starting).mode).toBe('webhook');
      const response = await plugins.handleInbound('/webhook/telegram', reply());
      expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ consumed: true, outcome: 'payment-reply' });
      expect(await waiting).toEqual({ answer: 'approve', channel: 'telegram' });
      expect(admissions).toBe(1); expect(requests).toHaveLength(1);
      expect(f.calls.filter(method => method === 'getMe')).toHaveLength(1);
    });
  });

  test('only the original registration credential authorizes a lazy verified bot session', async () => {
    const f = pollingHarness({ config: webhookConfig });
    expect((await f.supervisor.start()).mode).toBe('webhook');
    const registration = f.registrations[0]; if (!registration) throw new Error('Missing provider registration');
    expect(registration.secret).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    expect(registration.secret).not.toBe(webhookConfig['surfaces.telegram.webhookSecret']);
    expect(f.config['surfaces.telegram.webhookSecret']).toBe(webhookConfig['surfaces.telegram.webhookSecret']);
    expect(f.owner.authorizeWebhook?.('configured-compatibility-secret')).toBeNull();
    expect(f.owner.authorizeWebhook?.('123:synthetic-one')).toBeNull();
    expect(f.owner.authorizeWebhook?.('123')).toBeNull();
    expect(f.calls).toEqual(['setWebhook']);
    const lease = f.owner.authorizeWebhook?.(registration.secret); expect(lease).toBeTruthy();
    const handle = await lease?.acquire(); expect(handle).toBeTruthy();
    expect(await f.owner.reader.read(handle!)).toMatchObject({ id: '123', username: 'verified_bot' });
    expect(f.calls).toEqual(['setWebhook', 'getMe']);
    expect(JSON.stringify(f.owner.reader.current())).not.toContain(registration.secret);
    await f.supervisor.stop();
    expect(registration.signal?.aborted).toBe(true);
    expect(f.owner.authorizeWebhook?.(registration.secret)).toBeNull();
    expect(() => lease?.assertCurrent()).toThrow('unavailable');
    expect(await lease?.acquire()).toBeNull();
    await f.supervisor.start();
    const next = f.registrations[1]; if (!next) throw new Error('Missing replacement registration');
    expect(next.secret).not.toBe(registration.secret);
    expect(f.owner.authorizeWebhook?.(registration.secret)).toBeNull();
    expect(f.owner.authorizeWebhook?.(next.secret)).toBeTruthy();
    expect(await f.owner.reader.read(handle!)).toBeNull();
  });

  test.each([false, null, 'true', {}])('unconfirmed setWebhook result %j never publishes proof', async result => {
    const f = pollingHarness({ config: webhookConfig }); f.setRegistrationResult(result);
    expect((await f.supervisor.start()).mode).toBe('inactive');
    const registration = f.registrations[0]; if (!registration) throw new Error('Missing attempted registration');
    expect(f.owner.authorizeWebhook?.(registration.secret)).toBeNull();
    expect(await f.owner.reader.acquire()).toBeNull();
    expect(f.supervisor.status.reason).not.toContain(registration.secret);
    expect(registration.signal?.aborted).toBe(true);
  });

  test('an embedder without a local credential owner keeps configured-secret ingress without native proof', async () => {
    const f = pollingHarness({ config: webhookConfig, secrets: { get: () => null, getGlobalHome: () => undefined } as never });
    expect((await f.supervisor.start()).mode).toBe('webhook');
    expect(f.registrations[0]?.secret).toBe('configured-compatibility-secret');
    expect(f.owner.authorizeWebhook?.('configured-compatibility-secret')).toBeNull();
    expect(await f.owner.reader.acquire()).toBeNull(); expect(f.calls).toEqual(['setWebhook']);
  });

  test('stop owns an uncooperative registration request until it settles; its late acknowledgement cannot publish', async () => {
    const f = pollingHarness({ config: webhookConfig }), gate = deferred<unknown>();
    cleanups.push(() => gate.resolve(true));
    f.setPendingRegistration(gate.promise);
    const starting = f.supervisor.start(); await f.registrationStarted;
    const registration = f.registrations[0]; if (!registration) throw new Error('Missing attempted registration');
    expect(f.owner.authorizeWebhook?.(registration.secret)).toBeNull();
    let drained = false; const stopping = f.supervisor.stop().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(registration.signal?.aborted).toBe(true);
    gate.resolve(true); await starting; await stopping;
    expect(drained).toBe(true); expect(f.owner.authorizeWebhook?.(registration.secret)).toBeNull();
    expect(await f.owner.reader.acquire()).toBeNull(); expect(f.supervisor.status.mode).not.toBe('webhook');
  });

  test('credential rotation before registration acknowledgement cannot attach the old account', async () => {
    const f = pollingHarness({ config: webhookConfig }), gate = deferred<unknown>();
    cleanups.push(() => gate.resolve(true)); f.setPendingRegistration(gate.promise);
    const starting = f.supervisor.start(); await f.registrationStarted;
    f.setRegistryToken('456:synthetic-replacement'); gate.resolve(true);
    expect((await starting).mode).toBe('inactive');
    const registration = f.registrations[0]; if (!registration) throw new Error('Missing attempted registration');
    expect(f.owner.authorizeWebhook?.(registration.secret)).toBeNull();
    expect(await f.owner.reader.acquire()).toBeNull();
    expect(registration.signal?.aborted).toBe(true); expect(f.calls).toEqual(['setWebhook']);
  });

  test.each(['url', 'mode', 'token', 'disabled'] as const)('a changed original %s permanently retires the webhook lease', async change => {
    const f = pollingHarness({ config: webhookConfig }); await f.supervisor.start();
    const registration = f.registrations[0]; if (!registration) throw new Error('Missing registration');
    const lease = f.owner.authorizeWebhook?.(registration.secret); expect(lease).toBeTruthy();
    const handle = await lease?.acquire(); expect(handle).toBeTruthy();
    if (change === 'url') f.config['web.publicBaseUrl'] = 'https://different.example';
    else if (change === 'mode') f.config['surfaces.telegram.mode'] = 'polling';
    else if (change === 'token') f.config['surfaces.telegram.botToken'] = '456:synthetic-two';
    else f.config['surfaces.telegram.enabled'] = false;
    expect(() => lease?.assertCurrent()).toThrow('unavailable');
    expect(f.owner.authorizeWebhook?.(registration.secret)).toBeNull();
    expect(await f.owner.reader.read(handle!)).toBeNull();
  });
});

describe('real polling supervisor provenance wiring', () => {
  test('unrelated local secret edits preserve proof; real same-bot rotation re-verifies after ordinary restart', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-one');
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    const original = await f.owner.reader.read(handle);
    await local.secrets.set('SYNTHETIC_UNRELATED_API_KEY', 'synthetic-unrelated');
    expect(f.owner.reader.assertCurrent(handle)).toEqual(original!);
    expect(await f.owner.reader.read(handle)).toEqual(original);
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(1);
    await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-rotated');
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
    await f.supervisor.start(); const replacement = await snapshot(f.owner);
    expect(replacement.revision).toBe(original!.revision);
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(2);
  });

  test('a real local-secret write after read is fenced synchronously before capture', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-one');
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    const changing = local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '456:synthetic-two');
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
    await changing; expect(f.owner.reader.current()).toBeNull();
  });

  test('an actual registry-file rewrite after read cannot reuse the verified old account', async () => {
    const local = localCredentials();
    await local.secrets.set('SYNTHETIC_TELEGRAM_A', '123:synthetic-one');
    await local.secrets.set('SYNTHETIC_TELEGRAM_B', '456:synthetic-two');
    const setRegistry = (tokenKey: string) => writeFileSync(local.registryPath, JSON.stringify({ telegram: { name: 'telegram', authType: 'bearer', tokenKey } }));
    setRegistry('SYNTHETIC_TELEGRAM_A'); const f = pollingHarness(local);
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    setRegistry('SYNTHETIC_TELEGRAM_B');
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
  });

  test('an out-of-band local secret-store edit after read is caught without a change notification', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', '123:synthetic-one');
    const record = (await local.secrets.listDetailed()).find(value => value.key === 'SYNTHETIC_TELEGRAM_TOKEN')!;
    expect(record.secure).toBe(false);
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    writeFileSync(record.path!, JSON.stringify({ SYNTHETIC_TELEGRAM_TOKEN: '456:synthetic-two' }));
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
  });

  test('environment rotation after read is fenced before returning an identity snapshot', async () => {
    const key = 'SYNTHETIC_TELEGRAM_SYNC_TOKEN'; const previous = process.env[key];
    process.env[key] = '123:synthetic-one';
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    const f = pollingHarness({ config: { 'surfaces.telegram.botToken': { source: 'env', id: key } } });
    await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    expect(await f.owner.reader.read(handle)).toMatchObject({ id: '123' });
    expect(f.owner.reader.assertCurrent(handle)).toMatchObject({ id: '123' });
    process.env[key] = '456:synthetic-two';
    expect(() => f.owner.reader.assertCurrent(handle)).toThrow('unavailable');
  });

  test('nested local secret references remain unsupported for selected intake', async () => {
    const local = localCredentials(); await local.secrets.set('SYNTHETIC_TELEGRAM_TOKEN', 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_INNER');
    await local.secrets.set('SYNTHETIC_TELEGRAM_INNER', '123:synthetic-one');
    const f = pollingHarness({ ...local, config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/SYNTHETIC_TELEGRAM_TOKEN' } });
    await f.supervisor.start(); expect(await f.owner.reader.acquire()).toBeNull();
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(0);
  });

  test.each([
    { source: 'file', path: '/synthetic/not-read-by-this-test' },
    { source: 'exec', command: 'synthetic-never-executed', args: [] },
    { source: '1password', ref: 'op://synthetic/bot/token' },
    { source: 'vaultwarden', item: 'synthetic-item', field: 'password' },
    { source: 'bws', id: 'synthetic-id' },
  ])('external $source registry refs cannot qualify selected admission', async (tokenRef) => {
    // The legacy resolver is explicitly injected; this never reads the file,
    // launches a command, or contacts any external credential backend.
    const f = pollingHarness({ registry: {
      get: () => ({ name: 'telegram', authType: 'bearer', tokenKey: '', tokenRef }),
      resolveSecret: async () => '123:synthetic-one',
    } as never });
    await f.supervisor.start(); expect(await f.owner.reader.acquire()).toBeNull();
    expect(f.calls.filter(method => method === 'getMe')).toHaveLength(0);
  });

  test('local synchronous resolver preserves env precedence and refuses stored or env references', async () => {
    const local = localCredentials(); const key = 'SYNTHETIC_LOCAL_RESOLVER_KEY'; const previous = process.env[key];
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    delete process.env[key];
    await local.secrets.set(key, 'stored-synthetic');
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'resolved', value: 'stored-synthetic' });
    process.env[key] = 'environment-synthetic';
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'resolved', value: 'environment-synthetic' });
    process.env[key] = 'goodvibes://secrets/goodvibes/SYNTHETIC_OTHER';
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'unsupported' });
    delete process.env[key];
    await local.secrets.set(key, 'op://synthetic/item/password');
    expect(local.secrets.resolveLocalSecretSync(key)).toEqual({ state: 'unsupported' });
    expect(local.secrets.resolveLocalSecretSync('SYNTHETIC_MISSING_KEY')).toEqual({ state: 'absent' });
  });

  test('configured stale username cannot substitute for actual getMe and installing the seam adds no call', async () => {
    const f = pollingHarness(); await f.supervisor.start();
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(0);
    const account = await snapshot(f.owner);
    expect(account).toMatchObject({ id: '123', username: 'verified_bot' });
    expect(f.config['surfaces.telegram.botUsername']).toBe('configured_stale_bot');
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
    await snapshot(f.owner); expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
    const publicData = JSON.stringify({ account, current: f.owner.reader.current() });
    expect(publicData).not.toContain('synthetic-one'); expect(publicData).not.toContain('123:');
  });

  test('a different-bot secret rotation with unchanged config username is held until new verified session', async () => {
    const f = pollingHarness(); await f.supervisor.start(); const a = await snapshot(f.owner);
    f.setRegistryToken('456:synthetic-two'); f.setIdentity(bot(456, 'new_bot'));
    expect(await f.owner.reader.acquire()).toBeNull();
    await f.supervisor.start(); const b = await snapshot(f.owner);
    expect(b).toMatchObject({ id: '456', username: 'new_bot' }); expect(b.revision).not.toBe(a.revision);
    expect(f.config['surfaces.telegram.botUsername']).toBe('configured_stale_bot');
  });

  test('same-bot token rotation reacquires proof with the original account revision', async () => {
    const f = pollingHarness(); await f.supervisor.start(); const a = await snapshot(f.owner);
    f.setRegistryToken('123:synthetic-rotated'); expect(await f.owner.reader.acquire()).toBeNull();
    await f.supervisor.start(); const rotated = await snapshot(f.owner);
    expect(rotated.revision).toBe(a.revision); expect(f.calls.filter(x => x === 'getMe')).toHaveLength(2);
  });

  test('a stale actual getMe response cannot relabel the replacement polling session', async () => {
    const f = pollingHarness(); await f.supervisor.start();
    const gate = deferred<Record<string, unknown>>(); f.setPendingIdentity(gate.promise);
    const old = f.owner.reader.acquire();
    for (let i = 0; i < 30 && !f.calls.includes('getMe'); i++) await Promise.resolve();
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
    await f.supervisor.stop(); f.setPendingIdentity(null);
    f.config['surfaces.telegram.botToken'] = '456:synthetic-two'; f.setIdentity(bot(456, 'replacement_bot'));
    await f.supervisor.start(); const replacement = await snapshot(f.owner);
    gate.resolve(bot(123, 'stale_bot'));
    expect(await old).toBeNull(); expect(f.owner.reader.current()).toEqual(replacement);
    expect(replacement.id).toBe('456');
  });

  test('stop immediately revokes polling handles; acknowledged webhook registers a distinct lazy session', async () => {
    const f = pollingHarness(); await f.supervisor.start(); const handle = (await f.owner.reader.acquire())!;
    const stopping = f.supervisor.stop(); expect(f.owner.reader.current()).toBeNull();
    expect(await f.owner.reader.read(handle)).toBeNull(); await stopping;
    f.config['surfaces.telegram.mode'] = 'webhook'; f.config['web.publicBaseUrl'] = 'https://synthetic.example';
    await f.supervisor.start();
    expect(f.owner.reader.current()).toBeNull();
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(1);
    const registered = f.registrations[0]; if (!registered) throw new Error('Missing provider registration');
    const lease = f.owner.authorizeWebhook?.(registered.secret);
    expect(lease).toBeTruthy();
    const webhookHandle = await lease?.acquire();
    expect(webhookHandle).toBeTruthy();
    expect(await f.owner.reader.read(webhookHandle!)).toMatchObject({ id: '123' });
    expect(await f.owner.reader.read(handle)).toBeNull();
    expect(f.calls.filter(x => x === 'getMe')).toHaveLength(2);
  });

  test.each(['disabled', 'mode', 'identity unavailable'] as const)('%s refuses new source admission', async (change) => {
    const f = pollingHarness(); await f.supervisor.start();
    if (change === 'disabled') f.config['surfaces.telegram.enabled'] = false;
    else if (change === 'mode') f.config['surfaces.telegram.mode'] = 'webhook';
    else f.setIdentity({ username: 'unverified', is_bot: true });
    expect(await f.owner.reader.acquire()).toBeNull();
  });

  test('builtin config watcher invalidates before its debounced restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-source-watch-'));
    const owner = createTelegramSourceAccountOwner(); const callbacks = new Map<string, () => void>();
    const runtime = new BuiltinChannelRuntime({ telegramSourceAccounts: owner, telegramOffsetPath: join(directory, 'offset.json'),
      configManager: { get: (key: string) => key === 'surfaces.telegram.botToken' ? '123:synthetic-one' : undefined,
        subscribe: (key: string, callback: () => void) => { callbacks.set(key, callback); return () => callbacks.delete(key); } },
      secretsManager: { get: () => null, getGlobalHome: () => undefined }, serviceRegistry: { resolveSecret: async () => null },
    } as never);
    cleanups.push(async () => { await runtime.stopIngress(); rmSync(directory, { recursive: true, force: true }); });
    await runtime.startIngress(); attach(owner); await snapshot(owner);
    callbacks.get('surfaces.telegram.botToken')!(); expect(owner.reader.current()).toBeNull();
    expect(await owner.reader.acquire()).toBeNull();
  });
});
