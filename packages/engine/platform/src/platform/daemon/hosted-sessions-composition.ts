import type { FailureReadOptions } from '@goodvibes/engine/errors';
import { createNativeHostedTurnHost, type NativeHostedTurnDependencies, type NativeHostedTurnHost } from '../hosted-sessions/native-turn-host.js';
import { registerNativeHostedTurnGatewayMethods } from '../control-plane/routes/native-hosted-turn.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import { hostedSessionPresence } from '../agents/agent-owner-questions.js';
/**
 * hosted-sessions-composition.ts, wiring the hosted-session engine into a
 * daemon.
 *
 * The engine (platform/hosted-sessions) is deliberately ignorant of the daemon:
 * it takes a way to build a workspace floor, a place to publish lifecycle
 * notices, a store, and the settings it reads. This file supplies those from a
 * composed daemon, and nothing else.
 *
 * ── Why the floor factory is required rather than defaulted ────────────────
 *
 * A hosted run writes files, runs commands and delegates inside a workspace the
 * daemon was pointed at over the wire. WHICH permission seam sits in front of
 * that is the product's decision, the daemon puts its workspace trust gate
 * there, so an undecided workspace raises the trust question as an approval
 * record any attached surface can answer, and a restricted one refuses
 * non-read categories without asking.
 *
 * Defaulting that seam would mean picking a trust posture on the product's
 * behalf, and the only posture available to a default is "no gate at all". So
 * hosted sessions are OFF until a product states how a floor is built. A daemon
 * that says nothing hosts nothing, and the verbs refuse honestly rather than
 * running ungated work.
 */

import { existsSync, statSync } from 'node:fs';
import { allowedWorkspaceRoots } from '../hosted-sessions/workspace-roots.js';
import { sharedWorkspaceRegisterPath } from '../workspace/registration/shared-register-path.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import type { SessionLiveTurnControlsHolder } from '../control-plane/routes/session-runtime.js';
import {
  refuseHostedSessionGatewayMethods,
  registerHostedSessionGatewayMethods,
} from '../control-plane/routes/hosted-sessions.js';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import {
  createHostedContractWorkAdapter,
  createHostedSessionLivenessProbe,
  HostedSessionManager,
  HostedSessionStore,
  type HostedSessionEventPublisher,
  type HostedSessionManagerOptions,
  type HostedSessionLoadReport,
  type HostedSessionConversations,
  type HostedSessionSpine,
  type HostedWorkspaceFloorFactory,
  type HostedSurfaceTurns,
} from '../hosted-sessions/index.js';
import type { RuntimeServices } from '../runtime/services.js';
import { CONVERSATIONAL_DIAGNOSIS_SECTION } from '../agents/conversational-contract.js';

/** What a product states to turn hosted sessions on. */
export interface DaemonHostedSessionsOptions {
  /** Host-private owner supplied by product composition, never wire data. */
  readonly nativeConversation?: NativeHostedTurnDependencies | undefined;
  /**
   * How a workspace floor is built. Required, see the module header for why
   * there is no default.
   */
  readonly floorFactory: HostedWorkspaceFloorFactory;
  /**
   * The base system prompt for a hosted turn. The orchestrator appends the
   * runtime-awareness block itself, so this is the product's operator policy.
   * Omitted ⇒ a plain statement of what the session is.
   */
  readonly systemPrompt?: ((input: { readonly sessionId: string; readonly workspaceRoot: string }) => string) | undefined;
  /**
   * The product turns this daemon hosts by origin surface: a session created
   * with `originSurface: 'agent'` runs as the Agent's turn (its tools and its
   * prompt, with `systemPrompt` as the base) when `agent` is here. A surface
   * with no entry gets the platform tools and `systemPrompt`.
   */
  readonly surfaceTurns?: HostedSurfaceTurns | undefined;
  /**
   * Told of each hosted session's live conversation, so this daemon's rewind
   * verbs can rewind it in place and know where its turns ended. Omitted ⇒
   * conversation rewind of a hosted session is reported unavailable.
   */
  readonly conversations?: HostedSessionConversations | undefined;
  /** Where session state is written. Omitted ⇒ `<injected home>/.goodvibes/hosted-sessions`. */
  readonly stateDirectory?: string | undefined;
  /** Whether a workspace root is acceptable. Omitted ⇒ it must be an existing directory. */
  readonly isWorkspaceUsable?: ((workspaceRoot: string) => boolean) | undefined;
  /** The daemon's project work plan; a hosted session in that project keeps it with `work_plan`. */
  readonly workPlan?: HostedSessionManagerOptions['workPlan'];
}

/** What this composition needs from an already-built daemon. */
export interface HostedSessionCompositionInput {
  readonly failureReading?: FailureReadOptions | undefined;
  readonly options: DaemonHostedSessionsOptions;
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly shellPaths: ShellPathService;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly liveTurns: SessionLiveTurnControlsHolder;
  readonly eventPublisher: HostedSessionEventPublisher;
  readonly spine?: HostedSessionSpine | undefined;
  /** The daemon's bearer token, read live; a hosted session's Cloudflare status counts it as the Worker operator token. */
  readonly cloudflareAuthToken?: (() => string | null) | undefined;
  /** The daemon's owner inbox; each hosted session's `query` tool asks there. */
  readonly ownerQuestions?: HostedSessionManagerOptions['ownerQuestions'];
  /** The daemon's trigger supervisor; each hosted session's `trigger` tool uses it. */
  readonly triggers?: HostedSessionManagerOptions['triggers'];
}

