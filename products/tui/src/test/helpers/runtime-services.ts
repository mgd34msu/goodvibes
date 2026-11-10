import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'bun:test';
import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { ArchetypeLoader } from '@goodvibes-jev/engine/platform/platform/agents';
import { AgentMessageBus } from '@goodvibes-jev/engine/platform/platform/agents';
import { AgentOrchestrator } from '@goodvibes-jev/engine/platform/platform/agents';
import { AutomationManager } from '@goodvibes-jev/engine/platform/platform/automation';
import { ChannelPolicyManager } from '@goodvibes-jev/engine/platform/platform/channels';
import { RouteBindingManager } from '@goodvibes-jev/engine/platform/platform/channels';
import { ToolLLM } from '@goodvibes-jev/engine/platform/platform/config';
import { ApprovalBroker } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { SharedSessionBroker } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { GitService } from '@goodvibes-jev/engine/platform/platform/git';
import type { HookDispatcher } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { HookWorkbench } from '@goodvibes-jev/engine/platform/platform/hooks';
import { CodeIntelligence } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { LspService } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { TreeSitterService } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/platform/platform/media';
import { PluginManager } from '@goodvibes-jev/engine/platform/platform/plugins';
import { createFeatureFlagManager, type FeatureFlagManager } from '@/runtime/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import { RemoteSupervisor } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TaskScheduler } from '@goodvibes-jev/engine/platform/platform/scheduler';
import { SpawnTokenManager } from '@goodvibes-jev/engine/platform/platform/security';
import { FileUndoManager } from '@goodvibes-jev/engine/platform/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import { ModeManager } from '@goodvibes-jev/engine/platform/platform/state';
import { ProjectIndex } from '@goodvibes-jev/engine/platform/platform/state';
import { AgentManager, type AgentExecutor } from '@goodvibes-jev/engine/platform/platform/tools';
import { AutoHealer } from '@goodvibes-jev/engine/platform/platform/tools';
import { ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { ScheduleManager, TriggerManager, WorkflowManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { VoiceProviderRegistry } from '@goodvibes-jev/engine/platform/platform/voice';
import { WebSearchProviderRegistry } from '@goodvibes-jev/engine/platform/platform/web-search';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { makeProjectTempDir } from './project-temp.ts';
import { buildTestModelDefinition, patchTestProviderRegistry } from './test-managers.ts';

type IntelligenceTestRoots = {
  root: string;
  workingDir: string;
  homeDir: string;
  shellPaths: ReturnType<typeof createShellPathService>;
};

let testRoots: IntelligenceTestRoots | null = null;

let runtimeServices: RuntimeServices | null = null;
let runtimeOpening: Promise<RuntimeServices> | null = null;
let runtimeGeneration = 0;
const runtimePreparations = new Set<Promise<RuntimeServices>>();
const ownedRuntimes = new Set<RuntimeServices>();
const pendingRuntimeClosures = new Set<Promise<void>>();
class RetiredRuntimePreparationError extends Error {
  constructor() { super('Test runtime preparation was reset.'); }
}
let runtimeCounter = 0;
let toolLLM: ToolLLM | null = null;
let toolLLMRuntimeServices: RuntimeServices | null = null;
let autoHealer: AutoHealer | null = null;
let lspService: LspService | null = null;
let treeSitterService: TreeSitterService | null = null;
let codeIntelligence: CodeIntelligence | null = null;
let taskScheduler: TaskScheduler | null = null;
let featureFlags: FeatureFlagManager | null = null;
const spawnTokenManagers = new Map<string, SpawnTokenManager>();
const projectIndexes = new Map<string, ProjectIndex>();
const gitServices = new Map<string, GitService>();
let agentExecutorForTests: AgentExecutor | null = null;

function getTestRoots(): IntelligenceTestRoots {
  if (testRoots) return testRoots;

  const root = makeProjectTempDir('gv-test-runtime');
  const workingDir = join(root, 'intelligence-workspace');
  const homeDir = join(root, 'intelligence-home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  testRoots = {
    root,
    workingDir,
    homeDir,
    shellPaths: createShellPathService({
      workingDirectory: workingDir,
      homeDirectory: homeDir,
    }),
  };

  // The file's explicit afterAll drains original preparations and every retired
  // graph before removing this shared root. The preload also owns the enclosing
  // test-temp directory; no process-exit callback is needed here.

  return testRoots;
}

function nextRuntimeRoots(): { workingDir: string; configDir: string } {
  runtimeCounter += 1;
  const rootDir = join(getTestRoots().root, `runtime-${runtimeCounter}`);
  const workingDir = join(rootDir, 'workspace');
  const configDir = join(rootDir, 'config');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return { workingDir, configDir };
}

function applyExecutorIfPresent(services: RuntimeServices): void {
  services.agentManager.setExecutor(agentExecutorForTests);
}

function seedRuntimeProviderTestModels(services: RuntimeServices): void {
  patchTestProviderRegistry(services.providerRegistry);
  const mockProvider = {
    name: 'mock',
    models: ['mock-model'],
    async chat() {
      return {
        content: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed' as const,
      };
    },
  };
  services.providerRegistry.registerRuntimeProvider({
    provider: mockProvider,
    replace: true,
    models: [buildTestModelDefinition('mock', 'mock-model')],
  });
}

/**
 * Drop the shared test runtime graph, STOPPING it first.
 *
 * Dropping the reference alone is not enough. `createRuntimeServices()` starts
 * pollers while it builds, the fleet registry tick, the knowledge scheduler,
 * the push-subscription sweep, the cross-session orchestration sweep, the
 * orchestration snapshot writer, the config-file watch, the snapshot /
 * retention / consolidation schedulers, and every one of them keeps firing for
 * the rest of the process when the graph is abandoned rather than disposed.
 * This function is called from the `beforeEach`/`afterEach` of most tests that
 * use the shared graph, so it is the single place that decides whether the
 * suite accumulates one whole graph's worth of timers per test or none.
 */
export function resetTestRuntimeServices(): void {
  runtimeGeneration++;
  runtimeOpening = null;
  runtimeServices = null;
  toolLLM = null;
  toolLLMRuntimeServices = null;
  autoHealer = null;
  for (const services of ownedRuntimes) closeOwnedRuntime(services);
}

function closeOwnedRuntime(services: RuntimeServices): void {
  if (!ownedRuntimes.delete(services)) return;
  let closing: Promise<void>;
  // Native close retires new work immediately; retain its original drain.
  try { closing = services.close(); } catch (error) { closing = Promise.reject(error); }
  pendingRuntimeClosures.add(closing);
  void closing.catch(() => {});
}

/** Await all original preparations and graph closes, retaining cleanup failures. */
export async function drainTestRuntimeServices(): Promise<void> {
  resetTestRuntimeServices();
  const failures: unknown[] = [];
  while (runtimePreparations.size || pendingRuntimeClosures.size || ownedRuntimes.size) {
    const preparations = [...runtimePreparations];
    const prepared = await Promise.allSettled(preparations);
    for (const preparation of preparations) runtimePreparations.delete(preparation);
    for (const outcome of prepared)
      if (outcome.status === 'rejected' && !(outcome.reason instanceof RetiredRuntimePreparationError)) failures.push(outcome.reason);
    resetTestRuntimeServices();
    const closures = [...pendingRuntimeClosures];
    for (const closing of closures) pendingRuntimeClosures.delete(closing);
    const closed = await Promise.allSettled(closures);
    for (const outcome of closed) if (outcome.status === 'rejected') failures.push(outcome.reason);
  }
  if (failures.length) throw new AggregateError(failures, 'Owned TUI test runtimes did not drain.');
}

/**
 * Stop the shared test runtime graph when the calling test file finishes.
 *
 * Call this at the TOP LEVEL of a test file, next to its imports. It has to be
 * a function each file calls for itself: registering `afterAll` from this
 * module's own scope would run at IMPORT time, and because modules are cached
 * the hook would bind to whichever test file imported this helper first and
 * never run for any of the others.
 *
 * `resetTestRuntimeServices()` in an `afterEach` already covers the graphs a
 * file builds between tests; this covers the last one, which nothing else
 * would ever stop.
 *
 * Also removes `getTestRoots()`'s temp directory (the `gv-test-runtime-*`
 * scratch shared by getTestRuntimeServices/getTestLspService/
 * getTestCodeIntelligence/getTestTaskScheduler), which used to rely on a
 * `process.on('exit', ...)` hook registered lazily inside getTestRoots, Bun's
 * test runner never fires that under `bun test`, so it leaked the ENTIRE
 * directory tree (never removed at all) for every test file that touched any
 * of those shared services. This function is already the established
 * per-file `afterAll` entry point, so folding the cleanup in here reaches
 * every file without a second thing to remember to call.
 *
 * Reset stays synchronous so existing callers immediately retire their graph.
 * The original asynchronous closes are retained until this file's awaited
 * drain; failure preserves the roots and remains a test failure.
 */
export function disposeTestRuntimeServicesAfterAll(): void {
  afterAll(async () => {
    await drainTestRuntimeServices();
    if (testRoots) {
      rmSync(testRoots.root, { recursive: true, force: true });
      testRoots = null;
    }
  });
}

export async function getTestRuntimeServices(): Promise<RuntimeServices> {
  if (runtimeServices) return runtimeServices;
  if (runtimeOpening) return runtimeOpening;
  const generation = runtimeGeneration;
  const { workingDir, configDir } = nextRuntimeRoots();
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir: workingDir });
  const opening = (async () => {
    await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
    if (generation !== runtimeGeneration) throw new RetiredRuntimePreparationError();
    const created = createRuntimeServices({ modelDiscovery: 'skip', configManager,
      runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), workingDir,
      homeDirectory: workingDir, getConversationTitle: () => 'test-runtime' });
    ownedRuntimes.add(created);
    try {
      seedRuntimeProviderTestModels(created); applyExecutorIfPresent(created);
      if (generation !== runtimeGeneration) throw new RetiredRuntimePreparationError();
      runtimeServices = created;
      return created;
    } catch (error) {
      // Keep this failed construction owned even when it was never published.
      closeOwnedRuntime(created);
      throw error;
    }
  })();
  runtimeOpening = opening; runtimePreparations.add(opening);
  try { return await opening; }
  finally { runtimePreparations.delete(opening); if (runtimeOpening === opening) runtimeOpening = null; }
}

