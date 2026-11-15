/**
 * Native conversation intake keeps working through events that are not the input's fault: an unrelated
 * workspace registration, a provider outage, one caller's abort, an oversize transcript.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { createNativeConversationIntakeHost, type NativeConversationContinuationOwner } from '../platform/src/platform/workflow/work-ledger/native-intake.js';
import { canonicalNativeConversationContinuation, type NativeConversationContinuation } from '../platform/src/platform/workflow/work-ledger/native-continuation-context.js';
import type { NativeRequirementProposer } from '../platform/src/platform/workflow/work-ledger/native-intake-proposer.js';
import type { NativeConversationIntakeResult } from '../platform/src/platform/workflow/work-ledger/native-intake-wire.js';
import { makeRepo } from './contract/runner-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }

async function fixture(options: { proposer?: NativeRequirementProposer; continuation?: NativeConversationContinuationOwner } = {}) {
  const root = makeRepo(); mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json')); const token = tokens.mint({ name: 'Synthetic owned intake device' });
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: new GatewayMethodCatalog(),
    controlPlaneGateway: { touchWebSocketClient() {} } } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(token.token)!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'workspaces.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') });
  await scopes.add(root);
  const store = new KnowledgeStore({ dbPath: join(root, '.goodvibes', 'knowledge.sqlite') });
  const storage = await store.openNativeConversationStorage('project');
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const fake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, 'contract', 0.99);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.99);
    if (name.startsWith('part_')) return noulAnswer(0.01);
    if (name === 'refuse') return noulAnswer(0.99);
    return choiceAnswer(question, 'act', 0.99);
  });
  const port = withDecisionLog(fake.port, log);
  const proposer: NativeRequirementProposer = options.proposer ?? { async propose(input) { return { sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.text.length }] }; } };
  const deps = { projectId: 'project', projectRoot: root, sessionId: 'native-work:project', storage, scopes, port, decisionLog: log, proposer, ...(options.continuation ? { continuation: options.continuation } : {}) };
  const host = createNativeConversationIntakeHost(deps);
  const principalId = authority.current()!.principalId;
  cleanups.push(async () => { await host.close(); await store.close(); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });
  const original = { requestId: 'request-1', inputId: 'input-1', text: '  Add JSON export.\r\nKeep CSV unchanged.  ', unsupportedSources: [] };
  const target = (value: Exclude<NativeConversationIntakeResult, { kind: 'not-found' }>) => ({ inputId: value.sourceRef.inputId, sourceRevision: value.sourceRef.sourceRevision });
  return { root, authority, scopes, storage, host, principalId, original, target, capture: () => host.capture(original, authority) };
}

test('registering or declining unrelated workspaces does not strand a captured input', async () => {
  const f = await fixture();
  const captured = await f.capture();
  const elsewhere = mkdtempSync(join(tmpdir(), 'intake-other-root-')); cleanups.push(async () => { rmSync(elsewhere, { recursive: true, force: true }); });
  await f.scopes.add(elsewhere);
  await f.scopes.decline(join(elsewhere, 'private'));
  expect(await f.host.get({ inputId: f.original.inputId }, f.authority)).toEqual(captured);
  expect(await f.host.cancel(f.target(captured), f.authority)).toMatchObject({ kind: 'cancelled' });
});

test('a provider outage does not spend the proposal budget, so retrying still admits the input', async () => {
  let calls = 0;
  const f = await fixture({ proposer: { async propose(input) {
    if (++calls <= 3) throw new Error('provider unavailable');
    return { sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.text.length }] };
  } } });
  const captured = await f.capture(); const target = f.target(captured);
  await expect(f.host.admit(target, f.authority)).rejects.toThrow();
  await expect(f.host.resume(target, f.authority)).rejects.toThrow();
  await expect(f.host.resume(target, f.authority)).rejects.toThrow();
  expect(f.storage.current({ principalId: f.principalId, inputId: target.inputId })?.proposalsSpent).toBe(0);
  expect(await f.host.resume(target, f.authority)).toMatchObject({ kind: 'work' });
});

test('one caller aborting a shared capture does not fail the other caller', async () => {
  const entered = deferred(), release = deferred();
  const messages = [{ role: 'user' as const, content: 'Earlier.' }];
  const snapshot = (): NativeConversationContinuation => ({ sessionId: 'hosted-owned', revision: createHash('sha256').update(canonicalNativeConversationContinuation('hosted-owned', messages)).digest('hex'), messages });
  const f = await fixture({ continuation: { async capture() { entered.resolve(); await release.promise; return snapshot(); }, assertCurrent() {} } });
  const command = { ...f.original, continuation: { sessionId: 'hosted-owned' } };
  const controller = new AbortController();
  const first = f.host.capture(command, f.authority, { signal: controller.signal });
  await entered.promise;
  const second = f.host.capture(command, f.authority);
  controller.abort(); release.resolve();
  await expect(first).rejects.toThrow();
  expect(await second).toMatchObject({ kind: 'captured' });
});

test('a long session transcript is captured: the record has no size ceiling', async () => {
  const messages = [{ role: 'user' as const, content: 'x'.repeat(1_200_000) }];
  const f = await fixture({ continuation: { async capture() {
    return { sessionId: 'hosted-owned', revision: createHash('sha256').update(canonicalNativeConversationContinuation('hosted-owned', messages)).digest('hex'), messages };
  }, assertCurrent() {} } });
  expect(await f.host.capture({ ...f.original, continuation: { sessionId: 'hosted-owned' } }, f.authority)).toMatchObject({ kind: 'captured' });
});

test('a running input does not re-read its owners while it waits on a model', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ proposer: { async propose(input) {
    entered.resolve(); await release.promise;
    return { sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.text.length }] };
  } } });
  const captured = await f.capture();
  const watchers: Array<{ tick: () => void; everyMs: number }> = [];
  const realSetInterval = globalThis.setInterval;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, everyMs?: number) => {
    const handle = realSetInterval(() => {}, 1_000_000); handle.unref?.();
    watchers.push({ tick: callback, everyMs: everyMs ?? 0 });
    return handle;
  }) as unknown as typeof setInterval);
  try {
    const running = f.host.admit(f.target(captured), f.authority);
    await entered.promise;
    const checks = spyOn(f.scopes, 'currentScope');
    // One second of any timer the host scheduled: none reads the workspace registry.
    for (const watcher of watchers) for (let elapsed = 0; elapsed < 1_000; elapsed += Math.max(1, watcher.everyMs)) watcher.tick();
    expect(checks.mock.calls.length).toBe(0);
    release.resolve();
    expect((await running).kind).toBe('work');
  } finally { interval.mockRestore(); }
});
