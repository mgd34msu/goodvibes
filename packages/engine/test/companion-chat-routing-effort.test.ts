import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatManagerConfig, CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { PersistedChatSession } from '../platform/src/platform/companion/companion-chat-persistence.js';
import { CompanionChatPersistence } from '../platform/src/platform/companion/companion-chat-persistence.js';
import { dispatchCompanionChatRoutes } from '../platform/src/platform/companion/companion-chat-routes.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { AtomicWriteDurabilityError } from '../platform/src/platform/utils/atomic-json-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const managers: CompanionChatManager[] = [], roots: string[] = [], expectedCloseFailure = new Set<CompanionChatManager>();
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    if (expectedCloseFailure.has(manager)) await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
    else await manager.close();
  }
  expectedCloseFailure.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(options: Partial<CompanionChatManagerConfig> = {}, directory?: string) {
  const root = directory ?? makeProjectTempDir('companion-route-effort'); if (!directory) roots.push(root);
  const calls: Parameters<CompanionLLMProvider['chatStream']>[1][] = [];
  const manager = new CompanionChatManager({ persist: true, sessionsDir: root, rateLimiter: false, gcIntervalMs: 999999,
    eventPublisher: { publishEvent() {} }, provider: { async *chatStream(_messages, input) { calls.push(input); yield { type: 'text_delta', delta: 'owned answer' }; yield { type: 'done' }; } }, ...options });
  managers.push(manager); return { root, manager, calls };
}
const barrier = () => Promise.withResolvers<void>();
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(2); } throw new Error('Companion fixture did not settle'); }

test('session-only route and requested effort are durable before acknowledgment and survive real reopen', async () => {
  const declarations: string[] = [];
  const f = fixture({ nativeDataWriter: { declare(format) { declarations.push(format); } } });
  const original = f.manager.createSession({ provider: 'answer', model: 'first' }); await f.manager.flushSession(original.id);
  const updated = await f.manager.updateSessionPersisted(original.id, { provider: 'answer', model: 'second', reasoningEffort: 'max' });
  expect(updated).toMatchObject({ provider: 'answer', model: 'second', reasoningEffort: 'max' });
  expect(JSON.parse(readFileSync(join(f.root, `${original.id}.json`), 'utf8')).meta).toMatchObject({ model: 'second', reasoningEffort: 'max' });
  expect(declarations).toContain('companion-chat-effort-v1'); expect(f.calls).toHaveLength(0);
  await f.manager.close();
  const restored = fixture({}, f.root); await restored.manager.init();
  expect(restored.manager.getSession(original.id)).toMatchObject({ model: 'second', reasoningEffort: 'max' });
  await restored.manager.postMessageAndWaitForReply(original.id, 'Use the retained request');
  expect(restored.calls[0]).toMatchObject({ model: 'second', reasoningEffort: 'max' });
  await restored.manager.updateSessionPersisted(original.id, { reasoningEffort: null });
  await restored.manager.postMessageAndWaitForReply(original.id, 'Restore provider defaults');
  expect(restored.calls[1]?.reasoningEffort).toBeNull();
});

test('a historical missing effort field is readable and is not synthesized during reload', async () => {
  const f = fixture(), original = f.manager.createSession({ provider: 'answer', model: 'old-model' }); await f.manager.flushSession(original.id); await f.manager.close();
  const reopened = fixture({}, f.root); await reopened.manager.init();
  expect(Object.hasOwn(reopened.manager.getSession(original.id)!, 'reasoningEffort')).toBe(false);
  await reopened.manager.postMessageAndWaitForReply(original.id, 'Continue');
  expect(reopened.calls[0]?.reasoningEffort).toBeUndefined();
});

test('an active turn refuses route/effort changes while an acknowledged rename remains available', async () => {
  const entered = barrier(), release = barrier();
  const f = fixture({ provider: { async *chatStream() { entered.resolve(); await release.promise; yield { type: 'done' }; } } });
  const session = f.manager.createSession({ provider: 'original', model: 'original-model', reasoningEffort: 'xhigh' }); await f.manager.flushSession(session.id);
  await f.manager.postMessage(session.id, 'Remain on the original route'); await entered.promise;
  try {
    await expect(f.manager.updateSessionPersisted(session.id, { provider: 'other', model: 'other-model' })).rejects.toMatchObject({ code: 'CHAT_ROUTE_BUSY', status: 409 });
    await expect(f.manager.updateSessionPersisted(session.id, { reasoningEffort: 'max' })).rejects.toMatchObject({ code: 'CHAT_ROUTE_BUSY', status: 409 });
    expect(await f.manager.updateSessionPersisted(session.id, { title: 'Renamed without rerouting' })).toMatchObject({ title: 'Renamed without rerouting', provider: 'original', reasoningEffort: 'xhigh' });
  } finally { release.resolve(); }
});