export async function getTestArchetypeLoader(): Promise<ArchetypeLoader> {
  return (await getTestRuntimeServices()).archetypeLoader;
}

export async function getTestAgentMessageBus(): Promise<AgentMessageBus> {
  return (await getTestRuntimeServices()).agentMessageBus;
}

export async function getTestAgentOrchestrator(): Promise<AgentOrchestrator> {
  return (await getTestRuntimeServices()).agentOrchestrator;
}

export async function getTestAgentManager(): Promise<AgentManager> {
  return (await getTestRuntimeServices()).agentManager;
}

export async function getTestRouteBindings(): Promise<RouteBindingManager> {
  return (await getTestRuntimeServices()).routeBindings;
}

export async function getTestConfigManager(): Promise<RuntimeServices['configManager']> {
  return (await getTestRuntimeServices()).configManager;
}

export async function getTestProviderRegistry(): Promise<RuntimeServices['providerRegistry']> {
  return (await getTestRuntimeServices()).providerRegistry;
}

export async function getTestPanelManager(): Promise<RuntimeServices['panelManager']> {
  return (await getTestRuntimeServices()).panelManager;
}

export async function getTestBookmarkManager(): Promise<RuntimeServices['bookmarkManager']> {
  return (await getTestRuntimeServices()).bookmarkManager;
}

