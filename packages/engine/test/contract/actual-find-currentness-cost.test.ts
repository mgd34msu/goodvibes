/**
 * Real contract -> AgentManager -> AgentOrchestrator -> captured find.
 *
 * A unit worker's search reaches a currentness checkpoint several times per
 * file. Each complete verification re-captures the permission owner's whole
 * frame, so repeating it per checkpoint made a search over a few thousand
 * files take minutes of main-thread time, and several workers searching at
 * once looked hung. The count of complete verifications must follow elapsed
 * time, not the number of files.
 */
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { ConfigManager } from '../../platform/src/platform/config/index.js';
import { createContractRunner } from '../../platform/src/platform/contract/runner.js';
import { ContractStore } from '../../platform/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../../platform/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../../platform/src/platform/orchestration/engine.js';
import { createLaunchTolerantProviderRegistry } from '../../platform/src/platform/providers/index.js';
import type { LLMProvider } from '../../platform/src/platform/providers/interface.js';
import { createClientRuntimeServices } from '../../platform/src/platform/runtime/bootstrap.js';
import { resumeContracts } from '../../platform/src/platform/runtime/contract-composition.js';
import { RuntimeEventBus, createRuntimeStore } from '../../platform/src/platform/runtime/state.js';
import type { ToolCall, ToolResult } from '../../platform/src/platform/types/tools.js';
import { makeRepo, oneUnitPlan, runnerPort } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

const FILES = 400;
test('a unit worker search does not repeat complete owner verification per file', async () => {
  const root = makeRepo();
  fs.mkdirSync(join(root, 'src'));
  for (let i = 0; i < FILES; i++) {
    const dir = join(root, 'pkg', `d${i % 40}`, `s${i % 7}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, `f${i}.ts`), `export const state${i} = 'x';\nlet status = ${i};\n` + '// filler line\n'.repeat(200));
  }
  const git = (...args: string[]) => { const r = childProcess.spawnSync('git', ['-C', root, ...args]); expect(r.status, r.stderr.toString()).toBe(0); };
  git('add', '.'); git('commit', '-qm', 'fixture');
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.mode', 'allow-all'); config.set('behavior.autoApprove', true);
  config.set('contract.isolation', 'worktree'); config.set('tools.autoHeal', false);
  const bus = new RuntimeEventBus();
  const services = createClientRuntimeServices({
    surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
    runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
    providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
  });
  await resumeContracts(services.contractRunner, root);
  const previous = installJudgmentPort(withDecisionLog(runnerPort(context => {
    if (context.name === 'family') return choiceAnswer(context.question, 'file-mutation', 0.99);
    if (context.name === 'route' && context.question.type === 'choice'
      && Object.keys(context.question.criteria).sort().join(',') === 'fresh,owner,split')
      return choiceAnswer(context.question, 'owner', 0.99);
    return undefined;
  }).port, services.judgment.decisionLog));
  const steps: ToolCall[] = [
    { id: 'files', name: 'find', arguments: { queries: [{ id: 'inv', mode: 'files', patterns: ['**/*'] }], output: { format: 'count_only' } } },
    { id: 'content', name: 'find', arguments: { queries: [{ id: 'sig', mode: 'content', path: 'pkg', pattern: '(status|state|phase)\\s*=|AbortController' }], output: { format: 'count_only' } } },
    { id: 'complete-unit', name: 'write', arguments: { files: [{ path: 'src/csv.ts', mode: 'overwrite', content: 'export const parse = () => [];\n' }] } },
  ];
  const results = new Map<string, ToolResult>();
  const verifications = spyOn(services.permissionManager as unknown as { autonomousAuthority: (...args: unknown[]) => unknown }, 'autonomousAuthority');
  const verifiedAt: [step: string, verifications: number, at: number][] = [];
  let memberCalls = 0;
  const provider: LLMProvider = {
    name: 'stall-fixture', models: ['fixture'], isConfigured: () => true,
    async chat(request) {
      const planner = !request.tools?.some(tool => tool.name === 'write');
      if (planner) return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      const step = steps[memberCalls++];
      verifiedAt.push([step?.id ?? 'done', verifications.mock.calls.length, performance.now()]);
      return { content: step ? '' : 'Created src/csv.ts. The parser works.', toolCalls: step ? [step] : [],
        usage: { inputTokens: 1, outputTokens: 1 }, stopReason: step ? 'tool_call' : 'completed' };
    },
  };
  services.providerRegistry.registerRuntimeProvider({ provider, models: [{
    id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Fixture', description: 'stall',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard',
  }], replace: true });
  await services.providerRegistry.ready();
  const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
  const contractRunner = createContractRunner({
    agentManager: services.agentManager, messageBus: services.agentMessageBus, runtimeBus: bus,
    configManager: { get: config.get.bind(config), getCategory: ((name: string) => name === 'contract'
      ? { ...config.getCategory('contract'), gates: [] } : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory },
    projectRoot: root, routeSelector: async () => ({ model: `${provider.name}:fixture`, provider: provider.name, reason: 'scripted' }),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: services.agentManager }),
    createEngine: input => createOrchestrationEngine({
      agentManager: services.agentManager, configManager: config, runtimeBus: bus,
      projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
      initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
      contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
      runWorktreeSetup: () => undefined,
    }), fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
    priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-08' }), store,
    readAccessFilter: async path => await services.permissionManager.readAccess(path) === 'allow',
  });
  services.agentManager.setContractRunner(contractRunner);
  services.agentOrchestrator.setDependencies({ ...services, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: services.workflow,
    contractRunner, contractHooks: { ...contractRunner.hooks(), onTurnEnd(record, turn) {
      for (const result of turn.results) results.set(result.callId, result);
      contractRunner.hooks().onTurnEnd(record, turn);
    } },
  });
  const id = (await contractRunner.start({ ask: 'Add a CSV parser module', sessionId: 'stall-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' })).contract.id;
  while (!['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(contractRunner.get(id)!.status)) await new Promise(resolve => setTimeout(resolve, 100));
  try {
    expect(contractRunner.get(id)!.status).toBe('passed');
    expect(JSON.parse(results.get('files')!.output!).inv.count).toBe(FILES + 1);
    expect(JSON.parse(results.get('content')!.output!).sig).toEqual({ count: FILES, file_count: FILES });
    // Complete verifications are bounded by elapsed time (two independent
    // windows of at least 50 ms each), so a loaded machine is allowed more of
    // them; they are never owed per file. Before the bounded fences each step
    // made at least two per file however fast it ran.
    const bounded = (step: string): void => {
      const index = verifiedAt.findIndex(([id]) => id === step);
      const count = verifiedAt[index + 1]![1] - verifiedAt[index]![1];
      const elapsedMs = verifiedAt[index + 1]![2] - verifiedAt[index]![2];
      expect(count, `${step}: ${count} complete verifications in ${Math.round(elapsedMs)} ms`).toBeLessThan(Math.max(FILES / 2, 20 + elapsedMs / 20));
    };
    bounded('files');
    bounded('content');
    // Every later call sweeps the whole read set the searches built up; that
    // sweep must not verify the owner once per path either.
    bounded('complete-unit');
  } finally {
    verifications.mockRestore();
    try { contractRunner.cancel(id, 'cleanup'); await contractRunner.join(id); } catch { /* already settled */ }
    contractRunner.dispose(); store.dispose(); services.dispose(); installJudgmentPort(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