test('old null defaults resolve once at message admission and remain pinned across actual tool rounds', async () => {
  const calls: Parameters<CompanionLLMProvider['chatStream']>[1][] = [];
  let defaults = { provider: 'first-provider', model: 'first-model', reasoningEffort: 'max', systemPrompt: null }, reads = 0;
  const f = fixture({ persist: false, toolRegistry: new ToolRegistry(), resolveDefaultRoute() { reads++; return defaults; },
    provider: { async *chatStream(_messages, input) {
      calls.push(input);
      if (calls.length === 1) {
        defaults = { provider: 'later-provider', model: 'later-model', reasoningEffort: 'xhigh', systemPrompt: null };
        yield { type: 'tool_call', toolCallId: 'denied-owned-tool', toolName: 'unregistered-tool', toolInput: {} };
      } else { yield { type: 'text_delta', delta: 'finished' }; }
      yield { type: 'done' };
    } } });
  const session = f.manager.createSession();
  await f.manager.postMessageAndWaitForReply(session.id, 'Use a tool round');
  expect(calls).toHaveLength(2); expect(reads).toBe(1);
  for (const call of calls) expect(call).toMatchObject({ provider: 'first-provider', model: 'first-model', reasoningEffort: 'max' });
  await f.manager.postMessageAndWaitForReply(session.id, 'A genuinely later turn');
  expect(reads).toBe(2); expect(calls[2]).toMatchObject({ provider: 'later-provider', model: 'later-model', reasoningEffort: 'xhigh' });
});

test.each(['false', 'async', 'throw-promise'] as const)('invalid %s native floor declaration preserves original bytes/metadata and makes no model call', async kind => {
  let attempted = 0;
  const f = fixture({ nativeDataWriter: { declare() {
    attempted++;
    if (kind === 'throw-promise') throw Promise.reject(new Error('owned rejected declaration'));
    return kind === 'false' ? false : Promise.reject(new Error('owned async declaration'));
  } } });
  const session = f.manager.createSession({ provider: 'original', model: 'original-model' }); await f.manager.flushSession(session.id);
  const path = join(f.root, `${session.id}.json`), original = readFileSync(path);
  await expect(f.manager.updateSessionPersisted(session.id, { reasoningEffort: 'max' })).rejects.toThrow();
  expect(readFileSync(path)).toEqual(original); expect(Object.hasOwn(f.manager.getSession(session.id)!, 'reasoningEffort')).toBe(false);
  expect(f.calls).toHaveLength(0); expect(attempted).toBe(1); await Bun.sleep(0);
});

test('before-publication failure leaves old route bytes and metadata intact and holds future execution', async () => {
  const f = fixture(), session = f.manager.createSession({ provider: 'original', model: 'old-model' }); await f.manager.flushSession(session.id);
  const path = join(f.root, `${session.id}.json`), original = readFileSync(path);
  const save = spyOn(CompanionChatPersistence.prototype, 'saveSync').mockImplementation(() => { throw new AtomicWriteDurabilityError(path, 'before-publication', new Error('fixture failure')); });
  try {
    await expect(f.manager.updateSessionPersisted(session.id, { model: 'next-model', provider: 'next-provider', reasoningEffort: 'max' })).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE', status: 503 });
    expect(readFileSync(path)).toEqual(original); expect(f.manager.getSession(session.id)).toMatchObject({ provider: 'original', model: 'old-model' });
    await expect(f.manager.postMessage(session.id, 'Must not execute an unconfirmed route')).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' }); expect(f.calls).toHaveLength(0);
  } finally { save.mockRestore(); expectedCloseFailure.add(f.manager); }
});

test('close drains a genuinely accepted gated save before clearing the original session or returning', async () => {
  const entered = barrier(), release = barrier();
  const originalSave = CompanionChatPersistence.prototype.save;
  const save = spyOn(CompanionChatPersistence.prototype, 'save').mockImplementation(async function (this: CompanionChatPersistence, session: PersistedChatSession) { entered.resolve(); await release.promise; await originalSave.call(this, session); });
  const f = fixture(), session = f.manager.createSession({ title: 'Must survive immediate shutdown', provider: 'answer', model: 'model', reasoningEffort: 'max' });
  let closed = false; await entered.promise; const closing = f.manager.close().then(() => { closed = true; });
  try {
    await Bun.sleep(5); expect(closed).toBe(false); expect(existsSync(join(f.root, `${session.id}.json`))).toBe(false);
  } finally { release.resolve(); save.mockRestore(); }
  await closing;
  expect(JSON.parse(readFileSync(join(f.root, `${session.id}.json`), 'utf8')).meta).toMatchObject({ title: 'Must survive immediate shutdown', reasoningEffort: 'max' });
  expect(f.manager.getSession(session.id)).toBeNull();
});

