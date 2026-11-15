/**
 * Automatic and explicit native settlement: a failure keeps a fixed reason
 * code beside the failed state, and a settled attempt is terminal.
 */
import { checkSettings } from '../platform/src/platform/contract/check.js';
import { CONTRACT_CONFIG_DEFAULTS } from '../platform/src/platform/contract/config.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createWorkLedger } from '../platform/src/platform/workflow/work-ledger/service.js';
import { createNativeWorkExecutionHost } from '../platform/src/platform/workflow/work-ledger/native-execution.js';
import { criteriaSetIdForWork } from '../platform/src/platform/contract/durable-admission.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { makeRepo, makeHarness, oneUnitPlan, runnerPort, waitFor, type Harness, type HarnessOptions } from './contract/runner-support.js';
import { finishes } from './contract/steps-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { harness?: Partial<HarnessOptions>; decoratePort?: (port: JudgmentPort) => JudgmentPort; register?: boolean; automatic?: boolean; source?: { goal: string; criteria: string[] }; settlementAnswers?: Parameters<typeof runnerPort>[0] } = {}) {
  const root = makeRepo(); mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const tokens = new PairingTokenManager(join(root, '.goodvibes', 'pairing.json'));
  const paired = tokens.mint({ name: 'Owned synthetic test device' });
  const catalog = new GatewayMethodCatalog();
  const helper = new DaemonControlPlaneHelper({ pairingTokens: tokens, authToken: () => 'synthetic-shared', gatewayMethods: catalog, controlPlaneGateway: { touchWebSocketClient() {} },
    userAuth: { validateSession: (value: string) => value === 'synthetic-user-session' ? { username: 'owner' } : null, getUser: () => ({ username: 'owner', roles: ['admin'] }) } } as unknown as DaemonControlPlaneContext);
  const authority = helper.createNativeExecutionAuthority(paired.token)!;
  const scopes = new WorkspaceRegistrationStore({ path: join(root, '.goodvibes', 'registrations.json'), homeDir: join(root, 'home'), daemonStateDir: join(root, '.goodvibes', 'daemon') });
  if (options.register !== false) await scopes.add(root);
  const store = new KnowledgeStore({ dbPath: join(root, '.goodvibes', 'knowledge.sqlite') });
  const ledgerStorage = await store.openWorkLedgerStorage('project');
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: ledgerStorage, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  const created = await ledger.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Small display label', goal: options.source?.goal ?? 'Preserve the complete goal.\nKeep all original requirements ☃.', criteria: options.source?.criteria ?? ['Keep the exact parser behavior.', 'Keep the ordered second requirement.'] }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('fixture create failed');
  const claimed = await ledger.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('fixture claim failed');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
  const log = new SqliteDecisionLog(join(root, '.goodvibes', 'decisions.sqlite'));
  const fake = runnerPort(options.settlementAnswers);
  const port = options.decoratePort?.(withDecisionLog(fake.port, log)) ?? withDecisionLog(fake.port, log);
  const storage = await store.openNativeWorkExecutionStorage('project');
  const hostOptions = { projectId: 'project', projectRoot: root, sessionId: 'native-fixture', storage, scopes, port, decisionLog: log, verification: { settings: () => checkSettings(CONTRACT_CONFIG_DEFAULTS), readAccessFilter: options.harness?.readAccessFilter ?? (async () => true), automatic: options.automatic ?? false } };
  const host = createNativeWorkExecutionHost(hostOptions);
  const plan = oneUnitPlan(2); plan.goal = work.goal; plan.criteria = work.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text }));
  plan.groups[0]!.units[0]!.criteria = work.criteria.map((_text, index) => ({ id: `u1.c${index + 1}`, text: `Original requirement ${index + 1} holds`, serves: [`c${index + 1}`] }));
  const harness = makeHarness({ root, plan, scripts: { u1: finishes('complete native result') }, decisionLog: log,
    nativeDecisions: host.nativeOwner.decisions, durableAdmission: host.nativeOwner.admission, ...options.harness });
  host.attachRunner(harness.runner);
  cleanups.push(async () => { await host.close(); harness.dispose(); await Promise.all(harness.runner.list({ includeTerminal: true }).map(item => harness.runner.join(item.id))); await ledger.service.close(); await store.close(); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });
  return { root, tokens, paired, catalog, helper, authority, scopes, store, ledger, actor, work, target, get key() { const current = storage.currentByAttempt(target.attemptId); return current.record?.request.key ?? current.intent?.request.key ?? key; }, log, storage, host, hostOptions, harness, plan };
}
async function completed(harness: Harness, id: string) {
  await waitFor(() => ['passed', 'failed', 'cancelled'].includes(harness.runner.get(id)?.status ?? ''), 'native bridge completion', 15000);
  await harness.runner.join(id); return harness.runner.get(id)!;
}


test('a settlement that fails reports a fixed reason code, and a later success clears it', async () => {
  const f = await fixture();
  const started = await f.host.start(f.target, f.authority);
  await completed(f.harness, started.admission.contractId);
  const realSettings = f.hostOptions.verification.settings;
  f.hostOptions.verification.settings = () => { throw new Error('synthetic settings failure /private/path'); };
  await expect(f.host.settle(f.key, f.authority)).rejects.toThrow();
  const failed = f.host.status(f.key, f.authority);
  expect(failed.settlement).toEqual({ state: 'failed' });
  expect(failed.settlementFailure).toBe('verification-failed');
  expect(JSON.stringify(failed.settlementFailure)).not.toContain('private');

  f.hostOptions.verification.settings = realSettings;
  const receipt = await f.host.settle(f.key, f.authority);
  expect(receipt.attestation.outcome).toBe('verified');
  const settled = f.host.status(f.key, f.authority);
  expect(settled.settlement?.state).toBe('published');
  expect(settled.settlementFailure).toBeUndefined();
  expect(settled.recovery).toBe('terminal');
});
