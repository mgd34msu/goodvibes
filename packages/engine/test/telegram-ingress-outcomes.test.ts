import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramIngressSupervisor, describeWebhookUrlProblem } from '../platform/src/platform/channels/telegram/ingress.ts';
import { TelegramApiError, TelegramBotApi } from '../platform/src/platform/channels/telegram/api.ts';
import { TelegramOffsetStore, TelegramOffsetStoreError } from '../platform/src/platform/channels/telegram/offset-store.ts';
import { TelegramCursorMigration } from '../platform/src/platform/channels/telegram/cursor-migration.ts';
import { PaymentReplyHistoryError } from '../platform/src/platform/payments/reply-history.js';

interface Call { readonly method: string; readonly body: Record<string, unknown> }
const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const update = (id: number, text: string) => ({ update_id: id, message: { chat: { id: 4242, type: 'private' }, from: { id: 7, username: 'avery' }, text } });

function harness(options: {
  config?: Record<string, unknown>;
  polls?: Array<unknown[]>;
  authorize?: (text: string) => void;
  spawn?: (text: string) => unknown;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-tg-outcomes-'));
  const offsetPath = join(dir, 'telegram-offset.json');
  const calls: Call[] = [];
  const polls = [...(options.polls ?? [])];
  const processed: string[] = [];
  const config: Record<string, unknown> = {
    'surfaces.telegram.enabled': true, 'surfaces.telegram.mode': 'polling', 'surfaces.telegram.botToken': '123456:test-token',
    'surfaces.telegram.botUsername': 'goodvibes_bot', 'web.publicBaseUrl': 'https://daemon.example.com', ...options.config,
  };
  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const method = input.split('/').pop() ?? '';
    calls.push({ method, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (method === 'getUpdates') {
      const next = polls.shift();
      if (next) return ok(next);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
      });
    }
    if (method === 'getWebhookInfo') return ok({ url: '', pending_update_count: 0 });
    return ok(true);
  };
  const supervisor = new TelegramIngressSupervisor({
    configManager: { get: (key: string) => config[key] } as never,
    secretsManager: { get: () => null, getGlobalHome: () => undefined } as never,
    serviceRegistry: { resolveSecret: async () => null } as never,
    offsetFilePath: offsetPath,
    createApi: (token) => new TelegramBotApi(token, fetchImpl),
    conflictJitterFraction: () => 0,
    buildSurfaceAdapterContext: () => ({
      serviceRegistry: { resolveSecret: async () => null },
      configManager: { get: (key: string) => config[key] },
      routeBindings: { upsertBinding: async () => ({ id: 'binding-1', surfaceId: 'goodvibes_bot', externalId: '4242', channelId: '4242', threadId: undefined, title: 'Avery' }) },
      sessionBroker: {
        submitMessage: async (input: { body: string }) => ({ mode: 'spawn', task: { prompt: input.body, text: input.body }, session: { id: 'session-1' } }),
        bindAgent: async () => {},
      },
      authorizeSurfaceIngress: async (input: { text?: string }) => { options.authorize?.(input.text ?? ''); return { allowed: true }; },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      trySpawnAgent: (input: { task: { prompt?: string; text?: string } }) => {
        const text = input.task.prompt ?? input.task.text ?? '';
        processed.push(text);
        return options.spawn ? options.spawn(text) : { id: `agent-${processed.length}` };
      },
      queueSurfaceReplyFromBinding: () => {},
    }) as never,
  });
  return { supervisor, calls, processed, offsetPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function until(predicate: () => boolean, label: string, ceilingMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > ceilingMs) throw new Error(`${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const savedOffset = (path: string): number | null => {
  try { const cursor = new TelegramOffsetStore(path, '123456').load(); return cursor.mode === 'resume' ? cursor.offset : null; } catch { return null; }
};

describe('webhook registration without a secret', () => {
  test('an unmanaged webhook with no secret is not registered and reads inactive with the setting to fix', async () => {
    const h = harness({ config: { 'surfaces.telegram.mode': 'webhook' } });
    try {
      const status = await h.supervisor.start();
      expect(status.kind).toBe('inactive');
      expect(status.reason).toContain('surfaces.telegram.webhookSecret');
      expect(h.calls.some((call) => call.method === 'setWebhook')).toBe(false);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  });
});

describe('webhook URL guard', () => {
  test.each(['https://[::1]/', 'https://0.0.0.0/', 'https://169.254.1.1/', 'https://[fd00::1]/', 'https://100.64.0.1/'])('%s cannot be reached by Telegram', (url) => {
    expect(describeWebhookUrlProblem(url)).not.toBeNull();
  });
  test('a public host passes', () => {
    expect(describeWebhookUrlProblem('https://daemon.example.com/')).toBeNull();
  });
});

describe('batch persistence', () => {
  test('an update processed before a failure is not replayed', async () => {
    const h = harness({
      polls: [[update(10, 'first'), update(11, 'second'), update(12, 'third')]],
      authorize: (text) => { if (text === 'second') throw new PaymentReplyHistoryError(); },
    });
    try {
      await h.supervisor.start();
      await until(() => h.processed.length > 0, 'the first update');
      await until(() => savedOffset(h.offsetPath) === 11, 'the cursor saved past the first update only');
      expect(h.processed).toEqual(['first']);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 30_000);
});

describe('a processor that asks for a retry', () => {
  test('a 429 answer keeps the update unconfirmed and it is fetched again', async () => {
    let refused = false;
    const h = harness({
      polls: [[update(20, 'one'), update(21, 'two'), update(22, 'three')], [update(21, 'two'), update(22, 'three')]],
      spawn: (text) => {
        if (text === 'two' && !refused) { refused = true; return Response.json({ error: 'busy' }, { status: 429, headers: { 'Retry-After': '1' } }); }
        return { id: 'agent' };
      },
    });
    try {
      await h.supervisor.start();
      await until(() => h.calls.filter((call) => call.method === 'getUpdates').length >= 2, 'the second poll');
      // The first batch confirmed only the update before the refusal.
      expect(h.calls.filter((call) => call.method === 'getUpdates')[1]!.body.offset).toBe(21);
      await until(() => savedOffset(h.offsetPath) === 23, 'the retried updates confirmed');
      expect(h.processed.filter((text) => text === 'two')).toHaveLength(2);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 30_000);
});

describe('Telegram API failures', () => {
  test('a non-JSON error body becomes a TelegramApiError carrying the HTTP status', async () => {
    const api = new TelegramBotApi('123456:t', async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await api.getUpdates({ timeoutSeconds: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).httpStatus).toBe(502);
  });
});

describe('cursor migration preview', () => {
  test('a failed identity read is reported as retryable, not as a damaged cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-tg-migrate-'));
    try {
      const migration = new TelegramCursorMigration({
        filePath: join(dir, 'cursor.json'),
        identity: async () => { throw new Error('getMe timed out'); },
      });
      const error = await migration.preview().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TelegramOffsetStoreError);
      expect((error as TelegramOffsetStoreError).kind).toBe('identity-unavailable');
      await migration.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
