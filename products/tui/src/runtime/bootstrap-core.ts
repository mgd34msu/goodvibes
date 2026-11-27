import { REGULAR_KNOWLEDGE_DB_FILE, prepareConfiguredProjectContext } from '@goodvibes/engine/platform/platform/knowledge';
import { declareUnmarkedWorkIsOwners } from '@goodvibes/engine/platform/platform/security';
import { onProgramRegistrationRefused, programVerificationNotice } from '@goodvibes/engine/platform/platform/runtime/client';import { initialTerminalRuntimeFields } from '@goodvibes/engine/terminal-shell/bootstrap-primitives';
import { projectAgentToolDependencies } from '@goodvibes/engine/terminal-shell/bootstrap-command-context';
import {
  createTerminalFeatureFlags,
  disposeTerminalFeatureFlags,
  createTerminalEventState,
  initializeTerminalMemory,
  seedTerminalSession,
} from '@goodvibes/engine/terminal-shell/bootstrap-primitives';
import {
  initializeTerminalCatalog,
  seedTerminalControlPlane,
  attachTerminalRuntimeBindings,
} from '@goodvibes/engine/terminal-shell/bootstrap-runtime-bindings';
import { createTerminalRenderScheduler } from '@goodvibes/engine/terminal-shell/render-scheduler';
import { createTuiTurnPermissionManager, registerTuiTurnTools, terminalSettingsToolProgram } from './turn-tool-composition.ts';
import { terminalOwnerQuestions, wireOwnerQuestionSessions } from './client/owner-questions.ts';
import { readDaemonOperatorToken } from './daemon-operator-token.ts';
import { ConversationManager } from '../core/conversation';
import { createShellNoticeSink } from './notification-dispatch.ts';
import { getSharedNotificationFeed } from '../views/notifications-feed.ts';
import { registerSessionConversation, unregisterSessionConversation } from './conversation-rewind-port.ts';
import { noSandboxStartupLine, SelectionManager } from '@goodvibes/engine/terminal-shell';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { getConfiguredSystemPrompt } from '@goodvibes/engine/platform/platform/config';
import { installCloudflareAccessFetch } from '@goodvibes/engine/platform/platform/cloudflare';
import { getProviderIdFromModel } from '@goodvibes/engine/platform/platform/providers/provider-model';
import { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { registerAllTools } from '@goodvibes/engine/platform/platform/tools';
import { createSandboxContainmentNotice } from './daemon-attach-notices.ts';
import type { PermissionManager } from '@goodvibes/engine/platform/platform/permissions';
import { Compositor } from '../renderer/compositor.ts';
import { activeTokens } from '../renderer/theme.ts';
import type { PermissionRequestHandler } from '@goodvibes/engine/platform/platform/permissions';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { ConversationFollowUpItem } from '@goodvibes/engine/platform/platform/core';
import type { BootstrapOptions } from './context.ts';
import { type RuntimeStore } from '@goodvibes/engine/platform/platform/runtime/state';
import {
  type MutableRuntimeState,
  RuntimeEventBus,
  ForensicsCollector,
  ForensicsRegistry,
  generateUserSessionId,
  loadBootstrapSystemPrompt,
  syncConfiguredServices,
  registerBootstrapHookBridge,
  registerBootstrapRuntimeEvents,
} from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from './services.ts';
import { registerClientPhoneTool, setProgramCallContext } from '@goodvibes/engine/platform/platform/runtime/client';
import { shortCheckpointId } from '@goodvibes/engine/terminal-shell/recovery-commands';
import { createHostPowerSeam } from '@goodvibes/engine/platform/platform/power';
import { createUiRuntimeServices, type UiRuntimeServices } from './ui-services.ts';
import { join } from 'node:path';
import type { SystemMessagePriority } from '../core/system-message-router.ts';
import { SessionSpineClient, SessionUnionCache, TUI_SPINE_PARTICIPANT } from '@goodvibes/engine/platform/platform/runtime/session-spine';
import { SessionInboundInputPoller, createBootstrapInboundInputPoller } from '@goodvibes/engine/terminal-shell/session-inbound-inputs';
import { handOverLiveSession } from '@goodvibes/engine/terminal-shell/session-handover';
import type { OwnerInputRoute } from '@goodvibes/engine/terminal-shell/companion-input';
import { repositoryTrustNotice, type WorkspaceTrustLevel } from '@goodvibes/engine/platform/platform/runtime/operations';
import { HooksFileAwaitingTrustError } from '@goodvibes/engine/platform/platform/hooks';
import { attachRuntimeNotifications } from '@goodvibes/engine/platform/platform/integrations';
import { programNotices } from '@goodvibes/engine/terminal-shell/places';

// --- Pre-router buffer ---

const PRE_ROUTER_BUFFER_MAX = 100;

type BufferedStartupMessage = {
  readonly message: string;
  readonly priority: SystemMessagePriority;
};

/**
 * Small bounded queue that accumulates startup system messages emitted before
 * the SystemMessageRouter is attached. On attach the queue flushes in order.
 * If the queue overflows (> PRE_ROUTER_BUFFER_MAX), the oldest entries are
 * dropped and a summary message is prepended to the first flushed message.
 */
export class StartupNoticeBuffer {
  private readonly queue: BufferedStartupMessage[] = [];
  private overflowCount = 0;

  push(message: string, priority: SystemMessagePriority): void {
    if (this.queue.length >= PRE_ROUTER_BUFFER_MAX) {
      this.queue.shift();
      this.overflowCount++;
    }
    this.queue.push({ message, priority });
  }

  flush(router: import('../core/system-message-router.ts').SystemMessageRouter): void {
    const dropped = this.overflowCount;
    const pending = this.queue.splice(0);
    this.overflowCount = 0;
    if (dropped > 0) {
      router.routeSystemMessage(
        `[Startup] Pre-router buffer overflowed: ${dropped} earliest message${dropped !== 1 ? 's' : ''} were dropped`,
        'low',
      );
    }
    for (const item of pending) {
      router.routeSystemMessage(item.message, item.priority);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}

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
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler };
  readonly trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> }; // trust-at-consequence-time bridge, patched with the real modal-driving impl once the UI layer exists
  readonly systemMessageRouterRef: { value: SystemMessageRouter | null };
  readonly conversationFollowUpRef: { value: ((item: ConversationFollowUpItem) => void) | null };
  /**
   * Mutable ref patched by bootstrap.ts after the Orchestrator is constructed:
   * the path an input another surface queued for this session (the web app, the
   * companion app, a channel) takes into the conversation as a real turn.
   */
  readonly orchestratorHandleUserInputRef: { value: OwnerInputRoute | null };
  readonly requestRender: () => void;
  readonly setRenderRequest: (fn: () => void) => void;
  readonly runtimeSessionIdRef: { value: string };
  /** Cross-surface identity mirror; dormant for local-only, and for the platform's 'embedded' HostServiceMode, which no product-facing setting can select, this product only ever adopts an external daemon or runs local-only (see the ADOPT ONLY guard in bootstrap.ts) (docs/decisions/2026-07-06-session-spine-mode-branch-is-permanent.md). Activated by bootstrap.ts only for an adopted 'external' daemon. */
  readonly sessionSpine: SessionSpineClient;
  /** Inbound steer/follow-up delivery; dormant until bootstrap.ts activates it. */
  readonly sessionInboundInputs: SessionInboundInputPoller;
  /** Cache-backed read facade; bootstrap.ts drives its mode (external/local-only in this product, 'embedded' is a HostServiceMode value with no product-facing setting to select it here) from the same HostServiceMode as the spine above. */
  readonly sessionUnionCache: SessionUnionCache;
}