export async function getTestSessionManager(): Promise<RuntimeServices['sessionManager']> {
  return (await getTestRuntimeServices()).sessionManager;
}

export async function getTestSessionOrchestration(): Promise<RuntimeServices['sessionOrchestration']> {
  return (await getTestRuntimeServices()).sessionOrchestration;
}

export async function getTestReplayEngine(): Promise<RuntimeServices['replayEngine']> {
  return (await getTestRuntimeServices()).replayEngine;
}

export async function getTestServiceRegistry(): Promise<RuntimeServices['serviceRegistry']> {
  return (await getTestRuntimeServices()).serviceRegistry;
}

export async function getTestSubscriptionManager(): Promise<RuntimeServices['subscriptionManager']> {
  return (await getTestRuntimeServices()).subscriptionManager;
}

export async function getTestSessionBroker(): Promise<SharedSessionBroker> {
  return (await getTestRuntimeServices()).sessionBroker;
}

export async function getTestApprovalBroker(): Promise<ApprovalBroker> {
  return (await getTestRuntimeServices()).approvalBroker;
}

export async function getTestAutomationManager(): Promise<AutomationManager> {
  return (await getTestRuntimeServices()).automationManager;
}

export async function getTestChannelPolicyManager(): Promise<ChannelPolicyManager> {
  return (await getTestRuntimeServices()).channelPolicy;
}

