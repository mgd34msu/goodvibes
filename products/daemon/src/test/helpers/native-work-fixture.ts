import { spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import type { ModelDefinition, LLMProvider, ChatRequest, ChatResponse } from '@goodvibes-jev/engine/platform/platform/providers';
import { createWorkLedger } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import { PairingTokenManager } from '@goodvibes-jev/engine/platform/platform/pairing';
import { WorkspaceRegistrationStore } from '@goodvibes-jev/engine/platform/platform/workspace';
import type { NativePairedExecutionAuthority } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution';
import { createContractOperatorService } from '@goodvibes-jev/engine/platform/platform/contract';
import { createDaemonNativeWorkExecutionActivation } from '../../runtime/native-work-execution-activation.js';
import { makeOwnedTempDir } from './owned-temp.js';

export async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export const answer = (content: string): ChatResponse => ({ content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' });

export interface NativeWorkFixtureSettings {
  readonly retry?: { readonly delayMs: number; readonly sleep: (ms: number) => Promise<void> };
  /** Hands the activation the contract operator, for tests that answer its questions. */
  readonly contractOperator?: boolean;
}

/** An actual native work activation over a real ledger, git workspace and pairing owner; only the model provider is synthetic. */
export async function createNativeWorkFixture(pairingOwner?: PairingTokenManager, settings: NativeWorkFixtureSettings = {}) {
  const { retry } = settings;
  const root = makeOwnedTempDir('native-activation'); const workspace = join(root, 'workspace');
  mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), '# Owned native fixture\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']])
    if (spawnSync('git', args, { cwd: workspace }).status !== 0) throw new Error('Fixture git failed');
  const configManager = new ConfigManager({ workingDir: workspace, homeDir: root, configDir: join(root, 'config'), surfaceRoot: 'daemon' });
  const runtimeBus = new RuntimeEventBus();
  const services = createClientRuntimeServices({ configManager, runtimeBus, runtimeStore: createRuntimeStore(),
    surfaceRoot: 'daemon', workingDir: workspace, homeDirectory: root, requestApproval: async () => ({ approved: false }), modelDiscovery: 'skip' });
  const log = new SqliteDecisionLog(join(root, 'decisions.sqlite'));
  const readings = fakePort((name, question, state) => {
    if (question.type === 'noul') return noulAnswer(name === 'forbids_delegation' || name === 'checkable' || name.startsWith('fit') ? 0.99 : 0.01);
    if (question.type === 'score') return scoreAnswer(question, 0, 0.99);
    const choices = question.type === 'choice' ? Object.keys(question.criteria) : [];
    const preferred: Record<string, string> = { disposition: 'act', relation: 'supports', role: 'research', tier: 'standard', intent: 'chat', strategy: 'single', category: 'unknown', connection_failure: 'none' };
    // A rejected credential reads as a permanent failure; every other wording keeps the default reading.
    if (name === 'category' && JSON.stringify(state).includes('API key was rejected')) return choiceAnswer(question, 'authentication', 0.99);
    const pick = preferred[name];
    return choiceAnswer(question, pick && choices.includes(pick) ? pick : choices.find(key => key !== 'none')!, 0.99);
  });
  const port = withDecisionLog(readings.port, log); const previous = installJudgmentPort(port);
  const goal = 'Answer the native request yourself without delegation. Preserve the complete original request.';
  const criteria = ['The answer says native execution is complete.'];
  const plan = { goal, criteria: [{ id: 'c1', text: criteria[0], quote: criteria[0] }], groups: [{
    id: 'g1', title: 'Answer', goal, kind: 'work', dependsOn: [], criteria: [], units: [{ id: 'u1', title: 'Answer', goal,
      role: 'research', brief: 'Say native execution is complete.', dependsOn: [], files: [], criteria: [{ id: 'u1.c1', text: criteria[0], serves: ['c1'] }] }],
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
  services.providerRegistry.registerRuntimeProvider({ provider, models: [model], replace: true });
  // Routing must never select a built-in local proxy or make a live request.
  const catalog = spyOn(services.providerRegistry, 'listModels').mockReturnValue([model]);
  services.providerRegistry.setCurrentModel(model.registryKey);
  const knowledgeStore = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage: await knowledgeStore.openWorkLedgerStorage('project'),
    clock: { now: () => Date.now(), newId: kind => `${kind}-${++id}` } });
  const tokens = pairingOwner ?? new PairingTokenManager(join(root, 'pairing.json')); const paired = tokens.mint({ name: 'Synthetic fixture' });
  const scopesGranted = ['read:work-ledger', 'write:fleet'];
  const authority: NativePairedExecutionAuthority = {
    current() { const current = tokens.authenticateNative(paired.token); return current ? { ...current, scopes: scopesGranted } : null; },
    withCurrent(expected, callback) { return tokens.withNativeAuthority(paired.token, expected, assertCurrent => callback(() => ({ ...assertCurrent(), scopes: scopesGranted }))); },
  };
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: authority.current()!.principalId, role: 'coordinator' });
  const created = await ledger.service.execute({ type: 'create', expectedRevision: 0, requestId: 'create', title: 'Display title', goal, criteria }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error(`Fixture create failed: ${JSON.stringify(created)}`);
  const claimed = await ledger.service.execute({ type: 'claim', expectedRevision: 1, requestId: 'claim', workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('Fixture claim failed');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const scopes = new WorkspaceRegistrationStore({ path: join(root, 'registrations.json'), homeDir: root, daemonStateDir: join(root, '.goodvibes') });
  await scopes.add(workspace);
  const operator = createContractOperatorService({ runner: services.contractRunner, workingDirectory: workspace });
  const options = { ...(settings.contractOperator ? { contractOperator: operator } : {}), runtimeBus, configManager, providerRegistry: services.providerRegistry, projectRoot: workspace,
    projectId: 'project', sessionId: 'native-fixture', knowledgeStore, nativeScopes: scopes, judgmentPort: port, decisionLog: log,
    acpHost: { list: () => [] }, permissionManager: services.permissionManager, hookDispatcher: services.hookDispatcher, featureFlags: services.featureFlags,
    toolDependencies: { ...services, contractHooks: services.contractRunner.hooks(), workflowServices: services.workflow },
    ...(retry ? { retry } : {}) };
  const activation = createDaemonNativeWorkExecutionActivation(options);
  return { root, activation, options, operator, services, target, authority, paired, requests, readings, log, goal, criteria,
    hold(fn: typeof hold) { hold = fn; },
    async anotherTarget() {
      const revision = (await ledger.service.readSnapshot(actor)).revision;
      const created = await ledger.service.execute({ type: 'create', expectedRevision: revision, requestId: `create-${revision}`, title: 'Another display title', goal, criteria }, actor);
      if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('Second fixture create failed');
      const claimed = await ledger.service.execute({ type: 'claim', expectedRevision: revision + 1, requestId: `claim-${revision}`, workId: created.event.workId }, actor);
      if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('Second fixture claim failed');
      const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
      return { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
    },
    async close() { await activation.close(); await ledger.service.close(); await knowledgeStore.close(); catalog.mockRestore(); installJudgmentPort(previous); services.dispose(); log[Symbol.dispose](); } };
}
