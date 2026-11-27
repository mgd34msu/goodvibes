import type { LocalhostFetchApproval } from '../runtime/permissions/localhost-fetch-approval.js';
import { createCapturedCodeContext } from './captured-code-context.js';
import { admitCapturedRegistryContext, type CapturedRegistryContext } from '../tools/registry-tool/captured-source.js';
import { join } from 'node:path';
import { getContractActionSource, getContractActionPort, getSourceAttachments, type ContractActionPort } from '../tools/agent/contract-binding.js';
import { createCapturedExecNodeRuntimeAdmission } from '../tools/exec/captured-exec-runtime-input.js';
import { createCapturedExecBunRuntimeAdmission } from '../tools/exec/captured-bun-runtime-input.js';
import {
  admitCapturedExecDependency,
  type CapturedExecDependencyInput,
} from '../tools/exec/captured-exec-dependencies.js';
import {
  getContractInputAuthority,
  contractInputAuthoritySourceRoot,
  assertContractInputAuthority,
  isCapturedInputPath,
  assertContractInputReadAccess,
  type ContractInputAuthority,
} from '../contract/input-authority.js';
import { capturedInputTool, capturedInputReadFilter } from '../tools/shared/captured-input-tools.js';
import { randomUUID } from 'node:crypto';
import { createCapturedReplHistory, disposeCapturedReplHistory, type CapturedReplHistory } from '../tools/repl/captured.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../types/tools.js';
import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema-types.js';
import { resolveAtRestPolicy } from '../runtime/at-rest-persistence.js';
import type { ConversationMessageSnapshot } from '../core/conversation.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { composeTurnTools } from './turn-composition.js';
import { registerChannelAgentTools } from '../tools/channel/agent-tools.js';
import { AgentMessageBus } from './message-bus.js';
import type { ChannelPluginRegistry } from '../channels/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { FileStateCache } from '../state/file-cache.js';
import { ProjectIndex } from '../state/project-index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { ToolLLM } from '../config/tool-llm.js';
import type { LLMProvider } from '../providers/interface.js';
import type { ModelDefinition } from '../providers/registry-types.js';
import type { RequestProfile } from '../providers/capabilities.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ProgressAudience } from './progress-audience.js';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentProgress,
  emitAgentRunning,
} from '../runtime/emitters/index.js';
import { findModelDefinition, findModelDefinitionForProvider } from '../providers/registry-models.js';
import { CATALOG_PROVIDER_NAME_ALIASES, sameProviderCatalog } from '../providers/provider-aliases.js';
import { resolveModelReference } from '../providers/model-id-resolution.js';
import { readFallbackOrder } from '../providers/failover.js';
import { runAgentTask, type AgentOrchestratorRunContext } from './orchestrator-runner.js';
import { forgetProjectFramework } from './orchestrator-observations.js';
import { decideInProject } from '../permissions/call-project.js';
import { currentUntrustedContentScope, getProcessUntrustedContentLedger, withUntrustedContentScope } from '../security/untrusted-content.js';
import { buildPerTurnKnowledgeInjection, defaultTurnKnowledgeBudgetTokens, DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR } from './turn-knowledge-injection.js';
import { memoryProjectOf } from '../state/memory-project.js';
import { isPassiveCodeInjectionEnabled, isPassiveKnowledgeInjectionEnabled, turnFlagSources } from '../core/orchestrator-turn-flags.js';
export { summarizeToolArgs } from './orchestrator-utils.js';

/**
 * Conversation-snapshot bridge: where AgentOrchestrator forwards a running agent's
 * live conversation-snapshot accessor. In production this is AgentManager's
 * registerConversationSource/releaseConversationSource, wired post-
 * construction in runtime/services.ts (AgentOrchestrator is constructed
 * before AgentManager there, so this is a setter rather than a constructor
 * dependency, same pattern as setRuntimeBus).
 */
export interface AgentConversationSink {
  /** `source(last)` copies only the last `last` messages when given, the whole history otherwise. */
  readonly register: (agentId: string, source: (last?: number) => ConversationMessageSnapshot[]) => void;
  readonly release: (agentId: string) => void;
}

/**
 * Cooperative cancellation bridge: where AgentOrchestrator
 * looks up a per-agent AbortSignal registered by an orchestration engine's
 * work-item run. Same shape/wiring precedent as AgentConversationSink, a
 * setter rather than a constructor dependency, wired post-construction in
 * runtime/services.ts (production backing is
 * AgentManager.registerCancellationSignal/getCancellationSignal).
 */
export interface AgentCancellationSource {
  readonly get: (agentId: string) => AbortSignal | undefined;
}

type AgentProviderRoutingPolicy = NonNullable<AgentRecord['routing']>;
type ActiveModelRef = { id: string; provider: string; registryKey: string };
type ResolvedAgentProviderRouting = {
  readonly requestedModelId: string;
  readonly providerSelection: NonNullable<AgentProviderRoutingPolicy['providerSelection']>;
  readonly providerFailurePolicy: NonNullable<AgentProviderRoutingPolicy['providerFailurePolicy']>;
  readonly providerId?: string | undefined;
  readonly providerOverride?: string | undefined;
  readonly fallbackModels: readonly string[];
};

/**
 * True when `tool` is the profile capture tool, i.e. it can be re-bound to one
 * turn's write authority. Structural rather than a name match so a host that
 * registers its own capture tool under the same contract is bound too.
 */
function isCaptureBindableTool(
  tool: Tool,
): tool is Tool & { bindCapture: (decision: import('../personal-capture/index.js').CaptureAuthorityDecision) => Tool } {
  return typeof (tool as { bindCapture?: unknown }).bindCapture === 'function';
}

/** How many idle registries of other folders (projects, worktrees) are kept for their next run. */
const IDLE_REGISTRIES_KEPT = 8;

/** A project's own facilities for the runs in its folder (see `projectFacilities`). */
export interface AgentProjectFacilities {
  readonly toolCallHooks?: { fire(event: import('../hooks/types.js').HookEvent): Promise<import('../hooks/types.js').HookResult> } | undefined;
  readonly overflowHandler?: import('../tools/shared/overflow.js').OverflowHandler | undefined;
  /** The project's own tool servers (its MCP files and the owner's), started under that project's trust. */
  readonly mcpRegistry?: import('../mcp/index.js').McpRegistry | undefined;
  /** Starts `mcpRegistry`'s servers on the `mcp` tool's first call; absent, they were started with the registry. */
  readonly mcpConnect?: (() => Promise<void>) | undefined;
  /** The project's checklist (`work_plan`), the same plan a terminal program in that folder keeps. */
  readonly workPlan?: import('../tools/work-plan/index.js').WorkPlanToolStore | undefined;
  /** The files the turns in this project changed (the record `/review` and the changed-files view read). */
  readonly changeTracker?: import('../sessions/change-tracker.js').SessionChangeTracker | undefined;
  /** After a run or turn in this project: a checkpoint of the project when its files changed (a no-op otherwise). */
  readonly afterTurn?: ((turn: AgentProjectTurn) => void) | undefined;
  /** A conversation session works in this project: its TURN_COMPLETED events are checkpointed in the project's store. */
  readonly bindSession?: ((sessionId: string) => void) | undefined;
  /** The project's hook dispatcher itself (its hooks file), for a turn engine that fires turn hooks and manages hooks. */
  readonly hookDispatcher?: import('../hooks/dispatcher.js').HookDispatcher | undefined;
  /** Resolves once the project's hooks file is read and its checkpoint store holds its baseline (never rejects). */
  readonly ready?: (() => Promise<void>) | undefined;
  /** The host's settings as a turn in this project reads them: the project as its working folder (config/project-view.ts). */
  readonly configManager?: ConfigManager | undefined;
  /** The feature gates as a turn in this project reads them: a gate whose state is a setting follows the project's layer. */
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | undefined;
  /** The secret stores as a turn in this project reads them: the host's and the owner's, then the project's own. */
  readonly secretsManager?: Pick<import('../config/secrets.js').SecretsManager, 'get' | 'set' | 'getGlobalHome'> | undefined;
  /** The services a turn in this project reaches (`fetch`'s service sign-in), their credentials read from the project's secrets first. */
  readonly serviceRegistry?: import('../config/service-registry.js').ServiceRegistry | undefined;
  /**
   * The project's code index (the one a terminal program in that folder keeps), opened on first use while the code
   * index is switched on: what a turn's passive code context is read from, kept current after its edits. Undefined
   * while it is off.
   */
  readonly codeIndex?: (() => AgentProjectCodeIndex | undefined) | undefined;
  /** The project's hooks file in its dispatcher (runtime/project-environment.ts), for a composition that lends it on. */
  readonly hookWorkbench?: import('../hooks/workbench.js').HookWorkbench | undefined;
  readonly hookActivityTracker?: import('../hooks/activity.js').HookActivityTracker | undefined;
  /**
   * The project's tool servers for a step of planned work that runs in a captured copy of the project: started inside
   * that copy by `connect` (on the step's first `mcp` call), under the project's trust, its calls decided for the
   * project. Released when the step's registry goes.
   */
  readonly capturedToolServers?: ((copyRoot: string) => {
    readonly mcpRegistry: import('../mcp/index.js').McpRegistry; connect(): Promise<void>; release(): Promise<void>;
  }) | undefined;
}

/** What a turn asks its environment for its knowledge with. */
export interface AgentTurnKnowledgeInput {
  /** The message this turn answers. */
  readonly task: string;
  readonly conversationTail: Parameters<typeof buildPerTurnKnowledgeInjection>[0]['conversationTail'];
  /** Records given on this conversation's earlier turns, not given again. */
  readonly alreadyInjectedIds: readonly string[];
  readonly turn: number;
  /** The model's context window in tokens (0: unknown); the block takes at most 3% of it. */
  readonly contextWindow: number;
}

/** The knowledge block of one turn and the records it gave. */
export interface AgentTurnKnowledge {
  readonly block: string;
  readonly injectedIds: readonly string[];
}

