import { afterEach, expect, test } from 'bun:test';
import { TelegramPollingReceiveProgress } from '../sdk/src/platform/channels/telegram/receive-progress.js';
import { createTelegramSourceAccountOwner } from '../sdk/src/platform/channels/telegram/source-account.js';
import { TelegramBotApi, TelegramUpdateResponseError } from '../sdk/src/platform/channels/telegram/api.js';
import { TelegramIngressSupervisor } from '../sdk/src/platform/channels/telegram/ingress.js';
import { TelegramOffsetStore } from '../sdk/src/platform/channels/telegram/offset-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scope = { conversationId: '-100123', threadId: '9' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let clock = 0;
  const lifetime = new AbortController(); cleanup.push(() => lifetime.abort());
  const progress = new TelegramPollingReceiveProgress(lifetime.signal, () => clock);
  return { progress, lifetime, at: (value: number) => { clock = value; } };
}

test('queue silence requires an empty request started after the deadline, after actual dispatch/persistence completion', async () => {
  const f = fixture(), pin = f.progress.retain(); f.at(10); const beforeDeadline = f.progress.beginRequest();
  f.at(50); f.progress.completeRequest(beforeDeadline, true);
  let settled = false;
  const waiting = pin.waitFor(0, 40, f.lifetime.signal, scope).then(assertCurrent => { settled = true; return assertCurrent; });
  await Promise.resolve(); expect(settled).toBe(false); expect(f.progress.timeoutSeconds(25)).toBe(1);
  f.at(60); const nonempty = f.progress.beginRequest(); f.at(61); f.progress.completeRequest(nonempty, false);
  await Promise.resolve(); expect(settled).toBe(false);
  f.at(70); const empty = f.progress.beginRequest(); f.at(71);
  // Merely entering the request or receiving its response cannot publish
  // progress before the caller has dispatched and persisted that batch.
  await Promise.resolve(); expect(settled).toBe(false); f.progress.completeRequest(empty, true);
  const assertCurrent = await waiting; expect(() => assertCurrent()).not.toThrow(); expect(f.progress.timeoutSeconds(25)).toBe(25);
  f.at(80); f.progress.gap(scope); expect(() => assertCurrent()).toThrow();
});

test('a processing gap is scoped to its actual chat/topic, with immutable scope capture', async () => {
  const f = fixture(), pin = f.progress.retain(), original = { ...scope };
  const waiting = pin.waitFor(0, 10, f.lifetime.signal, original); original.conversationId = 'different';
  f.at(5); f.progress.gap({ conversationId: 'different', threadId: '9' });
  f.at(10); const started = f.progress.beginRequest(); f.at(11); f.progress.completeRequest(started, true);
  const assertCurrent = await waiting; expect(() => assertCurrent()).not.toThrow();
  f.at(12); f.progress.gap(scope); expect(() => assertCurrent()).toThrow();
});

test('same-millisecond global retirement cannot be hidden by an identical timestamp', async () => {
  const f = fixture(), original = f.progress.retain(); f.progress.gap();
  const current = f.progress.retain(), started = f.progress.beginRequest(); f.progress.completeRequest(started, true);
  await expect(original.waitFor(0, 0, f.lifetime.signal, scope)).rejects.toThrow();
  const assertCurrent = await current.waitFor(0, 0, f.lifetime.signal, scope); expect(() => assertCurrent()).not.toThrow();
});

test.each(['retention', 'clock', 'stop', 'conflict'] as const)('an original receive claim cannot survive %s', async reason => {
  const f = fixture(), pin = f.progress.retain();
  const waiting = pin.waitFor(0, 10, f.lifetime.signal, scope);
  if (reason === 'retention') { f.at(24 * 60 * 60 * 1000); f.progress.beginRequest(); }
  if (reason === 'clock') { f.at(2); f.progress.beginRequest(); f.at(1); expect(() => f.progress.beginRequest()).toThrow(); }
  if (reason === 'stop') f.lifetime.abort();
  if (reason === 'conflict') f.progress.gap();
  await expect(waiting).rejects.toThrow();
});

test('caller cancellation removes its barrier without retiring unrelated receive work', async () => {
  const f = fixture(), pin = f.progress.retain(), request = new AbortController();
  const waiting = pin.waitFor(0, 10, request.signal, scope); request.abort(); await expect(waiting).rejects.toThrow();
  expect(f.progress.timeoutSeconds(25)).toBe(25);
  f.at(10); const started = f.progress.beginRequest(); f.at(11); f.progress.completeRequest(started, true);
  const assertCurrent = await pin.waitFor(0, 10, f.lifetime.signal, scope); expect(() => assertCurrent()).not.toThrow();
});

