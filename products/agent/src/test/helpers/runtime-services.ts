/**
 * Runtime services test helper.
 *
 * CONTRACT: Importing this helper auto-registers a beforeEach that calls
 * resetAllTestServiceState(), so every test file gets a fresh singleton set
 * without needing to call reset manually. Runtime-backed getters are async:
 * acquisition activates the exact configured project before composing a graph.
 * Files that need custom reset logic
 * can still call resetAllTestServiceState() or individual reset functions
 * in their own beforeEach, bun:test runs all registered beforeEach hooks.
 */
import { seedProviderMetadataCacheFixture } from './provider-metadata-cache-fixture.ts';
import { afterAll, afterEach, beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
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
import { installAgentDaemonCredentialsClient } from '../../config/daemon-credential-routing.ts';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import { makeLongLivedProjectTempDir } from './project-temp.ts';
import { buildTestModelDefinition, patchTestProviderRegistry } from './test-managers.ts';

type IntelligenceTestRoots = {
  root: string;
  workingDir: string;
  homeDir: string;
  shellPaths: ReturnType<typeof createShellPathService>;
};

let testRoots: IntelligenceTestRoots | null = null;

let runtimeServices: RuntimeServices | null = null;
let runtimePreparation: Promise<RuntimeServices> | null = null;
let runtimeGeneration = 0;
const pendingRuntimePreparations = new Set<Promise<RuntimeServices>>();
const ownedRuntimes = new Set<RuntimeServices>();
const pendingRuntimeClosures = new Set<Promise<void>>();
class RetiredRuntimePreparationError extends Error {
  constructor() { super('Test runtime preparation was reset'); }
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

  // Long-lived: this root is memoized once (the `if (testRoots) return
  // testRoots` guard above) and reused by every one of the ~17 test files
  // that call getTestRuntimeServices()/getTestArchetypeLoader()/etc. across
  // the whole suite run, not just whichever file happens to create it
  // first. It must not go through makeProjectTempDir's per-test sweep,
  // which would delete it after the very first test that touches it and
  // break every later file still relying on it existing.
  const root = makeLongLivedProjectTempDir('gv-test-runtime');
  const workingDir = join(root, 'intelligence-workspace');
  const homeDir = join(root, 'intelligence-home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  makeStandaloneGitRoot(workingDir);

  testRoots = {
    root,
    workingDir,
    homeDir,
    shellPaths: createShellPathService({
      workingDirectory: workingDir,
      homeDirectory: homeDir,
    }),
  };

  // No cleanup registration here: `root` came from makeLongLivedProjectTempDir,
  // which already tracked it in the shared temp registry that the preload's
  // top-level afterAll sweeps. This used to register a second
  // `process.on('exit', …)` handler, which `bun test` never runs.

  return testRoots;
}

function nextRuntimeRoots(): { workingDir: string; configDir: string } {
  runtimeCounter += 1;
  const rootDir = join(getTestRoots().root, `runtime-${runtimeCounter}`);
  const workingDir = join(rootDir, 'workspace');
  const configDir = join(rootDir, 'config');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  makeStandaloneGitRoot(workingDir);
  return { workingDir, configDir };
}

/**
 * Make a test workspace its own git toplevel. The temp roots live under the
 * repo checkout (.test-tmp/), and the platform's WorkspaceCheckpointManager prefers
 * the ENCLOSING git repo's top level, without this boundary every test
 * runtime resolves to the checkout itself and they all share one
 * <repo>/.goodvibes/checkpoints/git side store, racing on git's config lock
 * the first time two files initialize it concurrently on a fresh runner.
 */
function makeStandaloneGitRoot(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, timeout: 30_000 });
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

export function resetTestRuntimeServices(): void {
  runtimeGeneration += 1;
  runtimePreparation = null;
  runtimeServices = null;
  toolLLM = null;
  toolLLMRuntimeServices = null;
  autoHealer = null;
  for (const services of ownedRuntimes) {
    ownedRuntimes.delete(services);
    let closing: Promise<void>;
    // Invoke now: native close fences new work synchronously, before its drain.
    try { closing = services.close(); } catch (error) { closing = Promise.reject(error); }
    pendingRuntimeClosures.add(closing);
    // Keep the original promise for the awaited boundary and failure report.
    void closing.catch(() => {});
  }
}

/** Retain roots until every original preparation and owned graph has drained.
 * A failed cleanup remains a test failure rather than an ignored rejection. */
export async function drainTestRuntimeServices(): Promise<void> {
  resetTestRuntimeServices();
  const failures: unknown[] = [];
  while (pendingRuntimePreparations.size || pendingRuntimeClosures.size || ownedRuntimes.size) {
    const preparations = [...pendingRuntimePreparations];
    const prepared = await Promise.allSettled(preparations);
    for (const preparation of preparations) pendingRuntimePreparations.delete(preparation);
    for (const outcome of prepared) if (outcome.status === 'rejected' && !(outcome.reason instanceof RetiredRuntimePreparationError)) failures.push(outcome.reason);
    resetTestRuntimeServices();
    const closures = [...pendingRuntimeClosures];
    for (const closing of closures) pendingRuntimeClosures.delete(closing);
    const closed = await Promise.allSettled(closures);
    for (const outcome of closed) if (outcome.status === 'rejected') failures.push(outcome.reason);
  }
  if (failures.length) throw new AggregateError(failures, 'Owned Agent test runtimes did not drain.');
}

export async function getTestRuntimeServices(): Promise<RuntimeServices> {
  if (runtimeServices) return runtimeServices;
  if (runtimePreparation) return runtimePreparation;
  const generation = runtimeGeneration;
  const { workingDir, configDir } = nextRuntimeRoots();
  const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir, workingDir, homeDir: workingDir });
  seedProviderMetadataCacheFixture({ configManager, workingDirectory: workingDir, homeDirectory: workingDir });
  const preparation = (async () => {
    await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-agent.sqlite', { activate: true });
    if (generation !== runtimeGeneration) throw new RetiredRuntimePreparationError();
    // The real constructor remains synchronous; nothing can publish a retired
    // preparation while the original activation is in flight.
    const services = createRuntimeServices({
      modelDiscovery: 'skip', configManager,
      runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
      workingDir, homeDirectory: workingDir, getConversationTitle: () => 'test-runtime',
    });
    ownedRuntimes.add(services);
    seedRuntimeProviderTestModels(services);
    applyExecutorIfPresent(services);
    runtimeServices = services;
    return services;
  })();
  runtimePreparation = preparation;
  pendingRuntimePreparations.add(preparation);
  try { return await preparation; }
  finally {
    pendingRuntimePreparations.delete(preparation);
    if (runtimePreparation === preparation) runtimePreparation = null;
  }
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