/** A project's code index as its turns read it and keep it current. */
export interface AgentProjectCodeIndex {
  readonly source: import('./turn-knowledge-injection.js').TurnCodeIndexSource;
  readonly reindex: Pick<import('../state/code-index-reindex.js').CodeIndexReindexScheduler, 'onToolExecuted'>
    & Partial<Pick<import('../state/code-index-reindex.js').CodeIndexReindexScheduler, 'schedule'>>;
}

/** One finished turn or run in a project, for its checkpoint. */
export interface AgentProjectTurn {
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly agentId?: string | undefined;
}

/**
 * A turn's environment in one project (see AgentOrchestrator.acquireTurnEnvironment): the tool registry rooted in the
 * project, the project's hooks for its tool calls, and the after-turn step (checkpoint). Release it when the turn ends.
 */
export interface AgentTurnEnvironment {
  readonly workingDirectory: string;
  readonly registry: ToolRegistry;
  readonly toolCallHooks?: AgentProjectFacilities['toolCallHooks'];
  /** The project's own hook dispatcher, for a turn engine that fires its turn's hooks itself (a core Orchestrator). */
  readonly hookDispatcher?: AgentProjectFacilities['hookDispatcher'];
  /** Resolves once the project's hooks file is read and its checkpoint baseline is taken: awaited before the turn's first tool call. */
  ready(): Promise<void>;
  /** The settings a turn engine there reads (the project as its working folder); absent, the host's own. */
  readonly configManager?: ConfigManager | undefined;
  /**
   * The knowledge a turn there is given before its first request, as a terminal conversation's turn is given it: the
   * owner's memory for this project and his own (never another project's), and the project's code context when the
   * code index is on. Null when passive knowledge is off or nothing cleared the relevance floor.
   */
  knowledge(input: AgentTurnKnowledgeInput): Promise<AgentTurnKnowledge | null>;
  /**
   * The project's own facilities (its tool servers, checklist, changed-files record, long-output folder, hooks), for a
   * turn that composes its own per-session registry (a hosted session) from them. Absent for the host's own folder.
   */
  readonly project?: AgentProjectFacilities | undefined;
  afterTurn(turn: AgentProjectTurn): void;
  release(): Promise<void>;
}

type AgentOrchestratorToolDeps = {
  readonly fileCache: FileStateCache;
  readonly projectIndex: ProjectIndex;
  readonly workingDirectory: string;
  readonly surfaceRoot: string;
  readonly fileUndoManager: import('../state/file-undo.js').FileUndoManager;
  readonly modeManager: import('../state/mode-manager.js').ModeManager;
  readonly processManager: import('../tools/shared/process-manager.js').ProcessManager;
  readonly agentMessageBus: AgentMessageBus;
  /** The agent manager the sub-agents' agent and workflow tools spawn through (registerAllTools requires it). */
  readonly agentManager: import('../tools/agent/manager.js').AgentManager;
  readonly webSearchService?: import('../web-search/index.js').WebSearchService | undefined;
  readonly channelRegistry?: import('../channels/index.js').ChannelPluginRegistry | null | undefined;
  readonly remoteRunnerRegistry?: import('../runtime/remote/index.js').RemoteRunnerRegistry | undefined;
  readonly knowledgeService?: import('../knowledge/index.js').KnowledgeService | undefined;
  readonly memoryRegistry?: import('../state/index.js').MemoryRegistry | undefined;
  /** The memory store a worker's `state mode=memory` uses (the host's memory spine); preferred over `memoryRegistry` (registerAllTools). */
  readonly memoryAccess?: import('../tools/state/memory-mirror.js').StateMemoryStore | undefined;
  /** True while memory is served by a connected host; without `memoryAccess` a worker's `state mode=memory` then fails instead of using a store the host does not serve. */
  readonly memoryRoutedOverWire?: (() => boolean) | undefined;
  /** The project work plan a worker's `work_plan` tool keeps (registerAllTools); absent, workers have no `work_plan`. */
  readonly workPlan?: import('../tools/work-plan/index.js').WorkPlanToolStore | undefined;
  /** The trigger supervisor a worker's `trigger` tool uses (registerAllTools); absent, workers have no `trigger` tool. */
  readonly triggers?: import('../triggers/manager.js').TriggerManager | import('../triggers/operations.js').TriggerOperations | undefined;
  /** The daemon's capabilities for its own turns (`capability_find`, `capability_run`; registerAllTools); absent, none. */
  readonly capabilityTools?: import('../tools/capability/daemon-tools.js').DaemonCapabilityToolHost | undefined;
  /** Supplying it registers the `profile` capture tool. See registerAllTools. */
  readonly personalCapture?: import('../personal-capture/index.js').PersonalCaptureHolder | undefined;
  readonly codeIndex?: import('./turn-knowledge-injection.js').TurnCodeIndexSource | undefined;
  readonly memoryEmbeddingRegistry?: import('../state/memory-embeddings.js').MemoryEmbeddingProviderRegistry | undefined;
  readonly isCodeInjectionSettingEnabled?: (() => boolean) | undefined;
  readonly codeIndexReindexScheduler?:
    | (Pick<import('../state/code-index-reindex.js').CodeIndexReindexScheduler, 'onToolExecuted'>
      & Partial<Pick<import('../state/code-index-reindex.js').CodeIndexReindexScheduler, 'schedule'>>)
    | undefined;
  /**
   * Additional per-tool-execution tap (e.g. CI auto-watch minting); composed with the reindex scheduler, never blocking.
   * `turn.project` is the project folder the run works in (absent for a run in the host's own folder, which is no project).
   */
  readonly toolExecutionObserver?:
    | ((toolName: string, args: Record<string, unknown>, success: boolean, turn: { readonly project?: string | undefined }) => void)
    | undefined;
  /** The contract runner's agent-loop seams (`runner.hooks()`), passed into every run context; see AgentOrchestratorRunContext.contractHooks. Absent where no contracts run. */
  readonly contractHooks?: import('../contract/agent-hooks.js').ContractAgentHooks | undefined;
  /** The owner inbox a spawned agent's `query` tool leaves questions in (registerAllTools); absent, it has no `query`. */
  readonly ownerQuestions?: import('../tools/query/index.js').QuestionInbox | (() => import('../tools/query/index.js').QuestionInbox) | undefined;
  /** The conversation each call belongs to, for a registry every web chat and run of a project shares (registerAllTools). */
  readonly turnSessionId?: (() => string | undefined) | undefined;
  /** Starts the contracts the agent and workflow tools hand work to (registerAllTools). */
  readonly contractRunner?: Pick<import('../contract/runner.js').ContractRunner, 'start' | 'list' | 'get'> | undefined;
  /** The artifact store a native request's files are read from, for the agents that do its work. */
  readonly artifacts?: Pick<import('../companion/companion-chat-attachments.js').CompanionChatArtifactStore, 'readContent'> | undefined;
  readonly sessionOrchestration: import('../sessions/orchestration/index.js').CrossSessionTaskRegistry;
  readonly archetypeLoader?: import('./archetypes.js').ArchetypeLoader | undefined;
  readonly configManager?: ConfigManager | undefined;
  readonly providerRegistry?: ProviderRegistry | undefined;
  readonly providerOptimizer?: import('../providers/optimizer.js').ProviderOptimizer | undefined;
  readonly toolLLM?: ToolLLM | undefined;
  readonly serviceRegistry?: import('../config/service-registry.js').ServiceRegistry | undefined;
  readonly secretsManager?:
    | Pick<import('../config/secrets.js').SecretsManager, 'get' | 'set' | 'getGlobalHome'>
    | null
    | undefined;
  /** The daemon's own auth token reader; a worker's goodvibes_context Cloudflare status counts it as the Worker-to-daemon operator token, as the daemon's routes do. */
  readonly cloudflareAuthToken?: (() => string | null) | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  readonly overflowHandler?: import('../tools/shared/overflow.js').OverflowHandler | undefined;
  readonly sandboxSessionRegistry: import('../runtime/sandbox/session-registry.js').SandboxSessionRegistry;
  readonly workflowServices: ReturnType<typeof import('../tools/workflow/index.js').createWorkflowServices>;
  /**
   * Permission gate applied to this orchestrator's background/subagent tool
   * calls (see AgentOrchestratorRunContext.permissionManager). Optional, when
   * omitted, background runs are ungated exactly as before background
   * permission enforcement existed.
   */
  /**
   * Fires the tool hooks for background and contract-unit calls, as for the main session.
   * Kept apart from `hookDispatcher` so the workers' tools do not gain hook management.
   */
  readonly toolCallHooks?: { fire(event: import('../hooks/types.js').HookEvent): Promise<import('../hooks/types.js').HookResult> } | null | undefined;
  /**
   * What a run in another project folder than `workingDirectory` uses in place of the host's own: that project's
   * hooks (its hooks file, fired for the runs there) and where its long tool output is kept. The host builds each
   * project's once, on first use, and hands the same back after; absent, such a run fires no hooks of the host's folder.
   */
  readonly projectFacilities?: ((workingDirectory: string) => AgentProjectFacilities) | undefined;
  /**
   * No registry of this folder is kept any more (its last idle one let go, IDLE_REGISTRIES_KEPT): the host may let the
   * folder's project facilities go too (its tool servers stopped, its checkpoint store closed); they are built again on
   * the next run there.
   */
  readonly releaseProjectFacilities?: ((workingDirectory: string) => void) | undefined;
  /**
   * The host's own folder is a project (a project's Work graph, rooted in that project): its turns and runs there take
   * that project's facilities as any other project's do, instead of the host's own. Absent: the host's folder is its own.
   */
  readonly ownFolderIsProject?: boolean | undefined;
  /**
   * Where the host keeps the run records (agent journals, run state) of a run working in `workingDirectory`, when not in
   * its own folder: the daemon keeps them under its records root, one folder per project, so a daemon run never writes
   * them in the daemon's own folder. Absent: the host's own folder (a terminal program's is its project).
   */
  readonly runRecordsRootOf?: ((workingDirectory: string) => string) | undefined;
  /** The host has no terminal screen (the daemon): every run is told so in one line. */
  readonly screenless?: boolean | undefined;
  readonly permissionManager?:
    | Pick<
        import('../permissions/manager.js').PermissionManager,
        'checkDetailed' | 'check' | 'readAccess' | 'passesBoundary'
      > & Partial<Pick<import('../permissions/manager.js').PermissionManager, 'prepareAutonomousOwner' | 'admitAutonomous' | 'autonomousPreparation'>>
    | undefined;
  /**
   * Settable holder for the context_accounting tool's session source. Threaded
   * through so the tool is registered on the shared roster; the interactive
   * session binds its Orchestrator-backed source after construction.
   */
  readonly contextAccountingHolder?: import('../tools/context-accounting/index.js').ContextAccountingHolder | undefined;
  /**
   * Broker a per-command exec-sandbox host-access escalation through the
   * approval broker before the command runs. Threaded to registerAllTools so
   * the exec tool's sandbox raises named escalation asks. Omitted → escalations
   * are not asked (today's behavior).
   */
  readonly sandboxEscalationHandler?: import('../runtime/permissions/sandbox-escalation-wiring.js').ExecSandboxEscalationHandler | undefined;
  /**
   * Broker the one-tap "allow localhost fetches for this project" ask through
   * the approval broker. Threaded to registerAllTools so the fetch tool can
   * ask once and persist the per-project approval. Omitted → unapproved
   * localhost fetches are refused with an honest reason.
   */
  readonly localhostFetchApproval?: LocalhostFetchApproval | undefined;
  /** Reports each contained (sandboxed) command run for the announce-once containment receipt. */
  readonly onSandboxedRun?: (() => void) | undefined;
  /**
   * Whether a worker's exec REQUIRES the boundary. Reaches every worker
   * registry through registerAllTools; omitted → the host fallback, as a
   * terminal composes it. A daemon-hosted composition states it so a worker
   * spawned by a hosted turn is held to the same posture as the turn.
   */
  readonly execContainment?: import('../tools/exec/containment.js').ExecContainmentRequirement | undefined;
  /**
   * Where daemon-owned settings are read and written. Without it a worker's
   * settings tool writes such a key into the local file, reports success and
   * configures nothing. See registerAllTools.
   */
  readonly configRouting?: import('../tools/goodvibes-runtime/config-routing.js').ConfigRoutingOptions | undefined;
  /**
   * Lets a product install its own wrappers on each worker registry once its
   * tools are registered, so the restrictions it puts on its main conversation
   * are not bypassed by delegating. The wrappers must not need the owner's
   * last message: a worker has none. A throw fails the registry build.
   */
  readonly decorateRegistry?: ((registry: ToolRegistry) => void) | undefined;
  /**
   * The admission policies the main registry's read and settings tools are
   * built with. A product whose decorateRegistry installs the admitted-read or
   * admitted-settings wrapper must pass the same policy here: the wrapper
   * refuses every call that has no input projector, and only the matching
   * policy registers one.
   */
  readonly readAdmissionPolicy?: 'agent-main-conversation' | undefined;
  readonly settingsAdmissionPolicy?: 'agent-main-conversation' | undefined;
  /**
   * The surface the agent being started was spawned for, when it is not this
   * host's own: asked once per run, inside the spawning turn's execution
   * context (the agent manager runs every agent, a woken one included, under
   * the mode owner of the turn that spawned it). Undefined for a run, or
   * absent: the host's own worker registry, as before.
   */
  readonly workerSurface?: (() => AgentWorkerSurface | undefined) | undefined;
  /**
   * Broker an exec PTY terminal-prompt answer through the approval broker
   * while the command keeps running. Threaded to registerAllTools so the exec
   * tool can answer prompts (host-key confirmations, credential asks) instead
   * of hanging to timeout. Omitted → the PTY path is not engaged.
   */
  readonly execPromptAnswerHandler?:
    | ((
        ask: import('../tools/exec/interactive.js').ExecPromptAsk,
      ) => Promise<import('../tools/exec/interactive.js').ExecPromptAnswer>)
    | undefined;
};

