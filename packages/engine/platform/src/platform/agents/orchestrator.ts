import type { LocalhostFetchApproval } from '../runtime/permissions/localhost-fetch-approval.js';
import { createCapturedCodeContext } from './captured-code-context.js';
import { admitCapturedRegistryContext, type CapturedRegistryContext } from '../tools/registry-tool/captured-source.js';
import { join } from 'node:path';
import { getContractActionSource, getContractActionPort, type ContractActionPort } from '../tools/agent/contract-binding.js';
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
  assertContractInputReadSet,
  withContractInputReadBatch,
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
import { registerAllTools } from '../tools/index.js';
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
  emitAgentStreamDelta,
} from '../runtime/emitters/index.js';
import { findModelDefinition, findModelDefinitionForProvider } from '../providers/registry-models.js';
import { CATALOG_PROVIDER_NAME_ALIASES, sameProviderCatalog } from '../providers/provider-aliases.js';
import { resolveModelReference } from '../providers/model-id-resolution.js';
import { runAgentTask, type AgentOrchestratorRunContext } from './orchestrator-runner.js';
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
  readonly register: (agentId: string, source: () => ConversationMessageSnapshot[]) => void;
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
  /** Saves a working-directory change for the next start; `state set runtime.workingDir` uses it (registerAllTools). */
  readonly workspaceSwap?: import('../tools/state/index.js').StateSwapManager | undefined;
  /** Supplying it registers the `profile` capture tool. See registerAllTools. */
  readonly personalCapture?: import('../personal-capture/index.js').PersonalCaptureHolder | undefined;
  readonly codeIndex?: import('./turn-knowledge-injection.js').TurnCodeIndexSource | undefined;
  readonly memoryEmbeddingRegistry?: import('../state/memory-embeddings.js').MemoryEmbeddingProviderRegistry | undefined;
  readonly isCodeInjectionSettingEnabled?: (() => boolean) | undefined;
  readonly codeIndexReindexScheduler?:
    | Pick<import('../state/code-index-reindex.js').CodeIndexReindexScheduler, 'onToolExecuted'>
    | undefined;
  /** Additional per-tool-execution tap (e.g. CI auto-watch minting); composed with the reindex scheduler, never blocking. */
  readonly toolExecutionObserver?:
    | ((toolName: string, args: Record<string, unknown>, success: boolean) => void)
    | undefined;
  /** The contract runner's agent-loop seams (`runner.hooks()`), passed into every run context; see AgentOrchestratorRunContext.contractHooks. */
  readonly contractHooks: import('../contract/agent-hooks.js').ContractAgentHooks;
  /** The owner inbox a spawned agent's `query` tool leaves questions in (registerAllTools); absent, it has no `query`. */
  readonly ownerQuestions?: import('../tools/query/index.js').QuestionInbox | (() => import('../tools/query/index.js').QuestionInbox) | undefined;
  /** Starts the contracts the agent and workflow tools hand work to (registerAllTools). */
  readonly contractRunner: Pick<import('../contract/runner.js').ContractRunner, 'start' | 'list' | 'get'>;
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
  readonly permissionManager?:
    | Pick<
        import('../permissions/manager.js').PermissionManager,
        'checkDetailed' | 'check' | 'getBackgroundAgentsMode' | 'readAccess' | 'passesBoundary'
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
  /** Runs currently using a non-default working directory's registry; the last one out releases it. */
  private cwdRunCounts = new Map<string, number>();
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

  private emitStreamDelta(recordId: string, content: string, accumulated: string): void {
    if (!this.runtimeBus || !content) return;
    emitAgentStreamDelta(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      content,
      accumulated,
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
    this.fullRegistries.delete(key);
    this.runKeyedRegistries.delete(key);
    const index = this.ownedProjectIndexes.get(key);
    const disposeState = this.registryDisposers.get(key);
    this.ownedProjectIndexes.delete(key);
    this.registryDisposers.delete(key);
    const failed = (what: string) => (error: unknown): void => {
      logger.warn(`AgentOrchestrator: ${what} teardown failed`, { workingDirectory: key, error: summarizeError(error) });
    };
    await Promise.all([
      index?.dispose().catch(failed('project index')),
      disposeState?.().catch(failed('session state')),
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
    const key = runKey ?? cwd;
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
      const registered = registerAllTools(registry, {
        ...this.toolDeps,
        ...(authority && capturedProcessManager ? { processManager: capturedProcessManager } : {}),
        contractRunner: this.toolDeps.contractRunner,
        projectRoot: defaultCwd,
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
      });
      // Keep the index registerAllTools built for us. Only for a non-default
      // cwd: for the default one it hands back the very object the composition
      // root passed in, which this class borrows and must not dispose.
      if (!isDefaultCwd || authority) this.ownedProjectIndexes.set(key, registered.projectIndex);
      this.registryDisposers.set(key, registered.dispose);
      if (runKey) this.runKeyedRegistries.add(key);
      registerChannelAgentTools(registry, this.toolDeps?.channelRegistry ?? this.channelRegistry);
      this.toolDeps.decorateRegistry?.(registry);
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
   * Build a ToolRegistry containing only the tools whose names appear in
   * the allowedNames list. Filters the provided full registry into a fresh
   * scoped registry.
   */
  private buildScopedRegistry(
    allowedNames: string[],
    fullRegistry: ToolRegistry,
    captureAuthority?: import('../personal-capture/index.js').CaptureAuthorityDecision | undefined,
  ): ToolRegistry {
    const allowed = new Set(allowedNames.filter((n) => n !== 'agent'));

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

  private resolveFallbackModelRoutes(
    providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getForModel'>,
    record: AgentRecord,
    currentModel: ActiveModelRef,
    primaryRequestedModelId: string,
  ): Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }> {
    const routing = this.resolveProviderRouting(record, currentModel, providerRegistry.listModels());
    if (routing.providerFailurePolicy !== 'ordered-fallbacks' || routing.fallbackModels.length === 0) {
      return [];
    }
    const seen = new Set([primaryRequestedModelId]);
    const routes: Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }> = [];
    const modelRegistry = providerRegistry.listModels();
    for (const rawFallback of routing.fallbackModels) {
      // routing.fallbackModels entries are already resolved/qualified by resolveProviderRouting().
      const requestedModelId = this.normalizeRequestedModelId(rawFallback);
      if (!requestedModelId || seen.has(requestedModelId)) continue;
      seen.add(requestedModelId);
      const fallbackDef = findModelDefinition(requestedModelId, modelRegistry);
      if (!fallbackDef) {
        throw new Error(`Agent fallback model '${requestedModelId}' is not in registry.`);
      }
      const fallbackProvider = routing.providerOverride && sameProviderCatalog(fallbackDef.provider, routing.providerOverride)
        ? routing.providerOverride : fallbackDef.provider;
      routes.push({
        provider: providerRegistry.getForModel(requestedModelId, fallbackProvider),
        modelId: this.resolveChatModelId(providerRegistry, requestedModelId, fallbackProvider),
        requestedModelId,
      });
    }
    return routes;
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
              { homeDirectory },
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
      return {
        workingDirectory: cwd,
        journalRoot: authority ? contractInputAuthoritySourceRoot(authority) : this.toolDeps?.workingDirectory ?? cwd,
        agentManager: this.toolDeps?.agentManager,
        contextAccountingHolder: this.toolDeps?.contextAccountingHolder,
        ...(autonomousSource ? { autonomousSource } : {}),
        ...(autonomousPort ? { autonomousPort } : {}),
        ...(authority || autonomousSource
          ? {
              beforeProviderRequest: async () => {
                autonomousSource?.();
                if (authority) {
                  await withContractInputReadBatch(authority, async () => {
                    await assertContractInputAuthority(authority, cwd, signal);
                    await assertContractInputReadAccess(authority, ownerReadAccess, signal);
                    await assertContractInputReadSet(authority, delivered, ownerReadAccess, signal);
                  });
                }
                autonomousSource?.();
              },
            }
          : {}),
        surfaceRoot: this.toolDeps?.surfaceRoot ?? '',
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
        emitStreamDelta: (recordId, content, accumulated) => this.emitStreamDelta(recordId, content, accumulated),
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
        codeIndex: authority ? createCapturedCodeContext({ authority, root: cwd, readAccessFilter: ownerReadAccess, registry: this.toolDeps?.memoryEmbeddingRegistry, signal }) : this.toolDeps?.codeIndex,
        isCodeInjectionSettingEnabled: this.toolDeps?.isCodeInjectionSettingEnabled,
        onToolExecuted:
          this.toolDeps?.codeIndexReindexScheduler || this.toolDeps?.toolExecutionObserver
            ? (toolName, args, success) => {
                if (!authority) this.toolDeps?.codeIndexReindexScheduler?.onToolExecuted(toolName, args, success);
                this.toolDeps?.toolExecutionObserver?.(toolName, args, success);
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
        ...(this.toolDeps?.toolCallHooks ? { hookDispatcher: this.toolDeps.toolCallHooks } : {}),
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
          ),
        buildScopedRegistry: (allowedNames, fullRegistry, captureAuthority) =>
          this.buildScopedRegistry(allowedNames, fullRegistry, captureAuthority),
        resolveProviderForRecord: (providerRegistry, record, currentModel) =>
          this.resolveProviderForRecord(providerRegistry, record, currentModel),
        resolveFallbackModelRoutes: (providerRegistry, record, currentModel, primaryRequestedModelId) =>
          this.resolveFallbackModelRoutes(providerRegistry, record, currentModel, primaryRequestedModelId),
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
    if (record.contractId && this.toolDeps?.contractRunner.get(record.contractId)?.nativeSource !== undefined && !autonomousSource)
      throw new Error('Native member has no construction-owned action source');
    const cwd = record.workingDirectory ?? this.toolDeps?.workingDirectory ?? '';
    if (!authority && isCapturedInputPath(cwd))
      throw new Error('captured view has no construction-owned input authority');
    const signal = this.cancellationSource?.get(record.id);
    const runKey = authority ? `${cwd}:captured-run:${randomUUID()}` : undefined;
    if (authority) await assertContractInputAuthority(authority, cwd, signal);
    // A registry for a dedicated worktree lives only while a run uses it; the default one is shared and stays.
    const sharesCwdRegistry = runKey === undefined && cwd !== (this.toolDeps?.workingDirectory ?? '');
    if (sharesCwdRegistry) this.cwdRunCounts.set(cwd, (this.cwdRunCounts.get(cwd) ?? 0) + 1);
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
      );
      await runAgentTask(context, record);
    } finally {
      try {
        // The captured code source belongs to this run; the shared one is not ours to close.
        if (authority) context?.codeIndex?.dispose?.();
        await context?.beforeRunSettlement?.();
      }
      finally {
        if (runKey) await this.releaseRegistry(runKey);
        else if (sharesCwdRegistry) {
          const remaining = (this.cwdRunCounts.get(cwd) ?? 1) - 1;
          if (remaining > 0) this.cwdRunCounts.set(cwd, remaining);
          else { this.cwdRunCounts.delete(cwd); await this.releaseRegistry(cwd); }
        }
      }
    }
  }
}
