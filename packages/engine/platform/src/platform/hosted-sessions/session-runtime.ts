import { effectivePermissionMode, isSettableGatePresetName, type GatePresetName } from '../gate/presets.js';
import { currentExecutionModeOwner, withExecutionModeOwner, type ExecutionModeOwner } from '../gate/execution-context.js';
import { emitPresetChanged } from '../runtime/emitters/gate.js';
import { readNativeConversationTurnPermit, type NativeConversationTurnPermit } from '../workflow/work-ledger/native-intake-client.js';
import { readNativeConversationTurnStatus } from '../core/native-turn-admission.js';
/**
 * Each hosted session owns its conversation, orchestrator, tool registry and
 * execution-mode revision. Model providers, permissions and workspace services
 * stay on the shared floor. A session-owned dynamic context selects policy for
 * its turns without mutating daemon configuration or another session's mode.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { ConversationManager } from '../core/conversation.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerAllTools } from '../tools/index.js';
import { registerDevicePhoneTool } from '../devices/device-phone-tool.js';
import { ContextAccountingHolder } from '../tools/context-accounting/index.js';
import { bindSessionContextAccounting } from '../tools/context-accounting/session-source.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import { createApprovalDerivedHandlers } from '../runtime/permissions/permission-composition.js';
import { readSessionContextUsage, type SessionLiveTurnControls } from '../control-plane/routes/session-runtime.js';
import { estimateConversationTokens } from '../core/context-compaction.js';
import type { ModelDefinition } from '../providers/registry.js';
import { withHostedSessionModel } from './model-route.js';
import { HostedSessionUnavailableError } from './errors.js';
import type { HostedWorkspaceFloor } from './workspace-floor.js';
import { createContractIntake } from '../contract/intake-route.js';
import { observeSessionContracts } from './session-contracts.js';
import { registerSessionFollowUps } from '../runtime/bootstrap-runtime-events.js';
import type { HostedDaemonRequestPath, HostedSurfaceTools, HostedSurfaceTurn } from './surface-turn.js';
import { askingQuestions, type QuestionAsker } from '../agents/agent-owner-questions.js';
import type { AgentWorkerSurface } from '../agents/orchestrator.js';
import type { ConfigRoutingOptions } from '../tools/goodvibes-runtime/config-routing.js';
import { watchSessionAnswers, type SessionAnswerWatch } from '../agents/agent-inlets.js';
import { callingAgentId } from '../agents/calling-agent.js';
import type { OwnerInbox } from '../control-plane/owner-inbox.js';
import type { QuestionInbox } from '../tools/query/index.js';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import { getProcessUntrustedContentLedger, withUntrustedContentScope } from '../security/untrusted-content.js';
import {
  containmentFor,
  resolveHostedExecPosture,
  type HostedSessionExecPosture,
} from './exec-posture.js';

/**
 * Where a hosted session's client-owned settings live, when the session belongs
 * to a surface other than the host.
 *
 * Returns null when the session IS the host's own, the host's ConfigManager is
 * then already the right answer, and null when the host has no home directory
 * to resolve a sibling surface against, which is the honest outcome rather than
 * inventing a path. A hosted session on a host with no home keeps the host's
 * store, exactly as it did before, instead of writing somewhere nobody reads.
 *
 * Deliberately a PATH and not a ConfigManager: constructing a manager for
 * another surface runs that surface's load migrations and shared-config
 * bootstrap. That is a non-owner rewriting a store it does not own, the very
 * class of defect this is here to close, and it would be self-defeating to
 * reintroduce it while fixing it.
 */
function resolveClientOwnedStore(
  services: HostedWorkspaceFloor['services'],
  originSurface: string,
): { readonly surface: string; readonly settingsPath: string } | null {
  if (originSurface === services.surfaceRoot) return null;
  const home = services.configManager.getHomeDirectory();
  if (!home) return null;
  return {
    surface: originSurface,
    settingsPath: resolveSurfaceDirectory(home, originSurface, 'settings.json'),
  };
}

