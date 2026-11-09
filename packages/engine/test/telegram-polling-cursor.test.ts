import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramOffsetStore } from '../platform/src/platform/channels/telegram/offset-store.js';
import { TelegramIngressSupervisor } from '../platform/src/platform/channels/telegram/ingress.js';
import { TelegramBotApi } from '../platform/src/platform/channels/telegram/api.js';
import { createTelegramSourceAccountOwner } from '../platform/src/platform/channels/telegram/source-account.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telegram-polling-cursor-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, path: join(root, 'cursor.json') };
}
function retain(path: string, account = '123') {
  const cursor = new TelegramOffsetStore(path, account).retainPolling(); cleanup.push(() => { try { cursor.release(); } catch { /* An explicitly replaced lease is foreign. */ } }); return cursor;
}

test('one actual polling owner retains its cursor, and only its own confirmed save advances its observation', () => {
  const f = fixture(); new TelegramOffsetStore(f.path, '123').save(500);
  const cursor = retain(f.path), first = cursor.capture();
  expect(first.observation).toMatchObject({ accountId: '123', offset: 500 }); expect(first.observation.physical).not.toBeNull();
  expect(() => new TelegramOffsetStore(f.path, '123').retainPolling()).toThrow('Another Telegram owner');
  expect(cursor.save(501, () => {})).toBe(501); expect(() => first.assertCurrent()).toThrow(); expect(() => cursor.assertCurrent()).not.toThrow();
  const next = cursor.capture(), bytes = readFileSync(f.path);
  expect(next.observation.offset).toBe(501); expect(cursor.save(501, () => {})).toBe(501);
  expect(readFileSync(f.path)).toEqual(bytes); expect(cursor.capture().observation).toEqual(next.observation);
  cursor.release(); expect(() => next.assertCurrent()).toThrow();
  const replacement = retain(f.path); expect(replacement.capture().observation.offset).toBe(501);
});

test.each(['advanced', 'same-bytes', 'deleted', 'other-account'] as const)('unowned cursor mutation (%s) never becomes this session’s confirmation offset', kind => {
  const f = fixture(); new TelegramOffsetStore(f.path, '123').save(500);
  const cursor = retain(f.path), entered = cursor.capture(), bytes = readFileSync(f.path);
  if (kind === 'advanced') new TelegramOffsetStore(f.path, '123').save(900);
  if (kind === 'other-account') new TelegramOffsetStore(f.path, '456').save(8);
  if (kind === 'same-bytes') writeFileSync(f.path, bytes);
  if (kind === 'deleted') unlinkSync(f.path);
  expect(() => entered.assertCurrent()).toThrow(); expect(() => cursor.capture()).toThrow();
  expect(() => cursor.save(501, () => {})).toThrow();
  if (kind === 'advanced') expect(new TelegramOffsetStore(f.path, '123').load()).toEqual({ mode: 'resume', offset: 900 });
  if (kind === 'other-account') {
    expect(new TelegramOffsetStore(f.path, '123').load()).toEqual({ mode: 'resume', offset: 500 });
    expect(new TelegramOffsetStore(f.path, '456').load()).toEqual({ mode: 'resume', offset: 8 });
  }
});

test('a replaced polling lease retires the original capability and its release cannot delete the replacement lease', () => {
  const f = fixture(), original = retain(f.path), observation = original.capture().observation;
  expect(observation).toEqual({ accountId: '123', offset: null, physical: null });
  unlinkSync(`${f.path}.polling-123.lock`);
  const replacement = retain(f.path); expect(() => original.assertCurrent()).toThrow(); expect(() => original.release()).toThrow('Original native lock owner changed');
  expect(() => replacement.assertCurrent()).not.toThrow(); expect(() => new TelegramOffsetStore(f.path, '123').retainPolling()).toThrow('Another Telegram owner');
});

test('malformed original cursor evidence releases its attempted lease without clearing or repairing the evidence', () => {
  const f = fixture(); writeFileSync(f.path, '{');
  expect(() => new TelegramOffsetStore(f.path, '123').retainPolling()).toThrow(); expect(readFileSync(f.path, 'utf8')).toBe('{');
  writeFileSync(f.path, JSON.stringify({ version: 2, accounts: [] }));
  expect(retain(f.path).capture().observation.offset).toBeNull();
});

test('a separate process holds confirmation until its actual death, then the strict lease can be reclaimed', async () => {
  const f = fixture(); new TelegramOffsetStore(f.path, '123').save(500);
  const module = new URL('../platform/src/platform/channels/telegram/offset-store.ts', import.meta.url).href;
  const script = `import { TelegramOffsetStore } from ${JSON.stringify(module)};
const cursor = new TelegramOffsetStore(${JSON.stringify(f.path)}, '123').retainPolling();
process.stdout.write('held\\n');
await Bun.stdin.text();
cursor.release();`;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  cleanup.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; });
  const reader = child.stdout.getReader();
  try {
    let ready = '';
    while (!ready.includes('\n')) {
      const chunk = await reader.read(); if (chunk.done) break;
      ready += new TextDecoder().decode(chunk.value); if (ready.length > 64) throw new Error('Unexpected cursor-holder output');
    }
    expect(ready).toBe('held\n');
    expect(() => new TelegramOffsetStore(f.path, '123').retainPolling()).toThrow('Another Telegram owner');
    child.kill('SIGKILL'); await child.exited;
    const replacement = retain(f.path); expect(replacement.capture().observation.offset).toBe(500);
  } finally { reader.releaseLock(); }
}, 15_000);

