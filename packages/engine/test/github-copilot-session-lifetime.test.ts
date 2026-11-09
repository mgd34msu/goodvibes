import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { GitHubCopilotProvider, COPILOT_DATED_STATIC_MODELS } from '../platform/src/platform/providers/github-copilot.js';
import { CopilotSessions } from '../platform/src/platform/providers/github-copilot-session.js';
import { ProviderAttemptDeniedError } from '../platform/src/platform/providers/attempt-guard.js';
import { runLiveModelRefresh } from '../platform/src/platform/providers/live-model-discovery.js';

const roots: string[] = [], releases: (() => void)[] = [], work: Promise<unknown>[] = [];
const originalFetch = globalThis.fetch;
let previousPort: ReturnType<typeof installJudgmentPort>;
let installedPort = false;
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(work.splice(0));
  if (installedPort) { installJudgmentPort(previousPort); installedPort = false; }
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function barrier() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  releases.push(release); return { pending, release };
}
function responseFor(source: string) {
  return Response.json({ token: `session-${source}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
}
function delayedJson(value: unknown, entered: ReturnType<typeof barrier>, gate: ReturnType<typeof barrier>) {
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) { entered.release(); await gate.pending; controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); },
  }), { headers: { 'content-type': 'application/json' } });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'copilot-owned-session-')); roots.push(root);
  const tokenCachePath = join(root, 'credentials', 'token.json'), modelsCachePath = join(root, 'models.json');
  const env: NodeJS.ProcessEnv = { COPILOT_GITHUB_TOKEN: 'account-a' };
  const exchanges: string[] = [], modelRequests: string[] = [];
  let exchange = async (source: string, _signal: AbortSignal | null | undefined) => responseFor(source);
  let listing = async (source: string) => Response.json({ data: [{ id: `model-${source}`, vendor: 'OpenAI', capabilities: { type: 'chat' } }] });
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (String(url).includes('/copilot_internal/v2/token')) {
      const source = auth.replace(/^Bearer /, ''); exchanges.push(source); return exchange(source, init?.signal);
    }
    if (String(url).endsWith('/models')) {
      const source = auth.replace(/^Bearer session-/, ''); modelRequests.push(source); return listing(source);
    }
    throw new Error('Unexpected Copilot session fixture request');
  }) as typeof fetch;
  const options = { tokenCachePath, modelsCachePath, env, fetchFn };
  const provider = new GitHubCopilotProvider(options);
  return { provider, options, env, root, tokenCachePath, modelsCachePath, exchanges, modelRequests,
    onExchange(callback: typeof exchange) { exchange = callback; }, onListing(callback: typeof listing) { listing = callback; } };
}

const chatSse = [
  { id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'model-account-a', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }] },
  { id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'model-account-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
function chatFixture() {
  previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port); installedPort = true;
  const sent: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('authorization') ?? '');
    return new Response(chatSse, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return sent;
}

test('actual model discovery and chat share one provider-owned credential exchange', async () => {
  const f = fixture(), entered = barrier(), gate = barrier(), sent = chatFixture();
  f.onExchange(async source => { entered.release(); await gate.pending; return responseFor(source); });
  const discovery = f.provider.refreshModels(true), chat = f.provider.chat({ model: 'model-account-a', messages: [{ role: 'user', content: 'Fixture' }] });
  work.push(discovery, chat); await entered.pending;
  expect(f.exchanges).toEqual(['account-a']); gate.release();
  expect((await discovery).source).toBe('live'); expect((await chat).content).toBe('Done.');
  await f.provider.chat({ model: 'model-account-a', messages: [{ role: 'user', content: 'Again' }] });
  expect(f.exchanges).toEqual(['account-a']); expect(sent).toEqual(['Bearer session-account-a', 'Bearer session-account-a']);
});

test('retire an earlier disk session and exchange again for each actual provider instance', async () => {
  const f = fixture(); mkdirSync(dirname(f.tokenCachePath), { recursive: true });
  writeFileSync(f.tokenCachePath, JSON.stringify({ token: 'old-unowned-session', expiresAt: Date.now() + 3_600_000, updatedAt: Date.now(), sourceFingerprint: 'previous-binding' }));
  expect((await f.provider.refreshModels(true)).source).toBe('live');
  expect(JSON.parse(readFileSync(f.tokenCachePath, 'utf8'))).toEqual({ version: 2, storage: 'provider-memory' });
  const restarted = new GitHubCopilotProvider(f.options); expect((await restarted.refreshModels()).source).toBe('live');
  expect(f.exchanges).toEqual(['account-a', 'account-a']);
  expect(f.modelRequests).toEqual(['account-a', 'account-a']);
  expect(readFileSync(f.tokenCachePath, 'utf8')).not.toContain('old-unowned-session');
  expect(readFileSync(f.tokenCachePath, 'utf8')).not.toContain('account-a');
});

test.each(['fetch', 'body'] as const)('credential rotation during token %s cannot publish the retired session', async phase => {
  const f = fixture(), entered = barrier(), gate = barrier(); let oldSignal: AbortSignal | null | undefined;
  f.onExchange(async (source, signal) => {
    if (source !== 'account-a') return responseFor(source);
    oldSignal = signal;
    if (phase === 'fetch') { entered.release(); await gate.pending; return responseFor(source); }
    return delayedJson({ token: 'session-account-a', expires_at: Math.floor(Date.now() / 1000) + 3600 }, entered, gate);
  });
  const old = f.provider.refreshModels(true); work.push(old); await entered.pending;
  f.env['COPILOT_GITHUB_TOKEN'] = 'account-b';
  expect((await f.provider.refreshModels(true)).source).toBe('live'); expect(oldSignal?.aborted).toBe(true);
  gate.release(); expect((await old).source).toBe('dated-static');
  expect(f.modelRequests).toEqual(['account-b']); expect(f.provider.models).toEqual(['model-account-b']);
  expect(JSON.parse(readFileSync(f.modelsCachePath, 'utf8')).models).toEqual(['model-account-b']);
});

test('an old models response cannot overwrite a newer account in memory or on disk', async () => {
  const f = fixture(), entered = barrier(), gate = barrier();
  f.onListing(async source => source === 'account-a'
    ? delayedJson({ data: [{ id: 'retired-model', vendor: 'Anthropic' }] }, entered, gate)
    : Response.json({ data: [{ id: 'current-model', vendor: 'OpenAI' }] }));
  const old = f.provider.refreshModels(true); work.push(old); await entered.pending;
  f.env['COPILOT_GITHUB_TOKEN'] = 'account-b';
  await f.provider.refreshModels(true); gate.release();
  expect((await old).source).toBe('dated-static'); expect(f.provider.models).toEqual(['current-model']);
  expect(JSON.parse(readFileSync(f.modelsCachePath, 'utf8')).models).toEqual(['current-model']);
});

test('observed A to B to A cannot revive a chat admitted by the retired owner', async () => {
  const f = fixture(), entered = barrier(), gate = barrier(), sent = chatFixture();
  await f.provider.refreshModels(true);
  const pending = f.provider.chat({ model: 'model-account-a', messages: [{ role: 'user', content: 'Fixture' }],
    beforeAttempt: async () => { entered.release(); await gate.pending; } });
  const handled = pending.catch(error => error); work.push(pending); await entered.pending;
  f.env['COPILOT_GITHUB_TOKEN'] = 'account-b'; expect(f.provider.isConfigured()).toBe(true);
  f.env['COPILOT_GITHUB_TOKEN'] = 'account-a'; expect(f.provider.isConfigured()).toBe(true);
  gate.release(); expect(await handled).toBeInstanceOf(ProviderAttemptDeniedError); expect(sent).toEqual([]);
  await f.provider.refreshModels(true); expect(f.exchanges).toEqual(['account-a', 'account-a']);
});

test('a cancelled session waiter does not cancel another caller or discard their shared exchange', async () => {
  const f = fixture(), entered = barrier(), gate = barrier(), sessions = new CopilotSessions(f.options), cancel = new AbortController();
  const owner = sessions.capture(); if (!owner) throw new Error('Expected configured fixture');
  f.onExchange(async source => { entered.release(); await gate.pending; return responseFor(source); });
  const first = sessions.resolve(owner, cancel.signal), second = sessions.resolve(owner); work.push(first, second);
  expect(JSON.stringify([sessions, owner])).not.toContain('account-a');
  const handled = first.catch(error => error); await entered.pending;
  cancel.abort(new Error('Caller cancelled')); expect((await handled).message).toBe('Caller cancelled');
  expect(owner.signal.aborted).toBe(false); expect(f.exchanges).toEqual(['account-a']);
  gate.release(); expect((await second).token).toBe('session-account-a');
  expect((await sessions.resolve(owner)).token).toBe('session-account-a'); expect(f.exchanges).toHaveLength(1);
});

test('source deletion invalidates the live session and discovered model metadata', async () => {
  const f = fixture(); await f.provider.refreshModels(true);
  delete f.env['COPILOT_GITHUB_TOKEN']; expect(f.provider.isConfigured()).toBe(false);
  expect(f.provider.models).toEqual([...COPILOT_DATED_STATIC_MODELS]);
  await expect(f.provider.chat({ model: 'model-account-a', messages: [{ role: 'user', content: 'Fixture' }] })).rejects.toThrow('requires');
  f.env['COPILOT_GITHUB_TOKEN'] = 'account-a'; await f.provider.refreshModels(true);
  expect(f.exchanges).toEqual(['account-a', 'account-a']);
});


test('sessions near expiry trigger a single shared renewal rather than reuse past their margin', async () => {
  const f = fixture(), sessions = new CopilotSessions(f.options), entered = barrier(), gate = barrier();
  const owner = sessions.capture(); if (!owner) throw new Error('Expected fixture owner');
  f.onExchange(async () => Response.json({ token: 'near-expiry', expires_at: Math.floor(Date.now() / 1000) + 60 }));
  expect((await sessions.resolve(owner)).token).toBe('near-expiry');
  f.onExchange(async source => { entered.release(); await gate.pending; return responseFor(source); });
  const first = sessions.resolve(owner), second = sessions.resolve(owner); work.push(first, second);
  await entered.pending; expect(f.exchanges).toHaveLength(2); gate.release();
  expect((await first).token).toBe('session-account-a'); expect((await second).token).toBe('session-account-a');
});

test('model-list publication retains its original guard across an awaited fetch', async () => {
  const f = fixture(), entered = barrier(), gate = barrier(); let current = true;
  const options = { providerName: 'fixture', cachePath: f.modelsCachePath, datedStaticModels: ['baseline'], datedStaticAsOf: '2026-11-08',
    isConfigured: true, force: true, assertCurrent: () => { if (!current) throw new Error('Private changed owner'); },
    fetchLive: async () => { entered.release(); await gate.pending; return ['retired']; } };
  const pending = runLiveModelRefresh(options), handled = pending.catch(error => error); work.push(pending);
  await entered.pending; current = false; options.assertCurrent = () => {}; gate.release();
  expect((await handled).message).toBe('The original model-discovery owner is no longer current.');
  expect(() => readFileSync(f.modelsCachePath, 'utf8')).toThrow();
});

test('an asynchronous model-list authority callback is drained and refused before fetching', async () => {
  let calls = 0;
  await expect(runLiveModelRefresh({ providerName: 'fixture', datedStaticModels: ['baseline'], datedStaticAsOf: '2026-11-08',
    isConfigured: true, assertCurrent: async () => { throw new Error('Private async owner'); },
    fetchLive: async () => { calls++; return ['unexpected']; } })).rejects.toThrow('original model-discovery owner');
  expect(calls).toBe(0);
});