export async function getTestFileUndoManager(): Promise<FileUndoManager> {
  return (await getTestRuntimeServices()).fileUndoManager;
}

export async function getTestModeManager(): Promise<ModeManager> {
  return (await getTestRuntimeServices()).modeManager;
}

export async function getTestWorkflowManager(): Promise<WorkflowManager> {
  return (await getTestRuntimeServices()).workflow.workflowManager;
}

export async function getTestTriggerManager(): Promise<TriggerManager> {
  return (await getTestRuntimeServices()).workflow.triggerManager;
}

export async function getTestScheduleManager(): Promise<ScheduleManager> {
  return (await getTestRuntimeServices()).workflow.scheduleManager;
}

export async function getTestGatewayMethodCatalog(): Promise<GatewayMethodCatalog> {
  return (await getTestRuntimeServices()).gatewayMethods;
}

export async function getTestHookDispatcher(): Promise<HookDispatcher> {
  return (await getTestRuntimeServices()).hookDispatcher;
}

export async function getTestHookWorkbench(): Promise<HookWorkbench> {
  return (await getTestRuntimeServices()).hookWorkbench;
}

export async function getTestPluginManager(): Promise<PluginManager> {
  return (await getTestRuntimeServices()).pluginManager;
}

export async function getTestMemoryEmbeddingRegistry(): Promise<MemoryEmbeddingProviderRegistry> {
  return (await getTestRuntimeServices()).memoryEmbeddingRegistry;
}

export async function getTestVoiceProviderRegistry(): Promise<VoiceProviderRegistry> {
  return (await getTestRuntimeServices()).voiceProviders;
}

export async function getTestMediaProviderRegistry(): Promise<MediaProviderRegistry> {
  return (await getTestRuntimeServices()).mediaProviders;
}

export async function getTestWebSearchProviderRegistry(): Promise<WebSearchProviderRegistry> {
  return (await getTestRuntimeServices()).webSearchProviders;
}

export async function getTestRemoteRunnerRegistry(): Promise<RemoteRunnerRegistry> {
  return (await getTestRuntimeServices()).remoteRunnerRegistry;
}

export async function getTestRemoteSupervisor(): Promise<RemoteSupervisor> {
  return (await getTestRuntimeServices()).remoteSupervisor;
}

export async function getTestToolLLM(): Promise<ToolLLM> {
  const services = (await getTestRuntimeServices());
  if (!toolLLM || toolLLMRuntimeServices !== services) {
    toolLLM = new ToolLLM({
      configManager: services.configManager,
      providerRegistry: services.providerRegistry,
    });
    toolLLMRuntimeServices = services;
  }
  return toolLLM;
}

