/** The actual local-turn producer shared by bootstrap and product regressions. */
import { registerAllTools, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { trustGatedAsk } from '@goodvibes-jev/engine/platform/platform/runtime/workspace-trust';
import type { WorkspaceTrustLevel } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createSandboxExecAsk, sandboxExecAskDepsFromRuntime } from '../permissions/sandbox-exec-gate.ts';
import { readDaemonOperatorToken } from './daemon-operator-token.ts';
import { terminalOwnerQuestions } from './client/owner-questions.ts';
import { controlSurfacesFor } from './control-surfaces.ts';
import type { RuntimeServices } from './services.ts';

/**
 * The turn's permission manager is built after the tools, so the read-access
 * filter finds it here when a tool runs. Until it exists every file counts as
 * withheld: a search must never return file content the read tool would hold
 * behind an ask just because the manager was not there yet.
 */
const turnPermissionManagers = new WeakMap<RuntimeServices, PermissionManager>();

export function registerTuiTurnTools(toolRegistry: ToolRegistry, services: RuntimeServices, options: {
  readonly resolveSessionId: () => string;
  readonly onSandboxedRun?: NonNullable<Parameters<typeof registerAllTools>[1]>['onSandboxedRun'];
  /** Approval for a model-requested hook change; the turn's permission manager is built after the tools, so the host binds it late. */
  readonly hookChangeGate?: NonNullable<Parameters<typeof registerAllTools>[1]>['hookChangeGate'] | undefined;
}) {
  return registerAllTools(toolRegistry, {
    // The query tool's questions go to the daemon's owner inbox; answers come back into this conversation.
    ownerQuestions: () => terminalOwnerQuestions(services, options.resolveSessionId),
    controlSurfaces: controlSurfacesFor(services),
    // A keyed state file is reclaimed only once no saved conversation carries its session id.
    isSessionResumable: (sessionToken) => services.sessionManager.has(sessionToken),
    resolveSessionId: options.resolveSessionId, surfaceRoot: services.surface.surfaceRoot, // task refs follow the LIVE runtime session (recovery reassigns it in place); without this they fall into the shared legacy namespace
    localhostFetchApproval: services.localhostFetchApproval, // loopback-fetch ask, built once in the services composition
    sandboxEscalationHandler: services.sandboxEscalationHandler,
    execPromptAnswerHandler: services.execPromptAnswerHandler, // terminal prompt-answer path, built once in the services composition
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    archetypeLoader: services.archetypeLoader,
    projectRoot: services.workingDirectory,
    contractRunner: services.contractRunner,
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: services.workingDirectory,
    configManager: services.configManager,
    runtimeBus: services.runtimeBus,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    overflowHandler: services.overflowHandler,
    changeTracker: services.sessionChangeTracker,
    // state mode=memory reads and writes the one memory store, through the connected host while it serves memory.
    memoryAccess: services.memorySpine,
    // The model keeps the same work plan /work-plan shows.
    workPlan: services.workPlan,
    // Register context_accounting against OUR holder (the Orchestrator-backed source bootstrap.ts binds with bindSessionContextAccounting).
    contextAccountingHolder: services.contextAccountingHolder,
    // First contained (sandboxed) command run announces "commands now run contained" once, recorded and surfaced now.
    onSandboxedRun: options.onSandboxedRun,
    hookDispatcher: services.hookDispatcher,
    // find, repo_map and the agent tool apply the same per-file read decision the read tool gets.
    readAccessFilter: async (absolutePath) => {
      const manager = turnPermissionManagers.get(services);
      return manager !== undefined && (await manager.readAccess(absolutePath)) === 'allow';
    },
    secretsManager: services.secretsManager, // goodvibes_context reads Cloudflare tokens held in the secret store
    cloudflareAuthToken: () => readDaemonOperatorToken(services.shellPaths.homeDirectory), // and counts the daemon's own token as the Worker operator token, as the daemon's status route does
    ...(options.hookChangeGate ? { hookChangeGate: options.hookChangeGate } : {}),
  });
}

export function createTuiTurnPermissionManager(services: RuntimeServices, requestTrustDecision: () => Promise<WorkspaceTrustLevel>): PermissionManager {
  const manager = new PermissionManager(
    // Composed ask layer: the workspace trust gate (outer) wraps the sandbox-aware exec gate (inner); see sandbox-exec-gate.ts. The catastrophic block is untouched. The innermost ask is the CLIENT raiser: it posts approvals.raise to the daemon and prompts here (see the platform's platform/runtime/client/approval-raiser.ts).
    trustGatedAsk(
      services.workspaceTrustManager,
      createSandboxExecAsk(
        sandboxExecAskDepsFromRuntime(services.configManager, services.featureFlags),
        (request, execution) => services.requestApproval({ request, signal: execution?.signal }),
      ),
      requestTrustDecision, // indirection through the ref, not bound early. main.ts patches the real impl in later
    ),
    createPermissionConfigReader(services.configManager),
    services.policyRuntimeState,
    services.hookDispatcher,
    services.featureFlags,
    services.userPermissionRuleStore,
    { workspaceTrust: services.workspaceTrustManager },
  );
  turnPermissionManagers.set(services, manager);
  return manager;
}
