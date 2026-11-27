/** The actual local-turn producer shared by bootstrap and product regressions. */
import type { registerAllTools, ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { composeTurnTools, programProjectFacilities } from '@goodvibes/engine/platform/platform/agents';
import { projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import { PermissionManager, capabilityCommandsResolver, createPermissionConfigReader } from '@goodvibes/engine/platform/platform/permissions';
import { trustGatedAsk } from '@goodvibes/engine/platform/platform/runtime/workspace-trust';
import type { WorkspaceTrustLevel } from '@goodvibes/engine/platform/platform/runtime/operations';
import { createSandboxExecAsk, sandboxExecAskDepsFromRuntime } from '../permissions/sandbox-exec-gate.ts';
import { readDaemonOperatorToken } from './daemon-operator-token.ts';
import { terminalOwnerQuestions } from './client/owner-questions.ts';
import { createDaemonVerbCaller } from './client/operator-endpoint.ts';
import { remoteTriggerOperations } from '@goodvibes/engine/platform/platform/triggers';
import { PersonalCaptureHolder, daemonPersonalCapturePort } from '@goodvibes/engine/platform/platform/personal-capture';
import { controlSurfacesFor } from './control-surfaces.ts';
import { registerCapabilityTools } from '@goodvibes/engine/terminal-shell/agent-turn/capability-tools';
import { wireAgentGoogleTool } from '@goodvibes/engine/terminal-shell/agent-turn/google-wiring';
import { connectedHostGoogleCalendar } from '@goodvibes/engine/terminal-shell/agent-turn/google-tool';
import { getOutwardApprovalStore, OUTWARD_APPROVAL_GESTURE } from '@goodvibes/engine/terminal-shell/agent-turn/outward-approvals';
import { askBoundHiddenValue, boundCapabilityCatalog, boundSessionCapabilities, onBoundCapabilityCatalogChange } from '@goodvibes/engine/terminal-shell/capability-host';
import { AGENT_PLATFORM_TOOL_ADMISSION } from '@goodvibes/engine/terminal-shell/agent-turn/read-modes';
import { buildProgramConfigRouting } from '@goodvibes/engine/terminal-shell/program-config-routing';
import type { RuntimeServices } from './services.ts';

/**
 * The turn's permission manager is built after the tools, so the read-access
 * filter finds it here when a tool runs. Until it exists every file counts as
 * withheld: a search must never return file content the read tool would hold
 * behind an ask just because the manager was not there yet.
 */
const turnPermissionManagers = new WeakMap<RuntimeServices, PermissionManager>();

interface TuiTurnToolOptions {
  readonly resolveSessionId: () => string;
  readonly onSandboxedRun?: NonNullable<Parameters<typeof registerAllTools>[1]>['onSandboxedRun'];
  /** Approval for a model-requested hook change; the turn's permission manager is built after the tools, so the host binds it late. */
  readonly hookChangeGate?: NonNullable<Parameters<typeof registerAllTools>[1]>['hookChangeGate'] | undefined;
  /** A headless run: the project's tool servers start on the turn's first `mcp` call (bootstrap starts none). */
  readonly toolServersOnFirstUse?: boolean | undefined;
}

export function registerTuiTurnTools(toolRegistry: ToolRegistry, services: RuntimeServices, options: TuiTurnToolOptions) {
  const registered = registerTerminalTurnTools(toolRegistry, services, options);
  // GoodVibes' own capabilities, found by need and run by id (the same two tools the Agent and the daemon's own
  // turns carry): what a person does in this app's screens and through the daemon, the model does through these,
  // each call admitted by the gate under the mode in force; the owner's own acts are refused (capability-tools.ts).
  registerCapabilityTools(toolRegistry, services.shellPaths, services.configManager, {
    catalog: boundCapabilityCatalog,
    onCatalogChange: onBoundCapabilityCatalogChange,
    askHidden: askBoundHiddenValue,
    session: boundSessionCapabilities,
    program: 'tui',
    workingDirectory: () => services.workingDirectory,
    // The live conversation: a record the model adds through capability_run names it.
    sessionId: options.resolveSessionId,
    // The model this conversation uses: a capability on it (its context window size) acts on it.
    model: () => services.providerRegistry.getCurrentModel().registryKey,
  });
  // The person's mail and calendar (`google`), as every other door's turn has them (the Agent's, the daemon's): mail on
  // this process's connector, calendar on the daemon's `calendar.events.*` when one is reachable, a refused send
  // approved by the owner in Waiting for you.
  wireAgentGoogleTool(toolRegistry, {
    configManager: services.configManager,
    secretsManager: services.secretsManager,
    homeDirectory: services.shellPaths.homeDirectory,
    artifactStore: services.artifactStore,
    calendarHost: connectedHostGoogleCalendar({ configManager: services.configManager, homeDirectory: services.shellPaths.homeDirectory }),
    approvals: { store: getOutwardApprovalStore(), gesture: OUTWARD_APPROVAL_GESTURE },
  });
  return registered;
}

/**
 * How the model's settings tools reach a setting's owner, the same as the Agent's: the daemon found from its own
 * binding with this machine's operator token (terminal-shell program-config-routing.ts), reads through this program's
 * connection, and the one admitted write (the input projector prepares it, the gate decides it once, the daemon is told
 * so with this program's registration). Used for this program's turns and the agents it spawns.
 */
export function terminalSettingsToolProgram(services: RuntimeServices): {
  readonly settingsAdmissionPolicy: typeof AGENT_PLATFORM_TOOL_ADMISSION.settingsAdmissionPolicy;
  readonly configRouting: ReturnType<typeof buildProgramConfigRouting>;
} {
  return {
    settingsAdmissionPolicy: AGENT_PLATFORM_TOOL_ADMISSION.settingsAdmissionPolicy,
    configRouting: buildProgramConfigRouting({
      homeDir: services.shellPaths.homeDirectory,
      readDaemonSnapshot: () => services.daemonConfig.snapshot(),
    }),
  };
}

function registerTerminalTurnTools(toolRegistry: ToolRegistry, services: RuntimeServices, options: TuiTurnToolOptions) {
  // The owner profile and dates are the daemon's: `profile` records and reads them through its methods, so this
  // program's turns have the tool every other door has (personal-capture/daemon-port.ts).
  const daemonCalls = createDaemonVerbCaller({ configManager: services.configManager, homeDirectory: () => services.shellPaths.homeDirectory });
  const personalCapture = new PersonalCaptureHolder();
  personalCapture.setPort(daemonPersonalCapturePort((methodId, input) => daemonCalls.invoke(methodId, input)));
  // The one composition every turn has (agents/turn-composition.ts), in this process: this program's host facts, the
  // project's environment (this program's own, built once for the folder it runs in) and the program's surface.
  // A headless run starts the project's tool servers on the turn's first `mcp` call (the servers' files are the
  // project root's, wherever in it the program was started), as the Agent's lazy start does.
  const projectRoots = { workingDirectory: projectIdentityOf(services.shellPaths.workingDirectory), homeDirectory: services.shellPaths.homeDirectory };
  const mcpConnect = options.toolServersOnFirstUse ? () => services.mcpRegistry.connectAll(projectRoots) : undefined;
  return composeTurnTools(toolRegistry, {
    project: { ...programProjectFacilities(services, services.configManager), ...(mcpConnect ? { mcpConnect } : {}) },
    program: { surfaceRoot: services.surface.surfaceRoot, ...terminalSettingsToolProgram(services) },
    host: {
    // The query tool's questions go to the daemon's owner inbox; answers come back into this conversation.
    ownerQuestions: () => terminalOwnerQuestions(services, options.resolveSessionId),
    // The trigger tool works on the daemon's supervisor: this terminal leaves triggers to the daemon.
    triggers: remoteTriggerOperations(createDaemonVerbCaller({ configManager: services.configManager, homeDirectory: () => services.shellPaths.homeDirectory })),
    controlSurfaces: controlSurfacesFor(services),
    // A keyed state file is reclaimed only once no saved conversation carries its session id.
    isSessionResumable: (sessionToken) => services.sessionManager.has(sessionToken),
    resolveSessionId: options.resolveSessionId, // task refs follow the LIVE runtime session (recovery reassigns it in place); without this they fall into the shared legacy namespace
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
    // None in this program (its work runs on the daemon): the agent tool hands a task over as work.
    ...(services.contractRunner ? { contractRunner: services.contractRunner } : {}),
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    personalCapture,
    workflowServices: services.workflow,
    sessionOrchestration: services.sessionOrchestration,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: services.workingDirectory,
    configManager: services.configManager,
    runtimeBus: services.runtimeBus,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    serviceRegistry: services.serviceRegistry,
    // state mode=memory reads and writes the one memory store, through the connected host while it serves memory.
    memoryAccess: services.memorySpine,
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
    // The secret store (goodvibes_context reads Cloudflare tokens there) and the gates are the project's, above.
    cloudflareAuthToken: () => readDaemonOperatorToken(services.shellPaths.homeDirectory), // and counts the daemon's own token as the Worker operator token, as the daemon's status route does
    ...(options.hookChangeGate ? { hookChangeGate: options.hookChangeGate } : {}),
    // A delegation nothing the owner said settles, and the decision model could not read, is put to the owner in the ordinary approval prompt.
    delegationAsk: async (question, { signal }) => {
      const manager = turnPermissionManagers.get(services);
      if (manager === undefined) return { approved: false, asked: false, reason: 'no approval prompt is available here to ask the owner' };
      return manager.askDelegation(question, { signal });
    },
    },
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
    createPermissionConfigReader(services.configManager, services.secretsManager),
    services.policyRuntimeState,
    services.hookDispatcher,
    services.featureFlags,
    services.userPermissionRuleStore,
    { workspaceTrust: services.workspaceTrustManager },
  );
  // The model's `code.test` and `worktree.setup` are decided as the commands they run (capability-commands.ts).
  manager.useCapabilityCommands(capabilityCommandsResolver(services.configManager));
  turnPermissionManagers.set(services, manager);
  return manager;
}
