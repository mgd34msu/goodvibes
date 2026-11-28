import type { LocalhostFetchApproval } from '../runtime/permissions/localhost-fetch-approval.js';
import { createCapturedAutoHealBackend } from './shared/captured-auto-heal.js';
import { createCapturedValidatorRunner } from './shared/captured-validators.js';
import { resolveScopedDirectory } from '../runtime/surface-root.js';
import { ToolRegistry } from './registry.js';
import type { Tool } from '../types/tools.js';
import { FileStateCache } from '../state/file-cache.js';
import { ProjectIndex } from '../state/project-index.js';
import { toolCallTelemetryFor } from '../state/telemetry.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { ModeManager } from '../state/mode-manager.js';
import { FileUndoManager } from '../state/file-undo.js';
import type { ConfigManager } from '../config/manager.js';
import { isEffectiveDangerMode } from '../config/index.js';
import { turnInputParty } from '../security/turn-input-party.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ToolLLM } from '../config/tool-llm.js';
import { ReadTool } from './read/index.js';
import { createAgentReadInputProjector } from './read/admission.js';
import type { ToolRegistrationOptions } from './input-projection.js';
import { createWriteTool } from './write/index.js';
import { createEditTool } from './edit/index.js';
import { CodeDiagnosticsProvider } from './shared/post-edit-diagnostics.js';
import { createRepoMapTool } from './repo-map/index.js';
import { ContextAccountingHolder, createContextAccountingTool } from './context-accounting/index.js';
import { createContractSelfCheckTool } from './contract-self-check/index.js';
import { createFindTool } from './find/index.js';
import { CodeIntelligence } from '../intelligence/index.js';
import { withProjectFilesEpoch } from '../intelligence/project-files-epoch.js';
import { createShellPathService, projectFolderOf } from '../runtime/shell-paths.js';
import { createExecTool } from './exec/index.js';
import { createExecValidatorRunner, type ExecToolOptions } from './exec/runtime.js';
import type { CredentialEnvScrubConfig } from './exec/credential-env.js';
import { configuredCredentialEnvScrub } from './exec/credential-env-config.js';
import { hostSandboxAvailability, type ExecSandboxRuntime } from './exec/sandbox.js';
import { createSandboxRuntimeConfig } from './exec/sandbox-config-lists.js';
import {
  detectPtyAvailability,
  probePtyHost,
  type ExecInteractionRuntime,
  type ExecPromptAsk,
  type ExecPromptAnswer,
} from './exec/interactive.js';
import { foreignInputWriteRefusal, type ExecContainmentRequirement } from './exec/containment.js';
import { createAnalyzeTool } from './analyze/index.js';
import { InspectTool } from './inspect/index.js';
import { createAgentTool } from './agent/index.js';
import { createConfiguredFetchDeps, createFetchTool } from './fetch/index.js';
import { createStateTool } from './state/index.js';
import { projectStateMemory, type StateMemoryStore } from './state/memory-mirror.js';
import { memoryProjectIdentity } from '../state/memory-project.js';
import { createLocalMemoryAccess } from '../runtime/memory-spine/client.js';
import { createWorkflowServices, createWorkflowTool } from './workflow/index.js';
import { createRegistryTool } from './registry-tool/index.js';
import { createKeyedStateReclaimCheck, createPerConversationKvState, createSessionBoundKvState } from './session-kv-state.js';
import { createTaskTool } from './task/index.js';
import { createWorkPlanTool, type WorkPlanToolStore } from './work-plan/index.js';
import { createMcpTool } from './mcp/index.js';
import { createQueryTool } from './query/index.js';
import { createTriggerTool } from '../triggers/trigger-tool.js';
import { TriggerManager } from '../triggers/manager.js';
import { createRemoteTool } from './remote-trigger/index.js';
import { createReplTool } from './repl/index.js';
import { createCapturedReplTool } from './repl/captured.js';
import { createControlTool, type ControlToolOptions } from './control/index.js';
import { createProfileTool } from './profile/index.js';
import { createChannelTool } from './channel/index.js';
import { createDaemonCapabilityTools } from './capability/daemon-tools.js';
import { CapabilityCatalog } from '../capabilities/catalog.js';
import { movedCapabilityEntries } from '../capabilities/builtin/index.js';
import { createWebSearchTool } from './web-search/index.js';
import { ProcessManager } from './shared/process-manager.js';
import type { AgentManager } from './agent/index.js';
import { AgentMessageBus } from '../agents/message-bus.js';
import { AGENT_MANAGER_SESSION_ID, type ContractRunner } from '../contract/runner.js';
import type { WebSearchService } from '../web-search/index.js';
import type { ChannelPluginRegistry } from '../channels/index.js';
import type { RemoteRunnerRegistry } from '../runtime/remote/index.js';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import type { SandboxSessionRegistry } from '../runtime/sandbox/session-registry.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SecretsManager } from '../config/secrets.js';
import { OverflowHandler } from './shared/overflow.js';
import type { SessionChangeTracker } from '../sessions/change-tracker.js';
import type { ArchetypeLoader } from '../agents/archetypes.js';
import { createGoodVibesContextTool, createGoodVibesSettingsTool } from './goodvibes-runtime/index.js';
import { createAgentSettingsInputProjector } from './goodvibes-runtime/settings-admission.js';

export {
  applyRoutedConfigWrite,
  localStorePathForKey,
  projectOverlayRefusal,
  readRoutedConfigValue,
  readRoutedConfigValues,
  resolveRouterDeps,
} from './goodvibes-runtime/config-routing.js';
export type {
  ConfigReadResult,
  ConfigRoutingOptions,
  ConfigValueOrigin,
  RoutedConfigRead,
  RoutedConfigWrite,
  UnavailableConfigRead,
} from './goodvibes-runtime/config-routing.js';

