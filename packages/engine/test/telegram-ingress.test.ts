/**
 * telegram-ingress.test.ts, inbound Telegram actually works.
 *
 * Background this pins down: registering `POST /webhook/telegram` does not give
 * a daemon inbound Telegram. Telegram pushes nothing until told a webhook URL
 * exists, and delivers nothing until asked via getUpdates. With neither call
 * wired up, a configured bot token produced a surface that could send but never
 * receive, which looked half-working rather than broken.
 *
 * These tests drive the supervisor through an injected fetch, so they assert
 * the real decisions (which Bot API methods get called, in what order, and what
 * happens on 409/401) without touching the network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramIngressSupervisor, describeWebhookUrlProblem, type TelegramIngressStatus } from '../platform/src/platform/channels/telegram/ingress.ts';
import { observeTelegramRuntime } from '../platform/src/platform/channels/builtin/health.ts';
import { resolveChannelHealthState } from '../platform/src/platform/channels/health.ts';
import { TelegramApiError, TelegramBotApi } from '../platform/src/platform/channels/telegram/api.ts';
import { TelegramOffsetStore } from '../platform/src/platform/channels/telegram/offset-store.ts';
import { PaymentReplyHistoryError } from '../platform/src/platform/payments/reply-history.js';

// ── fakes ───────────────────────────────────────────────────────────────────

interface ApiCall { readonly method: string; readonly body: Record<string, unknown>; readonly signal: AbortSignal | null | undefined; }

/** Queued Bot API responses; once drained, getUpdates long-polls until aborted. */
class FakeTelegram {
  readonly calls: ApiCall[] = [];
  private readonly queues = new Map<string, Array<() => Response | Promise<Response>>>();

  queue(method: string, ...responses: Array<() => Response | Promise<Response>>): void {
    const existing = this.queues.get(method) ?? [];
    this.queues.set(method, [...existing, ...responses]);
  }

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = input.split('/').pop() ?? '';
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    this.calls.push({ method, body, signal: init.signal });

    const next = this.queues.get(method)?.shift();
    if (next) return next();

    if (method === 'getWebhookInfo') return ok({ url: '', pending_update_count: 0 });

    if (method === 'getUpdates') {
      // Model Telegram's hold-open long poll: never resolve on its own, so the
      // loop cannot spin, and reject when the supervisor aborts on shutdown.
      const signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    return ok(true);
  };
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function apiError(code: number, description: string, retryAfter?: number): Response {
  return new Response(JSON.stringify({
    ok: false,
    error_code: code,
    description,
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  }), { status: code });
}

function textUpdate(updateId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: { chat: { id: 4242, type: 'private' }, from: { id: 7, username: 'avery' }, text },
  };
}

interface Harness {
  readonly supervisor: TelegramIngressSupervisor;
  readonly telegram: FakeTelegram;
  readonly spawned: string[];
  /** Every reason handed to onConcurrentConsumerConflict, in order. */
  readonly conflicts: string[];
  readonly offsetPath: string;
  /** Live settings, so a test can change config and re-decide the mode. */
  readonly config: Record<string, unknown>;
  cleanup(): void;
}