/** What a hosted session's loop is composed with. */
export interface HostedSessionRuntimeOptions {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly floor: HostedWorkspaceFloor;
  readonly permissionMode?: GatePresetName | undefined;
  /**
   * Whether the host still holds the session behind a keyed tool-state file
   * (by file-name token). Omitted, those files are never reclaimed.
   */
  readonly isSessionResumable?: ((sessionToken: string) => boolean) | undefined;
  readonly permissionModeChanged?: ((mode: GatePresetName) => Promise<void>) | undefined;
  /**
   * The base system prompt for this session's turns. The orchestrator appends
   * the runtime-awareness block itself, so this is the product's own operator
   * policy and nothing more.
   */
  readonly systemPrompt: string;
  /**
   * This session's model, already resolved against the live registry (see
   * model-route.ts). Omitted ⇒ the session follows the shared registry's
   * current selection, exactly as a terminal does.
   */
  readonly model?: ModelDefinition | undefined;
  /**
   * The surface this session was created FOR, `agent`, `tui`, `webui`.
   *
   * A hosted session is composed inside the host, and it used to take the host's
   * identity with it. That is wrong in a way that is invisible until it costs a
   * session: an agent conversation hosted by a `tui`-rooted floor resolved every
   * client-owned setting against the TUI's store, so enabling the wake word
   * changed the TUI and reported success to a user who was talking to the agent.
   *
   * Omitted ⇒ the host's own surface, which is right only when the host created
   * the session for itself.
   */
  readonly originSurface?: string | undefined;
  /** The daemon's bearer token, read live; the context tool's Cloudflare status counts it as the Worker operator token. */
  readonly cloudflareAuthToken?: (() => string | null) | undefined;
  /**
   * The owner inbox: the session's `query` tool asks there and the answer comes back into this conversation on
   * its next model request; answered while the session is closed, it is taken when the session is next opened.
   * Absent: no `query`.
   */
  readonly ownerQuestions?: HostedOwnerQuestions | undefined;
  /**
   * What this run's exec tool may do, when the caller decides per session
   * rather than per floor. Omitted ⇒ the floor's own decider, and
   * `conversational` when the floor states nothing either (exec-posture.ts).
   */
  readonly execPosture?: HostedSessionExecPosture | undefined;
  /**
   * What the engine keeps about the contracts this session starts
   * (session-contracts.ts): the record's list, and a notice when the session
   * says a contract's question or outcome. Omitted, the session still says
   * them in its conversation and lists nothing.
   */
  readonly contracts?: HostedSessionContractSink | undefined;
  /**
   * The origin surface's own turn (surface-turn.ts): its tools join the
   * platform's in this session's registry, and each model request's system
   * prompt is composed by it, with `systemPrompt` as its base. Omitted ⇒ the
   * platform tools and `systemPrompt` as it is.
   */
  readonly surfaceTurn?: HostedSurfaceTurn | undefined;
  /** The daemon's own request path, handed to the surface turn's tools. */
  readonly daemonRequests?: HostedDaemonRequestPath | undefined;
  /**
   * Whether a client is attached to this session now, read when a turn's
   * command stops on a terminal prompt or fetches localhost: attached, the
   * person there is asked. Omitted ⇒ no one is attached.
   */
  readonly attended?: (() => boolean) | undefined;
}

/** The engine's side of a session's contracts. */
export interface HostedSessionContractSink {
  /** The contracts the session's record lists now. */
  contractIds(): readonly string[];
  /** A contract was created under this session. */
  started(contractId: string): void;
  /** The session said a contract's question or outcome in its conversation. */
  said(line: string): void;
}

/**
 * A composed hosted session. Everything a caller needs to drive one turn, read
 * its history, and take it apart again.
 */