/** The default prompt: what this session is, stated plainly. */
function defaultHostedSystemPrompt(input: { readonly workspaceRoot: string }): string {
  return [
    [
      'You are running as a GoodVibes session hosted by the daemon rather than by a terminal.',
      `Your working directory is ${input.workspaceRoot}.`,
      'A person may be attached and watching, or may have detached and be reading this later, write as if both are true.',
    ].join(' '),
    // A hosted turn answers a person, so it is held to the same contract every
    // other conversational turn is held to, one text, not a second one that
    // drifts (agents/conversational-contract.ts).
    CONVERSATIONAL_DIAGNOSIS_SECTION,
  ].join('\n\n');
}

/** An existing directory, checked without throwing on a permission error. */
function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the hosted-session engine, attach its verbs and its lifecycle channel.
 * The caller still has to call `init()` (at start) and `dispose()` (at stop).
 */
export function composeHostedSessions(input: HostedSessionCompositionInput): HostedSessionManager {
  const config = input.configManager;
  const store = new HostedSessionStore(
    input.options.stateDirectory ?? input.shellPaths.resolveUserPath('hosted-sessions'),
    {
      get maxSessions(): number { return config.get('hostedSessions.maxSessions'); },
      get maxMessagesPerSession(): number { return config.get('hostedSessions.maxMessagesPerSession'); },
      get terminatedRetentionMs(): number { return config.get('hostedSessions.terminatedRetentionMs'); },
    },
  );
  let native: NativeHostedTurnHost | undefined;
  const manager = new HostedSessionManager({
    failureReading: input.failureReading,
    closeNativeTurns: () => native?.close() ?? Promise.resolve(),
    floorFactory: input.options.floorFactory,
    store,
    // Read live on every use: a policy change applies to the next detach, not
    // to whatever the value was when the daemon booted.
    settings: {
      detachPolicy: () => config.get('hostedSessions.detachPolicy'),
      maxSessions: () => config.get('hostedSessions.maxSessions'),
      attachmentTtlMs: () => config.get('hostedSessions.attachmentTtlMs'),
    },
    runtimeBus: input.runtimeBus,
    systemPrompt: input.options.systemPrompt ?? defaultHostedSystemPrompt,
    ...(input.options.surfaceTurns === undefined ? {} : { surfaceTurns: input.options.surfaceTurns }),
    liveTurns: input.liveTurns,
    ...(input.options.conversations === undefined ? {} : { conversations: input.options.conversations }),
    ...(input.spine === undefined ? {} : { spine: input.spine }),
    ...(input.cloudflareAuthToken === undefined ? {} : { cloudflareAuthToken: input.cloudflareAuthToken }),
    ...(input.ownerQuestions === undefined ? {} : { ownerQuestions: input.ownerQuestions }),
    ...(input.triggers === undefined ? {} : { triggers: input.triggers }),
    ...(input.options.workPlan === undefined ? {} : { workPlan: input.options.workPlan }),
    isWorkspaceUsable: input.options.isWorkspaceUsable ?? isExistingDirectory,
    allowedWorkspaceRoots: () => allowedWorkspaceRoots(input.shellPaths.workingDirectory, sharedWorkspaceRegisterPath(input.shellPaths)),
  });
  const rootsDescriptor = input.gatewayMethods.get('sessions.hosted.workspaces');
  if (rootsDescriptor) {
    input.gatewayMethods.register(rootsDescriptor, () => ({ roots: [...manager.workspaceRoots()] }), { replace: true });
  }
  if (input.options.nativeConversation) {
    const broker = input.spine as SharedSessionBroker | undefined;
    if (!broker || typeof broker.reserveNativeTurnInput !== 'function') throw new Error('Native hosted delivery requires the canonical session broker');
    native = createNativeHostedTurnHost({ ...input.options.nativeConversation, manager, broker });
    registerNativeHostedTurnGatewayMethods(input.gatewayMethods, native);
  }
  manager.setEventPublisher(input.eventPublisher);
  registerHostedSessionGatewayMethods(input.gatewayMethods, manager);
  return manager;
}

/**
 * The facade's one-line entry point. Everything this composition needs is
 * already on the runtime graph, so the facade names the graph rather than
 * spelling out six fields it would have to keep in step by hand, and an
 * absent options object returns null rather than making the facade branch.
 */
