/** Source-only regressions; execution is deferred until the coding worklist is complete. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramOffsetStore } from '../platform/src/platform/channels/telegram/offset-store.js';
import { TelegramPollingReceiveProgress } from '../platform/src/platform/channels/telegram/receive-progress.js';
import { TELEGRAM_UPDATE_RETENTION_MS } from '../platform/src/platform/channels/telegram/payment-receive-span.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const scope = { conversationId: '-100123', threadId: '9' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telegram-durable-payment-span-')), path = join(root, 'cursor.json');
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); let clock = 100, declared = 0;
  const attach = () => {
    const store = new TelegramOffsetStore(path, '123', () => {}, () => { declared++; });
    const cursor = store.retainPolling(), lifetime = new AbortController();
    cleanup.push(() => { lifetime.abort(); cursor.release(); });
    return { cursor, lifetime, progress: new TelegramPollingReceiveProgress(lifetime.signal, () => clock, cursor),
      close: () => { lifetime.abort(); cursor.release(); } };
  };
  return { path, attach, at: (value: number) => { clock = value; }, declarations: () => declared };
}

test('pre-notice native registration preserves an already-owned long poll and keeps original offset facts', () => {
  const f = fixture(), live = f.attach(), request = live.cursor.capture();
  const pin = live.progress.retain('purchase-1', 100); if (!pin.selector) throw new Error('Missing original selector');
  expect(pin.selector.offsetAtStart).toBeNull(); expect(() => request.assertCurrent()).not.toThrow();
  expect(live.cursor.capture().observation.offset).toBe(0); expect(f.declarations()).toBeGreaterThan(0);
  const row = JSON.parse(readFileSync(f.path, 'utf8')) as { version: number };
  expect(row.version).toBe(3);
  live.cursor.save(501, () => {}); expect(() => request.assertCurrent()).toThrow();
  expect(live.cursor.receiveSpans()[0]?.id).toBe(pin.selector.id);
});

test('restart restores the exact original selector but requires actual drained queue quiet', async () => {
  const f = fixture(), before = f.attach(), span = before.progress.retain('purchase-1', 100);
  if (!span.selector) throw new Error('Missing original native selector');
  const selector = span.selector;
  before.cursor.save(501, () => {}); before.close(); f.at(200);
  const after = f.attach(), restored = after.progress.restore(span.selector); let complete = false;
  const waiting = restored.waitFor(100, 250, after.lifetime.signal, scope).then(assertCurrent => { complete = true; return assertCurrent; });
  f.at(260); const nonempty = after.progress.beginRequest(); after.progress.completeRequest(nonempty, false);
  await Promise.resolve(); expect(complete).toBe(false);
  const empty = after.progress.beginRequest(); f.at(270); after.progress.completeRequest(empty, true);
  const current = await waiting; expect(() => current()).not.toThrow();
  expect(() => after.progress.restore({ ...selector, offsetAtStart: 999 })).toThrow();
  expect(() => after.progress.restore({ ...selector, purchaseId: 'another-purchase' })).toThrow();
});

test.each(['scoped-gap', 'conflict', 'retention', 'clock', 'compatibility-confirmation', 'same-bytes-replacement'] as const)('native restart cannot turn %s into quiet original reception', async reason => {
  const f = fixture(), before = f.attach(), pin = before.progress.retain('purchase-1', 100);
  if (!pin.selector) throw new Error('Missing native span');
  const selector = pin.selector;
  before.cursor.save(501, () => {});
  if (reason === 'scoped-gap') before.progress.gap(scope);
  if (reason === 'conflict') before.progress.gap();
  before.close();
  if (reason === 'compatibility-confirmation') new TelegramOffsetStore(f.path, '123').save(600);
  f.at(reason === 'retention' ? 100 + TELEGRAM_UPDATE_RETENTION_MS : reason === 'clock' ? 99 : 200);
  const after = f.attach();
  if (reason === 'same-bytes-replacement') writeFileSync(f.path, readFileSync(f.path));
  await expect(Promise.resolve().then(() => after.progress.restore(selector).waitFor(100, 200, after.lifetime.signal, scope))).rejects.toThrow();
});

test('one recipient gap survives restart without revoking another actual recipient', async () => {
  const f = fixture(), before = f.attach(), pin = before.progress.retain('purchase-1', 100);
  if (!pin.selector) throw new Error('Missing original span');
  before.progress.gap(scope); before.close(); f.at(200);
  const after = f.attach(), restored = after.progress.restore(pin.selector), started = after.progress.beginRequest();
  after.progress.completeRequest(started, true);
  const current = await restored.waitFor(100, 200, after.lifetime.signal, { conversationId: '-100456' }); expect(() => current()).not.toThrow();
  await expect(restored.waitFor(100, 200, after.lifetime.signal, scope)).rejects.toThrow();
});

test('a long configured window retains continuous archived custody beyond provider queue retention', async () => {
  const f = fixture(), before = f.attach(), pin = before.progress.retain('long-approval', 100);
  if (!pin.selector) throw new Error('Missing native receive span');
  let clock = 100;
  // Approval windows may last seven days and veto windows a full day. Only a
  // gap in actual processing loses provider retention, not the notice's age.
  for (let day = 0; day < 7; day++) for (let hour = 0; hour < 24; hour += 6) {
    clock += 6 * 60 * 60 * 1000; f.at(clock);
    const started = before.progress.beginRequest(); before.progress.completeRequest(started, true);
  }
  const current = await pin.waitFor(100, clock, before.lifetime.signal, scope);
  expect(() => current()).not.toThrow();
  before.close(); f.at(clock + 1000);
  const restarted = f.attach();
  const resumed = await restarted.progress.restore(pin.selector).waitFor(100, clock, restarted.lifetime.signal, scope);
  expect(() => resumed()).not.toThrow();
  f.at(clock + TELEGRAM_UPDATE_RETENTION_MS + 1000);
  expect(() => resumed()).toThrow();
});

test('bounded drain failure is not absence, and only actual terminal bookkeeping permits pruning', async () => {
  const f = fixture(), live = f.attach(), pin = live.progress.retain('purchase-1', 100);
  const waiting = pin.waitFor(100, 200, live.lifetime.signal, scope);
  for (let index = 0; index < 64; index++) { f.at(200 + index); const started = live.progress.beginRequest(); live.progress.completeRequest(started, false); }
  await expect(waiting).rejects.toThrow(); expect(live.cursor.receiveSpans()).toHaveLength(1);
  live.progress.prune(() => false); expect(live.cursor.receiveSpans()).toHaveLength(1);
  live.progress.prune(purchaseId => purchaseId === 'purchase-1'); expect(live.cursor.receiveSpans()).toEqual([]);
});

test.each([true, null, {}, { url: '' }, { url: '', pending_update_count: -1 }])('malformed webhook status cannot certify no prior receive path: %j', async result => {
  const { TelegramBotApi } = await import('../platform/src/platform/channels/telegram/api.js');
  const api = new TelegramBotApi('123:synthetic-token', async () => Response.json({ ok: true, result }));
  await expect(api.getWebhookInfo()).rejects.toThrow('not confirmed');
});

test('webhook removal requires actual provider acknowledgement', async () => {
  const { TelegramBotApi } = await import('../platform/src/platform/channels/telegram/api.js');
  const api = new TelegramBotApi('123:synthetic-token', async () => Response.json({ ok: true, result: false }));
  await expect(api.deleteWebhook(false)).rejects.toThrow('did not confirm');
});
