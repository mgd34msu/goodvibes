import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatManagerConfig, CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-manager.js';
import { CompanionChatPersistence } from '../platform/src/platform/companion/companion-chat-persistence.js';
import { dispatchCompanionChatRoutes } from '../platform/src/platform/companion/companion-chat-routes.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { waitFor } from './_helpers/test-timeout.ts';

const managers: CompanionChatManager[] = [], roots: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** The saved summary of a chat. */
const metaPath = (root: string, id: string) => join(root, `${id}.meta.json`);
function fixture(options: Partial<CompanionChatManagerConfig> = {}, directory?: string) {
  const root = directory ?? makeProjectTempDir('companion-route-effort'); if (!directory) roots.push(root);
  const calls: Parameters<CompanionLLMProvider['chatStream']>[1][] = [];
  const manager = new CompanionChatManager({ persist: true, sessionsDir: root, rateLimiter: false, gcIntervalMs: 999999,
    eventPublisher: { publishEvent() {} }, provider: { async *chatStream(_messages, input) { calls.push(input); yield { type: 'text_delta', delta: 'owned answer' }; yield { type: 'done' }; } }, ...options });
  managers.push(manager); return { root, manager, calls };
}
const barrier = () => Promise.withResolvers<void>();
// Event-loop turns, not wall-clock time: a close that does not wait for the held work settles within a few.
async function turns(count = 5) { for (let i = 0; i < count; i++) await new Promise<void>((resolve) => { setImmediate(resolve); }); }
const until = (check: () => boolean) => waitFor(check);

test('session-only route and requested effort are durable before acknowledgment and survive real reopen', async () => {
  const declarations: string[] = [];
  const f = fixture({ nativeDataWriter: { declare(format) { declarations.push(format); } } });
  const original = f.manager.createSession({ provider: 'answer', model: 'first' }); await f.manager.flushSession(original.id);
  const updated = await f.manager.updateSessionPersisted(original.id, { provider: 'answer', model: 'second', reasoningEffort: 'max' });
  expect(updated).toMatchObject({ provider: 'answer', model: 'second', reasoningEffort: 'max' });
  expect(JSON.parse(readFileSync(metaPath(f.root, original.id), 'utf8'))).toMatchObject({ model: 'second', reasoningEffort: 'max' });
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
  const path = metaPath(f.root, session.id), original = readFileSync(path);
  await expect(f.manager.updateSessionPersisted(session.id, { reasoningEffort: 'max' })).rejects.toThrow();
  expect(readFileSync(path)).toEqual(original); expect(Object.hasOwn(f.manager.getSession(session.id)!, 'reasoningEffort')).toBe(false);
  expect(f.calls).toHaveLength(0); expect(attempted).toBe(1); await turns(1);
});

test('a route change whose save fails is refused alone: the saved route and the chat stay as they were and keep working', async () => {
  const f = fixture(), session = f.manager.createSession({ provider: 'original', model: 'old-model' });
  const path = metaPath(f.root, session.id), original = readFileSync(path);
  const save = spyOn(CompanionChatPersistence.prototype, 'writeMeta').mockImplementation(() => { throw Object.assign(new Error('fixture failure'), { code: 'EIO' }); });
  try {
    await expect(f.manager.updateSessionPersisted(session.id, { model: 'next-model', provider: 'next-provider', reasoningEffort: 'max' })).rejects.toMatchObject({ code: 'CHAT_SAVE_FAILED', status: 503 });
  } finally { save.mockRestore(); }
  expect(readFileSync(path)).toEqual(original); expect(f.manager.getSession(session.id)).toMatchObject({ provider: 'original', model: 'old-model' });
  await f.manager.postMessageAndWaitForReply(session.id, 'Runs on the route that was saved');
  expect(f.calls[0]).toMatchObject({ provider: 'original', model: 'old-model' });
});

test('actual HTTP effort update accepts max/null, rejects malformed effort and returns only after native file publication', async () => {
  const f = fixture(), session = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(session.id);
  const context = { chatManager: f.manager, parseJsonBody: (request: Request) => request.json() as Promise<Record<string, unknown>>,
    parseOptionalJsonBody: (request: Request) => request.json() as Promise<Record<string, unknown>>, openSessionEventStream: () => new Response(null) };
  for (const reasoningEffort of ['xhigh', 'max', null]) {
    const response = await dispatchCompanionChatRoutes(new Request(`http://owned.invalid/api/companion/chat/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ reasoningEffort }) }), context);
    expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ session: { reasoningEffort } });
    expect(JSON.parse(readFileSync(metaPath(f.root, session.id), 'utf8')).reasoningEffort).toBe(reasoningEffort);
  }
  const original = readFileSync(metaPath(f.root, session.id));
  const refused = await dispatchCompanionChatRoutes(new Request(`http://owned.invalid/api/companion/chat/sessions/${session.id}`, { method: 'PATCH', body: '{"reasoningEffort":"unsupported"}' }), context);
  expect(refused?.status).toBe(400); expect(readFileSync(metaPath(f.root, session.id))).toEqual(original); expect(f.calls).toHaveLength(0);
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
  try { await turns(); expect(closed).toBe(false); } finally { release.resolve(); }
  await closing;
  const stored = (await new CompanionChatPersistence(f.root).loadAll()).find((entry) => entry.meta.id === session.id)!;
  expect(stored.messages.some(message => message.role === 'assistant' && message.content.includes('late ignored output'))).toBe(false);
});


test('restart preserves mismatched saved IDs without adopting a path outside its actual session directory', async () => {
  const f = fixture(), original = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(original.id); await f.manager.close();
  const originalPath = metaPath(f.root, original.id), before = readFileSync(originalPath, 'utf8');
  const foreign = { meta: { ...(JSON.parse(before) as { id: string }), id: '../outside-owned-session' }, messages: [] };
  const bytes = JSON.stringify(foreign); writeFileSync(join(f.root, 'unrelated.json'), bytes);
  const reopened = fixture({}, f.root); await reopened.manager.init();
  expect(reopened.manager.getSession('../outside-owned-session')).toBeNull();
  expect(reopened.manager.getSession(original.id)?.id).toBe(original.id);
  expect(readFileSync(join(f.root, 'unrelated.json'), 'utf8')).toBe(bytes);
  expect(existsSync(join(f.root, '../outside-owned-session.json'))).toBe(false);
  const persistence = new CompanionChatPersistence(f.root);
  expect(() => persistence.writeMeta({ ...original, id: '../outside-owned-session' })).toThrow('Invalid saved chat identifier');
  expect(readFileSync(originalPath, 'utf8')).toBe(before);
});

test.skipIf(process.platform === 'win32')('first session publication under restrictive umask creates usable private managed directories and file', async () => {
  const f = fixture(), original = f.manager.createSession({ provider: 'answer', model: 'model' }); await f.manager.flushSession(original.id);
  const path = join(f.root, 'new', 'nested', 'sessions'), persistence = new CompanionChatPersistence(path);
  const previous = process.umask(0o777);
  try { persistence.writeMeta(original); } finally { process.umask(previous); }
  expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(metaPath(path, original.id)).mode & 0o777).toBe(0o600);
  expect((await persistence.loadAll())[0]?.meta.id).toBe(original.id);
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