export async function initializeBootstrapCore(
  stdout: NodeJS.WriteStream,
  options: BootstrapOptions,
): Promise<BootstrapCoreState> {
  const workingDir = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const configManager = options.configManager;
  // This program is the person at their own keyboard: work in it that no turn or mark names is theirs (unknown is someone
  // else's everywhere else, the daemon included: security/turn-input-party.ts).
  declareUnmarkedWorkIsOwners();
  await prepareConfiguredProjectContext(configManager, workingDir, REGULAR_KNOWLEDGE_DB_FILE, { activate: true });

  // Gate states derive from the domain settings keys; the bridge keeps live
  // config writes flowing (honest pending-restart markers for startup-gated
  // features). Mirrors the platform composition root's owned-manager wiring.
  const featureFlags = createTerminalFeatureFlags(configManager);

  const userSessionId = `user-${generateUserSessionId()}`;
  const { runtimeBus, store, domainDispatch } = createTerminalEventState(configManager);
  let getConversationTitle = (): string | undefined => undefined;
  let ownerConversationMessages = (_sessionId: string): readonly object[] | undefined => undefined;
  const services = createRuntimeServices({
    configManager,
    featureFlags,
    runtimeBus,
    runtimeStore: store,
    getConversationTitle: () => getConversationTitle(),
    // A contract this session starts mid-turn sees the reads already in the
    // conversation, not only the ones the session file has caught up with.
    ownerConversationMessages: (sessionId) => ownerConversationMessages(sessionId),
    workingDir,
    homeDirectory,
    ...(options.daemonHomeDirectory === undefined ? {} : { daemonHomeDirectory: options.daemonHomeDirectory }),
    // This product only ever adopts an external daemon (or runs local-only), never embedding one,
    // so it holds its own OS inhibitor (fork default is non-spawning) and owns the wake-model boot retry itself. See services.ts.
    powerSeam: createHostPowerSeam(),
    provisionWakeModelsAtBoot: true,
  });
  await services.workspaceTrustManager.load(); // settle any already-persisted trust decision before any tool runs
  const providerRegistry = services.providerRegistry;
  let keybindingNotices: readonly string[] = [];
  initializeTerminalCatalog(providerRegistry, services.benchmarkStore, () => { keybindingNotices = services.keybindingsManager.loadFromDisk(); });
  seedTerminalControlPlane(domainDispatch, configManager);

  const { approvalBroker, hookDispatcher, hookWorkbench, memoryStore, sessionBroker: sharedSessionBroker } = services;
  // Dormant for local-only, and for the platform's 'embedded' HostServiceMode, no product-facing
  // setting can select it (platform-internal embedder/test machinery); bootstrap.ts activates this spine only for an adopted 'external' daemon.
  const sessionSpine = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui' });
  // Cache-backed read facade over the local broker (passthrough until bootstrap.ts
  // activates the adopted-daemon wire union for 'external').
  // selfSessionIds keeps local authoritative for our own wire-mirrored session even when local/wire ids diverge (D-TUI-1).
  const sessionUnionCache = new SessionUnionCache({ local: sharedSessionBroker, selfSessionIds: () => sessionSpine.mirroredSessionIds });

  const stopRuntimeBindings = attachTerminalRuntimeBindings(services, runtimeBus, store, configManager);

  const forensicsRegistry = new ForensicsRegistry();
  const forensicsCollector = new ForensicsCollector(runtimeBus, forensicsRegistry);
  const uiServices = createUiRuntimeServices(services, {
    forensicsRegistry,
    sessionUnionCache,
  });

  const conversation = new ConversationManager(() => stdout.columns || 80);
  conversation.setConfigManager(configManager);
  // Every system notice is a notification-history entry, full text
  // (core/notices.ts); the transcript draws none of them and nothing is drawn
  // over the conversation: the status bar counts the unread ones (ctrl+n).
  // One history entry per event: see createShellNoticeSink.
  conversation.setNoticeSink(createShellNoticeSink(getSharedNotificationFeed()));
  getConversationTitle = () => conversation.title;

  const compositor = new Compositor(stdout);
  const selection = new SelectionManager();

  // Declared before the tool composition: its `resolveSessionId` reads it.
  const runtimeSessionIdRef = { value: userSessionId };
  ownerConversationMessages = (sessionId) => sessionId === runtimeSessionIdRef.value ? conversation.readMessagesInPlace() : undefined;

  const toolRegistry = new ToolRegistry();
  const { fileCache, projectIndex, dispose: disposeTurnTools } = registerTuiTurnTools(toolRegistry, services, {
    // `permissionManager` is created further down; the gate only runs when a model asks to change a hook, long after bootstrap.
    hookChangeGate: (request, { signal }) => permissionManager.checkHookChange(request, { signal }),
    resolveSessionId: () => runtimeSessionIdRef.value,
    ...(options.toolServersOnFirstUse ? { toolServersOnFirstUse: true } : {}),
    onSandboxedRun: createSandboxContainmentNotice({
      configManager,
      notify: (text) => conversation.log(`[Sandbox] ${text}`, { fg: activeTokens().secondary }),
    }),
  });
  registerClientPhoneTool(toolRegistry, services.devices, { sessionId: () => runtimeSessionIdRef.value }); // the `phone` tool follows the LOOP, so it is registered here; the posture runtime it used to call is the daemon's now and this tool reaches it over the devices.* verbs (see the platform's client/phone-tool.ts)
  services.agentOrchestrator.setDependencies({
    ...projectAgentToolDependencies({ services, fileCache, projectIndex, configManager }),
    // This program runs no contracts (its work runs on the daemon): its agents have no contract hooks.
    ...(services.contractRunner ? { contractHooks: services.contractRunner.hooks() } : {}),
    surfaceRoot: services.surface.surfaceRoot,
    knowledgeService: services.knowledgeService,
    cloudflareAuthToken: () => readDaemonOperatorToken(services.shellPaths.homeDirectory),
    // A spawned agent asks the owner in the same inbox; the answer comes back to this conversation.
    ownerQuestions: () => terminalOwnerQuestions(services, () => runtimeSessionIdRef.value),
    // A spawned agent's settings tool reaches the daemon the way this program's own turns do (and the Agent's).
    ...terminalSettingsToolProgram(services),
  });

  const bootstrapUnsubs: Array<() => void | Promise<void>> = [];
  // A saved session is handed the owner's answers that waited for it when it is opened; deleting it settles its questions.
  bootstrapUnsubs.push(wireOwnerQuestionSessions(services, conversation, () => runtimeSessionIdRef.value));
  // Every checkpoint this program takes (its turns, its agents' runs) records this program's live session, so a
  // restore elsewhere can say whose change it takes back.
  services.workspaceCheckpointManager.setSessionResolver(() => runtimeSessionIdRef.value || undefined);
  // A change of this session that another session's restore took back is said here, at this session's next turn:
  // a line in the conversation, and the model is told with that turn's first request.
  bootstrapUnsubs.push(services.workspaceCheckpointManager.followTakenBack(() => runtimeSessionIdRef.value,
    (line, forModel) => {
      conversation.addWorkspaceNotice(line);
      conversation.hostInstructions.set('workspace', forModel, { once: true, append: true });
    }, shortCheckpointId));
  bootstrapUnsubs.push(stopRuntimeBindings);
  bootstrapUnsubs.push(disposeTurnTools);
  bootstrapUnsubs.push(() => disposeTerminalFeatureFlags(featureFlags));
  bootstrapUnsubs.push(() => conversation.setNoticeSink(null));
  await initializeTerminalMemory(memoryStore, bootstrapUnsubs);

  const {
    renderRequestRef,
    requestRender,
    dispose: disposeRenderScheduler,
  } = createTerminalRenderScheduler({
    afterRender: () => sessionSpine.heartbeat(runtimeSessionIdRef.value),
    onError: (error, _delayed) => logger.error('Render threw; next requestRender will reschedule', { error: String(error) }),
  });
  bootstrapUnsubs.push(disposeRenderScheduler);
  // THE ref, not a second one: the composition already holds the prompt seam its
  // client approval raiser calls, so the UI layer patching this patches that.
  const permissionPromptRef = services.localPromptRef as { requestPermission: PermissionRequestHandler };
  // Trust-at-consequence-time: raised by trustGatedAsk on the first non-read
  // request in an undecided workspace; overridden once the UI layer exists, same ref-patching pattern as permissionPromptRef above.
  const trustPromptRef = services.trustPromptRef;
  approvalBroker.start().catch((err) => logger.warn('approval broker start failed at bootstrap', { err }));
  sharedSessionBroker.start().catch((err) => logger.warn('shared session broker start failed at bootstrap', { err }));
  const startupNoticeBuffer = new StartupNoticeBuffer();
  // A keybindings file that was skipped or overridden would otherwise leave a shortcut silently doing nothing.
  for (const notice of keybindingNotices) startupNoticeBuffer.push(`[Startup] ${notice}`, 'high');
  // A decision log that had to start empty after damage is said on screen, not only in the log file.
  if (services.judgment.decisionLogNotice) startupNoticeBuffer.push(`[Startup] ${services.judgment.decisionLogNotice}`, 'high');
  // Where this computer cannot prove the program to the daemon: said once, in one sentence.
  const unverifiedNotice = programVerificationNotice();
  if (unverifiedNotice) startupNoticeBuffer.push(`[Security] ${unverifiedNotice}`, 'high');
  // Where the daemon could not verify this program (something loaded into it): said on screen, with what to do.
  onProgramRegistrationRefused((why) => startupNoticeBuffer.push(`[Security] ${why}`, 'high'));  // Smart ref: setting .value auto-flushes the pre-router buffer so events
  // buffered before the SystemMessageRouter attaches are not permanently lost.
  const systemMessageRouterRef = ((): { value: SystemMessageRouter | null } => {
    let _value: SystemMessageRouter | null = null;
    const ref = {} as { value: SystemMessageRouter | null };
    Object.defineProperty(ref, 'value', {
      get(): SystemMessageRouter | null {
        return _value;
      },
      set(router: SystemMessageRouter | null): void {
        _value = router;
        if (router && startupNoticeBuffer.size > 0) {
          startupNoticeBuffer.flush(router);
          requestRender();
        }
      },
      enumerable: true,
      configurable: true,
    });
    return ref;
  })();
  const conversationFollowUpRef: { value: ((item: ConversationFollowUpItem) => void) | null } = { value: null };
  const { unsubs: runtimeUnsubs } = registerBootstrapRuntimeEvents({
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter: () => systemMessageRouterRef.value,
    queueConversationFollowUp: (item) => conversationFollowUpRef.value?.(item),
    requestRender,
    agentManager: services.agentManager,
    // This program runs no contracts: none are read, so no contract event is announced here.
    contractRunner: services.contractRunner ?? { get: () => null, list: () => [] },
  });

  const routeOrBuffer = (message: string, priority: SystemMessagePriority): void => {
    const router = systemMessageRouterRef.value;
    if (router) router.routeSystemMessage(message, priority);
    else startupNoticeBuffer.push(message, priority);
  };
  // With no working sandbox, said once at start: what a model's command can then reach, and the control that turns
  // the sandbox on (no-sandbox-notice.ts).
  void noSandboxStartupLine(configManager.get('sandbox.enabled')).then((line) => { if (line) routeOrBuffer(line, 'high'); })
    .catch((error: unknown) => logger.warn('the no-sandbox notice could not be read', { error: String(error) }));

  // Startup TLS banner, emitted via startupNoticeBuffer.push() because the
  // SystemMessageRouter is not attached yet at this point in bootstrap. The
  // smart-ref setter on systemMessageRouterRef auto-flushes the buffer when
  // the router attaches, so the message will appear in the conversation on startup.
  {
    // controlPlane.enabled: other machines are served (only then can traffic cross the network).
    const cpServesOtherMachines = Boolean(configManager.get('controlPlane.enabled'));
    const cpHostMode = String(configManager.get('controlPlane.hostMode') ?? 'local');
    const cpTlsMode = String(configManager.get('controlPlane.tls.mode') ?? 'off');
    const hlEnabled = Boolean(configManager.get('danger.httpListener'));
    const hlHostMode = String(configManager.get('httpListener.hostMode') ?? 'local');
    const hlTlsMode = String(configManager.get('httpListener.tls.mode') ?? 'off');
    const cpNetworkPlaintext = cpServesOtherMachines && cpHostMode !== 'local' && cpTlsMode === 'off';
    const hlNetworkPlaintext = hlEnabled && hlHostMode !== 'local' && hlTlsMode === 'off';
    if (cpNetworkPlaintext || hlNetworkPlaintext) {
      const affected: string[] = [];
      const settings: string[] = [];
      // The rows of Devices and network, Addresses and ports (terminal-shell places/devices-place.ts).
      if (cpNetworkPlaintext) { affected.push('the daemon'); settings.push('"Daemon encryption"'); }
      if (hlNetworkPlaintext) { affected.push('the webhook receiver'); settings.push('"Webhooks encryption"'); }
      startupNoticeBuffer.push(
        `[Security] Other devices can reach ${affected.join(' and ')} without encryption: passwords, keys and your conversations travel in plain text. Turn on ${settings.join(' and ')} in the menu: Devices and network, Addresses and ports; or keep GoodVibes to this computer: System, Setup, "Only this computer".`,
        'high',
      );
    }
  }

  // bootstrap.ts patches orchestratorHandleUserInputRef.value after the Orchestrator
  // is constructed. Inputs another surface queued for this session (a steer from
  // the web app, a companion or ntfy message, sent by the daemon as follow-ups)
  // are collected by the inbound poller and run through it as real turns.
  const orchestratorHandleUserInputRef: {
    value: OwnerInputRoute | null;
  } = { value: null };

  // Inbound steer and follow-up delivery, see createBootstrapInboundInputPoller's doc comment.
  const inboundInputs = createBootstrapInboundInputPoller({
    runtimeSessionIdRef,
    narrate: (text) => routeOrBuffer(text, 'low'),
    orchestratorHandleUserInputRef,
    runtimeBus,
    // Another terminal ran `/session resume <id> --force` for this session: save it, let go, say so.
    onHandover: (sessionId) => {
      handOverLiveSession({
        sessionId,
        liveSessionId: () => runtime.sessionId,
        conversation,
        sessionManager: services.sessionManager,
        runtime,
        surface: services.surface,
        notify: (text) => routeOrBuffer(text, 'high'),
      });
    },
  });
  const sessionInboundInputs = inboundInputs.poller;
  runtimeUnsubs.push(inboundInputs.dispose);

  providerRegistry.startWatching(runtimeBus);

  // A workstream's start and ask come from its own record, so one started
  // before a restart is still announced by its request and real duration.
  const runtimeNotifications = {
    lookupContract: (contractId: string) => {
      const contract = services.contractRunner?.get(contractId);
      return contract ? { startedAt: contract.createdAt, name: contract.ask } : undefined;
    },
  };
  // This program's agents and work that end are announced through the daemon: its one webhook list and its Slack and
  // Discord notifier; a notice that fails lands in the daemon's failed list (program-notices.ts). This program keeps
  // no notifier and no failed list of its own.
  runtimeUnsubs.push(attachRuntimeNotifications(runtimeBus, (delivery, event) => programNotices.sendNotification(delivery, event), runtimeNotifications));

  // Requests to the daemon's Access-protected Cloudflare hostname present the
  // stored Access service token, so turning Access on does not lock this app out.
  runtimeUnsubs.push(installCloudflareAccessFetch(configManager, services.secretsManager));

  await syncConfiguredServices(domainDispatch.syncIntegration, services.serviceRegistry);

  const permissionManager = createTuiTurnPermissionManager(services, () => services.requestTrustDecision());
  // A bad hooks file must not stop the product from starting; it runs without file hooks until fixed.
  // One in a workspace the owner has not trusted waits for that trust, and the owner is told once.
  try {
    await hookWorkbench.loadAndApplyManagedHooks();
  } catch (err) {
    if (!(err instanceof HooksFileAwaitingTrustError)) logger.warn('tui hooks file not loaded; continuing without file hooks (non-fatal)', { error: summarizeError(err) });
  }
  void repositoryTrustNotice({
    trust: services.workspaceTrustManager,
    hooksFileWaiting: hookWorkbench.getAwaitingTrust(),
    heldMcpServers: () => services.mcpRegistry.heldForWorkspaceTrust(services.shellPaths),
  }).then((notice) => { if (notice) routeOrBuffer(notice, 'high'); },
    (error: unknown) => { logger.warn('folder trust notice not shown', { error: summarizeError(error) }); });

  const runtime: MutableRuntimeState = {
    ...initialTerminalRuntimeFields(
      configManager,
      getProviderIdFromModel,
      () => loadBootstrapSystemPrompt(configManager) || getConfiguredSystemPrompt(configManager) || '',
    ),
    get sessionId() {
      return runtimeSessionIdRef.value;
    },
    set sessionId(value: string) {
      const previous = runtimeSessionIdRef.value;
      runtimeSessionIdRef.value = value;
      services.liveSessionIdRef.value = value;
      if (value === previous) return;
      domainDispatch.syncSessionState({ conversationSessionId: value }, 'runtime.session-id');
      // The one live conversation moves with the session id (resume, fork,
      // recovery), so a rewind asked from another surface finds the session
      // this terminal is running and never the boot id.
      unregisterSessionConversation(previous);
      registerSessionConversation(value, conversation);
      services.conversationRewindHost.follow(value);
    },
  };
  runtimeSessionIdRef.value = runtime.sessionId;
  services.liveSessionIdRef.value = runtime.sessionId; // the session an ask raised on the daemon belongs to
  // This app's call context, carried on every call it makes to the daemon: its project folder and the conversation it
  // holds now (call-context.ts). The daemon never takes its own folder for a call that names none.
  // The registration each daemon it reaches issues it (call-context.ts `programCallHeadersFor`, kept in memory only) tells
  // it apart from the Agent, a command line and a script that hold the same operator token: a remembered answer and a
  // conversation it registered are its own.
  setProgramCallContext({ program: 'tui', project: () => services.shellPaths.workingDirectory, sessionId: () => runtimeSessionIdRef.value });
  // The live conversation, for this process's own /checkpoint rewind AND for the daemon's
  // questions about it, only the process holding the messages can count or
  // drop them (conversation-rewind-port.ts, the platform's client/conversation-rewind-host.ts).
  registerSessionConversation(runtime.sessionId, conversation);
  void sharedSessionBroker
    .createSession({
      id: runtime.sessionId,
      title: 'Terminal UI session',
      metadata: { source: 'tui' },
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'surface:tui',
        displayName: 'Terminal UI',
        lastSeenAt: Date.now(),
      },
    })
    .catch((err) => {
      logger.debug('session broker create session failed at bootstrap', { err });
    });
  // Fire-and-forget spine mirror, a permanent parallel-write posture alongside (never
  // instead of) the still-authoritative local SharedSessionBroker above. Dormant/queued
  // until bootstrap.ts's deferred task activates it for an adopted 'external' daemon.
  sessionSpine.register({ sessionId: runtime.sessionId, project: services.workingDirectory, title: 'Terminal UI session' });

  seedTerminalSession(domainDispatch, userSessionId, workingDir);

  runtimeUnsubs.push(...registerBootstrapHookBridge({ runtimeBus, hookDispatcher, runtime }));

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
    permissionPromptRef,
    trustPromptRef,
    systemMessageRouterRef,
    conversationFollowUpRef,
    orchestratorHandleUserInputRef,
    requestRender,
    setRenderRequest: (fn) => {
      renderRequestRef.value = fn;
    },
    runtimeSessionIdRef,
    sessionSpine,
    sessionInboundInputs,
    sessionUnionCache,
  };
}