/**
 * How a worker is built for a session of another product than the host's
 * (a session the daemon hosts for the GoodVibes Agent): the registry options
 * and decoration that product's own process builds its workers with, so a
 * worker such a session spawns is held to the same policy, tool set and
 * admission as one that product spawns itself. Each field applies on top of
 * the host's worker options; an absent field leaves the host's.
 */
export interface AgentWorkerSurface {
  /** Names the surface. Worker registries are kept per working directory and surface. */
  readonly id: string;
  /** The surface's own state root (`.goodvibes/<surface>/`) for the worker's tools. */
  readonly surfaceRoot?: string | undefined;
  /** Where the worker's settings tools read and write (a client-owned key goes to the surface's own file). */
  readonly configRouting?: import('../tools/goodvibes-runtime/config-routing.js').ConfigRoutingOptions | undefined;
  /** The admission the surface builds its workers' `read` and `goodvibes_settings` with. */
  readonly readAdmissionPolicy?: 'agent-main-conversation' | undefined;
  readonly settingsAdmissionPolicy?: 'agent-main-conversation' | undefined;
  /** The surface's own worker decoration, installed after the host's `decorateRegistry`. A throw fails the registry build. */
  readonly decorateRegistry?: ((registry: ToolRegistry) => void) | undefined;
}

/** The cache key of a worker registry shared by runs: the working directory, and the surface when one applies. */
function sharedRegistryKey(workingDirectory: string, surface: AgentWorkerSurface | undefined): string {
  // A path holds no NUL, so the two parts cannot run together.
  return surface ? `${workingDirectory}\u0000${surface.id}` : workingDirectory;
}

/**
 * AgentOrchestrator, runs AgentRecord tasks in-process.
 *
 * Each agent gets its own scoped ToolRegistry containing only the tools
 * listed in record.tools. The execution loop itself now lives in
 * `orchestrator-runner.ts`; this class owns shared registry/state wiring.
 */
export class AgentOrchestrator {
  /**
   * Keyed by working directory. A ToolRegistry is permanently bound to one
   * cwd at construction (every tool factory closes over it, see
   * tools/index.ts registerAllTools), so a distinct cwd genuinely needs its
   * own registry, not a mutable field. The default cwd
   * (`this.toolDeps.workingDirectory`) is cached under its own key exactly
   * like the single `fullRegistry` field this replaces, same lazy-build,
   * same channel-version invalidation, same object identity once built.
   */
  private fullRegistries = new Map<string, ToolRegistry>();
  /**
   * The ProjectIndex instances this orchestrator OWNS, keyed by the same cwd.
   *
   * A non-default cwd is given no index to share, so `registerAllTools` builds
   * one for it. Every reference to that index then lives inside the tool
   * closures of a registry we are about to drop, and it holds a debounced flush
   * timer, so nothing could flush or release it and it went out with the
   * garbage collector at best. The shared index for the DEFAULT cwd is never
   * in here: that one belongs to the composition root, and disposing a
   * borrowed object is how a live session loses its index.
   */
  private ownedProjectIndexes = new Map<string, ProjectIndex>();
  /**
   * Flushes and unregisters the session key-value store each registry owns,
   * keyed like `fullRegistries`. The store holds a debounced write and sits in a
   * process-wide set until disposed, so a registry that is dropped without it
   * leaks one store per registry for the process lifetime.
   */
  private registryDisposers = new Map<string, () => Promise<void>>();
  /**
   * The disposers of default-directory registries dropped for a rebuild. The host may still hold the
   * dropped registry, so its state stays open until the orchestrator is disposed or given new dependencies.
   */
  private retiredRegistryDisposers: Array<() => Promise<void>> = [];
  /** Registries built for one captured run; the run deletes its own, a channel change must not. */
  private runKeyedRegistries = new Set<string>();
  /** The tool servers a captured step's registry started in its copy, stopped when that registry is let go. */
  private readonly capturedStepServers = new Map<string, () => Promise<void>>();
  /**
   * Runs currently using a shared registry other than the default one (a
   * non-default working directory's, or one built for a surface), by registry
   * key; a channel change leaves a counted registry alone, and the last run
   * out of a non-default working directory releases its registry.
   */
  private cwdRunCounts = new Map<string, number>();
  /**
   * Registries of other folders no run uses now, most recently used last: the next run in the same project reuses
   * its registry (its tools, index and code intelligence) instead of building it again. The oldest beyond
   * IDLE_REGISTRIES_KEPT are released.
   */
  private idleRegistries: string[] = [];
  /** Tool sets cut from a full registry, by the names they keep (buildScopedRegistry); dropped with the registry. */
  private scopedRegistries = new WeakMap<ToolRegistry, Map<string, ToolRegistry>>();

  private async keepIdleRegistry(key: string): Promise<void> {
    this.idleRegistries = [...this.idleRegistries.filter((idle) => idle !== key), key];
    while (this.idleRegistries.length > IDLE_REGISTRIES_KEPT) {
      const oldest = this.idleRegistries.shift()!;
      if ((this.cwdRunCounts.get(oldest) ?? 0) === 0) await this.releaseRegistry(oldest);
    }
  }
  /** Runs working in each non-default directory; at none, its project-framework reading is forgotten. */
  private readonly frameworkDirectoryRuns = new Map<string, number>();
  private fullRegistryChannelVersion = -2;
  private toolDeps: AgentOrchestratorToolDeps | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private conversationSink: AgentConversationSink | null = null;
  private cancellationSource: AgentCancellationSource | null = null;
  private readonly channelRegistry: ChannelPluginRegistry | null;
  private readonly messageBus: import('./message-bus.js').AgentMessageBus;
  private readonly capturedBunRuntimeExecutable: string | undefined;