/**
 * The persisting session REGISTER, the one automation runs on. Named as the
 * graph names it now: `services.sessionBroker` is the client dispatch seam and
 * has none of these methods, so a test that wants ensureSession/submitMessage/
 * listSessions wants this.
 */
export async function getTestSessionBroker(): Promise<SharedSessionBroker> {
  return (await getTestRuntimeServices()).automationSessionRegister;
}

/** The inbound continuation-dispatch seam this surface binds its runner onto. */
export async function getTestSessionDispatch(): Promise<RuntimeServices['sessionBroker']> {
  return (await getTestRuntimeServices()).sessionBroker;
}

/** The sessions the composed graph believes this process is hosting. */
export async function getTestHostedSessions(): Promise<RuntimeServices['hostedSessions']> {
  return (await getTestRuntimeServices()).hostedSessions;
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
  if (services !== runtimeServices) throw new Error('Test runtime acquisition was reset');
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
  const services = await getTestRuntimeServices();
  const llm = await getTestToolLLM();
  if (services !== runtimeServices || toolLLMRuntimeServices !== services) throw new Error('Test runtime acquisition was reset');
  autoHealer ??= new AutoHealer(services.configManager, llm);
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
  // The two settings-routing clients are process-wide by design (five settings
  // writers reach them with no graph in scope), so a file that composed a
  // runtime would otherwise route every LATER file's secret and config writes
  // at a daemon that was never there, silently, since the refusal is a
  // rejected promise a keystroke handler swallows. Cleared first: routing is a
  // property of a live composed product, and a test that wants it installs its
  // own client and says so (see runtime/client-seams.test.ts).
  installAgentDaemonCredentialsClient(null);
  installAgentDaemonConfigClient(null);
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

// Auto-register a beforeEach reset so every test file that imports this helper
// starts with clean singleton state, without needing explicit reset calls.
// Files can still register additional beforeEach hooks, all registered hooks run.
beforeEach(async () => {
  resetAllTestServiceState();
  await drainTestRuntimeServices();
});

// Reset fences publication, while this set retains already-started native IO
// until the actual test lifetime drains before the preload removes its roots.
afterEach(drainTestRuntimeServices);
afterAll(drainTestRuntimeServices);

export function applyTestAgentExecutor(executor: AgentExecutor | null): void {
  agentExecutorForTests = executor;
  if (runtimeServices) {
    runtimeServices.agentManager.setExecutor(executor);
  }
}
