import { buildAgentConfigRouting } from '../config/daemon-config-routing.ts';
import { randomUUID } from 'node:crypto';
import { ToolRegistry, registerAllTools } from '@goodvibes-jev/engine/platform/platform/tools';
import { controlSurfacesFor } from './control-surfaces.ts';
import { installAgentToolPolicyGuard } from '../tools/agent-tool-policy-guard.ts';
import { registerAgentAutonomyScheduleTool } from '../tools/agent-autonomy-schedule-tool.ts';
import { agentBrowserProfileRoot, agentBrowserScreenshotRoot, agentBrowserToolBackend } from './agent-browser.ts';
import { registerAgentAccountsTool } from '../tools/agent-accounts-tool.ts';
import { AgentAccountRegistry, ACCOUNT_REGISTRY_PATH_SEGMENTS } from '@goodvibes-jev/engine/platform/platform/google';
import { containsSecretLikeText } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { registerAgentKnowledgeIngestTool } from '../tools/agent-knowledge-ingest-tool.ts';
import { registerAgentKnowledgeTool } from '../tools/agent-knowledge-tool.ts';
import { registerAgentLearningConsolidationTool } from '../tools/agent-learning-consolidation-tool.ts';
import { registerAgentModelCompareTool } from '../tools/agent-model-compare-tool.ts';
import { registerAgentReminderScheduleTool } from '../tools/agent-reminder-schedule-tool.ts';
import { registerAgentResearchReportTool } from '../tools/agent-research-report-tool.ts';
import {
  connectedHostGoogleCalendar,
  getOutwardApprovalStore,
  OUTWARD_APPROVAL_GESTURE,
  registerAgentTurnTools,
  type GoogleToolWiringDeps,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { connectedHostFamilyRemote } from '../agent/operator-gateway-call.ts';
import { registerAgentScheduleEditTool } from '../tools/agent-schedule-edit-tool.ts';
import { registerAgentScheduleTool } from '../tools/agent-schedule-tool.ts';
import { compactRegisteredToolDefinitions } from '../tools/tool-definition-compaction.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { readSurfaceEmailSettings } from '@goodvibes-jev/engine/platform/platform/email';
import type { RuntimeServices } from './services.ts';
import { readDaemonOperatorToken } from './daemon-operator-token.ts';
import { agentOwnerQuestions } from './client/owner-questions.ts';
import type { ProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';

/**
 * The main conversation's tool registry, composed exactly once, in one place:
 * the platform tools (with the daemon config
 * routing), the Agent's own tools, then the Agent's wrappers in order: the tool
 * policy guard, the execution-safety wrapper, and definition compaction. bootstrap-core.ts calls it for the live shell; the
 * exec refusal-and-kill test calls it too, so a reorder here is what that test
 * runs.
 */
export interface AgentToolRegistryDeps {
  /** The code-only owner for first-party local reads (the shipped Agent binds `services.localReadSourceOwner`). Search results are public URLs and need no owner. */
  readonly researchSourceOwner?: ProtectedSourceOwner;
  /** Native report-only opt-in, isolated from the general private-source owner. */
  readonly researchReportSourceOwner?: ProtectedSourceOwner;
  readonly services: RuntimeServices;
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  /** The runtime session id, read fresh on every call. */
  readonly resolveSessionId: () => string;
}

export interface AgentToolRegistry {
  readonly toolRegistry: ToolRegistry;
  readonly fileCache: ReturnType<typeof registerAllTools>['fileCache'];
  readonly projectIndex: ReturnType<typeof registerAllTools>['projectIndex'];
  /** Flushes and stops the session key-value store; the host calls it at shutdown. */
  readonly dispose: ReturnType<typeof registerAllTools>['dispose'];
}

/**
 * The policy a spawned or background worker's registry gets, so a worker's
 * calls are decided by the same read modes and admission readers as the main
 * conversation's. The main registry's extra layer is left out on purpose:
 * definition compaction only shapes what the main model sees.
 */
export function decorateAgentWorkerRegistry(registry: ToolRegistry): void {
  installAgentToolPolicyGuard(registry);
}

export function composeAgentToolRegistry(deps: AgentToolRegistryDeps): AgentToolRegistry {
  const { services, configManager, homeDirectory, resolveSessionId } = deps;
  const toolRegistry = new ToolRegistry(services.permissionManager);
  const { fileCache, projectIndex, dispose } = registerAllTools(toolRegistry, {
    hookDispatcher: services.hookDispatcher,
    // A model changing a hook is always put to the owner, whatever the mode or earlier answers.
    hookChangeGate: (request, { signal }) => services.permissionManager.checkHookChange(request, { signal }),
    // find, repo_map and the agent tool apply the same per-file read decision the read tool gets.
    readAccessFilter: async (absolutePath) => (await services.permissionManager.readAccess(absolutePath, resolveSessionId())) === 'allow',
    // goodvibes_context reads Cloudflare tokens held in the secret store.
    secretsManager: services.secretsManager,
    // The query tool's questions go to the connected host's owner inbox; answers come back into this conversation.
    ownerQuestions: () => agentOwnerQuestions(services, { configManager, homeDirectory }, resolveSessionId),
    // and counts the daemon's own token as the Worker operator token, as the daemon's status route does.
    cloudflareAuthToken: () => readDaemonOperatorToken(homeDirectory),
    execPromptAnswerHandler: services.execPromptAnswerHandler,
    localhostFetchApproval: services.localhostFetchApproval,
    sandboxEscalationHandler: services.sandboxEscalationHandler,
    contractRunner: services.contractRunner,
    projectRoot: services.workingDirectory,
    // Task refs are owned by the REAL runtime session, read fresh on every call:
    // accepting a recovery snapshot reassigns runtime.sessionId in place, and a
    // value captured here would keep writing refs under the session the user
    // just left. Without this the task graph falls back to the shared legacy
    // namespace and nothing is keyed to a session that can be reaped.
    resolveSessionId,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    // A keyed state file is reclaimed only once no saved conversation carries its session id.
    isSessionResumable: (sessionToken) => services.sessionManager.has(sessionToken),
    controlSurfaces: controlSurfacesFor(services),
    readAdmissionPolicy: 'agent-main-conversation',
    settingsAdmissionPolicy: 'agent-main-conversation',
    // ONE file cache and ONE project index for the process. registerAllTools
    // builds its own pair when none is passed, and then the file tools would read
    // an index the graph neither owns nor closes. Passing the graph's pair makes
    // the instance the tools read the instance the graph owns.
    fileCache: services.fileCache,
    projectIndex: services.projectIndex,
    // Daemon-owned settings (surfaces.*, the control-plane binding, watchers,
    // pairing, retention) must be read and written through the daemon that owns
    // them, not through this process's own store. Without this the settings
    // tools silently fall back to the local file: a value written here would
    // configure nothing, and reading it back afterwards would report it unset.
    //
    // The daemon home is derived from THIS process's home rather than the
    // machine's, so a run rooted at a scratch home cannot reach a real daemon.
    // Only an explicit GOODVIBES_DAEMON_HOME overrides that.
    configRouting: buildAgentConfigRouting({ homeDir: homeDirectory }),
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    archetypeLoader: services.archetypeLoader,
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: services.workingDirectory,
    configManager,
    runtimeBus: services.runtimeBus,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    overflowHandler: services.overflowHandler,
    changeTracker: services.sessionChangeTracker,
    // state mode=memory reads and writes the one memory store, through the connected host while it serves memory.
    memoryAccess: services.memorySpineClient,
    // Same holder instance `services.contextAccountingHolder` exposes, the
    // context_accounting tool registered here and the bind call bootstrap.ts
    // makes after constructing the Orchestrator (see
    // context-accounting-source.ts) must share ONE holder, otherwise the tool
    // would read an unbound holder of its own while the real source sits on a
    // different instance nothing reads.
    contextAccountingHolder: services.contextAccountingHolder,
  });
  // The Agent tools a turn has wherever it runs, the same list a turn the daemon
  // hosts for the Agent registers (agent-turn's registerAgentTurnTools).
  registerAgentTurnTools(toolRegistry, {
    gatewayMethods: services.gatewayMethods,
    remote: connectedHostFamilyRemote({ configManager, homeDirectory: services.shellPaths.homeDirectory }),
    shellPaths: services.shellPaths,
    artifactStore: services.artifactStore,
    notificationConfig: configManager,
    webhookNotifier: services.webhookNotifier,
    mediaProviders: services.mediaProviders,
    channelDeliveryRouter: services.channelDeliveryRouter,
    workPlan: services.workPlan,
    // The connected host the operator tools call, and the owner's mail address for signup aliases.
    settings: configManager,
    // This process's own browser, built on the first call that needs one.
    browser: {
      browser: agentBrowserToolBackend({
        screenshotDirectory: agentBrowserScreenshotRoot(services.shellPaths.homeDirectory),
        profileRoot: agentBrowserProfileRoot(services.shellPaths.homeDirectory),
        homeDirectory: services.shellPaths.homeDirectory,
      }),
      // A file: page is a local read, held to the same decision the read tool gets.
      readAccess: async (absolutePath) => (await services.permissionManager.readAccess(absolutePath, resolveSessionId())) === 'allow',
    },
    // The native Gmail/Calendar route (agent-turn's google-wiring.ts): this
    // process's stores, the adopted daemon's calendar when one is reachable, and
    // the owner's /google approve gesture for a refused send.
    google: {
      configManager: configManager as GoogleToolWiringDeps['configManager'],
      secretsManager: services.secretsManager,
      homeDirectory: services.shellPaths.homeDirectory,
      artifactStore: services.artifactStore,
      calendarHost: connectedHostGoogleCalendar({ configManager, homeDirectory: services.shellPaths.homeDirectory }),
      approvals: { store: getOutwardApprovalStore(), gesture: OUTWARD_APPROVAL_GESTURE },
    },
    memoryRegistry: services.memoryRegistry,
    memoryAccess: services.memorySpineClient,
  });
  // Accounts the agent creates are recorded here at creation time. Autonomous
  // signup is authorized; doing it invisibly is not, and this is what makes it
  // enumerable and revocable.
  registerAgentAccountsTool(toolRegistry, {
    shellPaths: services.shellPaths,
    // The platform registry takes its store path and its "does this look like a
    // credential" rule as inputs rather than deriving either: the path so no
    // product writes into another's storage root, the predicate because the
    // wording of that judgement belongs to the product that shows it.
    registry: new AgentAccountRegistry({
      storePath: services.shellPaths.resolveUserPath(
        GOODVIBES_AGENT_SURFACE_ROOT,
        ...ACCOUNT_REGISTRY_PATH_SEGMENTS,
      ),
      containsSecretLikeText,
    }),
    baseAddress: () => {
      return readSurfaceEmailSettings((key) => (configManager as { get: (key: string) => unknown }).get(key)).fromAddress ?? null;
    },
  });
  registerAgentKnowledgeIngestTool(toolRegistry, services.shellPaths, configManager);
  registerAgentKnowledgeTool(toolRegistry, services.shellPaths, configManager);
  registerAgentLearningConsolidationTool(toolRegistry, services.shellPaths, services.memoryRegistry, services.memorySpineClient);
  registerAgentResearchReportTool(toolRegistry, services.artifactStore, deps.researchReportSourceOwner ?? deps.researchSourceOwner,
    deps.researchReportSourceOwner ? 'report-only' : 'shared', deps.researchSourceOwner);
  registerAgentModelCompareTool(toolRegistry, {
    modelCatalog: services.providerRegistry,
    providerRegistry: services.providerRegistry,
    artifactStore: services.artifactStore,
    applyModelRoute: async (registryKey, parentOptions, ownership) => {
      const previousModel = String(configManager.get('provider.model') ?? '').trim();
      const applied = await toolRegistry.executeNested(`model-route-${randomUUID()}`, 'settings',
        { action: 'set', key: 'provider.model', value: registryKey }, parentOptions, ownership);
      let verified = false;
      try { verified = applied.success && JSON.parse(applied.output ?? '{}').verifiedInOwningStore === true; } catch { /* Value-free refusal below. */ }
      if (!verified || configManager.get('provider.model') !== registryKey) throw new Error('Model route transition did not verify in its owning store.');
      return {
        ...(previousModel ? { previousModel } : {}),
        selectedModel: registryKey,
      };
    },
  });
  registerAgentAutonomyScheduleTool(toolRegistry, services.shellPaths, configManager);
  registerAgentReminderScheduleTool(toolRegistry, services.shellPaths, configManager, services.artifactStore);
  registerAgentScheduleEditTool(toolRegistry, services.shellPaths, configManager);
  registerAgentScheduleTool(toolRegistry, services.shellPaths, configManager);
  installAgentToolPolicyGuard(toolRegistry);
  compactRegisteredToolDefinitions(toolRegistry);
  return { toolRegistry, fileCache, projectIndex, dispose };
}