test('actual HTTP effort update accepts max/null, rejects malformed effort and returns only after native file publication', async () => {
  const f = fixture(), session = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(session.id);
  const context = { chatManager: f.manager, parseJsonBody: (request: Request) => request.json() as Promise<Record<string, unknown>>,
    parseOptionalJsonBody: (request: Request) => request.json() as Promise<Record<string, unknown>>, openSessionEventStream: () => new Response(null) };
  for (const reasoningEffort of ['xhigh', 'max', null]) {
    const response = await dispatchCompanionChatRoutes(new Request(`http://owned.invalid/api/companion/chat/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ reasoningEffort }) }), context);
    expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ session: { reasoningEffort } });
    expect(JSON.parse(readFileSync(join(f.root, `${session.id}.json`), 'utf8')).meta.reasoningEffort).toBe(reasoningEffort);
  }
  const original = readFileSync(join(f.root, `${session.id}.json`));
  const refused = await dispatchCompanionChatRoutes(new Request(`http://owned.invalid/api/companion/chat/sessions/${session.id}`, { method: 'PATCH', body: '{"reasoningEffort":"unsupported"}' }), context);
  expect(refused?.status).toBe(400); expect(readFileSync(join(f.root, `${session.id}.json`))).toEqual(original); expect(f.calls).toHaveLength(0);
});

test('possible publication is preserved and execution held rather than overwriting it with a guessed rollback', async () => {
  const f = fixture(), session = f.manager.createSession({ provider: 'original', model: 'old-model' }); await f.manager.flushSession(session.id);
  const path = join(f.root, `${session.id}.json`), nativeSave = CompanionChatPersistence.prototype.saveSync;
  const save = spyOn(CompanionChatPersistence.prototype, 'saveSync').mockImplementation(function (this: CompanionChatPersistence, value: PersistedChatSession) {
    nativeSave.call(this, value); throw new AtomicWriteDurabilityError(path, 'published-indeterminate', new Error('fixture confirmation failed'));
  });
  try {
    await expect(f.manager.updateSessionPersisted(session.id, { provider: 'next', model: 'next-model', reasoningEffort: 'max' })).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
    expect(f.manager.getSession(session.id)).toMatchObject({ provider: 'original', model: 'old-model' });
    expect(JSON.parse(readFileSync(path, 'utf8')).meta).toMatchObject({ provider: 'next', model: 'next-model', reasoningEffort: 'max' });
    await expect(f.manager.postMessage(session.id, 'Cannot execute uncertain publication')).rejects.toMatchObject({ status: 503 }); expect(f.calls).toHaveLength(0);
  } finally { save.mockRestore(); expectedCloseFailure.add(f.manager); }
});

test('message preparation already owns its route before the first async content boundary', async () => {
  let selected = { provider: 'original', model: 'original-model', systemPrompt: null, reasoningEffort: 'xhigh' };
  const f = fixture({ persist: false, resolveDefaultRoute: () => selected });
  const session = f.manager.createSession(); const posted = f.manager.postMessageAndWaitForReply(session.id, 'Admit the original route');
  selected = { provider: 'later', model: 'later-model', systemPrompt: null, reasoningEffort: 'max' };
  await expect(f.manager.updateSessionPersisted(session.id, { provider: 'different', model: 'different-model' })).rejects.toMatchObject({ code: 'CHAT_ROUTE_BUSY' });
  await posted; expect(f.calls[0]).toMatchObject({ provider: 'original', model: 'original-model', reasoningEffort: 'xhigh' });
});

test('close waits for the exact admitted provider completion even when the provider ignores cancellation', async () => {
  const entered = barrier(), release = barrier();
  const f = fixture({ provider: { async *chatStream() { entered.resolve(); await release.promise; yield { type: 'text_delta', delta: 'late ignored output' }; yield { type: 'done' }; } } });
  const session = f.manager.createSession({ provider: 'original', model: 'model' }); await f.manager.flushSession(session.id);
  await f.manager.postMessage(session.id, 'Held native invocation'); await entered.promise;
  let closed = false; const closing = f.manager.close().then(() => { closed = true; });
  try { await Bun.sleep(5); expect(closed).toBe(false); } finally { release.resolve(); }
  await closing;
  const stored = JSON.parse(readFileSync(join(f.root, `${session.id}.json`), 'utf8')) as { messages: { role: string; content: string }[] };
  expect(stored.messages.some(message => message.role === 'assistant' && message.content.includes('late ignored output'))).toBe(false);
});


test('restart preserves mismatched saved IDs without adopting a path outside its actual session directory', async () => {
  const f = fixture(), original = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(original.id); await f.manager.close();
  const originalPath = join(f.root, `${original.id}.json`), before = readFileSync(originalPath, 'utf8');
  const foreign = JSON.parse(before) as { meta: { id: string } }; foreign.meta.id = '../outside-owned-session';
  const bytes = JSON.stringify(foreign); writeFileSync(join(f.root, 'unrelated.json'), bytes);
  const reopened = fixture({}, f.root); await reopened.manager.init();
  expect(reopened.manager.getSession('../outside-owned-session')).toBeNull();
  expect(reopened.manager.getSession(original.id)?.id).toBe(original.id);
  expect(readFileSync(join(f.root, 'unrelated.json'), 'utf8')).toBe(bytes);
  expect(existsSync(join(f.root, '../outside-owned-session.json'))).toBe(false);
  const persistence = new CompanionChatPersistence(f.root);
  await expect(persistence.save({ meta: { ...original, id: '../outside-owned-session' }, messages: [] })).rejects.toThrow('Invalid saved chat identifier');
  expect(readFileSync(originalPath, 'utf8')).toBe(before);
});

test('an explicitly configured directory alias stays on its original target and rejects retargeting', async () => {
  const root = makeProjectTempDir('companion-original-dir'); roots.push(root);
  const first = join(root, 'first'), other = join(root, 'other'), alias = join(root, 'selected');
  mkdirSync(first); mkdirSync(other); symlinkSync(first, alias, 'dir');
  const manager = fixture({}, alias).manager, session = manager.createSession({ provider: 'answer', model: 'first' }); await manager.flushSession(session.id);
  const original = readFileSync(join(first, `${session.id}.json`));
  renameSync(alias, join(root, 'original-alias')); symlinkSync(other, alias, 'dir');
  await expect(manager.updateSessionPersisted(session.id, { provider: 'answer', model: 'other', reasoningEffort: 'max' })).rejects.toMatchObject({ code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
  expect(readFileSync(join(first, `${session.id}.json`))).toEqual(original); expect(existsSync(join(other, `${session.id}.json`))).toBe(false);
  expectedCloseFailure.add(manager);
});


test.skipIf(process.platform === 'win32')('first session publication under restrictive umask creates usable private managed directories and file', async () => {
  const f = fixture(), original = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(original.id);
  const path = join(f.root, 'new', 'nested', 'sessions'), persistence = new CompanionChatPersistence(path);
  const previous = process.umask(0o777); let saved: Promise<void>;
  try { saved = persistence.save({ meta: original, messages: [] }); } finally { process.umask(previous); }
  await saved!;
  expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(join(path, `${original.id}.json`)).mode & 0o777).toBe(0o600);
  expect((await persistence.loadAll())[0]?.meta.id).toBe(original.id);
});


test('session deletion uses its admitted directory and refuses a retargeted alias without unlinking foreign data', async () => {
  const f = fixture(), session = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(session.id);
  const first = join(f.root, 'original'), other = join(f.root, 'foreign'), alias = join(f.root, 'alias');
  mkdirSync(first); mkdirSync(other); symlinkSync(first, alias, 'dir');
  const persistence = new CompanionChatPersistence(alias);
  await persistence.save({ meta: session, messages: [] }); await persistence.delete(session.id);
  expect(existsSync(join(first, `${session.id}.json`))).toBe(false);
  await persistence.delete(session.id); // ENOENT remains an acknowledged no-op.
  await persistence.save({ meta: session, messages: [] });
  writeFileSync(join(other, `${session.id}.json`), 'foreign bytes');
  renameSync(alias, join(f.root, 'old-alias')); symlinkSync(other, alias, 'dir');
  await expect(persistence.delete(session.id)).rejects.toThrow();
  expect(existsSync(join(first, `${session.id}.json`))).toBe(true);
  expect(readFileSync(join(other, `${session.id}.json`), 'utf8')).toBe('foreign bytes');
});

test('synchronous provider abort reentry observes the same already-reserved close operation', async () => {
  const entered = barrier(), release = barrier(); let reentered: Promise<void> | undefined;
  const f = fixture({ provider: { async *chatStream(_messages, options) {
    options.abortSignal?.addEventListener('abort', () => { reentered = f.manager.close(); }, { once: true });
    entered.resolve(); await release.promise; yield { type: 'done' };
  } } });
  const session = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(session.id);
  await f.manager.postMessage(session.id, 'Own one close'); await entered.promise;
  const closing = f.manager.close();
  try { expect(reentered).toBe(closing); expect(f.manager.close()).toBe(closing); } finally { release.resolve(); }
  await closing;
});