export interface HostedSessionRuntime {
  readonly sessionId: string;
  readonly conversation: ConversationManager;
  readonly toolRegistry: ToolRegistry;
  readonly orchestrator: Orchestrator;
  /** The per-call cancel / queued-message surface the session verbs act on. */
  readonly liveTurnControls: SessionLiveTurnControls & {
    getPermissionMode(): GatePresetName;
    setPermissionMode(mode: GatePresetName): Promise<void>;
  };
  /** True while a turn is in flight. */
  isRunning(): boolean;
  /**
   * Submit a user message. Resolves when this message's own turn has ended,
   * including a message queued behind a running turn. Rejects when the session
   * is shut down before the message is delivered, so the caller never records
   * an unanswered message as consumed. `operatorInput` says an authenticated
   * operator sent it (not a channel, schedule or other automation), which is
   * what starts a new untrusted-content turn for this session.
   * `answersContractQuestion` (an open escalation id of this session's
   * contracts) sends the message to that contract as the owner's answer.
   */
  submit(text: string, correlationId?: string, options?: { readonly operatorInput?: boolean | undefined; readonly answersContractQuestion?: string | undefined }): Promise<void>;
  /** Dedicated native delivery; refuses queue acceptance and requires actual completion. */
  submitNative(permit: NativeConversationTurnPermit, inputId: string, correlationId: string): Promise<void>;
  /** Interrupt the in-flight turn. Returns whether one was running. */
  cancel(): boolean;
  cancelNative(permit: NativeConversationTurnPermit): boolean;
  dispose(): void;
}