  constructor(
    config: {
      channelRegistry?: ChannelPluginRegistry | null | undefined;
      messageBus: import('./message-bus.js').AgentMessageBus;
      /** Absolute ordinary-Bun declaration from the host composition. */
      capturedBunRuntimeExecutable?: string | undefined;
    } = {
      messageBus: new AgentMessageBus(),
    },
  ) {
    this.capturedBunRuntimeExecutable = config.capturedBunRuntimeExecutable;
    this.channelRegistry = config.channelRegistry ?? null;
    this.messageBus = config.messageBus;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  /** Set the FeatureFlagManager for context-window awareness gating. */
  setFeatureFlagManager(manager: FeatureFlagManager): void {
    this.featureFlagManager = manager;
  }

  /**
   * Wire the conversation-snapshot bridge through AgentConversationSink. Pass null to detach, createRunContext() then
   * omits the register/release callbacks entirely and orchestrator-runner's
   * `?.()` calls become no-ops.
   */
  setConversationSink(sink: AgentConversationSink | null): void {
    this.conversationSink = sink;
  }

  /**
   * Wire the cancellation bridge (see AgentCancellationSource). Pass
   * null to detach, createRunContext() then omits getCancellationSignal
   * entirely and orchestrator-runner's `?.()` call becomes a no-op, so every
   * tool call runs with `opts` undefined exactly as before this change.
   */
  setCancellationSource(source: AgentCancellationSource | null): void {
    this.cancellationSource = source;
  }

  private emitterContext(agentId: string): import('../runtime/emitters/index.js').EmitterContext {
    return {
      sessionId: 'agent-orchestrator',
      traceId: `agent-orchestrator:${agentId}`,
      source: 'agent-orchestrator',
    };
  }

  /**
   * `audience` is required rather than defaulted so a new caller has to answer
   * "who is this for" at the call site. See agents/progress-audience.ts: an
   * unanswered one used to mean "everyone", and the tool trace ended up on the
   * owner's phone.
   */
  private emitAgentProgress(recordId: string, progress: string, audience: ProgressAudience): void {
    if (!this.runtimeBus) return;
    emitAgentProgress(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      progress,
      audience,
    });
  }

  private emitAgentStarted(recordId: string): void {
    if (!this.runtimeBus) return;
    emitAgentRunning(this.runtimeBus, this.emitterContext(recordId), { agentId: recordId });
  }