export function composeHostedSessionsForFacade(
  options: DaemonHostedSessionsOptions | undefined,
  runtimeServices: RuntimeServices,
  configManager: ConfigManager,
  runtimeBus: RuntimeEventBus,
  eventPublisher: HostedSessionEventPublisher,
  cloudflareAuthToken?: () => string | null,
): HostedSessionManager | null {
  // No options is the honest off state, not a missing wire: this daemon hosts
  // no conversation loops, and the verbs say so with the catalog's own coded
  // refusal rather than a bodiless 501 or a plain-Error 500.
  if (!options) {
    refuseHostedSessionGatewayMethods(runtimeServices.gatewayMethods);
    return null;
  }
  const manager = composeHostedSessions({
    failureReading: { port: runtimeServices.judgment.port },
    options,
    configManager,
    runtimeBus,
    shellPaths: runtimeServices.shellPaths,
    gatewayMethods: runtimeServices.gatewayMethods,
    liveTurns: runtimeServices.sessionLiveTurnControls,
    eventPublisher,
    spine: runtimeServices.sessionBroker,
    ...(cloudflareAuthToken === undefined ? {} : { cloudflareAuthToken }),
    ...(runtimeServices.ownerInbox === undefined ? {} : { ownerQuestions: runtimeServices.ownerInbox }),
    ...(runtimeServices.triggerManager === undefined ? {} : { triggers: runtimeServices.triggerManager }),
  });
  // Hand the broker's idle reaper a way to ask this engine whether a hosted
  // session is mid-turn. Without it the reaper judges a hosted session only by
  // signals a hosted turn never emits, and closes it 'idle-reaped' while its
  // turn is still running.
  runtimeServices.sessionBroker.setExternalLivenessProbe(createHostedSessionLivenessProbe(manager));
  // A hosted turn in flight makes the daemon busy, as a local one does (a working-directory move waits for it).
  runtimeServices.sessionBroker.setExternalTurnCounter(() => manager.list().filter((record) => record.status === 'running').length);
  // Closing the broker record of a hosted session ends the hosted session too; otherwise its
  // next registration re-opens the record the operator just closed.
  attachHostedSessionCloseSync(manager, runtimeServices.sessionBroker);
  // Whether a hosted session that asked the owner something is open, idle or ended is read from this engine.
  runtimeServices.ownerInbox?.usePresence(hostedSessionPresence(manager));
  // The contracts.* methods read and act across the hosted floors' runners too.
  runtimeServices.contractOperator.attachHosted(manager.contractRunners());
  // So does the fleet: a hosted session's workers are listed, stopped and steered with the daemon's own.
  runtimeServices.attachHostedFleetAgents(() => manager.fleetAgentManagers());
  // Dispatched contract work (the external work seam) runs in a hosted session:
  // a new one in the daemon's working directory unless the request names a
  // workspace the manager allows. Every floor's runner publishes on the daemon bus, so
  // settlement ends the session made for the work without anyone polling.
  manager.attachContractWork(createHostedContractWorkAdapter({
    runner: runtimeServices.contractOperator,
    hostedSessions: manager,
    workspaceRoot: runtimeServices.workingDirectory,
    settled: (listener) => subscribeContractSettlement(runtimeBus, listener),
  }));
  return manager;
}

/** Calls `listener` with the id of each contract that passes, fails or is cancelled. Returns the unsubscribe. */
function subscribeContractSettlement(bus: RuntimeEventBus, listener: (contractId: string) => void): () => void {
  const read = (envelope: { readonly payload: unknown }): void => {
    const contractId = (envelope.payload as { readonly contractId?: unknown } | null)?.contractId;
    if (typeof contractId === 'string') listener(contractId);
  };
  const unsubscribers = [bus.on('CONTRACT_PASSED', read), bus.on('CONTRACT_FAILED', read), bus.on('CONTRACT_CANCELLED', read)];
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}

/**
 * Terminate each live hosted session whose broker record was closed from
 * outside the engine. Returns the unsubscribe.
 */
export function attachHostedSessionCloseSync(
  manager: Pick<HostedSessionManager, 'list' | 'kill'>,
  broker: Pick<SharedSessionBroker, 'getSession' | 'subscribe'>,
): () => void {
  return broker.subscribe(() => {
    for (const record of manager.list()) {
      const brokered = broker.getSession(record.id);
      // No record is not a close: a session is hosted a moment before it is registered with the broker.
      if (brokered?.status !== 'closed') continue;
      manager.kill(record.id).catch((error: unknown) => {
        logger.warn('[hosted-sessions] could not end a hosted session whose broker record is closed', { sessionId: record.id, error: summarizeError(error) });
      });
    }
  });
}

/**
 * State what a restore pass found. A restart that could not bring a session
 * back has to say so; leaving the counts only in the report object the caller
 * may or may not read is how a silent loss stays silent.
 */
export function reportHostedSessionRestore(report: HostedSessionLoadReport): void {
  if (report.restored.length === 0 && report.rejected.length === 0
    && report.swept.length === 0 && report.evicted.length === 0) return;
  logger.info('DaemonServer: hosted sessions restored', {
    restored: report.restored.length,
    rejected: report.rejected.length,
    swept: report.swept.length,
    evicted: report.evicted.length,
    ...(report.rejected.length > 0
      ? { rejectedFiles: report.rejected.map((entry) => `${entry.file}: ${entry.reason}`) }
      : {}),
  });
}