/** Compose one hosted session's loop over an already-acquired workspace floor. */
export function createHostedSessionRuntime(options: HostedSessionRuntimeOptions): HostedSessionRuntime {
  const services = options.floor.services;
  let permissionMode = options.permissionMode ?? effectivePermissionMode(services.configManager.get('permissions.mode'), services.configManager.get('behavior.autoApprove') === true);
  let modeRevision = 0;
  let permissionModePersisted = true;
  let pendingModeWrite: Promise<void> | undefined;
  let disposed = false;
  const assertModeLive = (): void => { if (disposed) throw new Error('Hosted execution mode owner is disposed'); };
  const modeOwner: ExecutionModeOwner = {
    getMode() { assertModeLive(); return permissionMode; },
    getRevision() { assertModeLive(); return modeRevision; },
  };
  const originSurface = options.originSurface?.trim() || services.surfaceRoot;
  const clientOwnedStore = resolveClientOwnedStore(services, originSurface);
  const configRouting: ConfigRoutingOptions = { hostsDaemon: true, ...(clientOwnedStore ? { clientOwnedStore } : {}) };
  const sessionId = options.sessionId;
  // This session's own untrusted-content window. Every turn runs inside it, so
  // what its tools read is recorded under it and its outward actions are judged
  // against it alone: another session's pages never count against this one's
  // sends. The window opens empty when the loop is composed.
  const contentScope = hostedSessionContentScope(sessionId);
  const ledger = getProcessUntrustedContentLedger();
  withUntrustedContentScope(contentScope, () => ledger.startTurn());
  const conversation = new ConversationManager();
  const toolRegistry = new ToolRegistry();
  const contextAccountingHolder = new ContextAccountingHolder();

  // Per-session selection over the ONE shared registry (model-route.ts): every
  // mutation still lands on the shared instance; only `getCurrentModel` differs.
  const providerRegistry = options.model
    ? withHostedSessionModel(services.providerRegistry, options.model)
    : services.providerRegistry;

  const promptLifetime = new AbortController();
  const autonomousHost = { port: services.judgment.port, permissionManager: services.permissionManager,
    config: services.configManager, signal: promptLifetime.signal, workspaceTrust: services.workspaceTrust };
  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(services.configManager));
  const approvalHandlers = createApprovalDerivedHandlers({
    autonomousHost,
    requestApproval: services.requestApproval,
    configManager: services.configManager,
    featureFlags: services.featureFlags,
    announcementStore,
    attended: options.attended,
    permissionMode: () => permissionMode,
  });

  const inbox = options.ownerQuestions;
  // The owner's answer to this session's question rides its next model request; one given while the
  // session was closed waited in the store and is read once here, as the session is opened again.
  const answers = inbox ? watchSessionAnswers(conversation, () => sessionId) : null;
  answers?.open(sessionId);
  // An agent one of this session's turns starts runs under this session's mode owner; its questions come back here once it stops.
  hostedTurnSessions.set(modeOwner, sessionId);
  // A worker this session's turns spawn is built for this session's surface, as
  // that surface's own process builds its workers, with this session's routing.
  const decorateWorkerRegistry = options.surfaceTurn?.decorateWorkerRegistry;
  if (decorateWorkerRegistry) {
    hostedWorkerSurfaces.set(modeOwner, Object.freeze({
      id: originSurface,
      surfaceRoot: originSurface,
      configRouting,
      ...(options.surfaceTurn?.platformToolAdmission ?? {}),
      decorateRegistry: decorateWorkerRegistry,
    }));
  }
  if (answers) hostedSessionWatches.set(sessionId, answers);
  const ownerQuestions = inbox && answers
    ? askingQuestions(inbox, () => ({ session: sessionId, host: 'hosted', sessionWatch: answers }))
    : undefined;

  const registeredTools = registerAllTools(toolRegistry, {
    ...(ownerQuestions ? { ownerQuestions } : {}),
    // Shared per WORKSPACE, deliberately: two sessions editing one tree must
    // agree about the file they both just wrote (see workspace-floor.ts).
    fileCache: services.fileCache,
    projectIndex: services.projectIndex,
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    runtimeBus: services.runtimeBus,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    webSearchService: services.webSearchService,
    workflowServices: services.workflow,
    // `state mode=memory` reads and writes the workspace's one memory store.
    ...(services.memoryAccess ? { memoryAccess: services.memoryAccess } : {}),
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    // Per SESSION: without it every task-tool ref lands in the unowned legacy
    // namespace and owner-existence reaping cannot run.
    resolveSessionId: () => sessionId,
    ...(options.isSessionResumable ? { isSessionResumable: options.isSessionResumable } : {}),
    // A model changing a hook is always put to the owner, whatever the mode or earlier answers.
    hookDispatcher: services.hookDispatcher,
    hookChangeGate: (request, { signal }) => services.permissionManager.checkHookChange(request, { signal }),
    contractRunner: options.floor.contractRunner,
    projectRoot: options.workspaceRoot,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: options.workspaceRoot,
    // The session's OWN surface, not the host's. Everything keyed on this,
    // per-surface tool state under `.goodvibes/<surface>/`, and the store that
    // answers client-owned settings, follows the surface the session belongs to.
    surfaceRoot: originSurface,
    // This process IS the daemon, so daemon-owned keys are already local. What
    // must NOT be local is a client-owned key belonging to another surface, and
    // that is what `clientOwnedStore` redirects: to the originating surface's
    // own settings file, which the live surface is already watching.
    configRouting,
    // The surface's own admission for read and settings, as its own process builds them.
    ...(options.surfaceTurn?.platformToolAdmission ?? {}),
    archetypeLoader: services.archetypeLoader,
    ...(options.cloudflareAuthToken ? { cloudflareAuthToken: options.cloudflareAuthToken } : {}),
    configManager: services.configManager,
    providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    secretsManager: services.secretsManager,
    overflowHandler: services.overflowHandler,
    contextAccountingHolder,
    // A file the read tool would gate must not leak its content through a
    // search, the same filter a terminal composition installs.
    readAccessFilter: async (path: string) => (await services.permissionManager.readAccess(path, sessionId)) === 'allow',
    sandboxEscalationHandler: approvalHandlers.sandboxEscalationHandler,
    execPromptAnswerHandler: approvalHandlers.execPromptAnswerHandler,
    localhostFetchApproval: approvalHandlers.localhostFetchApproval,
    onSandboxedRun: approvalHandlers.onSandboxedRun,
    // The posture this file's header states: the caller's when it named one,
    // else the floor's, else contained. Nothing here reads the wire.
    execContainment: containmentFor(options.execPosture ?? resolveHostedExecPosture(
      options.floor.execPosture,
      { sessionId, workspaceRoot: options.workspaceRoot },
    )),
  });

  if (options.floor.devicePosture) registerDevicePhoneTool(toolRegistry, options.floor.devicePosture);

  // The user message the current turn answers; a surface prompt ranks its context against it.
  let turnText: string | null = null;
  // The same message when an authenticated operator sent it (an operator's input
  // or a native conversation turn); null for a turn channel or automation input started.
  let ownerTurnText: string | null = null;
  // The surface's own tools go in after the platform's, once per composed session.
  const surfaceTurn = options.surfaceTurn;
  let surfaceTools: HostedSurfaceTools | undefined;
  try {
    surfaceTools = surfaceTurn?.registerTools({ registry: toolRegistry, sessionId, workspaceRoot: options.workspaceRoot, floor: options.floor, providerRegistry,
      ownerTurnText: () => ownerTurnText,
      ...(options.daemonRequests ? { daemonRequests: options.daemonRequests } : {}) });
  } catch (error) {
    // Nothing else holds this session yet: release what was composed so far.
    answers?.dispose();
    if (answers && hostedSessionWatches.get(sessionId) === answers) hostedSessionWatches.delete(sessionId);
    hostedTurnSessions.delete(modeOwner);
    hostedWorkerSurfaces.delete(modeOwner);
    promptLifetime.abort();
    void registeredTools.dispose().catch((disposeError: unknown) => {
      logger.debug('[hosted-sessions] tool state disposal raised', { sessionId, error: summarizeError(disposeError) });
    });
    throw error;
  }
  // One composition per model-request signal: a turn's retries and tool rounds share it.
  const surfacePromptBySignal = new WeakMap<AbortSignal, Promise<string>>();
  const getSystemPrompt = surfaceTurn
    ? (signal?: AbortSignal): string | Promise<string> => {
      const existing = signal ? surfacePromptBySignal.get(signal) : undefined;
      if (existing) return existing;
      const composed = Promise.resolve(surfaceTurn.systemPrompt({
        sessionId, workspaceRoot: options.workspaceRoot, basePrompt: options.systemPrompt, providerRegistry, turnText, signal,
      }));
      if (signal) surfacePromptBySignal.set(signal, composed);
      return composed;
    }
    : (): string => options.systemPrompt;

  const orchestrator = new Orchestrator({
    conversation,
    // A hosted session has no viewport. The scroll seam is the renderer's, and
    // reporting a fixed height is honest here rather than pretending to measure
    // a terminal that is not attached.
    getViewportHeight: () => 0,
    scrollToEnd: () => {},
    toolRegistry,
    permissionManager: services.permissionManager,
    getSystemPrompt,
    hookDispatcher: services.hookDispatcher,
    flagManager: services.featureFlags,
    runtimeBus: services.runtimeBus,
    sessionId,
    services: {
      agentManager: services.agentManager,
      contractRunner: options.floor.contractRunner,
      contractIntake: createContractIntake({ runner: options.floor.contractRunner, projectRoot: options.workspaceRoot, getSelectedModel: () => providerRegistry.getCurrentModel() }),
    },
  });
  orchestrator.setCoreServices({
    configManager: services.configManager,
    providerRegistry,
    // A session-mode contract's unit is this session's own turns.
    contractHooks: options.floor.contractRunner.hooks(),
  });

  // context_accounting answers for this session: its injections, token use and compaction.
  const unbindContextAccounting = bindSessionContextAccounting(contextAccountingHolder, {
    orchestrator,
    getSessionId: () => sessionId,
    getContextWindow: () => {
      const known = providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel());
      return known !== null && known > 0 ? known : null;
    },
    runtimeBus: services.runtimeBus,
  });

  // The agents and contracts this session started, and only those, come back to
  // its next turn when they end, as they do in the terminal apps.
  const stopFollowUps = registerSessionFollowUps({
    runtimeBus: services.runtimeBus,
    agentManager: services.agentManager,
    contractRunner: options.floor.contractRunner,
    sessionId,
    queueConversationFollowUp: (item) => orchestrator.enqueueConversationFollowUp(item),
  });

  // The contracts this session starts talk back to it: their questions for the
  // owner and their outcomes are the session's replies.
  const contracts = options.contracts;
  const listed = new Set<string>();
  const stopContracts = observeSessionContracts({
    sessionId,
    runner: options.floor.contractRunner,
    contractIds: () => contracts?.contractIds() ?? [...listed],
    started: (contractId) => {
      listed.add(contractId);
      contracts?.started(contractId);
    },
    say: (line) => {
      conversation.addNotice(line, { level: 'info', kind: 'contract' });
      contracts?.said(line);
    },
  });

  const runtime: HostedSessionRuntime = {
    sessionId,
    conversation,
    toolRegistry,
    orchestrator,
    liveTurnControls: {
      getPermissionMode: () => modeOwner.getMode(),
      setPermissionMode: async mode => {
        assertModeLive();
        if (!isSettableGatePresetName(mode)) throw new Error('Invalid hosted execution mode');
        const previousMode = permissionMode;
        if (previousMode === mode && pendingModeWrite) return pendingModeWrite;
        if (previousMode === mode && permissionModePersisted) return;
        const changed = previousMode !== mode;
        if (changed) {
          permissionMode = mode;
          modeRevision++;
          // An admission belongs to its captured mode. Retire the pending turn
          // before persistence can await, including a return to the prior mode.
          if (orchestrator.isTurnInFlight) orchestrator.abort();
        }
        const revision = modeRevision;
        permissionModePersisted = false;
        const write = Promise.resolve().then(() => options.permissionModeChanged?.(mode)).then(() => {
          assertModeLive();
          if (modeRevision === revision) permissionModePersisted = true;
        });
        pendingModeWrite = write;
        try { await write; }
        finally {
          if (pendingModeWrite === write) pendingModeWrite = undefined;
          // A failed durable write rejects the operator request. The in-memory
          // selection remains real and observable; a same-mode retry saves it.
          if (changed && !disposed) emitPresetChanged(services.runtimeBus, { sessionId, traceId: randomUUID(), source: 'hosted-session-mode' }, {
            mode, previousMode, preset: mode, previousPreset: previousMode,
          });
        }
      },
      // The last request's input tokens once a turn has run; before that, the
      // estimate of what the next request would send.
      getContextUsage: () => readSessionContextUsage(
        orchestrator.lastInputTokens > 0 ? orchestrator.lastInputTokens : estimateConversationTokens(conversation.getMessagesForLLM()),
        providerRegistry,
      ),
      cancelTurn: (expectedTurnId: string) => orchestrator.cancelTurn(expectedTurnId),
      cancelToolCall: (callId: string) => orchestrator.cancelToolCall(callId),
      listQueuedMessages: () => orchestrator.listQueuedMessages(),
      editQueuedMessage: (id: string, text: string) => orchestrator.editQueuedMessage(id, text),
      deleteQueuedMessage: (id: string) => orchestrator.deleteQueuedMessage(id),
    },
    isRunning: () => orchestrator.isTurnInFlight,
    submit: async (text: string, correlationId?: string, submitOptions?: { readonly operatorInput?: boolean | undefined; readonly answersContractQuestion?: string | undefined }): Promise<void> => {
      if (disposed) throw new HostedSessionUnavailableError(sessionId, 'its loop was shut down before this message was delivered');
      // `ownerDirect` is deliberately unset: it also decides the gate's surface
      // authority, and a verb call carrying an operator token is not the owner
      // at his own terminal. The window is this session's own instead, and an
      // operator's input starts its next turn here. Only when no turn is in
      // flight: a message queued behind a running turn must not erase the
      // evidence that turn's pending send is judged against. Channel and
      // automation input never starts one, so their exposure accumulates.
      await withUntrustedContentScope(contentScope, async () => {
        // A running turn composed its prompt at its first request; this text is the next turn's.
        turnText = text;
        ownerTurnText = submitOptions?.operatorInput === true ? text : null;
        if (submitOptions?.operatorInput === true && !orchestrator.isTurnInFlight && !orchestrator.isThinking) ledger.startTurn();
        await withExecutionModeOwner(modeOwner, () => orchestrator.handleUserInput(text, undefined, {
          awaitQueuedTurn: true,
          ...(submitOptions?.answersContractQuestion !== undefined ? { answersContractQuestion: submitOptions.answersContractQuestion } : {}),
          origin: {
            source: 'hosted-session',
            surface: 'service',
            // Carry only the broker's correlation identity. It associates this
            // actual turn with its submitting input; it conveys no authority.
            ...(correlationId === undefined ? {} : { metadata: { correlationId } }),
          },
        }));
      });
    },
    submitNative: async (permit, inputId, correlationId): Promise<void> => {
      const source = readNativeConversationTurnPermit(permit);
      const before = readNativeConversationTurnStatus(permit);
      // `retryable` is a turn that failed before any effect; it may run again.
      if (orchestrator.isTurnInFlight || orchestrator.isThinking
        || (before !== 'unclaimed' && before !== 'retryable')) throw new Error(`Native turn cannot be queued or replayed: it is ${before}`);
      orchestrator.bindNativeConversationProject(source.projectId);
      turnText = source.text;
      ownerTurnText = source.text;
      await withUntrustedContentScope(contentScope, () => withExecutionModeOwner(modeOwner, () => orchestrator.handleUserInput(source.text, undefined, { nativeConversationTurnPermit: permit, requireImmediateNativeTurn: true,
        origin: { source: 'native-hosted-conversation', surface: 'service', metadata: { inputId, correlationId } } })));
      const after = readNativeConversationTurnStatus(permit);
      if (after !== 'settled') throw new Error(after === 'retryable'
        ? 'The model provider failed before the turn changed anything; the same message can be sent again.'
        : `Native hosted turn did not complete: it is ${after.replace('_', ' ')}`);
    },
    cancelNative: permit => orchestrator.cancelNativeConversationTurn(permit),
    cancel: (): boolean => {
      if (!orchestrator.isTurnInFlight) return false;
      orchestrator.abort();
      return true;
    },
    dispose: (): void => {
      disposed = true;
      modeRevision++;
      // An answer that arrives from here on waits in the store for the next time the session is opened.
      answers?.dispose();
      if (answers && hostedSessionWatches.get(sessionId) === answers) hostedSessionWatches.delete(sessionId);
      promptLifetime.abort();
      stopFollowUps();
      stopContracts();
      unbindContextAccounting();
      try {
        orchestrator.dispose();
      } catch (error) {
        logger.debug('[hosted-sessions] orchestrator disposal raised', {
          sessionId,
          error: summarizeError(error),
        });
      }
      // The session's key-value state is saved when its tools shut down; a session that ends here would otherwise lose it.
      void registeredTools.dispose().catch((error: unknown) => {
        logger.debug('[hosted-sessions] tool state disposal raised', { sessionId, error: summarizeError(error) });
      });
      void Promise.resolve().then(() => surfaceTools?.dispose?.()).catch((error: unknown) => {
        logger.debug('[hosted-sessions] surface tool disposal raised', { sessionId, error: summarizeError(error) });
      });
    },
  };
  return runtime;
}