export function resetTestToolLLM(): void {
  toolLLM = null;
  toolLLMRuntimeServices = null;
}

export async function getTestAutoHealer(): Promise<AutoHealer> {
  autoHealer ??= new AutoHealer((await getTestConfigManager()), (await getTestToolLLM()));
  return autoHealer;
}

export function resetTestAutoHealer(): void {
  autoHealer = null;
}

export function getTestLspService(): LspService {
  lspService ??= new LspService(getTestRoots().shellPaths);
  return lspService;
}

export function resetTestLspService(): void {
  lspService = null;
}

export function getTestTreeSitterService(): TreeSitterService {
  treeSitterService ??= new TreeSitterService();
  return treeSitterService;
}

export function getTestCodeIntelligence(): CodeIntelligence {
  codeIntelligence ??= new CodeIntelligence({
    shellPaths: getTestRoots().shellPaths,
    treeSitter: getTestTreeSitterService(),
    lsp: getTestLspService(),
  });
  return codeIntelligence;
}

export function getTestIntelligenceShellPaths() {
  return getTestRoots().shellPaths;
}

export function resetTestCodeIntelligence(): void {
  codeIntelligence = null;
  treeSitterService = null;
  lspService = null;
}

export async function getTestProcessManager(): Promise<ProcessManager> {
  return (await getTestRuntimeServices()).processManager;
}

export function resetTestProcessManager(): void {
  resetTestRuntimeServices();
}

export function getTestTaskScheduler(
  config?: string | ConstructorParameters<typeof TaskScheduler>[0],
): TaskScheduler {
  taskScheduler ??= new TaskScheduler(config ?? {
    storePath: join(getTestRoots().root, 'scheduler.json'),
    spawnTask: () => 'test-agent',
  });
  return taskScheduler;
}

export function resetTestTaskScheduler(): void {
  taskScheduler?.stop();
  taskScheduler = null;
}

export function getTestSpawnTokenManager(sessionId: string): SpawnTokenManager {
  const existing = spawnTokenManagers.get(sessionId);
  if (existing) return existing;
  const created = new SpawnTokenManager(sessionId);
  spawnTokenManagers.set(sessionId, created);
  return created;
}

export function resetTestSpawnTokenManagers(): void {
  spawnTokenManagers.clear();
}

export function getTestFeatureFlagManager(): FeatureFlagManager {
  featureFlags ??= createFeatureFlagManager();
  return featureFlags;
}

export function setTestFeatureFlagManager(manager: FeatureFlagManager): void {
  featureFlags = manager;
}

export function resetTestFeatureFlagManager(): void {
  featureFlags = null;
}

export function getTestProjectIndex(cwd: string): ProjectIndex {
  const existing = projectIndexes.get(cwd);
  if (existing) return existing;
  const created = new ProjectIndex(cwd);
  projectIndexes.set(cwd, created);
  return created;
}

export function resetTestProjectIndexes(): void {
  projectIndexes.clear();
}

export function getTestGitService(cwd = process.cwd()): GitService {
  const existing = gitServices.get(cwd);
  if (existing) return existing;
  const created = new GitService(cwd);
  gitServices.set(cwd, created);
  return created;
}

export function resetTestGitServices(cwd?: string): void {
  if (cwd) {
    gitServices.delete(cwd);
    return;
  }
  gitServices.clear();
}

export function resetAllTestServiceState(): void {
  resetTestRuntimeServices();
  resetTestToolLLM();
  resetTestAutoHealer();
  resetTestCodeIntelligence();
  resetTestTaskScheduler();
  resetTestSpawnTokenManagers();
  resetTestFeatureFlagManager();
  resetTestProjectIndexes();
  resetTestGitServices();
}

export function applyTestAgentExecutor(executor: AgentExecutor | null): void {
  agentExecutorForTests = executor;
  if (runtimeServices) {
    runtimeServices.agentManager.setExecutor(executor);
  }
}