function makeHarness(options: {
  readonly ingressFailure?: Error;
  readonly config?: Record<string, unknown>;
  readonly secrets?: Record<string, string>;
  readonly registrySecret?: string | null;
  /**
   * The conflict-retry jitter fraction. Defaults to 0 so a test waits for the
   * backoff floor and nothing else, the production default is `Math.random`,
   * and a test that has to wait out an unobservable five-second draw is
   * rolling dice rather than asserting recovery.
   */
  readonly conflictJitterFraction?: () => number;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gv-tg-'));
  const offsetPath = join(dir, 'telegram-offset.json');
  const telegram = new FakeTelegram();
  const spawned: string[] = [];
  const conflicts: string[] = [];

  const config: Record<string, unknown> = {
    'surfaces.telegram.enabled': true,
    'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123456:test-token',
    'surfaces.telegram.botUsername': 'goodvibes_bot',
    'web.publicBaseUrl': 'https://daemon.example.com',
    ...options.config,
  };

  const supervisor = new TelegramIngressSupervisor({
    configManager: { get: (key: string) => config[key] } as never,
    secretsManager: {
      get: (key: string) => options.secrets?.[key] ?? null,
      getGlobalHome: () => undefined,
    } as never,
    serviceRegistry: { resolveSecret: async () => options.registrySecret ?? null } as never,
    offsetFilePath: offsetPath,
    createApi: (token) => new TelegramBotApi(token, telegram.fetch),
    onConcurrentConsumerConflict: (detail) => { conflicts.push(detail); },
    conflictJitterFraction: options.conflictJitterFraction ?? ((): number => 0),
    buildSurfaceAdapterContext: () => ({
      serviceRegistry: { resolveSecret: async () => null },
      configManager: { get: (key: string) => config[key] },
      routeBindings: { upsertBinding: async () => ({ id: 'binding-1', surfaceId: 'goodvibes_bot', externalId: '4242', channelId: '4242', threadId: undefined, title: 'Avery' }) },
      sessionBroker: {
        submitMessage: async () => ({ mode: 'spawn', task: { prompt: 'x' }, session: { id: 'session-1' } }),
        bindAgent: async () => { /* no-op */ },
      },
      authorizeSurfaceIngress: async () => { if (options.ingressFailure) throw options.ingressFailure; return { allowed: true }; },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      trySpawnAgent: (input: { task: unknown }) => {
        spawned.push(JSON.stringify(input.task));
        return { id: `agent-${spawned.length}` };
      },
      queueSurfaceReplyFromBinding: () => { /* no-op */ },
    }) as never,
  });

  return {
    supervisor,
    telegram,
    spawned,
    conflicts,
    offsetPath,
    config,
    cleanup(): void { rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Per-test budget for this file.
 *
 * Every test here drives a real supervisor through polling intervals and waits
 * on `waitFor`, whose own ceiling is 10s (30s for the blocked-webhook case).
 * Bun's default per-test timeout is 5s, so those ceilings could never be
 * reached: under parallel full-suite load the runner killed the test before its
 * own deadline, and the failure read as a product bug rather than as the budget
 * mismatch it was. The budget is set above the largest ceiling so a failure here
 * means the behaviour did not happen, not that the machine was busy.
 */
const TEST_BUDGET_MS = 45_000;

async function waitFor(predicate: () => boolean, label: string, ceilingMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > ceilingMs) throw new Error(`telegram ingress: ${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── mode selection ──────────────────────────────────────────────────────────

describe('telegram ingress: mode selection is explicit and exclusive', () => {
  test('an unsaved payment reply stops the real poller before confirming its original update cursor', async () => {
    const h = makeHarness({ ingressFailure: new PaymentReplyHistoryError() });
    new TelegramOffsetStore(h.offsetPath, '123456').retainPolling().save(500);
    const bytes = readFileSync(h.offsetPath);
    h.telegram.queue('getUpdates', () => ok([textUpdate(500, 'Do not buy the original item.')]));
    try {
      await h.supervisor.start(); await waitFor(() => h.supervisor.status.mode === 'inactive', 'payment archive failure');
      expect(h.supervisor.status.running).toBe(false); expect(h.supervisor.status.reason).toContain('before confirming its cursor');
      expect(h.telegram.calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
      expect(h.telegram.calls.find(call => call.method === 'getUpdates')?.body.offset).toBe(500);
      expect(readFileSync(h.offsetPath)).toEqual(bytes); expect(new TelegramOffsetStore(h.offsetPath, '123456').load()).toEqual({ mode: 'resume', offset: 500 });
      expect(h.spawned).toEqual([]);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('polling mode clears any registered webhook before polling, and never registers one', async () => {
    const h = makeHarness();
    h.telegram.queue('getWebhookInfo', () => ok({ url: 'https://older-deployment.example/webhook/telegram', pending_update_count: 3 }));
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('polling');
      expect(status.running).toBe(true);

      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');

      // Mutual exclusion, enforced rather than assumed: Telegram answers
      // getUpdates with 409 while a webhook is registered, so polling must
      // delete it first, and must never register one itself.
      const methods = h.telegram.calls.map((call) => call.method);
      // Observe prior webhook custody before clearing it, then poll only
      // after Telegram acknowledges removal. The retained queue is untouched.
      expect(methods.slice(0, 3)).toEqual(['getWebhookInfo', 'deleteWebhook', 'getUpdates']);
      expect(methods).toContain('getUpdates');
      expect(methods).not.toContain('setWebhook');
      // Queued updates are handed to the poller, not discarded.
      expect(h.telegram.calls.find(call => call.method === 'deleteWebhook')?.body.drop_pending_updates).toBe(false);
    } finally {
      await h.supervisor.stop();
      h.cleanup();
    }
  }, TEST_BUDGET_MS);

  test('webhook mode registers the URL with the secret token and never polls', async () => {
    const h = makeHarness({
      config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 'shared-secret' },
    });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('webhook');
      // No loop at all in webhook mode, the other half of mutual exclusion.
      expect(status.running).toBe(false);

      const setWebhook = h.telegram.calls.find((call) => call.method === 'setWebhook');
      expect(setWebhook?.body.url).toBe('https://daemon.example.com/webhook/telegram');
      // Satisfies the x-telegram-bot-api-secret-token check in the handler.
      expect(setWebhook?.body.secret_token).toBe('shared-secret');

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(h.telegram.countOf('getUpdates')).toBe(0);
    } finally {
      await h.supervisor.stop();
      h.cleanup();
    }
  }, TEST_BUDGET_MS);

  test('webhook mode refuses a URL Telegram cannot reach, and says what to do', async () => {
    const h = makeHarness({
      config: { 'surfaces.telegram.mode': 'webhook', 'web.publicBaseUrl': 'http://127.0.0.1:3423' },
    });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('inactive');
      expect(status.reason).toContain('mode=polling');
      // Registering a webhook Telegram can never deliver to is worse than not
      // registering one: it looks configured and silently receives nothing.
      expect(h.telegram.countOf('setWebhook')).toBe(0);
    } finally {
      await h.supervisor.stop();
      h.cleanup();
    }
  }, TEST_BUDGET_MS);

  test('rejects loopback, private, and plain-HTTP base URLs', () => {
    expect(describeWebhookUrlProblem('https://daemon.example.com')).toBeNull();
    expect(describeWebhookUrlProblem('')).toContain('no public base URL');
    expect(describeWebhookUrlProblem('http://daemon.example.com')).toContain('HTTPS');
    expect(describeWebhookUrlProblem('https://127.0.0.1:3423')).toContain('cannot reach');
    expect(describeWebhookUrlProblem('https://192.168.1.10')).toContain('cannot reach');
    expect(describeWebhookUrlProblem('https://box.local')).toContain('cannot reach');
    expect(describeWebhookUrlProblem('https://127.attacker.example')).toBeNull();
    expect(describeWebhookUrlProblem('https://[::ffff:127.0.0.1]')).toContain('cannot reach');
  }, TEST_BUDGET_MS);
});

// ── reconfiguration ─────────────────────────────────────────────────────────

describe('telegram ingress: reconfiguration leaves no state behind', () => {
  test('switching webhook to polling swaps modes without leaving both armed', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 'shared-secret' } });
    try {
      expect((await h.supervisor.start()).mode).toBe('webhook');
      expect(h.telegram.countOf('setWebhook')).toBe(1);

      h.config['surfaces.telegram.mode'] = 'polling';
      const status = await h.supervisor.start();

      expect(status.mode).toBe('polling');
      expect(status.running).toBe(true);
      // The webhook registered a moment ago is retracted, so getUpdates is not
      // permanently blocked by the previous mode.
      expect(h.telegram.countOf('deleteWebhook')).toBeGreaterThanOrEqual(1);
      expect(h.telegram.countOf('setWebhook')).toBe(1);
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'polling after the switch');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('disabling the surface retracts the webhook this deployment registered', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 'shared-secret' } });
    try {
      await h.supervisor.start();
      h.telegram.queue('getWebhookInfo', () => ok({ url: 'https://daemon.example.com/webhook/telegram', pending_update_count: 0 }));

      h.config['surfaces.telegram.enabled'] = false;
      const status = await h.supervisor.start();

      expect(status.mode).toBe('inactive');
      // Telegram keeps pushing to a registered URL forever otherwise.
      expect(h.telegram.countOf('deleteWebhook')).toBe(1);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  for (const heldMethod of ['getWebhookInfo', 'deleteWebhook'] as const) {
    test(`a new webhook setup waits for an older disable ${heldMethod} and cannot be deleted or overwritten by it`, async () => {
      const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 'shared-secret' } });
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let disabling: Promise<unknown> | undefined, restarting: Promise<unknown> | undefined;
      try {
        await h.supervisor.start();
        const ownStatus = () => ok({ url: 'https://daemon.example.com/webhook/telegram', pending_update_count: 2 });
        if (heldMethod === 'deleteWebhook') h.telegram.queue('getWebhookInfo', ownStatus);
        h.telegram.queue(heldMethod, async () => {
          entered.resolve(); await release.promise; // Deliberately ignores abort.
          return heldMethod === 'getWebhookInfo' ? ownStatus() : ok(true);
        });
        h.config['surfaces.telegram.enabled'] = false;
        disabling = h.supervisor.start(); await entered.promise;
        h.config['surfaces.telegram.enabled'] = true;
        let restarted = false;
        restarting = h.supervisor.start().then(status => { restarted = true; return status; });
        await Promise.resolve(); await Promise.resolve();
        expect(h.telegram.calls.filter(call => call.method === heldMethod).at(-1)?.signal?.aborted).toBe(true);
        expect(restarted).toBe(false); expect(h.telegram.countOf('setWebhook')).toBe(1);
        release.resolve(); await disabling;
        expect(await restarting).toMatchObject({ mode: 'webhook', running: false });
        expect(h.supervisor.status.mode).toBe('webhook'); expect(h.telegram.countOf('setWebhook')).toBe(2);
        expect(h.telegram.countOf('deleteWebhook')).toBe(heldMethod === 'deleteWebhook' ? 1 : 0);
        expect(h.telegram.calls.filter(call => call.method === 'deleteWebhook').every(call => call.body.drop_pending_updates === false)).toBe(true);
      } finally {
        release.resolve(); await Promise.allSettled([disabling, restarting]);
        await h.supervisor.stop(); h.cleanup();
      }
    }, TEST_BUDGET_MS);
  }

  test('stop owns an older disabled webhook query until its ignored cancellation actually drains', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 'shared-secret' } });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let disabling: Promise<unknown> | undefined, stopping: Promise<unknown> | undefined;
    try {
      await h.supervisor.start();
      h.telegram.queue('getWebhookInfo', async () => {
        entered.resolve(); await release.promise;
        return ok({ url: 'https://daemon.example.com/webhook/telegram', pending_update_count: 2 });
      });
      h.config['surfaces.telegram.enabled'] = false;
      disabling = h.supervisor.start(); await entered.promise;
      let drained = false;
      stopping = h.supervisor.stop().then(() => { drained = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(drained).toBe(false); expect(h.telegram.calls.at(-1)?.signal?.aborted).toBe(true);
      release.resolve(); await stopping; await disabling;
      expect(drained).toBe(true); expect(h.telegram.countOf('deleteWebhook')).toBe(0);
      expect(h.supervisor.status.running).toBe(false);
    } finally {
      release.resolve(); await Promise.allSettled([disabling, stopping]);
      await h.supervisor.stop(); h.cleanup();
    }
  }, TEST_BUDGET_MS);

  test('disabling never tears down a webhook belonging to another deployment', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 'shared-secret' } });
    try {
      await h.supervisor.start();
      // The same bot token, driven by somebody else's daemon.
      h.telegram.queue('getWebhookInfo', () => ok({ url: 'https://someone-else.example.com/webhook/telegram', pending_update_count: 0 }));

      h.config['surfaces.telegram.enabled'] = false;
      await h.supervisor.start();

      expect(h.telegram.countOf('deleteWebhook')).toBe(0);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── diagnostics instead of silence ──────────────────────────────────────────

describe('telegram ingress: a configured surface that cannot receive says so', () => {
  test('a token with the surface disabled reports the half-finished setup', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.enabled': false } });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('inactive');
      expect(status.reason).toContain('surfaces.telegram.enabled is false');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('enabled with no resolvable token names the settings to fix', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.botToken': '' } });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('inactive');
      expect(status.reason).toContain('surfaces.telegram.botToken');
      expect(status.reason).toContain('TELEGRAM_BOT_TOKEN');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('the bot token resolves through a secret reference, not only a literal', async () => {
    const h = makeHarness({
      config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN' },
      secrets: { GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN: '123456:from-secret-store' },
    });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('polling');
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── the poll loop ───────────────────────────────────────────────────────────

describe('telegram ingress: polled updates reach the shared handler', () => {
  test('a polled message is dispatched through the same path as a webhook update', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => ok([textUpdate(101, 'triage the build')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'a polled update spawning an agent');
      expect(h.spawned).toHaveLength(1);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a polled /start onboards and does not spawn an agent', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => ok([textUpdate(102, '/start')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('sendMessage') > 0, 'an onboarding reply');
      expect(h.spawned).toHaveLength(0);
      const sent = h.telegram.calls.find((call) => call.method === 'sendMessage');
      expect(String(sent?.body.text)).toContain('GoodVibes is connected');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('stop() ends the loop promptly and aborts the in-flight long poll', async () => {
    const h = makeHarness();
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');
      await h.supervisor.stop();
      // The poll is held open for Telegram's full window; shutdown must not
      // wait it out.
      expect(h.supervisor.status.running).toBe(false);

      const pollsAtStop = h.telegram.countOf('getUpdates');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(h.telegram.countOf('getUpdates')).toBe(pollsAtStop);
    } finally { h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── failure handling ────────────────────────────────────────────────────────

describe('telegram ingress: errors are classified, not blindly retried', () => {
  test('a 409 conflict clears the webhook and resumes rather than backing off', async () => {
    // Jitter pinned to zero, so the only wait here is the backoff floor. With
    // the production draw this test raced a 0–5 s random delay against a 5 s
    // timeout and failed roughly one run in five, indistinguishable, at the
    // moment it mattered, from recovery actually being broken.
    const h = makeHarness({ conflictJitterFraction: () => 0 });
    h.telegram.queue('getUpdates',
      () => apiError(409, 'Conflict: can\'t use getUpdates method while webhook is active'),
      () => ok([textUpdate(201, 'after the conflict cleared')]),
    );
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'recovery from the webhook conflict', 20_000);
      // Recovery is an actual deleteWebhook, not just a sleep: the startup call
      // plus one conflict recovery.
      expect(h.telegram.countOf('deleteWebhook')).toBeGreaterThanOrEqual(2);
    } finally { await h.supervisor.stop(); h.cleanup(); }
    // Generous ceiling: the expected wait is the 1 s backoff floor, so this can
    // only be reached by recovery failing, never by the runner being busy.
  }, TEST_BUDGET_MS);

  test('a non-conflict failure is not staggered: the jitter is for competing consumers only', async () => {
    const draws: string[] = [];
    const h = makeHarness({
      conflictJitterFraction: () => { draws.push('drawn'); return 0; },
    });
    h.telegram.queue('getUpdates',
      () => apiError(500, 'Internal Server Error'),
      () => ok([textUpdate(203, 'after the server error')]),
    );
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'recovery from a server error', 20_000);
      expect(draws).toEqual([]);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a webhook that will not clear says so loudly and KEEPS RETRYING', async () => {
    const h = makeHarness();
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: webhook is active'));
      // Telegram genuinely reports one, so this is the proven-webhook case.
      h.telegram.queue('getWebhookInfo', () => ok({ url: 'https://stuck.example.com/hook', pending_update_count: 0 }));
    }
    try {
      await h.supervisor.start();
      await waitFor(
        () => h.supervisor.status.reason.includes('a webhook is registered for this bot'),
        'the blocked-on-webhook report',
        30_000,
      );
      const status = h.supervisor.status;
      // The operator gets the fix...
      expect(status.reason).toContain('surfaces.telegram.mode=webhook');
      expect(status.reason).toContain('will resume by itself');
      // ...and the loop is STILL ALIVE. This is the regression: it used to go
      // inactive here and stay dead until a human restarted the daemon.
      expect(status.mode).toBe('polling');
      expect(status.running).toBe(true);
      const pollsWhenBlocked = h.telegram.countOf('getUpdates');
      await waitFor(
        () => h.telegram.countOf('getUpdates') > pollsWhenBlocked,
        'polling to continue after the surface was reported blocked',
        30_000,
      );
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('the live repro: a 409 blaming a webhook when none is registered is a competing consumer, not a dead end', async () => {
    // Exactly what happened on the owner's machine: 409s that logged as a
    // webhook conflict, getWebhookInfo reporting NO webhook, deleteWebhook
    // running and changing nothing, and the loop then stopping forever.
    const h = makeHarness();
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, "Conflict: can't use getUpdates method while webhook is active"));
      h.telegram.queue('getWebhookInfo', () => ok({ url: '', pending_update_count: 0 }));
    }
    try {
      await h.supervisor.start();
      await waitFor(() => h.conflicts.length > 0, 'the competing-consumer report', 30_000);
      // Classified from evidence, not from the description string.
      expect(h.conflicts[0]).toContain('another process is already long-polling this bot token');
      expect(h.conflicts[0]).toContain('no webhook registered');
      // Never terminal.
      expect(h.supervisor.status.mode).toBe('polling');
      expect(h.supervisor.status.running).toBe(true);
      const polls = h.telegram.countOf('getUpdates');
      await waitFor(() => h.telegram.countOf('getUpdates') > polls, 'polling to keep going', 30_000);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('with clustering OFF a competing consumer is retried, because there is no election to stand down to', async () => {
    const h = makeHarness({ config: { 'cluster.enabled': false } });
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    }
    try {
      await h.supervisor.start();
      await waitFor(() => h.conflicts.length > 0, 'the competing-consumer report', 30_000);
      expect(h.conflicts[0]).toContain('Clustering is off');
      expect(h.conflicts[0]).toContain('backing off and retrying');
      expect(h.supervisor.status.running).toBe(true);
      // A webhook was never implicated, so nothing pointless was deleted.
      expect(h.telegram.countOf('deleteWebhook')).toBe(1); // the startup clear only
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('with clustering ON the node stands down for the election, and still retries', async () => {
    const h = makeHarness({ config: { 'cluster.enabled': true } });
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    }
    try {
      await h.supervisor.start();
      await waitFor(() => h.conflicts.length > 0, 'the stand-down report', 30_000);
      expect(h.conflicts[0]).toContain('leader election');
      expect(h.supervisor.status.running).toBe(true);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('a poll that succeeds after a conflict clears the blocked status and delivers the message', async () => {
    const h = makeHarness();
    // Three conflicts, so the exponential backoff (1s, 2s, 4s) plus jitter
    // stays well inside the ceiling below, the point of this test is the
    // recovery, not the wait.
    for (let i = 0; i < 3; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    }
    h.telegram.queue('getUpdates', () => ok([textUpdate(777, 'the message that was nearly lost')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'recovery after the other consumer went away', 30_000);
      // Recovery is real: the status goes back to the healthy sentence, so an
      // operator who was told the surface was dead is told it came back.
      expect(h.supervisor.status.reason).toContain('long-polling Telegram getUpdates');
      expect(h.supervisor.status.running).toBe(true);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('a rejected bot token stops immediately instead of retrying forever', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => apiError(401, 'Unauthorized'));
    try {
      await h.supervisor.start();
      await waitFor(() => h.supervisor.status.mode === 'inactive', 'the loop giving up on a bad token');
      expect(h.supervisor.status.reason).toContain('surfaces.telegram.botToken');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('stop() interrupts a long server-dictated backoff instead of waiting it out', async () => {
    const h = makeHarness();
    // Telegram asks for a 30s pause. Shutdown must not honour it.
    h.telegram.queue('getUpdates', () => apiError(429, 'Too Many Requests', 30));
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'the rate-limited poll');
      // Let the loop get into its backoff sleep before stopping.
      await new Promise((resolve) => setTimeout(resolve, 100));

      await h.supervisor.stop();
    } finally { h.cleanup(); }
  }, 15_000);

  test('one failing update does not wedge the cursor behind it', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => ok([
      // No chat id: the handler rejects it. The cursor must still advance.
      { update_id: 301, message: { text: 'broken' } },
      textUpdate(302, 'still gets through'),
    ]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'the following update being processed');
      await waitFor(() => {
        try { const cursor = new TelegramOffsetStore(h.offsetPath, '123456').load(); return cursor.mode === 'resume' && cursor.offset === 303; } catch { return false; }
      }, 'the cursor advancing past both updates');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── running is not receiving ────────────────────────────────────────────────

function healthOf(status: TelegramIngressStatus): string {
  return resolveChannelHealthState({ enabled: true, configured: true, runtime: observeTelegramRuntime(status) });
}

describe('telegram ingress: a loop that runs but receives nothing is not healthy', () => {
  test('polls that keep conflicting read degraded, and one poll that returns reads healthy again', async () => {
    const h = makeHarness({ config: { 'cluster.enabled': false } });
    for (let i = 0; i < 3; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    }
    h.telegram.queue('getUpdates', () => ok([]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.supervisor.status.lastError !== undefined, 'the receive failure being reported', 20_000);
      expect(h.supervisor.status.running).toBe(true);
      expect(h.supervisor.status.kind).toBe('retrying');
      expect(healthOf(h.supervisor.status)).toBe('degraded');
      await waitFor(() => h.telegram.countOf('getUpdates') >= 5, 'the poll after the recovery', 30_000);
      expect(h.supervisor.status.lastError).toBeUndefined();
      expect(h.supervisor.status.kind).toBe('receiving');
      expect(healthOf(h.supervisor.status)).toBe('healthy');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('polls that keep failing on the network read degraded too', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) h.telegram.queue('getUpdates', () => apiError(502, 'Bad Gateway'));
    try {
      await h.supervisor.start();
      await waitFor(() => h.supervisor.status.lastError !== undefined, 'the receive failure being reported', 20_000);
      expect(h.supervisor.status.lastError).toContain('failed 3 times in a row');
      expect(h.supervisor.status.kind).toBe('retrying');
      expect(healthOf(h.supervisor.status)).toBe('degraded');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('a stopped webhook supervisor does not read healthy', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 's' } });
    try {
      expect((await h.supervisor.start()).mode).toBe('webhook');
      await h.supervisor.stop();
      expect(h.supervisor.status.mode).toBe('inactive');
      expect(h.supervisor.status.kind).toBe('stopped');
      expect(healthOf(h.supervisor.status)).toBe('dead');
    } finally { h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('stop() does not wait on a conflict check, and a late answer reports nothing', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    h.telegram.queue('getWebhookInfo', () => ok({ url: '', pending_update_count: 0 }), () => new Promise<Response>((_resolve, reject) => {
      const signal = h.telegram.calls.at(-1)?.signal;
      signal?.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
    }));
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getWebhookInfo') >= 2, 'the conflict check');
      const stopped = await Promise.race([
        h.supervisor.stop().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(stopped).toBe(true);
      expect(h.conflicts).toEqual([]);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

describe('telegram ingress: webhook registration that fails is retried, within reason', () => {
  test('a transient setWebhook failure is retried until it succeeds', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 's' } });
    h.telegram.queue('setWebhook', () => apiError(502, 'Bad Gateway'));
    try {
      const first = await h.supervisor.start();
      expect(first.mode).toBe('inactive');
      expect(first.reason).toContain('retrying');
      await waitFor(() => h.supervisor.status.mode === 'webhook', 'the retried registration', 10_000);
      expect(h.telegram.countOf('setWebhook')).toBe(2);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a rejected token is not retried, and the reason names the setting', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 's' } });
    h.telegram.queue('setWebhook', () => apiError(401, 'Unauthorized'));
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('inactive');
      expect(status.reason).toContain('surfaces.telegram.botToken');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(h.telegram.countOf('setWebhook')).toBe(1);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── offset persistence ──────────────────────────────────────────────────────

describe('telegram offset store: the cursor survives restarts', () => {
  test('the cursor is persisted after a batch and resumed on the next start', async () => {
    const first = makeHarness();
    first.telegram.queue('getUpdates', () => ok([textUpdate(500, 'first run')]));
    try {
      await first.supervisor.start();
      await waitFor(() => first.spawned.length > 0, 'the first batch');
      await waitFor(() => {
        try { const cursor = new TelegramOffsetStore(first.offsetPath, '123456').load(); return cursor.mode === 'resume' && cursor.offset === 501; } catch { return false; }
      }, 'the cursor being written');
    } finally { await first.supervisor.stop(); }

    // A restart must ask Telegram to continue from 501, not replay, not skip.
    const second = makeHarness();
    rmSync(second.offsetPath, { force: true });
    mkdirSync(join(second.offsetPath, '..'), { recursive: true });
    writeFileSync(second.offsetPath, readFileSync(first.offsetPath, 'utf-8'));
    first.cleanup();
    try {
      await second.supervisor.start();
      await waitFor(() => second.telegram.countOf('getUpdates') > 0, 'a first poll after restart');
      const poll = second.telegram.calls.find((call) => call.method === 'getUpdates');
      expect(poll?.body.offset).toBe(501);
    } finally { await second.supervisor.stop(); second.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a first run with no cursor asks for the retained backlog', async () => {
    const h = makeHarness();
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');
      const poll = h.telegram.calls.find((call) => call.method === 'getUpdates');
      // No offset: Telegram hands over what it still holds, so a /start sent
      // before the daemon was running is still answered.
      expect(poll?.body.offset).toBeUndefined();
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a torn cursor is moved aside and polling asks for everything Telegram still holds', async () => {
    const h = makeHarness(), bytes = '{"version":2,"accounts":';
    writeFileSync(h.offsetPath, bytes);
    h.telegram.queue('getUpdates', () => ok([textUpdate(900, 'owner objection must still arrive')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'the queued message');
      expect(h.telegram.calls.find(call => call.method === 'getUpdates')?.body.offset).toBeUndefined();
      expect(readFileSync(h.offsetPath, 'utf-8')).not.toBe(bytes);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a cursor saved by an earlier version resumes for the bot recorded as discovered', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.discoveredBotTokenId': '123456' } });
    writeFileSync(h.offsetPath, JSON.stringify({ version: 1, offset: 700, updatedAt: '2026-11-08T12:00:00.000Z' }));
    try {
      const status = await h.supervisor.start();
      expect(status.kind).not.toBe('blocked');
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');
      expect(h.telegram.calls.find(call => call.method === 'getUpdates')?.body.offset).toBe(700);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a cursor saved by an earlier version with no recorded bot waits for review without polling', async () => {
    const h = makeHarness();
    const bytes = JSON.stringify({ version: 1, offset: 700, updatedAt: '2026-11-08T12:00:00.000Z' });
    writeFileSync(h.offsetPath, bytes);
    try {
      const status = await h.supervisor.start();
      expect(status.kind).toBe('blocked');
      expect(status.reason).toContain('/channels telegram-cursor');
      expect(h.telegram.countOf('getUpdates')).toBe(0);
      expect(readFileSync(h.offsetPath, 'utf-8')).toBe(bytes);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('switching bots starts the other queue without overwriting the original bot cursor', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => ok([textUpdate(500, 'first bot')]));
    try {
      await h.supervisor.start();
      await waitFor(() => new TelegramOffsetStore(h.offsetPath, '123456').load().mode === 'resume', 'first bot cursor');
      await h.supervisor.stop();
      h.config['surfaces.telegram.botToken'] = '654321:other-synthetic-token';
      const before = h.telegram.calls.length;
      h.telegram.queue('getUpdates', () => ok([textUpdate(4, 'second bot')]));
      await h.supervisor.start();
      await waitFor(() => new TelegramOffsetStore(h.offsetPath, '654321').load().mode === 'resume', 'second bot cursor');
      expect(h.telegram.calls.slice(before).find(call => call.method === 'getUpdates')?.body.offset).toBeUndefined();
      await h.supervisor.stop();
      h.config['surfaces.telegram.botToken'] = '123456:test-token';
      const returning = h.telegram.calls.length;
      await h.supervisor.start();
      await waitFor(() => h.telegram.calls.slice(returning).some(call => call.method === 'getUpdates'), 'original bot restart');
      expect(h.telegram.calls.slice(returning).find(call => call.method === 'getUpdates')?.body.offset).toBe(501);
      expect(new TelegramOffsetStore(h.offsetPath, '654321').load()).toEqual({ mode: 'resume', offset: 5 });
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

describe('a Telegram 409 is not classified from its description text', () => {
  // TelegramApiError used to carry isConcurrentConsumerConflict and
  // isWebhookConflict, a regex over Telegram's free-text description. Nothing
  // called them after conflict-policy.ts took over the 409 (it asks
  // getWebhookInfo), so they were a leftover guess and are removed.
  test('the error exposes only the structured facts Telegram sends', () => {
    const error = new TelegramApiError('getUpdates', {
      errorCode: 409,
      description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
    });
    expect(error.errorCode).toBe(409);
    expect('isConcurrentConsumerConflict' in error).toBe(false);
    expect('isWebhookConflict' in error).toBe(false);
  });
});
