import { effectivePermissionMode, isSettableGatePresetName, type GatePresetName } from '../gate/presets.js';
import { withExecutionModeOwner, type ExecutionModeOwner } from '../gate/execution-context.js';
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
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import { createApprovalDerivedHandlers } from '../runtime/permissions/permission-composition.js';
import type { SessionLiveTurnControls } from '../control-plane/routes/session-runtime.js';
import type { ModelDefinition } from '../providers/registry.js';
import { withHostedSessionModel } from './model-route.js';
import type { HostedWorkspaceFloor } from './workspace-floor.js';
import { createContractIntake } from '../contract/intake-route.js';
import { observeSessionContracts } from './session-contracts.js';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import {
  containmentFor,
  resolveHostedExecPosture,
  HOSTED_OWNER_TERMINAL_GUARD,
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
   * Submit a user message. Resolves when the turn this call started has ended;
   * a message submitted while a turn is running is QUEUED by the orchestrator
   * and this resolves immediately, which is the same contract a terminal has.
   */
  submit(text: string, correlationId?: string): Promise<void>;
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
  const sessionId = options.sessionId;
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
  });

  registerAllTools(toolRegistry, {
    // Shared per WORKSPACE, deliberately: two sessions editing one tree must
    // agree about the file they both just wrote (see workspace-floor.ts).
    fileCache: services.fileCache,
    projectIndex: services.projectIndex,
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    webSearchService: services.webSearchService,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    // Per SESSION: without it every task-tool ref lands in the unowned legacy
    // namespace and owner-existence reaping cannot run.
    resolveSessionId: () => sessionId,
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
    configRouting: {
      hostsDaemon: true,
      ...(clientOwnedStore ? { clientOwnedStore } : {}),
    },
    archetypeLoader: services.archetypeLoader,
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
    readAccessFilter: async (path: string) => (await services.permissionManager.readAccess(path)) === 'allow',
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
    ownerTerminalGuard: HOSTED_OWNER_TERMINAL_GUARD,
  });

  if (options.floor.devicePosture) registerDevicePhoneTool(toolRegistry, options.floor.devicePosture);

  const orchestrator = new Orchestrator({
    conversation,
    // A hosted session has no viewport. The scroll seam is the renderer's, and
    // reporting a fixed height is honest here rather than pretending to measure
    // a terminal that is not attached.
    getViewportHeight: () => 0,
    scrollToEnd: () => {},
    toolRegistry,
    permissionManager: services.permissionManager,
    getSystemPrompt: () => options.systemPrompt,
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
      conversation.addSystemMessage(line);
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
      cancelTurn: (expectedTurnId: string) => orchestrator.cancelTurn(expectedTurnId),
      cancelToolCall: (callId: string) => orchestrator.cancelToolCall(callId),
      listQueuedMessages: () => orchestrator.listQueuedMessages(),
      editQueuedMessage: (id: string, text: string) => orchestrator.editQueuedMessage(id, text),
      deleteQueuedMessage: (id: string) => orchestrator.deleteQueuedMessage(id),
    },
    isRunning: () => orchestrator.isTurnInFlight,
    submit: async (text: string, correlationId?: string): Promise<void> => {
      if (disposed) return;
      // `ownerDirect` is deliberately unset. It attests that the transport
      // authenticated the OWNER himself, and a verb call carrying an operator
      // token cannot honestly claim that, leaving it unset keeps the
      // untrusted-content window open, which is the safe direction.
      await withExecutionModeOwner(modeOwner, () => orchestrator.handleUserInput(text, undefined, {
        origin: {
          source: 'hosted-session',
          surface: 'service',
          // Carry only the broker's correlation identity. It associates this
          // actual turn with its submitting input; it conveys no authority.
          ...(correlationId === undefined ? {} : { metadata: { correlationId } }),
        },
      }));
    },
    submitNative: async (permit, inputId, correlationId): Promise<void> => {
      const source = readNativeConversationTurnPermit(permit);
      if (orchestrator.isTurnInFlight || orchestrator.isThinking
        || readNativeConversationTurnStatus(permit) !== 'unclaimed') throw new Error('Native turn cannot be queued or replayed');
      orchestrator.bindNativeConversationProject(source.projectId);
      await withExecutionModeOwner(modeOwner, () => orchestrator.handleUserInput(source.text, undefined, { nativeConversationTurnPermit: permit, requireImmediateNativeTurn: true,
        origin: { source: 'native-hosted-conversation', surface: 'service', metadata: { inputId, correlationId } } }));
      if (readNativeConversationTurnStatus(permit) !== 'settled') throw new Error('Native hosted turn did not complete');
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
      promptLifetime.abort();
      stopContracts();
      try {
        orchestrator.dispose();
      } catch (error) {
        logger.debug('[hosted-sessions] orchestrator disposal raised', {
          sessionId,
          error: summarizeError(error),
        });
      }
    },
  };
  return runtime;
}

/** A stable id for a new hosted session. */
export function newHostedSessionId(): string {
  return `hosted-${randomUUID()}`;
}