export { runRegisteredTool, currentToolExecuteOptions, previewRegisteredTool } from './registry.js';
export { ToolRegistry, assertCurrentToolExecution, assertCurrentToolInvocation, assertCurrentToolEffect, currentToolAutonomySource, commitCurrentToolSettingsPlan, currentToolSettingsPresentation, claimCurrentToolSettingsDispatch, noteCurrentToolEffectSent, toolActivityOf } from './registry.js';
export { registrySelect } from './batteries/registry-select.js';
export { registryCatalogGroupFit } from './batteries/registry-catalog-group.js';
export type { ToolExecutionEffect, CurrentToolAutonomySource } from './registry.js';
export type { ToolExecuteOptions } from '../types/tools.js';
export { ToolInputProjectionError, assertProjectionExecution, assertProjectionCurrent } from './input-projection.js';
export type {
  ToolPreparedSettingsMutation, ToolNativeReferencesCapture, ProjectedToolCall, ToolAdmissionEvidence, ToolInputProjectionProblem, ToolInputProjectionRequest,
  ToolInputProjectionResult, ToolInputProjector, ToolRegistrationOptions, ToolInputProjectionOptions,
} from './input-projection.js';
export { ProcessManager } from './shared/process-manager.js';
export type { BackgroundProcess, BgCommandResult, SpawnOptions, ProcessLifecycleEvent, ProcessLifecycleListener } from './shared/process-manager.js';
export { AGENT_TEMPLATES, AgentManager } from './agent/index.js';
export type { AgentExecutor, AgentRecord, AgentFleetOwnership } from './agent/index.js';
// A terminal program's delegations, run as pieces of work on the daemon's one runner.
export type { AgentWorkDelegation, DelegatedWork, DelegatedWorkUpdate } from './agent/work-delegation.js';
export { AutoHealer } from './shared/auto-heal.js';
export {
  appendSchemaFingerprint,
  computeSchemaFingerprint,
  computeSchemaFingerprintSync,
  getSchemaShapeId,
  SCHEMA_SHAPE_IDS,
} from './shared/schema-fingerprint.js';
export type { SchemaFingerprintMeta } from './shared/schema-fingerprint.js';
export { OverflowHandler, createSpillBackend } from './shared/overflow.js';
export { DiagnosticsBackend, FileBackend, LedgerBackend, overflowCleanup } from './shared/overflow.js';
export type {
  OverflowHandlerConfig,
  OverflowOptions,
  OverflowResult,
  RetentionPolicyConfig,
  SpillBackend,
  SpillBackendType,
  SpillEntry,
} from './shared/overflow.js';
export {
  WORKFLOW_DEFINITIONS,
  HookActionManager,
  WorkflowManager,
  ScheduleManager,
  createWorkflowServices,
  createWorkflowTool,
  parseInterval,
} from './workflow/index.js';
export type { HookActionDefinition, WorkflowServices } from './workflow/index.js';
export { loadSkillByTrigger } from './registry-tool/skill-loader.js';
export type { SkillLoaderRoots } from './registry-tool/skill-loader.js';
export { ReadTool } from './read/index.js';
export { createWriteTool } from './write/index.js';
export { createEditTool } from './edit/index.js';
export { createRepoMapTool } from './repo-map/index.js';
export { ContextAccountingHolder, createContextAccountingTool } from './context-accounting/index.js';
export type { ContextAccountingSource, ContextTokenState } from './context-accounting/index.js';
// The one session-backed source for context_accounting, bound by both terminal apps and the daemon's hosted sessions.
export { bindSessionContextAccounting, createSessionContextAccountingSource } from './context-accounting/session-source.js';
export type { SessionContextAccountingOptions, SessionContextAccountingHandle, ContextAccountingOrchestrator, CompactionActivityBus } from './context-accounting/session-source.js';
export type { EditToolOptions } from './edit/index.js';
export type { EditItem, EditInput } from './edit/types.js';
export { createFindTool } from './find/index.js';
export { createExecTool } from './exec/index.js';
// The per-command exec sandbox is wired internally by registerAllTools from the
// sandbox.* config + the exec-sandbox flag; only its types are re-exported here
// (type re-exports are erased at runtime, so they carry no bundle cost) so a
// consumer calling createExecTool directly can still name the option shape. The
// runner functions stay importable from the exec/sandbox module.
export type {
  ExecSandboxConfig,
  ExecSandboxRuntime,
  ExecSandboxPlan,
  SandboxAvailability,
  SandboxHostProbe,
  SandboxNetworkState,
  BwrapArgvInput,
  ResolveSandboxPlanInput,
} from './exec/sandbox.js';
// The PTY prompt-answer path is likewise wired internally by registerAllTools
// (probed only when the composition root supplies a prompt-answer handler);
// its types are re-exported for direct createExecTool callers, and the pure
// detection/argv helpers stay importable from the exec/interactive module.
export type {
  ExecInteractionRuntime,
  ExecPromptAsk,
  ExecPromptAnswer,
  PtyAvailability,
  PtyHostProbe,
} from './exec/interactive.js';
// The composition-stated exec posture: whether the boundary is REQUIRED
// (containment). It defaults to the historical behaviour when a composition says
// nothing, so naming it here is what lets a composition say something.
export { decideExecContainment, TURN_EXEC_CONTAINMENT } from './exec/containment.js';
export type {
  ExecContainmentPosture,
  ExecContainmentRequirement,
  ExecContainmentDecision,
} from './exec/containment.js';
export { formatDenialResponse, guardExecCommand } from './exec/ast-guard.js';
// The owner's credential-env allowlist setting: its key and the one reader every
// spawn uses, so a settings editor shows exactly the list commands get.
export { EXEC_ENV_SCRUB_ALLOWLIST_KEY, configuredCredentialEnvScrub } from './exec/credential-env-config.js';
export { createAnalyzeTool } from './analyze/index.js';
export { InspectTool } from './inspect/index.js';
export { createAgentTool } from './agent/index.js';
// Consumers MUST be able to reach this: RuntimePollerOwners.cancelHostedAgentRuns
// is required, and every fork that composes its own runtime graph has to supply
// it. Without a published route to the shared implementation the contract asks
// for something it does not hand out, and each fork re-writes the cancel loop.
export { cancelAllAgentRuns, type CancellableAgentRuns } from './agent/index.js';
export { createChannelTool } from './channel/index.js';
export { registerChannelAgentTools } from './channel/agent-tools.js';
export { createControlTool } from './control/index.js';
export type { ControlSurfaceEntry, ControlToolOptions } from './control/index.js';
export { readCredentialHeader } from './credential-header-reading.js';
export { createConfiguredFetchDeps, createFetchTool } from './fetch/index.js';
export type { ConfiguredFetchDepsOptions } from './fetch/index.js';
export { applySanitizer, resolveSanitizeMode } from './fetch/sanitizer.js';
export type { SanitizeMode } from './fetch/sanitizer.js';
export { TRUST_TIER_EVENTS, classifyHostTrustTier, extractHostname } from './fetch/trust-tiers.js';
export type { TrustTierConfig } from './fetch/trust-tiers.js';
export { repairToolCall } from './auto-repair.js';
export { createMcpTool } from './mcp/index.js';
export { createQueryTool } from './query/index.js';
export type { QuestionInbox } from './query/index.js';
export { createRegistryTool } from './registry-tool/index.js';
export { createRemoteTool } from './remote-trigger/index.js';
// The same tool's parameters, for the terminal programs' `remote` tool that runs the daemon's runners (terminal-shell daemon-remote-tool.ts).
export { REMOTE_TRIGGER_TOOL_SCHEMA } from './remote-trigger/schema.js';
export { createReplTool } from './repl/index.js';
export { createStateTool } from './state/index.js';
export { createTaskTool } from './task/index.js';
export { createWebSearchTool } from './web-search/index.js';
export { createWorkPlanTool } from './work-plan/index.js';
export type { WorkPlanToolStore } from './work-plan/index.js';

