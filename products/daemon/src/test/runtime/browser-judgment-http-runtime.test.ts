/** Actual daemon composition and authenticated callers against owned loopback Jev. */
import { expect, spyOn, test } from 'bun:test';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/platform/platform/intake';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-api';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { operationJudgmentRequests } from '../helpers/field-name-privacy-requests.js';

const ERROR = 'webui.errors.daemon-refusal';
const FAILURE_MESSAGE = 'The synthetic conversation has finished and cannot accept this operation.';
const FAILURE_SOURCE = { phase: 'source', parts: [{ kind: 'text', text: FAILURE_MESSAGE }], target: 'whole-line' };
const barrier = () => Promise.withResolvers<void>();
type WireRequest = { readonly state: unknown; readonly questions: Readonly<Record<string, unknown>> };
async function fixture() {
  const calls: WireRequest[] = [];
  let probability = 0.99;
  let beforeAnswer: (() => Promise<void>) | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/systemone') return new Response(null, { status: 404 });
    const input = await request.json() as WireRequest;
    calls.push(input); await beforeAnswer?.();
    if (Object.hasOwn(input.questions, 'lineHasCredential') || Object.hasOwn(input.questions, 'spanIsCredential')) {
      expect(Object.keys(input.questions).sort()).toEqual(['lineHasCredential', 'spanIsCredential']);
      expect(input.state).toEqual(FAILURE_SOURCE);
    }
    return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(input.questions).map((name) =>
      [name, { type: 'noul', noul: name === 'match' ? probability : name === 'session_closed' ? 0.99 : 0.01 }])),
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const restore = () => { identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); server.stop(true); };
  let daemon: Awaited<ReturnType<typeof startDaemonFixture>>;
  try {
    daemon = await startDaemonFixture({ root: makeOwnedTempDir('browser-judgment-http-runtime'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      configure(config) { config.set('judgment.endpoint', `http://127.0.0.1:${server.port}`); config.set('judgment.keySource', 'secret'); config.set('judgment.model', 'jev-1.13.0'); },
    });
  } catch (error) { restore(); throw error; }
  const getSecret = daemon.services.secretsManager.get.bind(daemon.services.secretsManager);
  let key: () => Promise<string | null> = async () => 'synthetic-browser-key';
  const secrets = spyOn(daemon.services.secretsManager, 'get').mockImplementation((name) => name === 'TYPESAFE_API_KEY' ? key() : getSecret(name));
  daemon.services.gatewayMethods.register({ id: 'synthetic.browser.failure', title: 'Synthetic failure', description: 'Owned failure source',
    category: 'sessions', access: 'authenticated', source: 'builtin', transport: ['http'], scopes: ['read:sessions'],
  }, async () => { throw new Error(FAILURE_MESSAGE); });
  /** A canonical failure from the daemon, and the reference it issued for interpreting it. */
  async function errorRef(token = daemon.token): Promise<string> {
    const failure = await fetch(`${daemon.baseUrl}/api/control-plane/methods/synthetic.browser.failure/invoke`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"body":{}}' });
    const failed = await failure.json() as { errorRef?: string };
    if (typeof failed.errorRef !== 'string') throw new Error(`No error reference was issued (${failure.status}).`);
    return failed.errorRef;
  }
  const refusal = (ref: string): BrowserJudgmentRequest<'webui.errors.daemon-refusal'> => ({
    protocolVersion: 1, requestId: crypto.randomUUID(), battery: ERROR, batteryVersion: 1, input: { errorRef: ref } });
  async function wire(input: BrowserJudgmentRequest, options: { token?: string; signal?: AbortSignal } = {}) {
    const response = await fetch(`${daemon.baseUrl}/api/judgment/batteries/run`, { method: 'POST',
      headers: { Authorization: `Bearer ${options.token ?? daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return { daemon, calls, errorRef, refusal, wire, setProbability: (value: number) => { probability = value; },
    setBeforeAnswer: (callback: () => Promise<void>) => { beforeAnswer = callback; }, setKey: (callback: () => Promise<string | null>) => { key = callback; },
    async stop() { try { await daemon.stop(); } finally { secrets.mockRestore(); restore(); } },
  };
}

test('production composition issues canonical error references, interprets them once and binds them to their caller', async () => {
  const f = await fixture();
  try {
    expect(f.daemon.services.browserJudgment).toBeDefined();
    const failure = await f.daemon.fetch('/api/control-plane/methods/synthetic.browser.failure/invoke', { method: 'POST', body: '{"body":{}}' });
    const failed = await failure.json() as { errorRef?: string };
    expect(failure.status).toBe(500); expect(failed.errorRef).toBeString(); expect(failure.headers.get('cache-control')).toBe('no-store');
    const interpreted = await f.wire(f.refusal(failed.errorRef!));
    expect(interpreted.status, JSON.stringify(interpreted.body)).toBe(200);
    expect(interpreted.body).toMatchObject({ status: 'settled', value: { session_closed: true, method_unknown: false }, structuralBasis: { method_unknown: 'http-status-not-404' } });
    expect(f.daemon.services.judgment.decisionLog.query({ battery: ERROR })).toHaveLength(1);
    const paired = f.daemon.services.pairingTokens.mint({ name: 'Other synthetic browser' });
    expect((await f.wire(f.refusal(failed.errorRef!), { token: paired.token })).status).toBe(422);
    const known = await f.daemon.fetch('/api/companion/chat/sessions/absent-synthetic-session');
    expect(await known.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    const requests = operationJudgmentRequests(f.calls);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toMatchObject({ methodId: 'synthetic.browser.failure', message: FAILURE_MESSAGE, status: 500 });
  } finally { await f.stop(); }
}, 30_000);

test('uncertain and missing-key callers remain unusable', async () => {
  const f = await fixture();
  try {
    f.setProbability(0.5);
    const uncertain = await f.wire(f.refusal(await f.errorRef())); expect(uncertain.body.status).toBe('held'); expect(uncertain.body).not.toHaveProperty('value');
    const count = operationJudgmentRequests(f.calls).length;
    f.setKey(async () => null);
    const absent = await f.wire(f.refusal(await f.errorRef())); expect(absent.status).toBe(503); expect(absent.body).not.toHaveProperty('value'); expect(operationJudgmentRequests(f.calls)).toHaveLength(count);
  } finally { await f.stop(); }
}, 30_000);

test.each(['settings', 'authentication', 'shutdown'] as const)('actual %s revocation fences asynchronous key lookup before fetch or retention', async (kind) => {
  const f = await fixture(); const entered = barrier(); const release = barrier();
  f.setKey(async () => { entered.resolve(); await release.promise; return 'synthetic-browser-key'; });
  const paired = f.daemon.services.pairingTokens.mint({ name: 'Synthetic browser authority' });
  const pending = f.errorRef(paired.token).then(ref => f.wire(f.refusal(ref), { token: paired.token })).catch((error: unknown) => error);
  try {
    await entered.promise;
    if (kind === 'settings') {
      const config = f.daemon.services.configManager;
      const next = config.get('judgment.timeoutMs') === 11_000 ? 12_000 : 11_000;
      config.set('judgment.timeoutMs', next);
      expect(config.get('judgment.timeoutMs')).toBe(next);
    }
    if (kind === 'authentication') expect(f.daemon.services.pairingTokens.revoke(paired.id)).toBe(true);
    if (kind === 'shutdown') await f.daemon.services.browserJudgment!.close();
    release.resolve();
    const result = await pending;
    expect(result).not.toMatchObject({ status: 200 });
    expect(operationJudgmentRequests(f.calls)).toHaveLength(0);
    expect(f.daemon.services.judgment.decisionLog.query({ battery: ERROR })).toEqual([]);
  } finally { release.resolve(); await pending; await f.stop(); }
}, 30_000);
