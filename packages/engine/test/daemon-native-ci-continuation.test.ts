import * as capturedExec from '../platform/src/platform/tools/exec/captured-exec.ts';
import * as nativeHostFactory from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution';
import { SQLiteStore } from '@goodvibes-jev/engine/platform/platform/state';
import { createHash } from 'node:crypto';
import * as crypto from 'node:crypto';
// An attacker may recompute the public record hash; this cannot mint private issuance.
const nativeCiDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
function observeFailureBindingHashes(brief: unknown) {
  const serialized = JSON.stringify(brief, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const create = crypto.createHash, reads: Array<() => readonly unknown[]> = [], restores: Array<() => void> = [];
  const hash = spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
    const hasher = create(algorithm, options);
    if (algorithm === 'sha256') {
      const update = spyOn(hasher, 'update'); reads.push(() => update.mock.calls.map(([input]) => input));
      restores.push(() => update.mockRestore());
    }
    return hasher;
  });
  return { count: () => reads.flatMap(read => read()).filter(input => input === serialized).length,
    restore() { for (const restore of restores) restore(); hash.mockRestore(); } };
}
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { createNativeWorkSubmissionHost } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-submission';
import { CiWatchAutoMinter, CiWatchService, CiWatchStore } from '@goodvibes-jev/engine/platform/platform/ci-watch';
import { startAdmittedCiRepair } from '@goodvibes-jev/engine/platform/platform/ci-watch';
import { nativeCiWatchOwner } from '../platform/src/platform/ci-watch/native-owner.js';
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { KnowledgeStore } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/platform/platform/runtime/client-services';
import { RuntimeEventBus } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import { BenchmarkStore, ProviderRegistry, type ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import type { LLMProvider, ChatRequest, ChatResponse } from '@goodvibes-jev/engine/platform/platform/providers';
import { createWorkLedger } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import { PairingTokenManager } from '@goodvibes-jev/engine/platform/platform/pairing';
import { WorkspaceRegistrationStore } from '@goodvibes-jev/engine/platform/platform/workspace';
import type { NativePairedExecutionAuthority } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution';
import { createDaemonNativeWorkExecutionActivation } from '../../../products/daemon/src/runtime/native-work-execution-activation.js';
import { makeOwnedTempDir } from '../../../products/daemon/src/test/helpers/owned-temp.js';

// Yields to the event loop between checks instead of reading the wall clock; the attempt budget only turns a
// condition that never holds into a labelled failure.
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  for (let attempt = 0; !(await predicate()); attempt++) {
    if (attempt >= 200000) throw new Error(`Timed out: ${label}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
const isWorkerRequest = (request: ChatRequest): boolean => request.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('Contract goal:'));
const answer = (content: string): ChatResponse => ({ content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' });

async function fixture(pairingOwner?: PairingTokenManager) {
  const root = makeOwnedTempDir('native-activation'); const workspace = join(root, 'workspace');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), '# Owned native fixture\n');
  const remote = join(root, 'remote.git');
  if (spawnSync('git', ['init', '--bare', '-q', remote]).status !== 0) throw new Error('Fixture remote failed');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['remote', 'add', 'origin', remote], ['add', '.'], ['commit', '-qm', 'Fixture']])
    if (spawnSync('git', args, { cwd: workspace }).status !== 0) throw new Error('Fixture git failed');
  const configManager = new ConfigManager({ workingDir: workspace, homeDir: root, configDir: join(root, 'config'), surfaceRoot: 'daemon' });
  const gatewayMethods = new GatewayMethodCatalog();
  const continuationScopeOwner = gatewayMethods.attachScopePolicyOwner(() => configManager.invalidateExternalPolicy(),
    snapshot => configManager.getDurableGatewayPolicyRevision(snapshot));
  const runtimeBus = new RuntimeEventBus();
  let approvals = 0;
  const services = createClientRuntimeServices({ workspaceTrust: null, configManager, runtimeBus, runtimeStore: createRuntimeStore(),
    surfaceRoot: 'daemon', workingDir: workspace, homeDirectory: root, requestApproval: async () => { approvals++; return { approved: false }; }, modelDiscovery: 'skip' });
  const log = new SqliteDecisionLog(join(root, 'decisions.sqlite'));
  const readings = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(name === 'checkable' || name.startsWith('fit') ? 0.99 : 0.01);
    if (question.type === 'score') return scoreAnswer(question, 0, 0.99);
    const choices = question.type === 'choice' ? Object.keys(question.criteria) : [];
    const preferred: Record<string, string> = { disposition: 'act', relation: 'supports', role: 'implement', tier: 'standard', intent: 'chat', strategy: 'single', category: 'unknown', connection_failure: 'none' };
    const pick = preferred[name];
    return choiceAnswer(question, pick && choices.includes(pick) ? pick : choices.find(key => key !== 'none')!, 0.99);
  });
  const port = withDecisionLog(readings.port, log); const previous = installJudgmentPort(port);
  const goal = 'Update README and publish the prepared repository through the native worker. Preserve the complete original request.';
  const criteria = ['The answer says native execution is complete.', 'Preserve this second requirement after the first: evidence remains separate. ☃'];
  const plan = { goal, criteria: criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text })), groups: [{
    id: 'g1', title: 'Answer', goal, kind: 'work', dependsOn: [], criteria: [], units: [{ id: 'u1', title: 'Answer', goal,
      role: 'implement', brief: 'Update README, publish the prepared repository with git push origin main, then say native execution is complete.', dependsOn: [], files: [], criteria: criteria.map((text, index) => ({ id: `u1.c${index + 1}`, text, serves: [`c${index + 1}`] })) }],
  }] };
  const requests: ChatRequest[] = [];
  let hold: ((request: ChatRequest) => Promise<ChatResponse>) | undefined;
  const provider = { name: 'native-fixture', models: ['model'], credentialAuthority: 'anonymous', modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true, async chat(request: ChatRequest) {
      requests.push(request);
      if (request.systemPrompt?.includes('You plan a contract')) return answer(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``);
      return hold ? hold(request) : answer('native execution is complete');
    } } as unknown as LLMProvider;
  const model = { id: 'model', provider: 'native-fixture', registryKey: 'native-fixture:model', displayName: 'Native fixture model', description: 'Synthetic test model',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100000, selectable: true, tier: 'standard' } as unknown as ModelDefinition;
  await services.providerRegistry.ready();
  await services.providerRegistry.modelDiscoverySettled();
  services.providerRegistry.registerRuntimeProvider({ provider, models: [model], replace: true });
  // Routing must never select a built-in local proxy or make a live request.
  const catalog = spyOn(services.providerRegistry, 'listModels').mockReturnValue([model]);
  services.providerRegistry.setCurrentModel(model.registryKey);
  const knowledgeStore = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: await knowledgeStore.openWorkLedgerStorage('project'),
    clock: { now: () => Date.now(), newId: kind => `${kind}-${++id}` } });
  const tokens = pairingOwner ?? new PairingTokenManager(join(root, 'pairing.json')); const paired = tokens.mint({ name: 'Synthetic fixture' });
  const scopesGranted = ['read:work-ledger', 'write:work-ledger', 'write:fleet'].sort();
  const authority: NativePairedExecutionAuthority = {
    current() { const current = tokens.authenticateNative(paired.token); return current ? { ...current, scopes: scopesGranted } : null; },
    issueContinuation(binding, assertCurrent, sourceBinding) { return tokens.issueNativeContinuation(paired.token, authority.current()!, binding, assertCurrent, sourceBinding); },
    withCurrent(expected, callback) { return tokens.withNativeAuthority(paired.token, expected, assertCurrent => callback(() => ({ ...assertCurrent(), scopes: scopesGranted }))); },
  };
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  const scopes = new WorkspaceRegistrationStore({ path: join(root, 'registrations.json'), homeDir: root, daemonStateDir: join(root, '.goodvibes') });
  await scopes.add(workspace);
  const submission = createNativeWorkSubmissionHost({ projectRoot: workspace, projectId: 'project', sessionId: 'native-fixture',
    service: ledger.service, authority: ledger.authority, scopes });
  const submitted = await submission.submit({ requestId: 'submit-native', inputId: 'original-source', expectedRevision: 0, goal, criteria }, authority);
  const target = { workId: submitted.receipt.workId, workRevision: submitted.receipt.expectedRevision.work,
    criteriaRevision: submitted.receipt.expectedRevision.criteria, attemptId: submitted.receipt.attemptId, attemptRevision: submitted.receipt.expectedRevision.attempt };
  let observer: ((tool: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  const options = { runtimeBus, configManager, providerRegistry: services.providerRegistry, projectRoot: workspace,
    projectId: 'project', sessionId: 'native-fixture', knowledgeStore, nativeScopes: scopes, judgmentPort: port, decisionLog: log, continuationGrants: tokens, continuationScopeOwner,
    acpHost: { list: () => [] }, permissionManager: services.permissionManager, hookDispatcher: services.hookDispatcher, featureFlags: services.featureFlags,
    toolDependencies: { ...services, toolExecutionObserver: (tool: string, args: Record<string, unknown>, success: boolean) => observer?.(tool, args, success), contractHooks: services.contractRunner.hooks(), workflowServices: services.workflow } };
  const activation = createDaemonNativeWorkExecutionActivation(options);
  return { root, workspace, activation, gatewayMethods, continuationScopeOwner, options, services, target, authority, paired, tokens, scopes, ledger, actor, knowledgeStore, requests, readings, log, goal, criteria,
    approvalCount: () => approvals,
    observe(value: typeof observer) { observer = value; },
    hold(fn: typeof hold) { hold = fn; },
    async close() { continuationScopeOwner.close(); await submission.close(); await activation.close(); await ledger.service.close(); await knowledgeStore.close(); catalog.mockRestore(); installJudgmentPort(previous); services.dispose(); log[Symbol.dispose](); } };
}


type Fixture = Awaited<ReturnType<typeof fixture>>;
type Execution = Awaited<ReturnType<ReturnType<typeof createDaemonNativeWorkExecutionActivation>['acquire']>>;
type CheckResult = Awaited<ReturnType<CiWatchService['checkWatch']>>;
type FailureBrief = { repo: string; ref: string; failingJobs: string[]; logs: string;
  jobs: Array<{ name: string; status: 'completed'; conclusion: string; headSha: string; runId: string; jobId: string }> };
type ContinuationRecord = NonNullable<ReturnType<NonNullable<Awaited<ReturnType<KnowledgeStore['openNativeWorkExecutionStorage']>>['continuations']>['current']>['record']>;

interface Scenario {
  f: Fixture; execution: Execution; source: { fetchJobs(): Promise<FailureBrief['jobs']>; fetchFailureLogs(): Promise<string> };
  ci: CiWatchService; lifetime: AbortController; logs: string; warnings: unknown[]; original: Awaited<ReturnType<Execution['start']>>;
  watches: Awaited<ReturnType<CiWatchService['listWatches']>>; issued: Extract<ContinuationRecord, { version: 2 }>;
  restarted?: ReturnType<typeof createDaemonNativeWorkExecutionActivation>; reopenedKnowledge?: KnowledgeStore; reopenedScope?: ReturnType<GatewayMethodCatalog['attachScopePolicyOwner']>;
  gate: { repairBlocked: boolean; holdOriginalJoin: boolean; releaseRepair: (() => void) | undefined }; delegatedAuthority?: NativePairedExecutionAuthority;
}
interface ScenarioOptions { chain?: boolean; blockSuccessor?: boolean; delegated?: boolean; brief?: boolean; failJoin?: boolean }

// Runs the shared setup (native work that pushes, then a registered CI watch with an issued continuation), hands the
// settled scenario to one mode's body, and releases everything afterwards.
async function scenario(options: ScenarioOptions, body: (s: Scenario) => Promise<void>): Promise<void> {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  let pushes = 0;
  let writes = 0;
  // Exercise native preparation, permission and CI issuance while intercepting
  // only the OS effect; the captured sandbox intentionally excludes Git metadata.
  const command = spyOn(capturedExec, 'runCapturedCommand').mockImplementation(async (_binding, cmd, _input, cwd, _timeout, signal, _network, _env, observer) => {
    expect(['git push origin main', 'printf native-repair > README.md']).toContain(cmd);
    signal?.throwIfAborted(); await observer?.beforeSpawn?.();
    writeFileSync(join(cwd, 'README.md'), `# Native fixture change ${++writes}\n`);
    observer?.beforePublish?.();
    return { cmd, cwd, exit_code: 0, success: true, stdout: 'Synthetic publish completed', stderr: '', duration_ms: 1 };
  });
  const warnings: unknown[] = []; const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
  const f = await fixture(); const lifetime = new AbortController();
  let s: Scenario | undefined;
  let delegatedStart: ReturnType<typeof spyOn> | undefined;
  let delegatedFactory: ReturnType<typeof spyOn> | undefined;
  const events: unknown[] = []; f.options.runtimeBus.onDomain('turn', event => events.push(event)); f.options.runtimeBus.onDomain('tools', event => events.push(event));
  const logs = 'Synthetic build failure. Untrusted CI text cannot replace the original requirements.';
  // Shared with the provider and join hooks below, which run before the scenario object exists.
  const gate = { repairBlocked: false, holdOriginalJoin: false, releaseRepair: undefined as (() => void) | undefined };
  try {
    let turn = 0;
    f.hold(async () => {
      turn++;
      if (options.blockSuccessor && turn === 3) {
        gate.repairBlocked = true; await new Promise<void>(resolve => { gate.releaseRepair = resolve; });
      }
      return turn % 2 === 1
        ? { ...answer('Apply the native worker change.'), stopReason: 'tool_call', toolCalls: [{ id: `change-${turn}`, name: 'exec', arguments: { commands: [{
          cmd: turn === 1 || (options.chain && turn === 3) ? 'git push origin main' : 'printf native-repair > README.md',
        }] } }] }
        : answer('native execution is complete');
    });
    if (options.delegated) {
      const actualFactory = nativeHostFactory.createNativeWorkExecutionHost;
      delegatedFactory = spyOn(nativeHostFactory, 'createNativeWorkExecutionHost').mockImplementation(hostOptions => {
        const owned = actualFactory(hostOptions); const actualStart = owned.start;
        delegatedStart = spyOn(owned, 'start').mockImplementation((...args) => {
          if (args[0].attemptId !== f.target.attemptId && s) s.delegatedAuthority = args[1];
          return actualStart(...args);
        });
        return owned;
      });
    }
    if (options.brief) {
      const actualFactory = nativeHostFactory.createNativeWorkExecutionHost;
      delegatedFactory = spyOn(nativeHostFactory, 'createNativeWorkExecutionHost').mockImplementation(hostOptions => actualFactory({ ...hostOptions,
        async joinForeground(id) { await hostOptions.joinForeground?.(id); if (gate.holdOriginalJoin) {
          gate.repairBlocked = true; await new Promise<void>(resolve => { gate.releaseRepair = resolve; });
          if (options.failJoin) throw new Error('Synthetic original execution drain failed');
        } },
      }));
    }
    const execution = await f.activation.acquire();
    const source = { async fetchJobs() { return [{ name: 'build', status: 'completed' as const, conclusion: 'failure', headSha: 'sha-original', runId: 'run-original', jobId: 'job-original' }]; }, async fetchFailureLogs() { return logs; } };
    const store = new CiWatchStore(join(f.root, 'ci-watches.json'));
    const ci = new CiWatchService({ source, store,
      recoverOwner: watch => execution.recoverCiWatchOwner(watch),
      revokeOwner: watch => execution.revokeCiWatch(watch),
      autonomousRepair: request => startAdmittedCiRepair({ workspaceTrust: null, port: f.options.judgmentPort,
        permissionManager: f.services.permissionManager,
        config: f.options.configManager, signal: lifetime.signal }, request, async () => { throw new Error('Native repair must never use a compatibility starter'); }),
    });
    const minter = new CiWatchAutoMinter({ service: ci, workingDirectory: f.workspace,
      resolveRepoSlug: async () => 'fixture/native', resolveCurrentBranch: async () => 'main' });
    f.observe((tool, args, success) => {
      if (tool === 'exec' && success && JSON.stringify(args).includes('git push origin main')) pushes++;
      return minter.onToolExecuted(tool, args, success);
    });
    const original = await execution.start(f.target, f.authority);
    await waitFor(() => ['passed','failed','cancelled'].includes(execution.status(original.admission.key, f.authority).contract?.status ?? ''), 'original native work to finish').catch(error => { throw new Error(JSON.stringify({ error: String(error), status: execution.status(original.admission.key, f.authority), events, warnings, requests: f.requests.map(request => request.messages) })); });
    const originalResult = execution.status(original.admission.key, f.authority).contract!;
    expect(originalResult.status, JSON.stringify({ error: originalResult.error, events, requests: f.requests.map(request => ({ systemPrompt: request.systemPrompt?.slice(0,100), messages: request.messages })), pushes })).toBe('passed');
    expect(pushes, JSON.stringify({ events, requests: f.requests.map(request => request.messages), warnings })).toBe(1);
    await waitFor(async () => (await ci.listWatches()).length > 0, 'original CI watch registration');
    // The native owner pins the watch as it was registered; `expiresAt` and `repair` are the CI service's scheduling state.
    const watches = (await ci.listWatches()).map(({ expiresAt: _expiresAt, repair: _repair, ...identity }) => identity);
    expect(originalResult.nativeSource).toMatchObject({ goal: f.goal, criteria: f.criteria }); expect(watches, JSON.stringify(warnings)).toHaveLength(1);
    expect(watches[0]!.continuationId).toBeDefined();
    const continuationStorage = (await f.knowledgeStore.openNativeWorkExecutionStorage('project')).continuations!;
    const issued = continuationStorage.current(watches[0]!.continuationId!).record!;
    expect(issued.version).toBe(2);
    if (issued.version !== 2) throw new Error('Expected actual native CI2 publication');
    expect(issued.issue.successorAttemptId).toMatch(/^attempt-ci-[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/);
    expect(issued.issue.policyRevision).toBe(JSON.stringify([f.options.configManager.getDurableConfigurationIncarnation(), f.continuationScopeOwner.current().revision]));
    await waitFor(async () => (await store.load()).length > 0, 'CI watch persisted');
    expect(await store.load()).toHaveLength(1);
    await waitFor(() => execution.status(original.admission.key, f.authority).settlement?.state === 'published', 'original native settlement').catch(error => { throw new Error(JSON.stringify({ error: String(error), state: execution.status(original.admission.key, f.authority), warnings })); });
    s = { f, execution, source, ci, lifetime, logs, warnings, original, watches, issued, gate };
    await body(s);
  } finally {
    command.mockRestore(); delegatedFactory?.mockRestore(); delegatedStart?.mockRestore(); gate.releaseRepair?.(); lifetime.abort();
    s?.reopenedScope?.close(); await s?.restarted?.close(); await s?.reopenedKnowledge?.close(); await f.close();
    warn.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore();
  }
}

// Closes the original activation (unless the successor must keep running) and reopens everything from disk, as a daemon restart would.
async function restartDaemon(s: Scenario, options: { closeFirst: boolean; policyUnchanged?: boolean; now?: () => number }): Promise<CiWatchService> {
  const { f } = s;
  await waitFor(() => s.execution.status(s.original.admission.key, f.authority).settlement?.state === 'published', 'original native settlement').catch(error => { throw new Error(JSON.stringify({ error: String(error), state: s.execution.status(s.original.admission.key, f.authority), warnings: s.warnings })); });
  if (options.closeFirst) { f.continuationScopeOwner.close(); await f.activation.close(); }
  const configManager = new ConfigManager({ workingDir: f.workspace, homeDir: f.root, configDir: join(f.root, 'config'), surfaceRoot: 'daemon' });
  const gateway = new GatewayMethodCatalog();
  s.reopenedScope = gateway.attachScopePolicyOwner(() => configManager.invalidateExternalPolicy(),
    snapshot => configManager.getDurableGatewayPolicyRevision(snapshot));
  if (options.policyUnchanged) {
    expect(JSON.stringify([configManager.getDurableConfigurationIncarnation(), s.reopenedScope.current().revision]))
      .toBe(s.issued.issue.policyRevision);
  }
  s.reopenedKnowledge = new KnowledgeStore({ dbPath: join(f.root, 'knowledge.sqlite') });
  s.restarted = createDaemonNativeWorkExecutionActivation({ ...f.options, configManager, knowledgeStore: s.reopenedKnowledge,
    continuationGrants: new PairingTokenManager(join(f.root, 'pairing.json')), continuationScopeOwner: s.reopenedScope,
    nativeScopes: new WorkspaceRegistrationStore({ path: join(f.root, 'registrations.json'), homeDir: f.root, daemonStateDir: join(f.root, '.goodvibes') }) });
  s.execution = await s.restarted.acquire();
  const execution = s.execution;
  return new CiWatchService({ source: s.source, store: new CiWatchStore(join(f.root, 'ci-watches.json')), now: options.now,
    recoverOwner: watch => execution.recoverCiWatchOwner(watch),
    revokeOwner: watch => execution.revokeCiWatch(watch),
    autonomousRepair: request => startAdmittedCiRepair({ workspaceTrust: null, port: f.options.judgmentPort,
      permissionManager: f.services.permissionManager,
      config: configManager, signal: s.lifetime.signal }, request, async () => { throw new Error('Native recovery cannot use compatibility'); }) });
}

// The CI check must have started a genuine native successor that carries the original request and the CI evidence.
async function expectNativeSuccessor(s: Scenario, repaired: CheckResult) {
  const { f } = s;
  expect(repaired, JSON.stringify(repaired)).toMatchObject({ fixSessionTriggered: true });
  const current = (await f.ledger.service.readSnapshot(f.actor)).works[0]!;
  expect(current.attempt!.id).not.toBe(f.target.attemptId); expect(current.attempt!.predecessorId).toBe(f.target.attemptId);
  const successor = s.execution.statusByAttempt(current.work.id, current.attempt!.id, f.authority);
  expect(successor.kind).toBe('execution');
  if (successor.kind !== 'execution') throw new Error('No native successor receipt');
  expect(current.attempt!.id).toBe(s.issued.issue.successorAttemptId);
  expect(successor.execution.version).toBe(2);
  expect(successor.execution.request.binding.actionId).toBe(s.issued.issue.successorSourceBinding);
  await waitFor(() => s.execution.statusByAttempt(current.work.id, current.attempt!.id, f.authority).kind === 'execution'
    && f.requests.filter(isWorkerRequest).length >= 3, 'genuine native repair member');
  expect(successor.execution.request.input.nativeSource).toMatchObject({ sourceId: s.original.contract.nativeSource!.sourceId,
    sourceRevision: s.original.contract.nativeSource!.sourceRevision, goal: f.goal, criteria: f.criteria });
  expect(successor.execution.request.input.taskEvidence).toContain(s.logs);
  expect(f.log.query({ site: 'work-ledger.native-start' }).length).toBeGreaterThanOrEqual(2);
  expect(f.approvalCount()).toBe(0);
  expect(f.requests.some(request => isWorkerRequest(request) && JSON.stringify(request.messages).includes(s.logs))).toBe(true);
  expect(f.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
  return current;
}

// A perturbed authority must refuse the repair and leave only the original and its first worker turn behind.
async function expectRepairRefused(s: Scenario, polling: CiWatchService) {
  const repaired = await polling.checkWatch(s.watches[0]!.id);
  expect(repaired.fixSessionTriggered).toBe(false); expect(repaired.fixSessionError).toBeDefined();
  expect(s.f.requests.filter(isWorkerRequest)).toHaveLength(2);
}

async function withBlockedRepair(s: Scenario, body: (blocked: { brief: FailureBrief; repairing: Promise<unknown>; hashes: ReturnType<typeof observeFailureBindingHashes>; before: NonSharedBuffer }) => Promise<void>) {
  const operation = s.execution.recoverCiWatchOwner(s.watches[0]!)!, owner = nativeCiWatchOwner(operation)!;
  const brief: FailureBrief = { repo: 'fixture/native', ref: 'main', failingJobs: ['build'], logs: s.logs, jobs: [{ name: 'build', status: 'completed', conclusion: 'failure', headSha: 'sha-original', runId: 'run-original', jobId: 'job-original' }] };
  const hashes = observeFailureBindingHashes(brief), before = readFileSync(s.f.knowledgeStore.storagePath);
  s.gate.holdOriginalJoin = true; const repairing: Promise<unknown> = owner.startRepair(brief); void repairing.catch(() => {});
  try {
    await waitFor(() => s.gate.repairBlocked, 'actual native original execution drain');
    expect(hashes.count()).toBe(0);
    await body({ brief, repairing, hashes, before });
  } finally { hashes.restore(); s.gate.holdOriginalJoin = false; s.gate.releaseRepair?.(); await repairing.catch(() => {}); }
}

function flipPolicyAndBack(s: Scenario) {
  const before = s.f.options.configManager.get('display.showTokenSpeed');
  s.f.options.configManager.setRuntimeOverride('display.showTokenSpeed', !before); s.f.options.configManager.setRuntimeOverride('display.showTokenSpeed', before);
}

// The owner and its exact source must be refused cancellation without touching the paired-token file or the CI owner.
async function expectCancelRefused(s: Scenario, authority: NativePairedExecutionAuthority, key: typeof s.original.admission.key) {
  const before = readFileSync(join(s.f.root, 'pairing.json'), 'utf8');
  await expect(s.execution.cancel(key, authority, 'Must not revoke unrelated source')).rejects.toThrow();
  expect(readFileSync(join(s.f.root, 'pairing.json'), 'utf8')).toBe(before);
  expect(() => s.execution.recoverCiWatchOwner(s.watches[0]!)).not.toThrow();
}

// Cancels `key` with the continuation records removed, then restores them so recovery has to decide from the cancelled executions alone.
async function cancelWithRecordsRemoved(s: Scenario, key: typeof s.original.admission.key, delegated: boolean) {
  const { f } = s;
  const sqlite = (f.knowledgeStore as unknown as { sqlite: SQLiteStore }).sqlite;
  const backup = sqlite.readPersisted(db => ({
    continuation: db.exec('SELECT project_id,continuation_id,format_version,state_json FROM native_ci_continuations')[0]!.values,
    executions: db.exec('SELECT attempt_id,state_json FROM native_work_executions')[0]!.values,
    intents: db.exec('SELECT attempt_id,state_json FROM native_work_execution_intents')[0]!.values,
  }));
  if (!delegated) await sqlite.transactPersisted(db => { db.run('DELETE FROM native_ci_continuations'); return { changed: true, value: undefined }; }, () => {});
  if (delegated) {
    expect(s.delegatedAuthority).toBeDefined(); expect(s.delegatedAuthority!.current()).not.toBeNull();
    await expect(s.execution.cancel(key, s.delegatedAuthority!, 'Delegated owner retires its own source')).rejects.toThrow('recovery-required');
    expect(s.delegatedAuthority!.current()).toBeNull();
  } else await s.execution.cancel(key, f.authority, 'Authenticated owner cancels this exact source');
  await sqlite.transactPersisted(db => {
    db.run('DELETE FROM native_ci_continuations');
    for (const row of backup.continuation) db.run('INSERT INTO native_ci_continuations(project_id,continuation_id,format_version,state_json) VALUES (?,?,?,?)', [String(row[0]), String(row[1]), Number(row[2]), String(row[3])]);
    for (const row of backup.executions) db.run('UPDATE native_work_executions SET state_json=? WHERE attempt_id=?', [String(row[1]),String(row[0])]);
    for (const row of backup.intents) db.run('UPDATE native_work_execution_intents SET state_json=? WHERE attempt_id=?', [String(row[1]),String(row[0])]);
    return { changed: true, value: undefined };
  }, () => {});
}

async function successorKey(s: Scenario) {
  expect((await s.ci.checkWatch(s.watches[0]!.id)).fixSessionTriggered).toBe(true);
  const latest = (await s.f.ledger.service.readSnapshot(s.f.actor)).works[0]!;
  const successor = s.execution.statusByAttempt(latest.work.id, latest.attempt!.id, s.f.authority);
  if (successor.kind !== 'execution') throw new Error('Missing successor execution');
  const key = successor.execution.request.key;
  await waitFor(() => s.execution.status(key, s.f.authority).settlement?.state === 'published', 'successor settlement before cancellation');
  // The original watch retired when its repair started, and the successor has issued no new watch/grant.
  expect(await s.ci.listWatches()).toHaveLength(0);
  return key;
}

const name = (mode: string) => `registered native CI continuation: ${mode}`;
const TIMEOUT = 60000;

test(name('direct'), () => scenario({}, async s => {
  await expectNativeSuccessor(s, await s.ci.checkWatch(s.watches[0]!.id));
}), TIMEOUT);

test(name('restart'), () => scenario({}, async s => {
  const polling = await restartDaemon(s, { closeFirst: true, policyUnchanged: true });
  await expectNativeSuccessor(s, await polling.checkWatch(s.watches[0]!.id));
}), TIMEOUT);

test(name('concurrent'), () => scenario({}, async s => {
  const [repaired] = await Promise.all([s.ci.checkWatch(s.watches[0]!.id), s.ci.checkWatch(s.watches[0]!.id)]);
  const current = await expectNativeSuccessor(s, repaired!);
  // The started repair retired the watch, so no later check can start a second one.
  expect(repaired!.retired).toBe(true);
  await expect(s.ci.checkWatch(s.watches[0]!.id)).rejects.toThrow('No CI watch');
  const snapshot = await s.f.ledger.service.readSnapshot(s.f.actor); expect(snapshot.works[0]!.attempt!.id).toBe(current.attempt!.id);
}), TIMEOUT);

test(name('chain'), () => scenario({ chain: true }, async s => {
  const current = await expectNativeSuccessor(s, await s.ci.checkWatch(s.watches[0]!.id));
  await waitFor(async () => (await s.ci.listWatches()).some(watch => watch.continuationId !== s.watches[0]!.continuationId), 'chained CI watch registration');
  const nextWatch = (await s.ci.listWatches()).find(watch => watch.continuationId !== s.watches[0]!.continuationId);
  expect(nextWatch, JSON.stringify(s.warnings)).toBeDefined();
  const next = await s.ci.checkWatch(nextWatch!.id);
  expect(next.fixSessionTriggered, JSON.stringify(next)).toBe(true);
  const snapshot = await s.f.ledger.service.readSnapshot(s.f.actor); expect(snapshot.works[0]!.attempt!.predecessorId).toBe(current.attempt!.id);
}), TIMEOUT);

test(name('partial-claim-restart'), () => scenario({}, async s => {
  const { f } = s;
  const consume = f.tokens.consumeNativeContinuation.bind(f.tokens);
  const consumptionFault = spyOn(f.tokens, 'consumeNativeContinuation').mockImplementation((...args) => { consume(...args); throw new Error('Synthetic response loss after private consumption'); });
  try {
    const partial = await s.ci.checkWatch(s.watches[0]!.id);
    expect(partial.fixSessionTriggered).toBe(false);
    expect(partial.fixSessionError).toBe('Synthetic response loss after private consumption');
    expect(f.requests.filter(isWorkerRequest)).toHaveLength(2);
  } finally { consumptionFault.mockRestore(); }
  // A repair that failed to start waits out its backoff, saved with the watch, before it is tried again.
  const polling = await restartDaemon(s, { closeFirst: true, policyUnchanged: true, now: () => Date.now() + 5 * 60_000 });
  await expectNativeSuccessor(s, await polling.checkWatch(s.watches[0]!.id));
}), TIMEOUT);

test(name('launched-restart'), () => scenario({ blockSuccessor: true }, async s => {
  expect((await s.ci.checkWatch(s.watches[0]!.id)).fixSessionTriggered).toBe(true);
  await waitFor(() => s.gate.repairBlocked, 'actual successor member effect');
  // The started repair retired the watch on disk, so the restarted daemon has nothing that could launch a second one.
  const polling = await restartDaemon(s, { closeFirst: false, policyUnchanged: true });
  expect(await polling.listWatches()).toHaveLength(0);
  await expect(polling.checkWatch(s.watches[0]!.id)).rejects.toThrow('No CI watch');
  expect(s.f.requests.filter(isWorkerRequest)).toHaveLength(3);
}), TIMEOUT);

test(name('brief-mutation'), () => scenario({ brief: true }, async s => {
  const { f } = s;
  await withBlockedRepair(s, async ({ brief, repairing, hashes }) => {
    brief.logs = 'Changed while original work drained'; brief.failingJobs[0] = 'changed'; brief.jobs[0]!.headSha = 'changed';
    s.gate.holdOriginalJoin = false; s.gate.releaseRepair?.(); await repairing;
    expect(hashes.count()).toBe(1);
    const work = (await f.ledger.service.readSnapshot(f.actor)).works[0]!, next = s.execution.statusByAttempt(work.work.id, work.attempt!.id, f.authority);
    if (next.kind !== 'execution') throw new Error('Missing actual native repair');
    expect(next.execution.request.input.taskEvidence).toContain(s.logs); expect(next.execution.request.input.taskEvidence).not.toContain(brief.logs);
    expect(next.execution.request.binding.actionId).toBe(s.issued.issue.successorSourceBinding);
  });
}), TIMEOUT);

test(name('brief-close-drain'), () => scenario({ brief: true }, async s => {
  const { f } = s;
  await withBlockedRepair(s, async ({ repairing, hashes }) => {
    let finished = false; const closing = f.activation.close().then(() => { finished = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0)); expect(finished).toBe(false);
    s.gate.holdOriginalJoin = false; s.gate.releaseRepair?.(); await expect(repairing).rejects.toThrow(); await closing;
    expect(hashes.count()).toBe(0);
    expect(finished).toBe(true); expect((await f.ledger.service.readSnapshot(f.actor)).works[0]!.attempt!.id).toBe(f.target.attemptId);
    expect(f.requests.filter(isWorkerRequest)).toHaveLength(2);
  });
}), TIMEOUT);

test(name('brief-join-failure'), () => scenario({ brief: true, failJoin: true }, async s => {
  const { f } = s;
  await withBlockedRepair(s, async ({ repairing, hashes, before }) => {
    s.gate.holdOriginalJoin = false; s.gate.releaseRepair?.(); await expect(repairing).rejects.toThrow();
    expect(hashes.count()).toBe(0);
    expect(readFileSync(f.knowledgeStore.storagePath)).toEqual(before);
    expect((await f.ledger.service.readSnapshot(f.actor)).works[0]!.attempt!.id).toBe(f.target.attemptId);
    expect(f.requests.filter(isWorkerRequest)).toHaveLength(2);
  });
}), TIMEOUT);

test(name('brief-scope-retired'), () => scenario({ brief: true }, async s => {
  const { f } = s;
  await withBlockedRepair(s, async ({ repairing, hashes, before }) => {
    expect((await f.scopes.remove(f.workspace)).removed).toBe(true);
    s.gate.holdOriginalJoin = false; s.gate.releaseRepair?.(); await expect(repairing).rejects.toThrow();
    expect(hashes.count()).toBe(0);
    expect(readFileSync(f.knowledgeStore.storagePath)).toEqual(before);
    expect((await f.ledger.service.readSnapshot(f.actor)).works[0]!.attempt!.id).toBe(f.target.attemptId);
    expect(f.requests.filter(isWorkerRequest)).toHaveLength(2);
  });
}), TIMEOUT);

test(name('policy-aba-restart'), () => scenario({}, async s => {
  flipPolicyAndBack(s);
  await expectRepairRefused(s, await restartDaemon(s, { closeFirst: true }));
}), TIMEOUT);

test(name('delete-after-policy-restart'), () => scenario({}, async s => {
  flipPolicyAndBack(s);
  const polling = await restartDaemon(s, { closeFirst: true });
  expect(await polling.deleteWatch(s.watches[0]!.id)).toBe(true);
  expect(() => s.execution.recoverCiWatchOwner(s.watches[0]!)).toThrow();
}), TIMEOUT);

test(name('catalog-aba-restart'), () => scenario({}, async s => {
  const descriptor = s.f.gatewayMethods.get('workLedger.snapshot')!;
  s.f.gatewayMethods.unregister(descriptor.id); s.f.gatewayMethods.register(descriptor);
  await expectRepairRefused(s, await restartDaemon(s, { closeFirst: true }));
}), TIMEOUT);

test(name('ledger-aba'), () => scenario({}, async s => {
  const { f } = s;
  for (const type of ['reopen', 'claim'] as const) {
    const snapshot = await f.ledger.service.readSnapshot(f.actor);
    const result = await f.ledger.service.execute({ type, workId: f.target.workId, requestId: `external-${type}`, expectedRevision: snapshot.revision,
      ...(type === 'reopen' ? { reason: 'Explicit owner reopened the source' } : {}) }, f.actor);
    expect(result.kind).toBe('accepted');
  }
  await expectRepairRefused(s, s.ci);
}), TIMEOUT);

test(name('token-revoke'), () => scenario({}, async s => {
  s.f.tokens.revoke(s.f.paired.id);
  await expectRepairRefused(s, s.ci);
}), TIMEOUT);

test(name('scope-aba'), () => scenario({}, async s => {
  await s.f.scopes.remove(s.f.workspace); await s.f.scopes.add(s.f.workspace);
  await expectRepairRefused(s, s.ci);
}), TIMEOUT);

test(name('watch-edit'), () => scenario({}, async s => {
  expect(() => s.execution.recoverCiWatchOwner({ ...s.watches[0]!, repo: 'unissued/target' })).toThrow();
  expect(() => s.execution.recoverCiWatchOwner({ ...s.watches[0]!, continuationId: 'unissued-grant' })).toThrow();
}), TIMEOUT);

for (const mode of ['record-edit', 'record-forge'] as const) test(name(mode), () => scenario({}, async s => {
  const sqlite = (s.f.knowledgeStore as unknown as { sqlite: SQLiteStore }).sqlite;
  await sqlite.transactPersisted(db => {
    const row = JSON.parse(String(db.exec('SELECT state_json FROM native_ci_continuations')[0]!.values[0]![0]));
    if (mode === 'record-edit') row.watch.repo = 'edited/together';
    else { row.issue.successorSourceBinding = 'f'.repeat(64); row.grant.binding = nativeCiDigest(row.issue); }
    db.run('UPDATE native_ci_continuations SET state_json = ?', [JSON.stringify(row)]);
    return { changed: true, value: undefined };
  }, () => {});
  expect(() => s.execution.recoverCiWatchOwner(mode === 'record-edit' ? { ...s.watches[0]!, repo: 'edited/together' } : s.watches[0]!)).toThrow();
}), TIMEOUT);

test(name('delete-replay'), () => scenario({}, async s => {
  expect(await s.ci.deleteWatch(s.watches[0]!.id)).toBe(true);
  expect(() => s.execution.recoverCiWatchOwner(s.watches[0]!)).toThrow();
}), TIMEOUT);

test(name('closed-owner'), () => scenario({}, async s => {
  const owned = s.execution.recoverCiWatchOwner(s.watches[0]!)!;
  await s.f.activation.close(); expect(() => owned.assertCurrent()).toThrow();
}), TIMEOUT);

test(name('cancel-unrelated-owner'), () => scenario({}, async s => {
  const { f } = s;
  const other = f.tokens.mint({ name: 'Unrelated paired owner' });
  const authority: NativePairedExecutionAuthority = {
    current() { const current = f.tokens.authenticateNative(other.token); return current ? { ...current, scopes: f.authority.current()!.scopes } : null; },
    withCurrent(expected, callback) { return f.tokens.withNativeAuthority(other.token, expected, check => callback(() => ({ ...check(), scopes: f.authority.current()!.scopes }))); },
  };
  await expectCancelRefused(s, authority, s.original.admission.key);
}), TIMEOUT);

test(name('cancel-unknown-attempt'), () => scenario({}, async s => {
  await expectCancelRefused(s, s.f.authority, { ...s.original.admission.key, attemptId: 'unknown-owned-attempt' });
}), TIMEOUT);

test(name('cancel-changed-authority-scopes'), () => scenario({}, async s => {
  const { f } = s;
  await expectCancelRefused(s, { ...f.authority, current() { return { ...f.authority.current()!, scopes: ['write:work-ledger'] }; } }, s.original.admission.key);
}), TIMEOUT);

test(name('cancel-original-restart'), () => scenario({}, async s => {
  await cancelWithRecordsRemoved(s, s.original.admission.key, false);
  await restartDaemon(s, { closeFirst: true });
  expect(() => s.execution.recoverCiWatchOwner(s.watches[0]!)).toThrow();
}), TIMEOUT);

test(name('cancel-successor-restart'), () => scenario({}, async s => {
  await cancelWithRecordsRemoved(s, await successorKey(s), false);
  await restartDaemon(s, { closeFirst: true });
  expect(() => s.execution.recoverCiWatchOwner(s.watches[0]!)).toThrow();
}), TIMEOUT);

test(name('cancel-delegated-restart'), () => scenario({ delegated: true }, async s => {
  await cancelWithRecordsRemoved(s, await successorKey(s), true);
  await restartDaemon(s, { closeFirst: true });
  expect(() => s.execution.recoverCiWatchOwner(s.watches[0]!)).toThrow();
}), TIMEOUT);