/**
 * The state tool's memory store over a local registry. While a connected host
 * serves memory this registry is not the store prompts read, and it cannot
 * reach the host, so every operation fails and says so.
 */
function localStateMemory(
  registry: import('../state/index.js').MemoryRegistry,
  routedOverWire: (() => boolean) | undefined,
): StateMemoryStore {
  const local = createLocalMemoryAccess(registry);
  if (!routedOverWire) return local;
  const reach = <A extends unknown[], T>(run: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => {
    if (routedOverWire()) {
      throw new Error('memory is served by the connected host and this session has no route to it; hand the memory to the main session, which can save it');
    }
    return run(...args);
  };
  return {
    add: reach(local.add),
    list: reach(local.list),
    update: reach(local.update),
    updateReview: reach(local.updateReview),
    delete: reach(local.delete),
    get: reach(local.get),
  };
}

/** The PTY backend of this host, probed once per process (a `command -v script` spawn), not once per registry. */
let ptyAvailability: ReturnType<typeof detectPtyAvailability> | undefined;
function hostPtyAvailability(): ReturnType<typeof detectPtyAvailability> {
  ptyAvailability ??= detectPtyAvailability(probePtyHost());
  return ptyAvailability;
}

/**
 * Register all built-in tools into the given registry.
 * Creates shared FileStateCache and ProjectIndex instances so read/write/edit
 * tools share cache state within a session.
 */
export function registerAllTools(
  registry: ToolRegistry,
  deps?: {
    fileCache?: FileStateCache | undefined;
    projectIndex?: ProjectIndex | undefined;
    fileUndoManager: FileUndoManager;
    modeManager: ModeManager;
    processManager: ProcessManager;
    agentManager?: AgentManager | undefined;
    agentMessageBus: AgentMessageBus;
    /** Starts the contracts the agent tool and the workflow tool's `contract` definition hand work to; absent in a program that runs none. */
    contractRunner?: Pick<ContractRunner, 'start' | 'list' | 'get'> | null | undefined;
    /** The project a contract started by a tool works in. */
    projectRoot: string;
    /** Where this host keeps the journals of agents run here, when not in `projectRoot` (the daemon's records of the project). */
    agentJournalRoot?: string | undefined;
    webSearchService?: WebSearchService | undefined;
    channelRegistry?: ChannelPluginRegistry | null | undefined;
    remoteRunnerRegistry?: RemoteRunnerRegistry | undefined;
    workflowServices: ReturnType<typeof createWorkflowServices>;
    mcpRegistry?: import('../mcp/registry.js').McpRegistry | undefined;
    /** Starts the registry's servers; given, the `mcp` tool starts them on its first call rather than they start with the turn. */
    mcpConnect?: (() => Promise<void>) | undefined;
    sessionOrchestration?: CrossSessionTaskRegistry | undefined;
    /**
     * Resolves the host's real runtime session id, called fresh on each task-tool
     * invocation. Without it the task tool writes every ref into the unowned
     * legacy namespace and owner-existence reaping over the task graph cannot
     * run, the bounds still apply, but nothing is keyed to a real session.
     */
    resolveSessionId?: (() => string) | undefined;
    /**
     * For a registry several conversations use at once (the daemon's, for every web chat and run of a project): the
     * conversation a call belongs to, resolved per call (security/turn-session.ts `whoseTurn`). Given, and with no
     * `resolveSessionId`, the task list, the checklist, session state, a question left for the owner and the contracts
     * an agent or workflow starts are that conversation's; records that name none stay readable as before. The trigger
     * tool keeps no conversation (its owner session is the one whose probe tools it uses and that reaps it).
     */
    turnSessionId?: (() => string | undefined) | undefined;
    /**
     * Whether the host still holds the session a keyed state file belongs to
     * (by its file-name token). Without it keyed state files are never reclaimed.
     */
    isSessionResumable?: ((sessionToken: string) => boolean) | undefined;
    sandboxSessionRegistry?: SandboxSessionRegistry | undefined;
    workingDirectory: string;
    surfaceRoot: string;
    /** Restrictive, construction-owned Agent read surface; never an execution option. */
    readAdmissionPolicy?: 'agent-main-conversation' | undefined;
    /** Restrictive adopted settings surface; omitted preserves legacy platform calls. */
    settingsAdmissionPolicy?: 'agent-main-conversation' | undefined;
    /**
     * How the settings tools reach the runtime that OWNS a given key. Without
     * it a client writes daemon-owned settings into its own store, where they
     * configure nothing, and reads them back from that same store, where they
     * look unset. Hosts that embed or can reach a daemon should supply this.
     */
    configRouting?: import('./goodvibes-runtime/config-routing.js').ConfigRoutingOptions | undefined;
    /**
     * The daemon's own auth token reader. The Cloudflare status the `goodvibes_context` tool reports counts it as
     * the Worker-to-daemon operator token when none is stored, exactly as the daemon's own status route does.
     */
    cloudflareAuthToken?: (() => string | null) | undefined;
    archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
    configManager?: ConfigManager | undefined;
    /** The runtime event bus the tool runtime reports on; the state tool's analytics mode reads the calls it reports. */
    runtimeBus?: RuntimeEventBus | undefined;
    providerRegistry?: ProviderRegistry | undefined;
    toolLLM?: ToolLLM | undefined;
    featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
    serviceRegistry?: Pick<ServiceRegistry, 'resolveAuth' | 'resolveAuthFor' | 'getAll' | 'inspect'> | null | undefined;
    secretsManager?: Pick<SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null | undefined;
    overflowHandler?: OverflowHandler | undefined;
    changeTracker?: SessionChangeTracker | undefined;
    /**
     * The project memory store `state mode=memory` reads and writes: the host's
     * memory spine, which reaches a connected host while that host serves memory.
     * Preferred over `memoryRegistry`.
     */
    memoryAccess?: import('./state/memory-mirror.js').StateMemoryStore | undefined;
    /** Project memory registry: the store `state mode=memory` uses when no `memoryAccess` is given. */
    memoryRegistry?: import('../state/index.js').MemoryRegistry | undefined;
    /**
     * True while memory is served by a connected host. A registry given without
     * `memoryAccess` cannot reach that host, so `state mode=memory` then fails
     * instead of reading or writing a local store the host does not serve.
     */
    memoryRoutedOverWire?: (() => boolean) | undefined;
    /**
     * Where the owner profile store and occasions service arrive once the
     * gateway composition has built them. Supplying it registers the `profile`
     * tool, which is how a conversational turn records a trip, a date or a fact
     * the owner just stated. Without it the tool is not registered at all,
     * rather than registered and quietly unable to write.
     */
    personalCapture?: import('../personal-capture/index.js').PersonalCaptureHolder | undefined;
    /**
     * Post-edit diagnostics provider for write/edit tool results. Defaults to
     * the in-process tree-sitter syntax provider; pass null to disable, or a
     * custom provider to override.
     */
    diagnosticsProvider?: import('./shared/post-edit-diagnostics.js').DiagnosticsProvider | null | undefined;
    /**
     * A fixed credential-env scrub for exec, scheduled commands and trigger
     * actions, for an embedder or test that does not use the owner's setting.
     * Omitted (every product): the scrub stays on and the owner's
     * `permissions.execEnvScrubAllowlist` is read from the config manager at
     * each spawn (exec/credential-env-config.ts).
     */
    credentialEnvScrub?: CredentialEnvScrubConfig | undefined;
    /**
     * Per-file read-permission decision shared with search / list / map tools
     * (find, repo_map). Wired at the composition root to
     * PermissionManager.readAccess so a file the owner denied reads for
     * never leaks its content through a search. Omitted → all files allowed.
     */
    readAccessFilter?: import('./shared/read-access.js').ReadAccessFilter | undefined;
    capturedReadAccess?: import('./shared/read-access.js').ReadAccessFilter | undefined;
    capturedExec?: import('./exec/captured-exec.js').CapturedExecAuthority | undefined;
    capturedReplHistory?: import('./repl/captured.js').CapturedReplHistory | undefined;
    /**
     * The owner inbox the `query` tool leaves questions in (in process in the
     * daemon, or the inbox.* client in a terminal app). Absent: no query tool,
     * since a question nobody can see is not a question.
     */
    ownerQuestions?: import('./query/index.js').QuestionInbox | (() => import('./query/index.js').QuestionInbox) | undefined;
    /** The project work plan the `work_plan` tool keeps (the store the work plan view shows). Absent: no `work_plan` tool. */
    workPlan?: WorkPlanToolStore | undefined;
    /**
     * The trigger supervisor the `trigger` tool creates, lists, cancels and resets
     * triggers on: the one in this process, or the host's (`remoteTriggerOperations`)
     * for an app that leaves triggers to the daemon. Absent: no `trigger` tool.
     */
    triggers?: import('../triggers/manager.js').TriggerManager | import('../triggers/operations.js').TriggerOperations | undefined;
    capturedRegistry?: import('./registry-tool/captured-source.js').CapturedRegistryContext | undefined;
    /**
     * Settable holder for the context_accounting tool's session source. The tool
     * is always registered (consumers inherit it like repo_map); the interactive
     * session binds its Orchestrator-backed source onto this holder after
     * construction. Omitted → the tool registers with a fresh empty holder and
     * honestly reports "no live session context bound".
     */
    contextAccountingHolder?: ContextAccountingHolder | undefined;
    /**
     * Broker a per-command exec-sandbox host-access escalation (network,
     * host-privilege escalation) through the approval broker before the command
     * runs. Wired at the composition root to the sandbox-escalation seam.
     * Omitted → escalations are not asked (today's behavior).
     */
    sandboxEscalationHandler?: import('../runtime/permissions/sandbox-escalation-wiring.js').ExecSandboxEscalationHandler | undefined;
    /**
     * Broker the one-tap "allow localhost fetches for this project" ask through
     * the approval broker. Wired at the composition root (see
     * runtime/permissions/localhost-fetch-approval.ts). Omitted → unapproved
     * localhost fetches are refused with an honest reason naming
     * fetch.allowLocalhost.
     */
    localhostFetchApproval?: LocalhostFetchApproval | undefined;
    /**
     * Reports each contained (sandboxed) command run; the composition root
     * wires it to the announce-once containment receipt.
     */
    onSandboxedRun?: (() => void) | undefined;
    /**
     * Broker an exec PTY terminal-prompt answer through the approval broker
     * while the command keeps running. Wired at the composition root (see
     * runtime/permissions/exec-prompt-wiring.ts). Omitted → the PTY path is
     * not engaged and every command runs the unchanged pipe-based path.
     */
    execPromptAnswerHandler?: ((ask: ExecPromptAsk) => Promise<ExecPromptAnswer>) | undefined;
    /**
     * Whether this composition REQUIRES the exec boundary. Omitted →
     * `host-allowed`: when no boundary is available a command runs on the host
     * with the self-labelling note, exactly as before.
     *
     * A hosted CONVERSATIONAL turn states `required`, and then an absent
     * boundary is a refusal rather than a silent fallback. A hosted WORKSTREAM
     * that genuinely needs the host is granted `host-allowed` per spawn by the
     * product composing it, the posture never arrives from the model, the
     * wire, or a tool argument. See exec/containment.ts.
     */
    execContainment?: ExecContainmentRequirement | undefined;
    /** The product's own commands and panels, for the `control` tool; omitted means this composition has no command surface. */
    controlSurfaces?: ControlToolOptions | undefined;
    /** The host's real hook dispatcher; supplying it offers `state mode=hooks`. */
    hookDispatcher?: import('../hooks/index.js').HookDispatcher | undefined;
    /** Approval for model-requested hook changes; the host wires it to the permission manager. Without it hooks can be listed, not changed. */
    hookChangeGate?: import('./state/index.js').HookChangeGate | undefined;
    /**
     * Puts a delegation nothing the owner said settles, and the decision model
     * could not read, to the owner (PermissionManager.askDelegation). Without it
     * such a delegation starts once the gate admitted the call.
     */
    delegationAsk?: import('../agents/delegation-authority.js').DelegationOwnerAsk | undefined;
    /**
     * The daemon's own capabilities for this registry's turns (`capability_find`,
     * `capability_run`, tools/capability/daemon-tools.ts). A terminal program
     * registers its own pair (terminal-shell agent-turn/capability-tools.ts) and
     * passes none.
     */
    capabilityTools?: import('./capability/daemon-tools.js').DaemonCapabilityToolHost | undefined;
  },
): { fileCache: FileStateCache; projectIndex: ProjectIndex; /** Flushes and stops the session key-value store; call at shutdown. */ dispose: () => Promise<void> } {
  const fileCache = deps?.fileCache ?? new FileStateCache();
  if (
    !deps?.fileUndoManager ||
    !deps?.modeManager ||
    !deps?.processManager ||
    !deps?.agentMessageBus ||
    !deps?.workflowServices
  ) {
    throw new Error(
      'registerAllTools requires explicit fileUndoManager, modeManager, processManager, agentMessageBus, and workflowServices ownership.',
    );
  }
  const fileUndoManager = deps.fileUndoManager;
  const modeManager = deps.modeManager;
  const processManager = deps.processManager;
  const agentManager =
    deps?.agentManager ??
    (deps?.remoteRunnerRegistry
      ? ((deps.remoteRunnerRegistry as unknown as { agentManager?: AgentManager | null }).agentManager ?? null)
      : null);
  if (!agentManager) {
    throw new Error('registerAllTools requires agentManager');
  }
  const agentMessageBus = deps.agentMessageBus;
  // A contract started by a tool belongs to the conversation session; without a
  // resolver it takes AgentManager's own event session, the one the runner gives
  // agent-manager spawns.
  // A registry several conversations use names each call's own (deps.turnSessionId); a host's own session otherwise.
  const conversationOf = deps.resolveSessionId === undefined ? deps.turnSessionId : undefined;
  const sessionOfCall: (() => string) | undefined = deps.resolveSessionId ?? (conversationOf ? () => conversationOf() ?? '' : undefined);
  const resolveContractSessionId = deps.resolveSessionId ?? (conversationOf ? () => conversationOf() || AGENT_MANAGER_SESSION_ID : () => AGENT_MANAGER_SESSION_ID);
  const archetypeLoader = deps?.archetypeLoader;
  const webSearchService = deps?.webSearchService;
  const channelRegistry = deps?.channelRegistry ?? null;
  const remoteRunnerRegistry = deps?.remoteRunnerRegistry;
  const workflowServices = deps.workflowServices;
  const mcpRegistry = deps?.mcpRegistry;
  if (!deps?.configManager || !deps?.providerRegistry || !deps?.toolLLM) {
    throw new Error('registerAllTools requires configManager, providerRegistry, and toolLLM');
  }
  // Exec, trigger actions and scheduled commands read the owner's scrub setting
  // from the config manager when they spawn: every registry hands over the same
  // source, so a spawned agent's registry cannot reset what the main one set,
  // and a changed setting applies to the next command without a restart.
  const scrubConfig = deps.configManager;
  const credentialEnvScrub = deps.credentialEnvScrub ?? ((): CredentialEnvScrubConfig => configuredCredentialEnvScrub(scrubConfig));
  workflowServices.commands.setCredentialEnvScrub(credentialEnvScrub);
  if (!deps?.sandboxSessionRegistry) {
    throw new Error('registerAllTools requires sandboxSessionRegistry');
  }
  if (!deps?.sessionOrchestration) {
    throw new Error('registerAllTools requires sessionOrchestration');
  }
  const sessionOrchestration = deps.sessionOrchestration;
  const workingDirectory = deps?.workingDirectory;
  if (!workingDirectory) {
    throw new Error('registerAllTools requires workingDirectory');
  }
  if (!deps?.surfaceRoot || deps.surfaceRoot.trim().length === 0) {
    throw new Error('registerAllTools requires surfaceRoot');
  }
  // The index is the project's (kept at the project root), relative paths the working folder's.
  const projectIndex = deps?.projectIndex ?? new ProjectIndex(workingDirectory, projectFolderOf(workingDirectory));
  // `register` refuses a definition a provider or the gate cannot use.
  const registerTool = (tool: Tool, registration?: ToolRegistrationOptions): void => {
    registry.register(tool, registration);
  };

  registerTool(
    createGoodVibesContextTool({
      configManager: deps.configManager,
      providerRegistry: deps.providerRegistry,
      toolRegistry: registry,
      channelRegistry,
      serviceRegistry: deps.serviceRegistry as Pick<ServiceRegistry, 'getAll' | 'inspect'> | null | undefined,
      secretsManager: deps.secretsManager ?? null,
      workingDirectory,
      homeDirectory: deps.configManager.getHomeDirectory() ?? undefined,
      surfaceRoot: deps.surfaceRoot,
      configRouting: deps.configRouting,
      ...(deps.cloudflareAuthToken ? { cloudflareAuthToken: deps.cloudflareAuthToken } : {}),
    }),
  );
  registerTool(
    createGoodVibesSettingsTool({
      configManager: deps.configManager,
      configRouting: deps.configRouting,
      admissionPolicy: deps.settingsAdmissionPolicy,
    }),
    deps.settingsAdmissionPolicy === 'agent-main-conversation'
      ? { inputProjection: createAgentSettingsInputProjector(deps.configManager, deps.configRouting) } : undefined,
  );
  if (deps.personalCapture) {
    const captureConfig = deps.configManager;
    registerTool(
      createProfileTool({
        holder: deps.personalCapture,
        ...(captureConfig
          ? { captureEnabled: (): boolean => captureConfig.get('profile.conversationalCapture') !== false }
          : {}),
        // A tool nobody re-bound is answering on a surface the owner is sitting
        // at; the channel-bound case is produced per turn by bindCapture.
        defaultAuthority: {
          authority: 'owner-direct',
          // The program the owner is sitting at, named in the line's provenance: the terminal app's own turns say so.
          surface: deps.surfaceRoot === 'tui' ? 'tui' : 'agent',
          canCapture: true,
          source: 'local-surface',
          reason: 'This turn came from a surface you are using directly, so it carries your authority.',
        },
      }),
    );
  }
  const readConfigManager = deps.configManager;
  // Reading outside the project (another project's files, the owner's home) is the owner's own turn's only, under their
  // own settings (YOLO: their choice for their own turns). A turn on anyone else's input (a member's or a device's chat, a
  // channel message, an outside agent, a runner, work someone else caused) reads inside its project only, by real
  // path, whatever the mode. The product's own homes are never read from outside them (utils/path-safety.ts).
  const allowOutsideProject = () => turnInputParty().party === 'owner' && isEffectiveDangerMode(readConfigManager);
  // One code-intelligence facade for read, find and post-edit diagnostics: one
  // parser, the workspace's language files, and one set of language servers
  // (started by find references, then also asked for type errors after an
  // edit). Without a home directory the language files cannot be resolved, so
  // it parses with the built-in table and has no language servers. The facade
  // is the workspace's shared one, so /intelligence and worker agents in the
  // same directory ask the same warm servers.
  const intelligenceHome = deps.configManager.getHomeDirectory();
  const intelligenceHold = intelligenceHome
    ? CodeIntelligence.holdForWorkspace(createShellPathService({ workingDirectory, homeDirectory: intelligenceHome }))
    : undefined;
  const codeIntelligence = intelligenceHold?.intelligence ?? new CodeIntelligence({});
  registerTool(new ReadTool(projectIndex, fileCache, codeIntelligence, deps.capturedReadAccess, allowOutsideProject, () => readConfigManager.get('tools.defaultTokenBudget')),
    deps.readAdmissionPolicy === 'agent-main-conversation'
      ? { inputProjection: createAgentReadInputProjector(projectIndex, allowOutsideProject) } : undefined);
  // One post-edit diagnostics provider shared by write and edit. Default:
  // syntax errors from the in-process parser, plus type errors from a language
  // server that is already running (it never starts one). `null` disables.
  const diagnosticsProvider =
    deps.diagnosticsProvider === null
      ? undefined
      : (deps.diagnosticsProvider ?? new CodeDiagnosticsProvider(codeIntelligence));
  // Per-command exec sandbox: only probe the host (a bwrap spawn) when the
  // graduation-gated flag AND the sandbox.enabled config switch are both on, so
  // the default path stays zero-cost and byte-for-byte unchanged.
  const sandboxConfigManager = deps.configManager;
  const sandboxCategory = sandboxConfigManager.getCategory('sandbox');
  const execSandbox: ExecSandboxRuntime | null =
    (deps.featureFlags?.isEnabled('exec-sandbox') ?? false) && sandboxCategory.enabled
      ? {
          // Read at each command: an allowlist or writable-path change applies to the next command. Only the
          // host probe and the decision to wire a sandbox at all are made at startup.
          config: createSandboxRuntimeConfig(sandboxConfigManager),
          availability: hostSandboxAvailability(),
          featureEnabled: true,
          homeDir: sandboxConfigManager.getHomeDirectory() ?? undefined,
          ...(deps.sandboxEscalationHandler ? { requestEscalation: deps.sandboxEscalationHandler } : {}),
          ...(deps.onSandboxedRun ? { onSandboxedRun: deps.onSandboxedRun } : {}),
        }
      : null;
  // Hook actions and scheduled commands run inside the same boundary as exec.
  // Only a registry that has the sandbox hands it over, so a registry built
  // without one (a spawned agent's) cannot take it away from the shared services.
  if (execSandbox) workflowServices.commands.setSandbox(execSandbox);
  // PTY prompt-answer path: only probe the host (a `command -v script` spawn)
  // when the composition root wired a prompt-answer handler, so the default
  // path stays zero-cost and byte-for-byte unchanged.
  const execInteraction: ExecInteractionRuntime | null = deps.execPromptAnswerHandler
    ? {
        availability: hostPtyAvailability(),
        requestPromptAnswer: deps.execPromptAnswerHandler,
      }
    : null;
  const execOptions: ExecToolOptions = {
    ...(deps.capturedExec ? { capturedInput: deps.capturedExec } : {}),
    featureFlags: deps.featureFlags,
    overflowHandler: deps.overflowHandler,
    defaultWorkingDirectory: workingDirectory,
    credentialEnvScrub,
    ...(execSandbox ? { sandbox: execSandbox } : {}),
    ...(execInteraction ? { interaction: execInteraction } : {}),
    ...(deps.execContainment ? { containment: deps.execContainment } : {}),
  };
  const capturedAutoHeal = deps.capturedExec ? createCapturedAutoHealBackend(deps.capturedExec) : undefined;
  // Validators run only through exec's own path (sandbox plan, containment, credential scrub), never a separate spawn.
  const validatorRunner = deps.capturedExec
    ? createCapturedValidatorRunner(deps.capturedExec, { sandbox: execSandbox, credentialEnvScrub })
    : createExecValidatorRunner(processManager, execOptions);
  // A turn acting on someone else's input writes no file (exec/containment.ts foreignInputWriteRefusal, decided in
  // security/turn-input-party.ts): asked at the call, since one registry serves the owner's turns and others' alike.
  const ownersWritesOnly = (tool: Tool): Tool => ({
    ...tool,
    execute: async (args, options) => {
      const refusal = foreignInputWriteRefusal(tool.definition.name);
      return refusal ? { success: false, error: refusal } : tool.execute(args, options);
    },
  });
  registerTool(
    ownersWritesOnly(createWriteTool({
      projectRoot: workingDirectory,
      fileCache,
      projectIndex,
      capturedReadAccess: deps.capturedReadAccess,
      validatorRunner,
      capturedAutoHeal,
      fileUndoManager,
      configManager: deps.configManager,
      toolLLM: deps.toolLLM,
      changeTracker: deps?.changeTracker,
      diagnosticsProvider,
    })),
  );
  registerTool(
    ownersWritesOnly(createEditTool(fileCache, {
      cwd: workingDirectory,
      validatorRunner,
      capturedAutoHeal,
      fileUndoManager,
      configManager: deps.configManager,
      toolLLM: deps.toolLLM,
      changeTracker: deps?.changeTracker,
      diagnosticsProvider,
    })),
  );
  registerTool(
    createFindTool(workingDirectory, deps.featureFlags, undefined, deps.readAccessFilter, deps.capturedReadAccess, allowOutsideProject, codeIntelligence),
  );
  registerTool(
    createRepoMapTool({
      projectRoot: workingDirectory,
      allowOutsideProject,
      ...(deps.readAccessFilter ? { readAccessFilter: deps.readAccessFilter } : {}),
    }),
  );
  // One holder answers context_accounting and the state tool's budget and context modes.
  const contextAccountingHolder = deps.contextAccountingHolder ?? new ContextAccountingHolder();
  registerTool(createContextAccountingTool(contextAccountingHolder));
  if (deps.contractRunner) registerTool(createContractSelfCheckTool(deps.contractRunner));
  // A command or file operation can change any project file, so each exec
  // call ends by marking cached project-file facts (the import graph) stale.
  registerTool(
    withProjectFilesEpoch(createExecTool(processManager, execOptions)),
  );
  registerTool(createAnalyzeTool(deps.toolLLM, deps.featureFlags, workingDirectory));
  registerTool(new InspectTool(deps.featureFlags, workingDirectory, allowOutsideProject));
  registerTool(
    createAgentTool({
      manager: agentManager,
      messageBus: agentMessageBus,
      configManager: deps.configManager,
      ...(archetypeLoader ? { archetypeLoader } : {}),
      ...(deps.contractRunner ? { contractRunner: deps.contractRunner } : {}),
      projectRoot: deps.projectRoot,
      ...(deps.agentJournalRoot ? { journalRoot: deps.agentJournalRoot } : {}),
      surfaceRoot: deps.surfaceRoot,
      readAccessFilter: deps.readAccessFilter,
      resolveSessionId: resolveContractSessionId,
      ...(deps.delegationAsk ? { delegationAsk: deps.delegationAsk } : {}),
      ...(deps.providerRegistry ? { getSelectedModel: () => deps.providerRegistry!.getCurrentModel() } : {}),
    }),
  );
  // Scoped under the surface (surfaceRoot is required above). KVState reads and
  // writes only its own session file there and reaps stale session files at its
  // first load and then on a timer, so no retention call is needed here.
  // The host's real session id keys the file, and follows the host when it resumes or forks a session, so
  // state set before a restart is read back when that session resumes; a registry with no host session
  // (a worker's) gets a generated id, as before.
  const reclaimCheck = createKeyedStateReclaimCheck(deps.isSessionResumable);
  const kvOptions = {
    stateDir: resolveScopedDirectory(workingDirectory, deps.surfaceRoot, 'state'),
    ...(reclaimCheck ? { canReclaimKeyedState: reclaimCheck } : {}),
  };
  // Several conversations at once: each its own state file, side by side (session-kv-state.ts).
  const kvBinding = conversationOf ? createPerConversationKvState(kvOptions, conversationOf) : createSessionBoundKvState(kvOptions, deps.resolveSessionId);
  // Every state-tool write is on disk when the call returns, so no exit hook is needed to flush it.
  const kvState = kvBinding.state;
  // A local trigger supervisor's platform-tool probes may call this registry's reading tools.
  let detachProbeTools: (() => void) | undefined;
  const dispose = async (): Promise<void> => {
    detachProbeTools?.();
    await (intelligenceHold ? intelligenceHold.release() : codeIntelligence.dispose());
    await kvBinding.dispose();
  };
  // Only the host's real dispatcher is ever handed over (a private one would accept hooks nothing fires).
  // Without one the state tool does not offer mode=hooks. With one but no gate it lists hooks and refuses changes.
  const printLevelConfig = deps.configManager;
  const sharedStateMemory = deps.memoryAccess
    ?? (deps.memoryRegistry ? localStateMemory(deps.memoryRegistry, deps.memoryRoutedOverWire) : undefined);
  // Memory is one store for every project: this registry's keys are its folder's project's (memory-project.ts).
  const stateMemory = sharedStateMemory ? projectStateMemory(sharedStateMemory, memoryProjectIdentity(workingDirectory)) : undefined;
  registerTool(
    createStateTool(kvState, projectIndex, {
      ...(deps.hookDispatcher ? { hookDispatcher: deps.hookDispatcher } : {}),
      ...(deps.hookChangeGate ? { hookGate: deps.hookChangeGate } : {}),
      workingDir: workingDirectory,
      daemonHomeDir: deps.configManager.getHomeDirectory() ?? undefined,
      modeManager,
      setPrintLevel: (level) => printLevelConfig.setDynamic('behavior.hitlMode', level),
      // This registry's project's calls only; a program's registry (one conversation) also its calls that name none.
      ...(deps.runtimeBus ? { telemetryDB: toolCallTelemetryFor(deps.runtimeBus).forProject(projectIdentityOf(workingDirectory), { unattributed: conversationOf === undefined }) } : {}),
      ...(stateMemory ? { memory: stateMemory } : {}),
      contextAccounting: contextAccountingHolder,
    }),
  );
  registerTool(
    createWorkflowTool(workflowServices, {
      ...(deps.contractRunner ? { contractRunner: deps.contractRunner } : {}),
      projectRoot: deps.projectRoot,
      resolveSessionId: resolveContractSessionId,
      ...(deps.delegationAsk ? { delegationAsk: deps.delegationAsk } : {}),
    }),
  );
  const fetchConfigManager = deps.configManager;
  registerTool(
    createFetchTool(createConfiguredFetchDeps({
      serviceRegistry: deps.serviceRegistry,
      featureFlags: deps.featureFlags,
      configManager: fetchConfigManager,
      localhostFetchApproval: deps.localhostFetchApproval,
    })),
  );
  if (webSearchService) {
    registerTool(createWebSearchTool(webSearchService));
  }
  registerTool(
    createRegistryTool(registry, {
      capturedInput: deps.capturedRegistry,
      workingDirectory,
      homeDirectory: deps.configManager.getHomeDirectory() ?? undefined,
      surfaceRoot: deps.surfaceRoot,
    }),
  );
  // The task registry keys refs by owning session, and that key is now the
  // host's real runtime identity rather than a model-supplied tool argument.
  // Resolved per call, not captured here: accepting a crash-recovery snapshot
  // reassigns the runtime's sessionId in place, and a captured value would keep
  // writing refs under the session the user just left.
  registerTool(
    createTaskTool(sessionOrchestration, {
      ...(sessionOfCall ? { resolveSessionId: sessionOfCall } : {}),
      ...(conversationOf ? { ownSessionOnly: true } : {}),
    }),
  );
  // The model's checklist is the project work plan the user sees; a host with its own work plan tool leaves this out.
  // Several conversations at once: each lists and changes its own items (and those that name none).
  if (deps.workPlan) registerTool(createWorkPlanTool(deps.workPlan, {
    ...(sessionOfCall ? { resolveSessionId: sessionOfCall } : {}),
    ...(conversationOf ? { perConversation: true } : {}),
  }));
  // "Tell me when this build exits", "watch this log", "check this URL every minute": supervised by the host, not this turn.
  if (deps.triggers) {
    // A trigger made from this registry's turns works in its folder.
    registerTool(createTriggerTool(deps.triggers, { ...(deps.resolveSessionId ? { resolveSessionId: deps.resolveSessionId } : {}), workingDirectory }));
    // A probe of a trigger made here runs on this registry: its session's, and its project's (probe-tools.ts).
    if (deps.triggers instanceof TriggerManager) detachProbeTools = deps.triggers.attachProbeTools(registry, deps.resolveSessionId, workingDirectory);
  }
  if (mcpRegistry) {
    registerTool(createMcpTool(mcpRegistry, deps?.mcpConnect));
  }
  if (deps.ownerQuestions) {
    // A question says the project this registry works in: a session the daemon hosts posts in process, with no
    // program's call context for the inbox route to read it from.
    registerTool(createQueryTool({ inbox: deps.ownerQuestions, resolveProject: () => workingDirectory, ...(sessionOfCall ? { resolveSessionId: sessionOfCall } : {}) }));
  }
  if (remoteRunnerRegistry) {
    // Its turns see the runners and results of work made in this registry's project only (a turn is held to its own).
    registerTool(createRemoteTool(remoteRunnerRegistry, { importRoot: workingDirectory, onlyProject: workingDirectory }));
  }
  // An ordinary session evaluates through exec's path, so repl is offered only
  // where that path is contained: the per-command sandbox is on and this host has it.
  if (deps.capturedExec) {
    registerTool(createCapturedReplTool(deps.capturedExec, deps.featureFlags, deps.capturedReplHistory));
  } else if (execSandbox?.availability.available) {
    registerTool(createReplTool(validatorRunner, { workingDirectory }));
  }
  // A composition that supplies no lists (hosted, daemon) has no command surface; the tool says so instead of an empty list.
  registerTool(createControlTool(deps.controlSurfaces ?? {}));
  registerTool(createChannelTool(channelRegistry));
  // A registry that already has the pair (one composition handing its tools on) keeps the first.
  if (deps.capabilityTools && !registry.has('capability_run')) {
    const { tools: [find, run], runProjection } = createDaemonCapabilityTools(deps.capabilityTools, new CapabilityCatalog(movedCapabilityEntries()));
    registerTool(find!);
    // A secret input is hidden from the call before anything keeps or shows it.
    registerTool(run!, { inputProjection: runProjection });
  }
  return { fileCache, projectIndex, dispose };
}
export { booleanValue } from './batteries/boolean-value.js';

export { learningCuratorScore, learningProposalTarget, learningDuplicateAlignment, learningSurvivorSelection, learningSurvivorEquivalence } from './batteries/learning-curator.js';

export { memoryClass } from './batteries/memory-class.js';