function receiver(path: string, options: { ignoreAbort?: boolean; processing?: Promise<void>; enteredProcessing?: () => void } = {}) {
  const accounts = createTelegramSourceAccountOwner(), entered = deferred<void>(), conflict = deferred<void>();
  const calls: { offset: unknown; finish(updates: readonly unknown[]): void }[] = [];
  const settings: Record<string, unknown> = { 'surfaces.telegram.enabled': true, 'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123:synthetic-token', 'surfaces.telegram.botUsername': 'fixture_bot' };
  let dispatched = 0;
  const supervisor = new TelegramIngressSupervisor({ offsetFilePath: path, telegramSourceAccounts: accounts,
    configManager: { get: (key: string) => settings[key] } as never,
    secretsManager: { get: () => null, getGlobalHome: () => undefined, onDidChange: () => () => {}, resolveLocalSecretSync: () => ({ state: 'absent' }) } as never,
    serviceRegistry: { get: () => null, resolveSecret: async () => null } as never,
    onConcurrentConsumerConflict() { conflict.resolve(); },
    createApi: token => new TelegramBotApi(token, async (url, init) => {
      const method = url.split('/').pop();
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 123, username: 'fixture_bot', is_bot: true, first_name: 'Fixture' } });
      if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: '', pending_update_count: 0 } });
      if (method !== 'getUpdates') return Response.json({ ok: true, result: true });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => { init.signal?.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
        calls.push({ offset: body['offset'], finish(updates) { init.signal?.removeEventListener('abort', abort); resolve(Response.json({ ok: true, result: updates })); } });
        if (!options.ignoreAbort) { init.signal?.addEventListener('abort', abort, { once: true }); if (init.signal?.aborted) abort(); }
        entered.resolve();
      });
    }),
    buildSurfaceAdapterContext: () => ({ configManager: { get: (key: string) => settings[key] },
      async authorizeSurfaceIngress() {
        dispatched++; options.enteredProcessing?.(); await options.processing; return { allowed: false, reason: 'payment-reply-recorded' };
      } }) as never,
  });
  cleanup.push(async () => { for (const call of calls) call.finish([]); await supervisor.stop(); });
  return { supervisor, accounts, entered, conflict, calls, dispatched: () => dispatched };
}
const update = { update_id: 500, message: { message_id: 52, date: 1, from: { id: 42 }, chat: { id: -100123, type: 'private' }, text: 'Do not buy the original item.' } };

test('a replacement receiver cannot overtake an original getUpdates that ignores cancellation', async () => {
  const f = fixture(); new TelegramOffsetStore(f.path, '123').save(500); const bytes = readFileSync(f.path);
  const first = receiver(f.path, { ignoreAbort: true }); await first.supervisor.start(); await first.entered.promise;
  const handle = await first.accounts.reader.acquire(); if (!handle) throw new Error('Missing original private source');
  let drained = false; const closing = first.supervisor.stop().then(() => { drained = true; });
  let secondStopDrained = false; const secondStop = first.supervisor.stop().then(() => { secondStopDrained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(secondStopDrained).toBe(false); expect(() => first.accounts.reader.assertCurrent(handle)).toThrow();
  const second = receiver(f.path); await second.supervisor.start(); await second.conflict.promise;
  expect(second.calls).toEqual([]); expect(await second.accounts.reader.acquire()).toBeNull();
  first.calls[0]?.finish([update]); await closing; await secondStop;
  expect(drained).toBe(true); expect(secondStopDrained).toBe(true); expect(first.dispatched()).toBe(0);
  await second.entered.promise; expect(second.calls[0]?.offset).toBe(500); expect(readFileSync(f.path)).toEqual(bytes);
  expect(() => new TelegramOffsetStore(f.path, '123').retainPolling()).toThrow('Another Telegram owner');
}, 15_000);

test('shutdown drains actual inbound dispatch before releasing the original queue lease', async () => {
  const f = fixture(); new TelegramOffsetStore(f.path, '123').save(500);
  const processing = deferred<void>(), enteredProcessing = deferred<void>();
  const first = receiver(f.path, { processing: processing.promise, enteredProcessing: () => enteredProcessing.resolve() });
  cleanup.push(() => processing.resolve());
  await first.supervisor.start(); await first.entered.promise; first.calls[0]?.finish([update]); await enteredProcessing.promise;
  const closing = first.supervisor.stop();
  expect(() => new TelegramOffsetStore(f.path, '123').retainPolling()).toThrow('Another Telegram owner');
  processing.resolve(); await closing;
  const next = retain(f.path); expect(next.capture().observation.offset).toBe(500);
});

test('the actual poller rejects a foreign cursor advance before dispatch or another confirmation request', async () => {
  const f = fixture(); new TelegramOffsetStore(f.path, '123').save(500);
  const native = receiver(f.path); await native.supervisor.start(); await native.entered.promise;
  const handle = await native.accounts.reader.acquire(); if (!handle) throw new Error('Missing actual source');
  new TelegramOffsetStore(f.path, '123').save(900); const bytes = readFileSync(f.path);
  expect(() => native.accounts.reader.assertCurrent(handle)).toThrow(); native.calls[0]?.finish([update]);
  const deadline = Date.now() + 2000;
  while (native.supervisor.status.mode !== 'inactive') {
    if (Date.now() >= deadline) throw new Error('The stale original receive owner did not retire');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  expect(native.dispatched()).toBe(0); expect(native.calls).toHaveLength(1); expect(readFileSync(f.path)).toEqual(bytes);
});