test('the actual source owner fences the private receive claim through credential awaits and same-bot replacement', async () => {
  const f = fixture(), owner = createTelegramSourceAccountOwner(); let reads = 0;
  const attach = () => owner.attach({ lifetime: f.lifetime.signal, receiveProgress: f.progress, isCurrent: async () => true, isCurrentSync: () => true,
    readIdentity: async () => { reads++; return { id: '123', username: 'fixture_bot' }; } });
  attach(); const coverage = owner.reader.retainReceiveCoverage?.(); if (!coverage) throw new Error('Missing receive reservation');
  const handle = await owner.reader.acquire(); if (!handle) throw new Error('Missing verified private account');
  f.at(10); const started = f.progress.beginRequest(); f.at(11); f.progress.completeRequest(started, true);
  const assertCurrent = await coverage.waitFor(handle, 0, 10, f.lifetime.signal, scope); expect(reads).toBe(1); expect(() => assertCurrent()).not.toThrow();
  const borrowed = JSON.parse(JSON.stringify(handle)) as typeof handle;
  await expect(coverage.waitFor(borrowed, 0, 10, f.lifetime.signal, scope)).rejects.toThrow();
  attach(); expect(() => assertCurrent()).toThrow();
  const replacement = await owner.reader.acquire(); if (!replacement) throw new Error('Missing replacement account');
  await expect(coverage.waitFor(replacement, 0, 10, f.lifetime.signal, scope)).rejects.toThrow();
});

test('the actual native poller publishes quiet progress only after processing, saved cursor and a subsequent empty request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-receive-loop-')), offsetPath = join(root, 'cursor.json');
  let clock = 100;
  const accounts = createTelegramSourceAccountOwner(), processing = deferred<void>(), finishProcessing = deferred<void>();
  const pollEntries = [deferred<void>(), deferred<void>(), deferred<void>()];
  const polls: { readonly offset: unknown; readonly finish: (updates: unknown[]) => void }[] = [];
  const values: Record<string, unknown> = { 'surfaces.telegram.enabled': true, 'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123:synthetic-token', 'surfaces.telegram.botUsername': 'fixture_bot' };
  const supervisor = new TelegramIngressSupervisor({ now: () => clock, offsetFilePath: offsetPath, telegramSourceAccounts: accounts,
    configManager: { get: (key: string) => values[key] } as never,
    serviceRegistry: { get: () => null, resolveSecret: async () => null } as never,
    secretsManager: { get: () => null, getGlobalHome: () => undefined, onDidChange: () => () => {}, resolveLocalSecretSync: () => ({ state: 'absent' }) } as never,
    createApi: token => new TelegramBotApi(token, async (url, init) => {
      const method = url.split('/').pop();
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 123, username: 'fixture_bot', is_bot: true, first_name: 'Fixture' } });
      if (method === 'getUpdates') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Promise<Response>((resolve, reject) => {
          const aborted = () => { init.signal?.removeEventListener('abort', aborted); reject(new DOMException('Cancelled', 'AbortError')); };
          const index = polls.length;
          polls.push({ offset: body['offset'], finish: updates => { init.signal?.removeEventListener('abort', aborted); resolve(Response.json({ ok: true, result: updates })); } });
          init.signal?.addEventListener('abort', aborted, { once: true }); if (init.signal?.aborted) aborted();
          pollEntries[index]?.resolve();
        });
      }
      return Response.json({ ok: true, result: true });
    }),
    buildSurfaceAdapterContext: () => ({ configManager: { get: (key: string) => values[key] },
      async authorizeSurfaceIngress() { processing.resolve(); await finishProcessing.promise; return { allowed: false, reason: 'payment-reply-recorded' }; },
    }) as never,
  });
  cleanup.push(async () => { finishProcessing.resolve(); await supervisor.stop(); rmSync(root, { recursive: true, force: true }); });
  await supervisor.start(); await pollEntries[0]?.promise;
  const coverage = accounts.reader.retainReceiveCoverage?.(); if (!coverage) throw new Error('Missing native receive reservation');
  const handle = await accounts.reader.acquire(); if (!handle) throw new Error('Missing private verified bot');
  let complete = false;
  const waiting = coverage.waitFor(handle, 100, 200, new AbortController().signal, scope).then(assertCurrent => { complete = true; return assertCurrent; });
  clock = 250; polls[0]?.finish([]); await pollEntries[1]?.promise;
  expect(complete).toBe(false);
  polls[1]?.finish([{ update_id: 500, message: { message_id: 52, date: 1, from: { id: 42 }, chat: { id: -100123, type: 'private' }, text: 'Synthetic dispatch barrier' } }]);
  await processing.promise; expect(complete).toBe(false);
  clock = 260; finishProcessing.resolve(); await pollEntries[2]?.promise;
  expect(polls[2]?.offset).toBe(501); expect(new TelegramOffsetStore(offsetPath, '123').load()).toEqual({ mode: 'resume', offset: 501 });
  expect(complete).toBe(false);
  clock = 270; polls[2]?.finish([]);
  const assertCurrent = await waiting; expect(() => assertCurrent()).not.toThrow();
  await supervisor.stop(); expect(() => assertCurrent()).toThrow();
});

test.each([null, true, [{}], [null], [{ update_id: -1 }], [{ update_id: 499 }], [{ update_id: 500 }, { update_id: 500 }],
  Array.from({ length: 101 }, (_value, index) => ({ update_id: 500 + index }))])('a malformed getUpdates payload cannot become an empty queue', async result => {
  const api = new TelegramBotApi('123:synthetic-token', async () => Response.json({ ok: true, result }));
  await expect(api.getUpdates({ offset: 500, timeoutSeconds: 1 })).rejects.toBeInstanceOf(TelegramUpdateResponseError);
});
