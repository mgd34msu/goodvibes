import { initialTerminalRuntimeFields } from '@goodvibes-jev/engine/terminal-shell/bootstrap-primitives';
import { projectAgentToolDependencies } from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-context';
import {
  createTerminalFeatureFlags,
  createTerminalEventState,
  initializeTerminalMemory,
  attachTerminalCompanionInput,
  seedTerminalSession,
  syncTerminalNotifierQueues,
} from '@goodvibes-jev/engine/terminal-shell/bootstrap-primitives';
import {
  initializeTerminalCatalog,
  seedTerminalControlPlane,
  attachTerminalRuntimeBindings,
} from '@goodvibes-jev/engine/terminal-shell/bootstrap-runtime-bindings';
import { createTerminalRenderScheduler } from '@goodvibes-jev/engine/terminal-shell/render-scheduler';
import { ConversationManager } from '../core/conversation';
import { publishToSharedFeed } from '../core/notices.ts';
import { registerSessionConversation } from './conversation-rewind-port.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { getConfiguredSystemPrompt } from '../config/index.ts';
import { installAgentDaemonConfigClient } from '../config/daemon-config-routing.ts';
import { installAgentDaemonCredentialsClient } from '../config/daemon-credential-routing.ts';
import { getProviderIdFromModel } from '../config/provider-model.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerAllTools } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { PermissionManager } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { createRuntimeNotifier } from './bootstrap-notifier.ts';
import { readAgentHostSetting } from '../config/host-settings.ts';

import { Compositor } from '../renderer/compositor.ts';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { ConversationFollowUpItem } from '@goodvibes-jev/engine/sdk/platform/core';
import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ControlPlaneRecentEvent } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { BootstrapOptions } from './context.ts';
import '@/runtime/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';

import { type RuntimeStore } from './store/index.ts';
import { ForensicsCollector, ForensicsRegistry } from '@/runtime/index.ts';
import { generateUserSessionId } from '@/runtime/index.ts';
import { loadBootstrapSystemPrompt, syncConfiguredServices } from '@/runtime/index.ts';
import { registerBootstrapHookBridge } from '@/runtime/index.ts';
import { createRuntimeServices, foldAgentLegacyMemory, type RuntimeServices } from './services.ts';
import { createHostPowerSeam } from '@goodvibes-jev/engine/sdk/platform/power';
import { formatMemoryFoldReport } from '@goodvibes-jev/engine/sdk/platform/state';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { importVibeFilesIntoMemoryOnce } from '../agent/vibe-file.ts';
import { createUiRuntimeServices, type UiRuntimeServices } from './ui-services.ts';
import { getTerminalSize } from '../shell/terminal-size.ts';
import { installPermissionManagerSafetyGuard } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import { composeAgentToolRegistry } from './agent-tool-registry.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { registerAgentRuntimeEvents } from './agent-runtime-events.ts';

export interface BootstrapCoreState {
  readonly userSessionId: string;
  readonly runtimeBus: RuntimeEventBus;
  readonly store: RuntimeStore;
  readonly services: RuntimeServices;
  readonly uiServices: UiRuntimeServices;
  readonly conversation: ConversationManager;
  readonly compositor: Compositor;
  readonly selection: SelectionManager;
  readonly toolRegistry: ToolRegistry;
  readonly fileCache: ReturnType<typeof registerAllTools>['fileCache'];
  readonly projectIndex: ReturnType<typeof registerAllTools>['projectIndex'];
  readonly permissionManager: PermissionManager;
  readonly forensicsCollector: ForensicsCollector;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly runtime: MutableRuntimeState;
  readonly bootstrapUnsubs: Array<() => void | Promise<void>>;
  readonly runtimeUnsubs: Array<() => void>;
  readonly agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler };
  readonly systemMessageRouterRef: { value: SystemMessageRouter | null };
  readonly conversationFollowUpRef: { value: ((item: ConversationFollowUpItem) => void) | null };
  /**
   * Mutable ref patched by bootstrap.ts after the Orchestrator is constructed.
   * When non-null, COMPANION_MESSAGE_RECEIVED fires a real LLM turn via
   * orchestrator.handleUserInput() instead of only appending the user message.
   */
  readonly orchestratorHandleUserInputRef: { value: ((text: string, options?: OrchestratorUserInputOptions) => void) | null };
  readonly requestRender: () => void;
  readonly setRenderRequest: (fn: () => void) => void;
  readonly runtimeSessionIdRef: { value: string };
}