/** The owner inbox as a hosted session uses it: asks and reads there, and settles a session that ended. */
export type HostedOwnerQuestions = QuestionInbox & Pick<OwnerInbox, 'claim' | 'settleSession'>;

/** The hosted session whose turn runs under each mode owner (an agent a turn started inherits it). */
const hostedTurnSessions = new WeakMap<ExecutionModeOwner, string>();
/** The answer watch of each hosted session whose loop is composed in this process. */
const hostedSessionWatches = new Map<string, SessionAnswerWatch>();
/**
 * The worker surface of each hosted session whose surface states one, by the
 * mode owner its turns run under. Kept for the owner's life, not the
 * session's: an agent a turn spawned that is woken after the session closed
 * is still built for that surface.
 */
const hostedWorkerSurfaces = new WeakMap<ExecutionModeOwner, AgentWorkerSurface>();

/**
 * The surface a worker being started on a hosted workspace floor was spawned
 * for: that of the hosted session whose turn spawned it, read from the mode
 * owner the agent runs under. Undefined for a worker of any other session, or
 * outside one, which then gets the floor's own worker registry. One lookup.
 */
export function hostedWorkerSurface(): AgentWorkerSurface | undefined {
  const owner = currentExecutionModeOwner();
  return owner ? hostedWorkerSurfaces.get(owner) : undefined;
}

/**
 * The asker of a question an agent on a hosted workspace floor posts: that
 * agent, which takes the answer on its next model request while it runs, and
 * the hosted session whose turn started it, whose conversation takes the answer
 * once the agent stops (now when the session is open, otherwise when it is next
 * opened). Undefined outside an agent's tool call.
 */
export function hostedAgentAsker(): QuestionAsker | undefined {
  const agent = callingAgentId();
  if (agent === undefined) return undefined;
  const owner = currentExecutionModeOwner();
  const session = owner ? hostedTurnSessions.get(owner) : undefined;
  if (session === undefined) return { agent, host: 'hosted' };
  const sessionWatch = hostedSessionWatches.get(session);
  return { agent, session, host: 'hosted', ...(sessionWatch ? { sessionWatch } : {}) };
}

/** The untrusted-content scope a hosted session's turns run in. */
export function hostedSessionContentScope(sessionId: string): string {
  return `session:${sessionId}`;
}

/** A stable id for a new hosted session. */
export function newHostedSessionId(): string {
  return `hosted-${randomUUID()}`;
}