  private emitAgentCancelledEvent(recordId: string, reason: string): void {
    if (!this.runtimeBus) return;
    emitAgentCancelled(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      reason,
    });
  }

  private emitAgentFailedEvent(recordId: string, error: string, durationMs: number): void {
    if (!this.runtimeBus) return;
    emitAgentFailed(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      error,
      durationMs,
    });
  }

  private emitAgentCompletedEvent(
    recordId: string,
    durationMs: number,
    output: string,
    toolCallsMade: number,
    usage: AgentRecord['usage'] | undefined,
  ): void {
    if (!this.runtimeBus) return;
    emitAgentCompleted(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      durationMs,
      output,
      toolCallsMade,
      usage,
    });
  }

  /**
   * Inject shared file-cache and project-index so agent tools share state with main session.
   * Call once during application startup, before any agents are spawned.
   */
  setDependencies(toolDeps: AgentOrchestratorToolDeps): void {
    this.toolDeps = toolDeps;
    this.releaseOwnedProjectIndexes();
    this.fullRegistries = new Map();
    this.runKeyedRegistries.clear();
    this.fullRegistryChannelVersion = -2;
  }

  /**
   * Release everything this orchestrator started that outlives a turn: today
   * that is the ProjectIndex it builds for each non-default working directory,
   * each holding a debounced 5s flush timer. Called by the runtime graph's
   * disposal scope. Idempotent.
   */
  dispose(): void {
    this.releaseOwnedProjectIndexes();
    this.fullRegistries.clear();
    this.runKeyedRegistries.clear();
  }

  /**
   * Cancel each owned index's pending flush and write out what it holds.
   *
   * Fire-and-forget on purpose: the disposal scope is synchronous, and one
   * index whose final write fails must not strand the owners queued behind it.
   * The timer, the part that leaks, is cancelled synchronously inside
   * `ProjectIndex.dispose()` before the flush it awaits, so the leak is closed
   * whether or not the write lands.
   */
  private releaseOwnedProjectIndexes(): void {
    for (const key of new Set([...this.ownedProjectIndexes.keys(), ...this.registryDisposers.keys()])) {
      void this.releaseRegistry(key);
    }
    for (const dispose of this.retiredRegistryDisposers.splice(0)) {
      dispose().catch((error: unknown) => {
        logger.warn('AgentOrchestrator: session state teardown failed', { error: summarizeError(error) });
      });
    }
  }

  /** Drop one cached registry and release the index and key-value store built for it. */
  private async releaseRegistry(key: string): Promise<void> {
    const runKeyed = this.runKeyedRegistries.has(key);
    this.fullRegistries.delete(key);
    this.runKeyedRegistries.delete(key);
    // The folder's project facilities go with its last registry, kept or counted (a surface's registry of the same
    // folder keeps them); a run's own registry is not a folder's.
    if (!runKeyed) {
      const folder = key.split('\u0000')[0]!;
      const held = [...this.fullRegistries.keys(), ...this.cwdRunCounts.keys()].some((other) => other.split('\u0000')[0] === folder);
      if (!held) this.toolDeps?.releaseProjectFacilities?.(folder);
    }
    const index = this.ownedProjectIndexes.get(key);
    const disposeState = this.registryDisposers.get(key);
    const stopServers = this.capturedStepServers.get(key);
    this.ownedProjectIndexes.delete(key);
    this.registryDisposers.delete(key);
    this.capturedStepServers.delete(key);
    const failed = (what: string) => (error: unknown): void => {
      logger.warn(`AgentOrchestrator: ${what} teardown failed`, { workingDirectory: key, error: summarizeError(error) });
    };
    await Promise.all([
      index?.dispose().catch(failed('project index')),
      disposeState?.().catch(failed('session state')),
      stopServers?.().catch(failed('captured tool servers')),
    ]);
  }

  /**
   * Returns the fully-populated ToolRegistry for this orchestrator's DEFAULT
   * working directory. Used by companion chat to execute tool calls emitted
   * by the LLM, companion chat has no per-call cwd override, so this always
   * resolves to `this.toolDeps.workingDirectory`. Delegates to the
   * lazy-initialized internal registry cache.
   */
  getToolRegistry(): ToolRegistry {
    return this.getFullRegistry();
  }

  /**
   * The ONE way a turn this host runs gets its environment in a project (a web chat's turn, a hosted or handed-off
   * turn; a run of this orchestrator's own agents is built the same way in runAgent): the registry rooted in that
   * folder with the project's tool servers, checklist, changed-files record and long-output folder, the project's
   * hooks for its tool calls, and the step after the turn (a checkpoint of the project when its files changed).
   * Made once per project and reused by every later turn there; the turn releases it when it ends. No folder (or the
   * host's own): the host's own registry and hooks, as before.
   */
  acquireTurnEnvironment(workingDirectory?: string): AgentTurnEnvironment {
    const defaultCwd = this.toolDeps?.workingDirectory ?? '';
    const cwd = workingDirectory ?? defaultCwd;
    if (cwd === defaultCwd && this.toolDeps?.ownFolderIsProject !== true) {
      const hooks = this.toolDeps?.toolCallHooks ?? undefined;
      return { workingDirectory: cwd, registry: this.getFullRegistry(), ...(hooks ? { toolCallHooks: hooks } : {}), ready: () => Promise.resolve(),
        knowledge: (input) => this.turnKnowledge(cwd, undefined, input), afterTurn: () => {}, release: async () => {} };
    }
    // The host's own folder when it is a project (a project's Work graph): its registry is the host's shared one, kept.
    const own = cwd === defaultCwd;
    const key = sharedRegistryKey(cwd, undefined);
    if (!own) this.cwdRunCounts.set(key, (this.cwdRunCounts.get(key) ?? 0) + 1);
    let registry: ToolRegistry;
    let project: AgentProjectFacilities | undefined;
    try {
      registry = own ? this.getFullRegistry() : this.getFullRegistry(cwd);
      project = this.toolDeps?.projectFacilities?.(cwd);
    } catch (error) {
      if (!own) {
        const left = (this.cwdRunCounts.get(key) ?? 1) - 1;
        if (left > 0) this.cwdRunCounts.set(key, left); else this.cwdRunCounts.delete(key);
      }
      throw error;
    }
    let released = own;
    return {
      workingDirectory: cwd,
      registry,
      ...(project?.toolCallHooks ? { toolCallHooks: project.toolCallHooks } : {}),
      ...(project?.hookDispatcher ? { hookDispatcher: project.hookDispatcher } : {}),
      ...(project?.configManager ? { configManager: project.configManager } : {}),
      ...(project ? { project } : {}),
      ready: () => project?.ready?.() ?? Promise.resolve(),
      knowledge: (input) => this.turnKnowledge(cwd, project, input),
      afterTurn: (turn) => {
        try { project?.afterTurn?.(turn); }
        catch (error) { logger.warn('AgentOrchestrator: the project\'s after-turn step failed', { workingDirectory: cwd, error: summarizeError(error) }); }
      },
      release: async () => {
        if (released) return;
        released = true;
        const remaining = (this.cwdRunCounts.get(key) ?? 1) - 1;
        if (remaining > 0) { this.cwdRunCounts.set(key, remaining); return; }
        this.cwdRunCounts.delete(key);
        await this.keepIdleRegistry(key);
      },
    };
  }

  /**
   * The tools of the person's own things this host gives every turn it runs (remote runners, the owner profile, and its
   * own registry decoration: mail and calendar, the paired phone), for a turn whose registry is composed elsewhere in
   * this host (a hosted session's), so every door's turn has the same.
   */
  hostTurnTools(): {
    readonly remoteRunnerRegistry?: import('../runtime/remote/index.js').RemoteRunnerRegistry | undefined;
    readonly personalCapture?: import('../personal-capture/index.js').PersonalCaptureHolder | undefined;
    readonly decorateRegistry?: ((registry: ToolRegistry) => void) | undefined;
    readonly memoryRegistry?: import('../state/index.js').MemoryRegistry | undefined;
  } {
    const deps = this.toolDeps;
    return {
      ...(deps?.memoryRegistry ? { memoryRegistry: deps.memoryRegistry } : {}),
      ...(deps?.remoteRunnerRegistry ? { remoteRunnerRegistry: deps.remoteRunnerRegistry } : {}),
      ...(deps?.personalCapture ? { personalCapture: deps.personalCapture } : {}),
      ...(deps?.decorateRegistry ? { decorateRegistry: (registry: ToolRegistry) => this.toolDeps?.decorateRegistry?.(registry) } : {}),
    };
  }

  /**
   * One turn's knowledge in `cwd`, the same selection a terminal conversation's turn makes (core/orchestrator-turn-loop.ts):
   * the owner's memory for that project and his own, ranked against the turn's message and the conversation, within
   * the passive-injection budget and relevance floor; the project's code context when the code index and its flag are
   * on. Null when passive knowledge is off, there is no memory, or nothing cleared the floor.
   */
  private async turnKnowledge(cwd: string, project: AgentProjectFacilities | undefined, input: AgentTurnKnowledgeInput): Promise<AgentTurnKnowledge | null> {
    const memoryRegistry = this.toolDeps?.memoryRegistry;
    const config = this.toolDeps?.configManager;
    if (!memoryRegistry || !config) return null;
    const permissionManager = this.toolDeps?.permissionManager;
    // A project's turn reads its project's gates (a gate whose state is a setting follows the project's one settings
    // file), and its code index is the project's own, there only while that index is kept.
    const code = project?.codeIndex?.();
    const flags = project
      ? turnFlagSources(project.featureFlags ?? this.featureFlagManager, { isCodeInjectionSettingEnabled: () => code !== undefined })
      : turnFlagSources(this.featureFlagManager, { isCodeInjectionSettingEnabled: this.toolDeps?.isCodeInjectionSettingEnabled });
    if (!isPassiveKnowledgeInjectionEnabled(flags)) return null;
    try {
      const injection = await buildPerTurnKnowledgeInjection({
        memoryRegistry,
        project: memoryProjectOf(cwd),
        task: input.task,
        conversationTail: input.conversationTail,
        budgetTokens: defaultTurnKnowledgeBudgetTokens(input.contextWindow, config.get('agents.passiveInjection.budgetTokens')),
        relevanceFloor: config.get('agents.passiveInjection.relevanceFloor') ?? DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
        alreadyInjectedIds: input.alreadyInjectedIds,
        turn: input.turn,
        ...(code ? { codeIndex: code.source, codeInjectionEnabled: isPassiveCodeInjectionEnabled(flags), codeLimit: config.get('agents.passiveInjection.codeLimit') } : {}),
        // A code chunk is read back from its file under the owner's read decision for this project, as the read tool would.
        ...(code && permissionManager ? { codeAuthority: { readAccessFilter: async (path: string) =>
          (await decideInProject(cwd, () => permissionManager.readAccess(path))) === 'allow' } } : {}),
      });
      if (!injection.block) return null;
      // The code chunks are checked once more as they are handed to the turn: a file changed since it was read is not
      // sent, and the memory records go alone.
      if (injection.assertCodeCurrent) {
        try { await injection.assertCodeCurrent(); }
        catch { return injection.memoryBlock ? { block: injection.memoryBlock, injectedIds: injection.record.injectedIds.filter((_, index) => injection.record.injectedSources[index] === 'memory') } : null; }
      }
      return { block: injection.block, injectedIds: injection.record.injectedIds };
    } catch (error) {
      // Optional context: its failure never stops the turn.
      logger.warn('AgentOrchestrator: a turn\'s knowledge was not read; it goes on without it', { workingDirectory: cwd, error: summarizeError(error) });
      return null;
    }
  }

  /**
   * Lazily build and cache the full ToolRegistry for `workingDirectory`
   * (default: `this.toolDeps.workingDirectory`, unchanged from before this
   * cache became keyed). A non-default cwd, a spawned agent's dedicated
   * worktree (AgentRecord.workingDirectory, see AgentInput.workingDirectory)
   *, gets its OWN fresh fileCache/projectIndex rather than reusing the
   * shared session's: those are scoped to the default cwd and would
   * otherwise silently index/search the wrong directory.
   */
  private getFullRegistry(
    workingDirectory?: string,
    authority?: ContractInputAuthority,
    signal?: AbortSignal,
    runKey?: string,
    delivered = new Set<string>(),
    capturedOwnerRead?: import('../tools/shared/read-access.js').ReadAccessFilter,
    dependencyInputs: readonly CapturedExecDependencyInput[] = [],
    capturedRegistry?: CapturedRegistryContext,
    capturedProcessManager?: import('../tools/shared/process-manager.js').ProcessManager,
    nodeRuntimeAdmission?: import('../tools/exec/captured-exec.js').CapturedExecAuthority['nodeRuntimeAdmission'],
    bunRuntimeAdmission?: import('../tools/exec/captured-exec.js').CapturedExecAuthority['bunRuntimeAdmission'],
    capturedReplHistory?: CapturedReplHistory,
    surface?: AgentWorkerSurface,
    projectToolsInCopy = false,
  ): ToolRegistry {
    const channelVersion = this.channelRegistry?.getVersion() ?? -1;
    if (this.fullRegistryChannelVersion !== channelVersion) {
      // Dropping the registries drops the only references to the indexes built
      // for them, so release those first, a channel plugin being installed or
      // removed must not be a way to accumulate orphaned flush timers. A registry a
      // run is still using stays (its tools already hold its index) and is released
      // when that run ends. The default directory's registry may be held by the host's
      // own callers, so it is dropped for a rebuild without closing what it holds.
      const defaultKey = this.toolDeps?.workingDirectory ?? '';
      for (const key of [...this.fullRegistries.keys()]) {
        if (this.runKeyedRegistries.has(key) || (this.cwdRunCounts.get(key) ?? 0) > 0) continue;
        if (key === defaultKey) {
          const retired = this.registryDisposers.get(key);
          if (retired) this.retiredRegistryDisposers.push(retired);
          this.fullRegistries.delete(key);
          this.registryDisposers.delete(key);
          continue;
        }
        void this.releaseRegistry(key);
      }
      this.fullRegistryChannelVersion = channelVersion;
    }
    const defaultCwd = this.toolDeps?.workingDirectory ?? '';
    const cwd = workingDirectory ?? defaultCwd;
    if (!authority && isCapturedInputPath(cwd))
      throw new Error('captured view has no construction-owned input authority');
    const key = runKey ?? sharedRegistryKey(cwd, surface);
    let registry = this.fullRegistries.get(key);
    if (!registry) {
      if (!this.toolDeps?.configManager || !this.toolDeps?.providerRegistry || !this.toolDeps?.toolLLM) {
        throw new Error(
          'AgentOrchestrator requires configManager, providerRegistry, and toolLLM dependencies before tool registration',
        );
      }
      registry = new ToolRegistry();
      const isDefaultCwd = cwd === defaultCwd;
      // Read-side deny enforcement for search/list/map tools: give them the same
      // per-file read decision the read tool gets, so a file the read tool would
      // hold behind an ask (a read Jev reads as touching secrets) never leaks its content
      // through grep/glob/repo_map. Reads live config each call, so mode changes
      // apply immediately. Absent a permission manager, tools default to allow-all.
      const permissionManager = this.toolDeps.permissionManager;
      const ownerReadAccess = authority
        ? capturedOwnerRead
        : permissionManager
          ? async (absolutePath: string): Promise<boolean> =>
              (await permissionManager.readAccess(absolutePath)) === 'allow'
          : undefined;
      const readAccessFilter = authority
        ? capturedInputReadFilter(authority, cwd, ownerReadAccess, signal, delivered)
        : ownerReadAccess;
      // A run in another project (or this host's own folder when it is a project's Work graph) works for that project:
      // its environment comes from the project (agents/turn-composition.ts, the one composition every turn has).
      const projectHere = !((isDefaultCwd && this.toolDeps.ownFolderIsProject !== true) || authority);
      // A step of planned work runs in a captured copy of its project: it is given the project's checklist and the
      // project's tool servers started inside that copy (agents/orchestrator.ts AgentProjectFacilities.capturedToolServers),
      // nothing else of the project's (its hooks, long output and settings stay the host's, as for every captured step).
      const capturedProject = authority && runKey && projectToolsInCopy ? this.capturedStepProject(contractInputAuthoritySourceRoot(authority), cwd, runKey) : undefined;
      const project = projectHere ? this.toolDeps.projectFacilities?.(cwd) : capturedProject;
      const registered = composeTurnTools(registry, { program: {
        // A worker spawned for another surface gets that surface's state root, settings routing and admission.
        surfaceRoot: surface?.surfaceRoot ?? this.toolDeps.surfaceRoot,
        ...(surface?.configRouting !== undefined ? { configRouting: surface.configRouting } : {}),
        ...(surface?.readAdmissionPolicy !== undefined ? { readAdmissionPolicy: surface.readAdmissionPolicy } : {}),
        ...(surface?.settingsAdmissionPolicy !== undefined ? { settingsAdmissionPolicy: surface.settingsAdmissionPolicy } : {}),
      }, ...(project ? { project } : {}), host: {
        ...this.toolDeps,
        ...(authority && capturedProcessManager ? { processManager: capturedProcessManager } : {}),
        contractRunner: this.toolDeps.contractRunner,
        // A run in another project works for that project, never the host's folder: its agent and workflow
        // tools start contracts there, its capability calls name it, and the host's own work plan and the host's
        // long-output folder are not its own (those are the project's, above).
        projectRoot: isDefaultCwd || authority ? defaultCwd : cwd,
        // The agent tool reads a finished agent's journal where this folder's runs keep it (runRecordsRootOf).
        ...(!authority && this.toolDeps.runRecordsRootOf ? { agentJournalRoot: this.toolDeps.runRecordsRootOf(cwd) } : {}),
        ...(projectHere && this.toolDeps.capabilityTools ? { capabilityTools: { ...this.toolDeps.capabilityTools, workingDirectory: () => cwd } } : {}),
        workingDirectory: cwd,
        ...(this.runtimeBus ? { runtimeBus: this.runtimeBus } : {}),
        fileCache: isDefaultCwd && !authority ? this.toolDeps.fileCache : undefined,
        projectIndex: isDefaultCwd && !authority ? this.toolDeps.projectIndex : undefined,
        readAccessFilter,
        ...(authority
          ? {
              capturedReadAccess: readAccessFilter,
              capturedExec: {
                authority,
                root: cwd,
                readAccessFilter: ownerReadAccess,
                signal,
                dependencyInputs,
                nodeRuntimeAdmission,
                bunRuntimeAdmission,
              },
              capturedRegistry,
              capturedReplHistory,
              diagnosticsProvider: null,
            }
          : {}),
      } });
      // Keep the index registerAllTools built for us. Only for a non-default
      // cwd: for the default one it hands back the very object the composition
      // root passed in, which this class borrows and must not dispose.
      if (!isDefaultCwd || authority) this.ownedProjectIndexes.set(key, registered.projectIndex);
      this.registryDisposers.set(key, registered.dispose);
      if (runKey) this.runKeyedRegistries.add(key);
      registerChannelAgentTools(registry, this.toolDeps?.channelRegistry ?? this.channelRegistry);
      this.toolDeps.decorateRegistry?.(registry);
      surface?.decorateRegistry?.(registry);
      if (authority) {
        const guarded = new ToolRegistry();
        for (const tool of registry.list())
          guarded.register(
            capturedInputTool(tool, authority, cwd, ownerReadAccess, signal),
            registry.registrationOptionsFor(tool.definition.name),
          );
        registry = guarded;
      }
      this.fullRegistries.set(key, registry);
    }
    return registry;
  }

  /**
   * What a step of planned work in a captured copy (`copyRoot`) of `projectRoot` has of its project: the project's
   * checklist and its tool servers started inside the copy, kept until the step's own registry (`runKey`) is let go.
   * The host's long-output folder stays the step's, as before. Undefined when the host builds no project facilities.
   */
  private capturedStepProject(projectRoot: string, copyRoot: string, runKey: string): AgentProjectFacilities | undefined {
    let project: AgentProjectFacilities | undefined;
    try { project = this.toolDeps?.projectFacilities?.(projectRoot); }
    catch (error) {
      logger.warn('AgentOrchestrator: a step\'s project facilities were not built; it runs without its tool servers and checklist', { projectRoot, error: summarizeError(error) });
      return undefined;
    }
    if (!project) return undefined;
    let servers: ReturnType<NonNullable<AgentProjectFacilities['capturedToolServers']>> | undefined;
    try { servers = project.capturedToolServers?.(copyRoot); }
    catch (error) { logger.warn('AgentOrchestrator: a step\'s tool servers were not started in its copy', { copyRoot, error: summarizeError(error) }); }
    if (servers) this.capturedStepServers.set(runKey, servers.release);
    return {
      ...(this.toolDeps?.overflowHandler ? { overflowHandler: this.toolDeps.overflowHandler } : {}),
      ...(project.workPlan ? { workPlan: project.workPlan } : {}),
      // Started on the step's first `mcp` call, not when the step starts: a step that uses no tool server starts none.
      ...(servers ? { mcpRegistry: servers.mcpRegistry, mcpConnect: servers.connect } : {}),
    };
  }

  /**
   * Build a ToolRegistry containing only the tools whose names appear in
   * the allowedNames list. Filters the provided full registry into a fresh
   * scoped registry.
   */
  private buildScopedRegistry(
    allowedNames: string[],
    fullRegistry: ToolRegistry,
    captureAuthority?: import('../personal-capture/index.js').CaptureAuthorityDecision | undefined,
  ): ToolRegistry {
    // `agent` stays when the run's list names it (a schedule's or trigger's run is offered a conversation's tools, agent
    // included): what it starts is held to the fleet's ceiling and depth at the spawn (AgentManager admission).
    const allowed = new Set(allowedNames);
    // The same tool set over the same registry is built once and reused by every later run that asks for it (a
    // schedule's or trigger's run is offered a conversation's tools each time): registering every tool again screens
    // every definition again on each run. Not when this run's authority is bound onto a tool: that instance is its own.
    const cacheKey = captureAuthority ? undefined : [...allowed].sort().join('\u0000');
    const cached = cacheKey === undefined ? undefined : this.scopedRegistries.get(fullRegistry)?.get(cacheKey);
    if (cached) return cached;

    const scopedRegistry = new ToolRegistry();
    for (const tool of fullRegistry.list()) {
      if (!allowed.has(tool.definition.name)) continue;
      // The profile tool writes under an authority the MODEL must not be able to
      // assert, a sentence inside a forwarded email claiming to be the owner
      // would otherwise walk straight through the write gate. So the authority
      // the composition root resolved for this turn is bound onto the instance
      // this run sees, and never appears in the tool's arguments.
      if (captureAuthority && isCaptureBindableTool(tool)) {
        scopedRegistry.register(tool.bindCapture(captureAuthority), fullRegistry.registrationOptionsFor(tool.definition.name));
        continue;
      }
      scopedRegistry.register(tool, fullRegistry.registrationOptionsFor(tool.definition.name));
    }

    if (cacheKey !== undefined) {
      const byNames = this.scopedRegistries.get(fullRegistry) ?? new Map<string, ToolRegistry>();
      // A few tool sets per registry at most (a job's own list, a conversation's); the oldest goes past eight.
      if (byNames.size >= 8) byNames.delete(byNames.keys().next().value!);
      byNames.set(cacheKey, scopedRegistry);
      this.scopedRegistries.set(fullRegistry, byNames);
    }
    return scopedRegistry;
  }

  private resolveProviderForRecord(
    providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels'>,
    record: AgentRecord,
    currentModel: ActiveModelRef,
  ): { provider: LLMProvider; modelId: string; requestedModelId: string } {
    const optimizedRoute = this.resolveOptimizedProviderRoute(providerRegistry, record);
    if (optimizedRoute) return optimizedRoute;

    const routing = this.resolveProviderRouting(record, currentModel, providerRegistry.listModels());
    const scopedModelId = this.normalizeRequestedModelId(routing.requestedModelId);

    try {
      return {
        provider: providerRegistry.getForModel(scopedModelId, routing.providerOverride),
        modelId: this.resolveChatModelId(providerRegistry, scopedModelId, routing.providerOverride),
        requestedModelId: scopedModelId,
      };
    } catch (err) {
      throw new Error(`Cannot resolve provider for model '${scopedModelId}': ${summarizeError(err)}`);
    }
  }

  private resolveOptimizedProviderRoute(
    providerRegistry: Pick<ProviderRegistry, 'getForModel' | 'listModels'>,
    record: AgentRecord,
  ): { provider: LLMProvider; modelId: string; requestedModelId: string } | null {
    const optimizer = this.toolDeps?.providerOptimizer;
    if (!optimizer?.enabled || optimizer.mode === 'manual') return null;
    if (record.model || record.provider) return null;
    if (record.routing?.providerSelection === 'concrete' || record.routing?.providerSelection === 'synthetic') {
      return null;
    }

    const decision = optimizer.selectRoute(this.buildOptimizerRequestProfile(record));
    if (!decision?.explanation.accepted) return null;

    try {
      return {
        provider: providerRegistry.getForModel(decision.modelId, decision.providerId),
        modelId: this.resolveChatModelId(providerRegistry, decision.modelId, decision.providerId),
        requestedModelId: `${decision.providerId}:${decision.modelId}`,
      };
    } catch (error) {
      logger.warn('[AgentOrchestrator] provider optimizer selected an unresolved route; using default model routing', {
        agentId: record.id,
        providerId: decision.providerId,
        modelId: decision.modelId,
        error: summarizeError(error),
      });
      return null;
    }
  }

  private buildOptimizerRequestProfile(record: AgentRecord): RequestProfile {
    return {
      requiresToolCalling: record.tools.length > 0,
      requiresReasoningControls: record.reasoningEffort !== undefined,
    };
  }

  private resolveProviderRouting(
    record: AgentRecord,
    currentModel: ActiveModelRef,
    modelRegistry: readonly ModelDefinition[],
  ): ResolvedAgentProviderRouting {
    // A bare model override resolves via the shared resolver, the
    // record's own `provider` field (when present) is passed as context so
    // "model X on provider Y" qualifies immediately instead of demanding the
    // user already know the provider:model registryKey format.
    const resolvedModelOverride = record.model
      ? resolveModelReference(record.model, modelRegistry, { contextProviderId: record.provider })
      : undefined;
    const requestedModelId = this.normalizeRequestedModelId(resolvedModelOverride ?? currentModel.registryKey);
    const providerFromRegistryKey = resolvedModelOverride?.slice(0, resolvedModelOverride.indexOf(':'));
    if (record.provider && !record.model) {
      throw new Error('Agent provider routing requires a provider-qualified model when provider is supplied.');
    }
    if (record.provider && providerFromRegistryKey && !sameProviderCatalog(providerFromRegistryKey, record.provider)) {
      throw new Error(`Agent model override '${record.model}' conflicts with provider '${record.provider}'.`);
    }
    const fallbackModels = (record.routing?.fallbackModels ?? record.fallbackModels ?? [])
      .filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      .map((model) => resolveModelReference(model.trim(), modelRegistry));
    const providerSelection =
      record.routing?.providerSelection ??
      (record.provider === 'synthetic' ? 'synthetic' : record.provider ? 'concrete' : 'inherit-current');
    const providerId = record.provider;
    // A catalog-qualified model in the current provider keeps its selected
    // connection (e.g. OpenAI subscription). An explicit connection alias stays explicit.
    const modelProvider = providerFromRegistryKey && !CATALOG_PROVIDER_NAME_ALIASES[providerFromRegistryKey]
      && sameProviderCatalog(providerFromRegistryKey, currentModel.provider)
      ? currentModel.provider : providerFromRegistryKey;
    const effectiveProviderId =
      providerSelection === 'synthetic'
        ? undefined
        : providerSelection === 'concrete'
          ? (providerId ?? modelProvider ?? currentModel.provider)
          : (modelProvider ?? currentModel.provider);
    const providerOverride = effectiveProviderId !== 'synthetic' ? effectiveProviderId : undefined;
    const providerFailurePolicy =
      record.routing?.providerFailurePolicy ?? (fallbackModels.length > 0 ? 'ordered-fallbacks' : 'fail');
    if (providerFailurePolicy === 'ordered-fallbacks' && fallbackModels.length === 0) {
      throw new Error('Agent ordered fallback routing requires at least one provider-qualified fallback model.');
    }
    if (providerFailurePolicy === 'fail' && fallbackModels.length > 0) {
      throw new Error(
        'Agent fail routing cannot include fallback models; use ordered-fallbacks to enable model failover.',
      );
    }
    return {
      requestedModelId,
      providerSelection,
      providerFailurePolicy,
      providerId,
      providerOverride,
      fallbackModels,
    };
  }

  private normalizeRequestedModelId(requestedModelId: string): string {
    return requestedModelId.trim();
  }

  private resolveChatModelId(
    providerRegistry: Pick<ProviderRegistry, 'listModels'>,
    requestedModelId: string,
    providerOverride?: string,
  ): string {
    const registry = providerRegistry.listModels();
    const def = providerOverride
      ? findModelDefinitionForProvider(requestedModelId, providerOverride, registry, CATALOG_PROVIDER_NAME_ALIASES)
      : findModelDefinition(requestedModelId, registry);
    if (def) return def.id;
    throw new Error(`Model '${requestedModelId}' is not in registry.`);
  }

  private resolveFallbackOrder(
    providerRegistry: Pick<ProviderRegistry, 'listModels'>,
    record: AgentRecord,
    currentModel: ActiveModelRef,
  ): readonly string[] {
    const routing = this.resolveProviderRouting(record, currentModel, providerRegistry.listModels());
    if (routing.providerFailurePolicy === 'ordered-fallbacks') return routing.fallbackModels;
    // `fail` set on purpose stops at the first provider failure; left unset, the person's order applies.
    if (record.routing?.providerFailurePolicy === 'fail') return [];
    return readFallbackOrder(this.toolDeps?.configManager?.get('provider.fallbackModels'));
  }

  /**
   * @param workingDirectory Per-call cwd override (AgentRecord.workingDirectory).
   * Absent ⇒ `this.toolDeps.workingDirectory`, byte-identical to every run
   * context built before this parameter existed.
   */
  private async createRunContext(
    workingDirectory?: string,
    authority?: ContractInputAuthority,
    signal?: AbortSignal,
    runKey?: string,
    needsCapturedExec = false,
    needsCapturedRegistry = false,
    autonomousSource?: () => import('../permissions/autonomous.js').AutonomousToolSource,
    autonomousPort?: ContractActionPort,
    surface?: AgentWorkerSurface,
    needsProjectTools = false,
  ): Promise<AgentOrchestratorRunContext> {
    const cwd = workingDirectory ?? this.toolDeps?.workingDirectory ?? '';
    const delivered = new Set<string>();
    const originalPermissionManager = this.toolDeps?.permissionManager;
    if (autonomousSource && (!originalPermissionManager?.admitAutonomous || !originalPermissionManager.autonomousPreparation))
      throw new Error('Native contract member requires the shared autonomous permission owner');
    if (authority && !originalPermissionManager)
      throw new Error('captured agent requires original-owner read authorization');
    // Wake/steer can reuse one captured authority for another actual run.
    // Only registry rebuilds inside this invocation retain the same journal.
    // Created after the guards above: a refused run has no settlement to close it.
    const capturedReplHistory = authority ? createCapturedReplHistory(authority, signal) : undefined;
    const processManager = this.toolDeps?.processManager;
    const inputResources = new Set<() => void>();
    let inputsRetired = false;
    const retainInputResource = (dispose: () => void): void => {
      if (inputsRetired) { dispose(); throw new Error('Captured runtime input owner ended'); }
      inputResources.add(dispose);
    };
    const disposeInputs = () => {
      if (inputsRetired) return;
      inputsRetired = true;
      const errors: unknown[] = [];
      for (const dispose of inputResources) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      inputResources.clear();
      if (errors.length) throw new AggregateError(errors, 'Captured runtime input cleanup failed');
    };
    let runSettlement: Promise<void> | undefined;
    const beforeRunSettlement = authority && capturedReplHistory ? () => {
      if (runSettlement) return runSettlement;
      const retained = Promise.withResolvers<void>();
      runSettlement = retained.promise;
      try {
        disposeCapturedReplHistory(capturedReplHistory);
        retained.resolve(Promise.resolve(processManager?.stopOwnedBoundaries(authority)).finally(disposeInputs));
      } catch (failure) {
        try { disposeInputs(); } catch (cleanup) { retained.reject(new AggregateError([failure, cleanup], 'Captured run cleanup failed')); return runSettlement; }
        retained.reject(failure);
      }
      return runSettlement;
    } : undefined;
    const contractHooks = this.toolDeps?.contractHooks;
    const ownerReadAccess = originalPermissionManager
      ? async (path: string): Promise<boolean> => (await originalPermissionManager.readAccess(path)) === 'allow'
      : undefined;
    const configManager = this.toolDeps?.configManager;
    const homeDirectory = configManager?.getHomeDirectory() ?? undefined;
    try {
      const dependency =
        authority && needsCapturedExec
          ? await admitCapturedExecDependency(
              { authority, root: cwd, readAccessFilter: ownerReadAccess, signal, retainInputResource },
              {
                sourceRoot: join(contractInputAuthoritySourceRoot(authority), 'node_modules'),
                targetRelativePath: 'node_modules',
              },
            )
          : undefined;
      const dependencyInputs = Object.freeze(dependency ? [dependency] : []);
      const nodeRuntimeAdmission = authority && needsCapturedExec
        ? createCapturedExecNodeRuntimeAdmission({
            authority, root: cwd, readAccessFilter: ownerReadAccess, signal, retainInputResource,
          })
        : undefined;
      const bunRuntimeAdmission = authority && needsCapturedExec
        ? createCapturedExecBunRuntimeAdmission({ authority, root: cwd, readAccessFilter: ownerReadAccess, signal, retainInputResource },
            this.capturedBunRuntimeExecutable === undefined ? undefined : { bunExecutable: this.capturedBunRuntimeExecutable })
        : undefined;
      if (authority) await assertContractInputAuthority(authority, cwd, signal);
      const capturedRegistry =
        authority && needsCapturedRegistry
          ? await admitCapturedRegistryContext(
              { authority, root: cwd, readAccessFilter: ownerReadAccess, signal },
              { homeDirectory, surfaceRoot: this.toolDeps?.surfaceRoot },
            )
          : undefined;
      if (authority) await assertContractInputAuthority(authority, cwd, signal);
      // Defensive getter: a config snapshot predating the atRest section must fall
      // back to the honest default, never throw out of an agent run.
      const atRestGet = configManager
        ? (key: string): unknown => {
            try {
              return configManager.get(key as ConfigKey);
            } catch {
              return undefined;
            }
          }
        : undefined;
      // A run in another project than the host's folder uses that project's own (its hooks), never the host's;
      // the host's code index describes the host's folder, so such a run is given none rather than the wrong one.
      const ownFolder = cwd === (this.toolDeps?.workingDirectory ?? '');
      const projectHere = !authority && (!ownFolder || this.toolDeps?.ownFolderIsProject === true);
      const project = projectHere ? this.toolDeps?.projectFacilities?.(cwd) : undefined;
      const turnHooks = !projectHere ? this.toolDeps?.toolCallHooks : project?.toolCallHooks;
      // A run in a project reads that project's code index (when it is on), never the host's.
      const projectCode = projectHere ? project?.codeIndex?.() : undefined;
      return {
        workingDirectory: cwd,
        // The run's journal is the host's record, kept with the host's records (never written into the project): the
        // daemon's records of the run's project, else the host's own folder.
        journalRoot: authority ? contractInputAuthoritySourceRoot(authority) : this.toolDeps?.runRecordsRootOf?.(cwd) ?? this.toolDeps?.workingDirectory ?? cwd,
        agentManager: this.toolDeps?.agentManager,
        contextAccountingHolder: this.toolDeps?.contextAccountingHolder,
        ...(autonomousSource ? { autonomousSource } : {}),
        ...(autonomousPort ? { autonomousPort } : {}),
        ...(authority || autonomousSource
          ? {
              beforeProviderRequest: async () => {
                autonomousSource?.();
                if (authority) {
                  // Once per provider request: the view is the captured one (the batch,
                  // before and after) and every path read so far still passes the owner's
                  // policy (the paths delivered to the model are among them).
                  await assertContractInputReadAccess(authority, ownerReadAccess, signal);
                }
                autonomousSource?.();
              },
            }
          : {}),
        surfaceRoot: this.toolDeps?.surfaceRoot ?? '',
        ...(this.toolDeps?.screenless ? { screenless: true } : {}),
        atRestPolicy: resolveAtRestPolicy(atRestGet),
        ...(configManager ? { configManager } : {}),
        runtimeBus: this.runtimeBus,
        featureFlagManager: this.featureFlagManager,
        emitterContext: (agentId) => this.emitterContext(agentId),
        emitAgentProgress: (recordId, progress, audience) => this.emitAgentProgress(recordId, progress, audience),
        emitAgentStarted: (recordId) => this.emitAgentStarted(recordId),
        emitAgentCancelledEvent: (recordId, reason) => this.emitAgentCancelledEvent(recordId, reason),
        emitAgentFailedEvent: (recordId, error, durationMs) => this.emitAgentFailedEvent(recordId, error, durationMs),
        emitAgentCompletedEvent: (recordId, durationMs, output, toolCallsMade, usage) =>
          this.emitAgentCompletedEvent(recordId, durationMs, output, toolCallsMade, usage),
        registerConversationSource: this.conversationSink
          ? (agentId, source) => this.conversationSink!.register(agentId, source)
          : undefined,
        releaseConversationSource: this.conversationSink
          ? (agentId) => this.conversationSink!.release(agentId)
          : undefined,
        getCancellationSignal: this.cancellationSource ? (agentId) => this.cancellationSource!.get(agentId) : undefined,
        processManager,
        messageBus: this.messageBus,
        knowledgeService: this.toolDeps?.knowledgeService,
        memoryRegistry: this.toolDeps?.memoryRegistry,
        codeReadAccessFilter: ownerReadAccess,
        codeIndex: authority ? createCapturedCodeContext({ authority, root: cwd, readAccessFilter: ownerReadAccess, registry: this.toolDeps?.memoryEmbeddingRegistry, signal })
          : projectHere ? projectCode?.source : ownFolder ? this.toolDeps?.codeIndex : undefined,
        isCodeInjectionSettingEnabled: this.toolDeps?.isCodeInjectionSettingEnabled,
        // A captured tree is not the shared index; only the shared one is reindexed, and only from its own folder.
        onCodeSourcesChanged: projectCode?.reindex.schedule
          ? (paths) => { for (const path of paths) projectCode.reindex.schedule?.(path); }
          : !authority && ownFolder && !projectHere && this.toolDeps?.codeIndexReindexScheduler?.schedule
            ? (paths) => { for (const path of paths) this.toolDeps?.codeIndexReindexScheduler?.schedule?.(path); }
            : undefined,
        onToolExecuted:
          this.toolDeps?.codeIndexReindexScheduler || this.toolDeps?.toolExecutionObserver || projectCode
            ? (toolName, args, success) => {
                if (projectCode) projectCode.reindex.onToolExecuted(toolName, args, success);
                else if (!authority && ownFolder) this.toolDeps?.codeIndexReindexScheduler?.onToolExecuted(toolName, args, success);
                // The run's project: its folder when it works in one, the captured input's project for a contract run.
                const turnProject = projectHere ? cwd : authority ? contractInputAuthoritySourceRoot(authority) : undefined;
                this.toolDeps?.toolExecutionObserver?.(toolName, args, success, { ...(turnProject ? { project: turnProject } : {}) });
              }
            : undefined,
        contractHooks: authority && contractHooks && processManager
          ? {
              onTurnEnd: (record, turn) => {
                void processManager.waitOwnedBoundaries(authority, signal).then(() => {
                  signal?.throwIfAborted();
                  contractHooks.onTurnEnd(record, turn);
                }).catch((error: unknown) => {
                  logger.debug('Captured turn check stopped before execution settlement', { error: String(error) });
                });
              },
              holdCompletion: async (record, candidateOutput) => {
                await processManager.waitOwnedBoundaries(authority, signal);
                signal?.throwIfAborted();
                return contractHooks.holdCompletion(record, candidateOutput);
              },
            }
          : contractHooks,
        ...(beforeRunSettlement ? { beforeRunSettlement } : {}),
        archetypeLoader: this.toolDeps?.archetypeLoader,
        providerOptimizer: this.toolDeps?.providerOptimizer,
        providerRegistry: this.toolDeps!.providerRegistry!,
        ...(this.toolDeps?.permissionManager ? { permissionManager: this.toolDeps.permissionManager } : {}),
        ...(turnHooks ? { hookDispatcher: turnHooks } : {}),
        getFullRegistry: () =>
          this.getFullRegistry(
            cwd,
            authority,
            signal,
            runKey,
            delivered,
            ownerReadAccess,
            dependencyInputs,
            capturedRegistry,
            processManager,
            nodeRuntimeAdmission,
            bunRuntimeAdmission,
            capturedReplHistory,
            surface,
            needsProjectTools,
          ),
        buildScopedRegistry: (allowedNames, fullRegistry, captureAuthority) =>
          this.buildScopedRegistry(allowedNames, fullRegistry, captureAuthority),
        resolveProviderForRecord: (providerRegistry, record, currentModel) =>
          this.resolveProviderForRecord(providerRegistry, record, currentModel),
        resolveFallbackOrder: (providerRegistry, record, currentModel) =>
          this.resolveFallbackOrder(providerRegistry, record, currentModel),
      };
    } catch (error) {
      try { if (beforeRunSettlement) await beforeRunSettlement(); else disposeInputs(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Captured run construction and cleanup failed'); }
      throw error;
    }
  }

  /**
   * Run an agent task described by the given record. Honors
   * `record.workingDirectory` when set (see AgentInput.workingDirectory),
   * every tool this run's registry exposes is bound to that cwd instead of
   * the orchestrator's default.
   */
  async runAgent(record: AgentRecord): Promise<void> {
    const authority = getContractInputAuthority(record);
    const autonomousSource = getContractActionSource(record);
    if (record.contractId && this.toolDeps?.contractRunner?.get(record.contractId)?.nativeSource !== undefined && !autonomousSource)
      throw new Error('Native member has no construction-owned action source');
    const cwd = record.workingDirectory ?? this.toolDeps?.workingDirectory ?? '';
    if (!authority && isCapturedInputPath(cwd))
      throw new Error('captured view has no construction-owned input authority');
    const signal = this.cancellationSource?.get(record.id);
    const runKey = authority ? `${cwd}:captured-run:${randomUUID()}` : undefined;
    if (authority) await assertContractInputAuthority(authority, cwd, signal);
    // Asked here, under the spawning turn's execution context: the surface this worker is built for.
    const surface = this.toolDeps?.workerSurface?.();
    const defaultCwd = this.toolDeps?.workingDirectory ?? '';
    // A registry for a dedicated worktree lives only while a run uses it; the default one is shared and stays,
    // and so does the default directory's registry for a surface, which every worker that surface spawns there reuses.
    const sharedKey = runKey === undefined ? sharedRegistryKey(cwd, surface) : undefined;
    const countedKey = sharedKey !== defaultCwd ? sharedKey : undefined;
    if (countedKey !== undefined) this.cwdRunCounts.set(countedKey, (this.cwdRunCounts.get(countedKey) ?? 0) + 1);
    // Runs per non-default directory, whatever registry they use: the project-framework reading of a
    // directory (a worktree) is forgotten once no run works there.
    const frameworkDirectory = cwd !== defaultCwd ? cwd : undefined;
    if (frameworkDirectory !== undefined) this.frameworkDirectoryRuns.set(frameworkDirectory, (this.frameworkDirectoryRuns.get(frameworkDirectory) ?? 0) + 1);
    let context: AgentOrchestratorRunContext | undefined;
    try {
      context = await this.createRunContext(
        cwd,
        authority,
        signal,
        runKey,
        record.tools.some((name) => ['exec', 'write', 'edit', 'repl'].includes(name)),
        record.tools.includes('registry'),
        autonomousSource,
        getContractActionPort(record),
        surface,
        // A step of planned work that names its project's tool servers or checklist is given them in its copy.
        record.tools.some((name) => name === 'mcp' || name === 'work_plan'),
      );
      // A native request's files reach the agents that do its work, read through the chat attachment path.
      // Kept with the contract's source getter (whichever runner owns the contract), else read from this runner's contract.
      const attachments = getSourceAttachments(autonomousSource)
        ?? (record.contractId ? this.toolDeps?.contractRunner?.get(record.contractId)?.nativeSource?.attachments : undefined);
      if (attachments && attachments.length > 0) context = { ...context, taskAttachments: { attachments, artifacts: this.toolDeps?.artifacts ?? null } };
      // Every permission decision of this run is made for its own project (a captured view's: the project it was
      // captured from): that project's rules, folder trust and session answers, never the folder this daemon started in.
      const runContext = context;
      const run = () => decideInProject(authority ? contractInputAuthoritySourceRoot(authority) : cwd, () => runAgentTask(runContext, record));
      // What a run of its own (a schedule, a trigger, a channel's agent) reads from outside is its own: judged against its
      // own outward actions, never counted in another project's or conversation's turn. A run started inside a
      // conversation's or a piece of work's window stays in that window (stricter, never looser).
      if (currentUntrustedContentScope() !== undefined) await run();
      else {
        await withUntrustedContentScope(`agent:${record.id}`, () => {
          getProcessUntrustedContentLedger().startTurn();
          return run();
        });
      }
    } finally {
      // A run in another project ends as a turn there does: a checkpoint of that project when its files changed.
      if (!authority && (cwd !== defaultCwd || this.toolDeps?.ownFolderIsProject === true)) {
        try { this.toolDeps?.projectFacilities?.(cwd).afterTurn?.({ agentId: record.id, ...(record.sessionId ? { sessionId: record.sessionId } : {}) }); }
        catch (error) { logger.warn('AgentOrchestrator: the project\'s after-run step failed', { workingDirectory: cwd, error: summarizeError(error) }); }
      }
      try {
        // The captured code source belongs to this run; the shared one is not ours to close.
        if (authority) context?.codeIndex?.dispose?.();
        await context?.beforeRunSettlement?.();
      }
      finally {
        if (frameworkDirectory !== undefined) {
          const left = (this.frameworkDirectoryRuns.get(frameworkDirectory) ?? 1) - 1;
          if (left > 0) this.frameworkDirectoryRuns.set(frameworkDirectory, left);
          else {
            this.frameworkDirectoryRuns.delete(frameworkDirectory);
            forgetProjectFramework(frameworkDirectory);
          }
        }
        if (runKey) await this.releaseRegistry(runKey);
        else if (countedKey !== undefined) {
          const remaining = (this.cwdRunCounts.get(countedKey) ?? 1) - 1;
          if (remaining > 0) this.cwdRunCounts.set(countedKey, remaining);
          else {
            this.cwdRunCounts.delete(countedKey);
            if (cwd !== defaultCwd) await this.keepIdleRegistry(countedKey);
          }
        }
      }
    }
  }
}