import {
  approvalMetadataForRequest,
  companionMessageToOrchestratorInputOptions,
  registerWebhookNotifier,
} from './bootstrap-core-helpers.ts';

// Re-exported so every existing importer of this module is unaffected by the
// split; the definitions moved, the public surface did not.
export type { CompanionMessagePayload } from './bootstrap-core-helpers.ts';
export {
  approvalMetadataForRequest,
  companionMessageToOrchestratorInputOptions,
  registerWebhookNotifier,
} from './bootstrap-core-helpers.ts';

/** The live Agent permission composition, shared by main and background calls. */
export function composeAgentPermissionManager(services: Pick<RuntimeServices, 'permissionManager'>): PermissionManager {
  const manager = services.permissionManager;
  installPermissionManagerSafetyGuard(manager);
  return manager;
}

export async function initializeBootstrapCore(
  stdout: NodeJS.WriteStream,
  options: BootstrapOptions,
  getControlPlaneRecentEvents: (limit: number) => readonly ControlPlaneRecentEvent[],
): Promise<BootstrapCoreState> {
  const workingDir = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const configManager = options.configManager;

  // Gate states derive from domain settings keys (behavior.*, sandbox.*, ...);
  // the featureFlags config category no longer exists. The live bridge keeps
  // config.set changes on those keys flowing into the manager afterwards.
  const featureFlags = createTerminalFeatureFlags(configManager);

  const userSessionId = `user-${generateUserSessionId()}`;
  // Declared here, before createRuntimeServices, so the checkpoint manager can be
  // handed a live session-id resolver at construction time. Its value starts as
  // the bootstrap user session id and is advanced to the real runtime session id
  // below (see runtimeSessionIdRef.value = runtime.sessionId). Because the
  // resolver is consulted at the moment each automatic snapshot fires, not at
  // subscription time, reading .value through this closure keeps same-launch
  // checkpoints stamped with whatever session id is current when the turn ends,
  // which is exactly the id the restore/rewind lookup filters on.
  const runtimeSessionIdRef = { value: userSessionId };
  // Point the bus listener cap at runtime.eventBus.maxListeners before the
  // first bus exists, so every bus this process builds later uses it.
  const { runtimeBus, store, domainDispatch } = createTerminalEventState(configManager);
  let getConversationTitle = (): string | undefined => undefined;
  const services = createRuntimeServices({
    configManager,
    featureFlags,
    runtimeBus,
    runtimeStore: store,
    getConversationTitle: () => getConversationTitle(),
    resolveSessionId: () => runtimeSessionIdRef.value || undefined,
    workingDir,
    homeDirectory,
    // The embedded interactive runtime IS the long-lived composition that owns
    // the sleep edge, it holds a LOCAL OS inhibitor for keep-awake /
    // idle-inhibit while the process lives. Opt into the real host power seam
    // here (createRuntimeServices otherwise defaults to the non-spawning
    // unavailable seam). Pinned by power-keep-awake-composition.test.ts.
    powerSeam: createHostPowerSeam(),
  });
  // Daemon-owned settings and credentials leave this process from here on. The
  // routing is installed at the INTERACTIVE boot rather than inside
  // createRuntimeServices, because that factory also runs for CLI subcommands,
  // readiness probes and unit tests, none of which should change how an
  // unrelated later write behaves. Cleared by services.dispose().
  installAgentDaemonCredentialsClient(services.daemonCredentialsClient);
  installAgentDaemonConfigClient(services.daemonConfigClient);
  const providerRegistry = services.providerRegistry;
  initializeTerminalCatalog(providerRegistry, services.benchmarkStore, () => services.keybindingsManager.loadFromDisk());
  seedTerminalControlPlane(domainDispatch, configManager, userSessionId, {
    id: 'client:goodvibes-agent',
    kind: 'service',
    label: 'GoodVibes Agent',
    capabilities: ['session', 'commands', 'automation'],
    metadata: {
      product: 'goodvibes-agent',
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      clientKindNote: 'Connected-host client kind; GoodVibes Agent remains an interactive operator TUI.',
    },
  });

  const {
    approvalBroker,
    hookDispatcher,
    hookWorkbench,
    memoryStore,
    // The register automation runs on. It is NOT the dispatch path any more,
    // inbound continuations reach the loop over services.sessionBroker, the wire
    // dispatch, but this process still creates its own session record in it so
    // an automation job targeting "the live session" finds one.
    automationSessionRegister: sharedSessionBroker,
  } = services;

  const stopRuntimeBindings = attachTerminalRuntimeBindings(services, runtimeBus, store, configManager);

  const forensicsRegistry = new ForensicsRegistry();
  const forensicsCollector = new ForensicsCollector(runtimeBus, forensicsRegistry);
  const policyRuntimeState = services.policyRuntimeState;
  const uiServices = createUiRuntimeServices(services, {
    forensicsRegistry,
    getControlPlaneRecentEvents,
  });

  const conversation = new ConversationManager(() => getTerminalSize(stdout).width);
  conversation.setConfigManager(configManager);
  // Every system notice is a toast and a /notifications entry in full (core/notices.ts); the transcript draws none.
  conversation.setNoticeSink(publishToSharedFeed);
  getConversationTitle = () => conversation.title;

  const compositor = new Compositor(stdout);
  const selection = new SelectionManager();

  // The main conversation's tool registry: the platform tools, the Agent's own
  // tools, then its policy, platform-boundary and execution-safety wrappers, in
  // that order (agent-tool-registry.ts). One function, so the exec
  // refusal-and-kill test drives exactly the chain a live turn uses.
  const { toolRegistry, fileCache, projectIndex } = composeAgentToolRegistry({
    services,
    configManager,
    homeDirectory,
    // Task refs are owned by the REAL runtime session, read fresh on every call.
    resolveSessionId: () => runtimeSessionIdRef.value,
    getLastUserMessage: () => conversation.getLastUserMessage(),
    researchReportSourceOwner: services.researchReportSourceOwner,
  });
  // Captured so the permissionManager-bearing follow-up call below (issued once
  // permissionManager exists, further down this function) can replay every
  // field, AgentOrchestrator.setDependencies() fully replaces its stored
  // toolDeps rather than merging, so a partial second call would silently drop
  // everything set here.
  const agentOrchestratorToolDeps = {
    ...projectAgentToolDependencies({ services, fileCache, projectIndex, configManager }),
    contractHooks: services.contractRunner.hooks(),
    secretsManager: services.secretsManager,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    knowledgeService: services.agentKnowledgeService,
  };
  services.agentOrchestrator.setDependencies(agentOrchestratorToolDeps);

  const bootstrapUnsubs: Array<() => void | Promise<void>> = [];
  bootstrapUnsubs.push(stopRuntimeBindings);
  // D5 fix: stop the heartbeat watcher on shutdown so the setInterval is cleared.
  // Registered here (after declaration) rather than inside the watcher block above.

  await initializeTerminalMemory(memoryStore, bootstrapUnsubs);

  // Fold the agent's legacy per-surface memory into the canonical
  // cross-surface store (id-keyed, idempotent, never deletes the legacy file) and
  // SURFACE the fold report, migration honesty requires that what moved is visible,
  // not silently swallowed. Non-fatal: a fold failure must never block startup.
  try {
    const foldReport = await foldAgentLegacyMemory(services.memoryStore, services.memoryEmbeddingRegistry, services.shellPaths);
    logger.info('agent legacy memory fold report', { report: formatMemoryFoldReport(foldReport) });
  } catch (err) {
    logger.warn('agent legacy memory fold failed (non-fatal)', { error: summarizeError(err) });
  }

  // ONE-TIME migration of discovered VIBE.md files into persona/constraint
  // records, guarded by a persisted path→hash marker so it never re-imports the same
  // file (which would create near-duplicate persona records). After this, the VIBE
  // prompt is a PROJECTION of those records (buildVibeProjectionPrompt).
  try {
    const importedPersona = await importVibeFilesIntoMemoryOnce(services.memorySpineClient, services.shellPaths);
    if (importedPersona > 0) {
      logger.info('agent VIBE.md persona migration', { records: importedPersona });
    }
  } catch (err) {
    logger.warn('agent VIBE.md persona migration failed (non-fatal)', { error: summarizeError(err) });
  }

  const {
    renderRequestRef,
    requestRender,
    dispose: disposeRenderScheduler,
  } = createTerminalRenderScheduler({
    onError: (error, delayed) =>
      logger.error((delayed ? 'Throttled' : 'Immediate') + ' render threw; next requestRender will reschedule', { error: String(error) }),
  });
  bootstrapUnsubs.push(disposeRenderScheduler);
  // The graph owns the prompt holder now: the ask seam reads through it, and
  // the seam is part of the composition. The renderer still patches
  // `requestPermission` onto this same object, so nothing about how a prompt is
  // installed changed, only where the object is declared.
  const permissionPromptRef = services.permissionPromptRef as { requestPermission: PermissionRequestHandler };
  void approvalBroker.start();
  void sharedSessionBroker.start();
  const systemMessageRouterRef: { value: SystemMessageRouter | null } = { value: null };
  const conversationFollowUpRef: { value: ((item: ConversationFollowUpItem) => void) | null } = { value: null };
  const { unsubs: runtimeUnsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter: () => systemMessageRouterRef.value,
    queueConversationFollowUp: (item) => conversationFollowUpRef.value?.(item),
    requestRender,
    configManager,
    agentManager: services.agentManager,
    contractRunner: services.contractRunner,
    toolRegistry,
  });

  // Subscribe to companion main-chat messages received from the connected host's HTTP layer.
  // The connected host emits COMPANION_MESSAGE_RECEIVED on the runtime bus when a companion
  // POST /api/sessions/:id/messages with kind='message' arrives.
  //
  // bootstrap.ts patches orchestratorHandleUserInputRef.value after the Orchestrator
  // is constructed. When that ref is set, we delegate to orchestrator.handleUserInput()
  // which (a) adds the user message to the conversation view and (b) fires a real LLM
  // turn whose STREAM_DELTA / TURN_COMPLETED events flow to both TUI and companion SSE.
  //
  // The fallback (ref not yet set) adds the message to the conversation view only,
  // this path is unreachable in practice because the event bus is not connected to
  // any live HTTP traffic until after the orchestrator is wired in bootstrap.ts.
  const orchestratorHandleUserInputRef: {
    value: ((text: string, options?: OrchestratorUserInputOptions) => void) | null;
  } = { value: null };
  runtimeUnsubs.push(attachTerminalCompanionInput(runtimeBus, orchestratorHandleUserInputRef, conversation, requestRender));

  providerRegistry.startWatching(runtimeBus);

  const webhookUrls = (configManager.getCategory('notifications') as { webhookUrls?: string[] }).webhookUrls ?? [];
  if (webhookUrls.length > 0) {
    // Reuse the services.webhookNotifier instance (constructed no-arg in services.ts).
    // Configure it with the resolved URL list via setUrls(), attach it to the runtime
    // bus so it receives SESSION_NOTIFICATION events, and register detach() in
    // runtimeUnsubs so the bus subscription is cleaned up on shutdown.
    registerWebhookNotifier(services.webhookNotifier, webhookUrls, runtimeBus, runtimeUnsubs);
    domainDispatch.syncIntegration(
      {
        id: 'webhooks',
        displayName: 'Webhooks',
        category: 'communication',
        status: 'healthy',
        enabled: true,
        successCount: 0,
        errorCount: 0,
        meta: { urlCount: webhookUrls.length },
      },
      'bootstrap.webhooks',
    );
  }

  const notifier = await createRuntimeNotifier(services.serviceRegistry, (key) => readAgentHostSetting(configManager, key));
  runtimeUnsubs.push(
    syncTerminalNotifierQueues(notifier, domainDispatch, () => {
      notifier.attachToRuntimeBus(runtimeBus);
      return () => notifier.detach();
    }),
  );

  await syncConfiguredServices(domainDispatch.syncIntegration, services.serviceRegistry);

  // The permission gate is the graph's. services.permissionManager rides the
  // client raiser: the ask is posted to the daemon AND prompted here, and the
  // first real answer wins. The background-agent attribution that feeds the
  // fleet plane's `state: 'awaiting-approval'` is carried by the shared free
  // function the manager is built through, not by a local copy of that
  // mapping.
  const permissionManager = composeAgentPermissionManager(services);
  // Wire permissionManager into the SAME AgentOrchestrator instance that runs
  // spawned/background agent tool calls (services.agentOrchestrator, set up
  // above with agentOrchestratorToolDeps before permissionManager existed).
  // Without this, the SDK's gateBackgroundToolCall() sees no permissionManager
  // on context and leaves every background tool call ungated, spawned agents
  // would run with no permission check at all, regardless of permissions.mode
  // or permissions.backgroundAgents. Replays the full toolDeps object because
  // setDependencies() replaces rather than merges.
  services.agentOrchestrator.setDependencies({ ...agentOrchestratorToolDeps, permissionManager });
  await hookWorkbench.loadAndApplyManagedHooks();

  const runtime: MutableRuntimeState = {
    ...initialTerminalRuntimeFields(
      configManager,
      getProviderIdFromModel,
      () => loadBootstrapSystemPrompt(configManager) || getConfiguredSystemPrompt(configManager) || '',
    ),
    sessionId: userSessionId,
  };
  runtimeSessionIdRef.value = runtime.sessionId;
  // Register this process's live conversation so the composed daemon's
  // rewind.plan/apply verbs can serve conversation scope for this session
  // (see conversation-rewind-port.ts and services.ts's conversationRewindPort
  // wiring). Ported from goodvibes-tui's identical bootstrap-time call.
  registerSessionConversation(runtime.sessionId, conversation);
  // This process is now HOSTING that session. Four seams read this and nothing
  // else: inbound continuation dispatch polls it, the conversation-rewind host
  // answers "am I holding this?" from it, the trigger family's liveness check
  // reads it, and both "is anything busy" consumers count turns against it.
  services.hostedSessions.adopt(runtime.sessionId);
  // Offer this session's conversation to the daemon, and answer the questions it
  // asks about it. Without this a rewind touching a session hosted here got the
  // daemon's own empty registry answering "0 messages to drop", a confident
  // answer to a question it could not reach. Released at shutdown; a lapsed
  // lease reaches the same end state if this process dies first.
  services.conversationRewindHost.start(runtime.sessionId);
  void sharedSessionBroker
    .createSession({
      id: runtime.sessionId,
      // The record's IDENTITY axis, and it has to be said out loud here.
      //
      // This call named neither `kind` nor `project`, so the broker fell back to
      // its documented defaults for an ungrounded create: `classifySessionOriginKind`
      // (session-broker-sessions.ts) maps a non-channel surface, this one is
      // 'service', to 'tui', and project defaults to 'unknown'. The local mirror
      // at ~/.goodvibes/agent/control-plane/sessions.json therefore filed every
      // agent session as kind:"tui" project:"unknown", while the spine
      // registration twenty lines below correctly filed the SAME session as
      // kind:'agent' with its real project. Two stores describing one session and
      // disagreeing about what it is: a fleet listing filtered on kind:"agent"
      // missed this process's own sessions, and one filtered on kind:"tui" claimed
      // terminal sessions that were never opened.
      //
      // The default was never wrong for what it knew, it is a fallback for a
      // caller that says nothing. Saying it is this call site's job.
      kind: 'agent',
      project: workingDir,
      title: 'GoodVibes Agent session',
      // Declares the session permission mode at creation time in the shared
      // metadata bag (safe-owner, safe-jev, yolo, or the read-only plan posture).
      // Read-only declaration, the execution owner
      // itself always reads permissions.mode live off configManager, so this
      // does not change enforcement; it lets cross-session tooling see which
      // mode a session started under without re-deriving it.
      metadata: { source: 'goodvibes-agent', permissionMode: configManager.get('permissions.mode') },
      participant: {
        surfaceKind: 'service',
        surfaceId: 'surface:goodvibes-agent',
        displayName: 'GoodVibes Agent',
        lastSeenAt: Date.now(),
      },
    })
    .catch((err) => {
      logger.debug('session broker create session failed at bootstrap', { err });
    });

  // Mirror the create into the daemon spine (fire-and-forget; the local
  // broker above stays the source of truth). kind:'agent' is the canonical record
  // identity; participant.surfaceKind stays 'service' (the TRANSPORT axis).
  services.sessionSpineClient.register({
    sessionId: runtime.sessionId,
    project: workingDir,
    title: 'GoodVibes Agent session',
  });
  // Debounced heartbeat off turn activity, coalesced to one wire call per window,
  // no title, reopen:false. Uses the ref so a resumed session id is followed.
  runtimeUnsubs.push(
    uiServices.events.turns.on('TURN_SUBMITTED', () => services.sessionSpineClient.heartbeat(runtimeSessionIdRef.value)),
    uiServices.events.turns.on('TURN_COMPLETED', () => services.sessionSpineClient.heartbeat(runtimeSessionIdRef.value)),
  );

  // The public client runtime already publishes PRESET_CHANGED for live settings.

  seedTerminalSession(domainDispatch, userSessionId, workingDir);

  runtimeUnsubs.push(
    ...registerBootstrapHookBridge({
      runtimeBus,
      hookDispatcher,
      runtime,
    }),
  );

  return {
    userSessionId,
    runtimeBus,
    store,
    services,
    uiServices,
    conversation,
    compositor,
    selection,
    toolRegistry,
    fileCache,
    projectIndex,
    permissionManager,
    forensicsCollector,
    forensicsRegistry,
    runtime,
    bootstrapUnsubs,
    runtimeUnsubs,
    agentStatusIntervalRef,
    permissionPromptRef,
    systemMessageRouterRef,
    conversationFollowUpRef,
    orchestratorHandleUserInputRef,
    requestRender,
    setRenderRequest: (fn) => {
      renderRequestRef.value = fn;
    },
    runtimeSessionIdRef,
  };
}
