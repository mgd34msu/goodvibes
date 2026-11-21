// ---------------------------------------------------------------------------
// idle-power-services.ts, the idle-time / sleep-ownership / live-turn slice of
// the runtime composition, extracted from services.ts (file-size hygiene).
//
// Mirrors the platform's own createRuntimeServices wiring: idle-time memory
// consolidation (learning.consolidation.*), host sleep ownership (power.*), and
// the per-session live-turn control holder that backs the
// sessions.toolCalls.cancel / sessions.queuedMessages.* wire verbs. Consolidation
// receipts ride the SAME attach-time queue every other receipt uses, a run that
// changed something records a one-line notice into the file-backed
// feature-announcement store, drained on the next surface attach; a quiet run
// records nothing.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '../config/index.js';
import type { MemoryConsolidationRunReceipt, MemoryRegistry } from '../state/index.js';
import { MemoryConsolidationScheduler, MemoryUsageTracker } from '../state/index.js';
import type { TurnEvent } from '../../events/turn.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { SessionLiveTurnControlsHolder } from '../control-plane/index.js';
import { PowerManager, wireRuntimePower, createUnavailablePowerSeam } from '../power/index.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from './feature-announcements.js';
import type { RuntimeEventBus } from './state.js';
import { formatConsolidationReceipt } from '../state/consolidation-receipt.js';
import { classifyDaemonOrigin, configuredDaemonOrigin } from './client/daemon-target-resolver.js';

export interface IdlePowerServicesDeps {
  readonly configManager: ConfigManager;
  readonly memoryRegistry: MemoryRegistry;
  /** The store a turn's memory use is counted on (consolidation's decay reads the counters); absent: `memoryRegistry`. */
  readonly usageRegistry?: MemoryRegistry | undefined;
  readonly runtimeBus: RuntimeEventBus;
  /** Whether new work is admitted (daemon/work-admission.ts); no consolidation pass starts while it is not. */
  readonly workAdmitted?: (() => boolean) | undefined;
  /** True when no session is busy, the consolidation scheduler's idle gate. */
  readonly isIdle: () => boolean;
  /** Sleep-edge checkpoint + a wake catch-up tick (store snapshots). */
  readonly snapshotTick: () => void;
  /** Wake catch-up: fire the automation heartbeat. */
  readonly heartbeat: () => Promise<void>;
  /** Where a run's receipt goes; absent: the attach-time notice queue (a run with nothing to report records nothing). */
  readonly onConsolidationReceipt?: ((receipt: MemoryConsolidationRunReceipt) => void) | undefined;
  /**
   * Host power seam. platform 1.9.0 makes wireRuntimePower default an absent seam to
   * the REAL host seam (createHostPowerSeam, which spawns systemd-inhibit and a
   * dbus-monitor sleep-edge watcher on Linux, caffeinate and a `log stream`
   * sleep-edge watcher on macOS). That spawn is a host-level side effect, so
   * this fork mirrors the platform's own createRuntimeServices: when no seam is passed
   * we default to the NON-spawning unavailable seam, keeping test-constructed
   * runtimes deterministic. Only the real long-lived compositions (the standalone
   * daemon and the embedded interactive runtime, which itself IS the daemon) pass
   * createHostPowerSeam() to opt into live OS keep-awake/idle-inhibit.
   */
  readonly powerSeam?: Parameters<typeof wireRuntimePower>[0]['seam'];
}

export interface IdlePowerServices {
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  /**
   * The one per-turn memory usage tracker of this process, fed by every turn
   * on the bus: a completed turn's injected memories (its `metadata.memory`)
   * get one usage reading and one counter update. A product whose own prompt
   * injects memories adds their ids with `onComposed` before the turn ends.
   */
  readonly memoryUsageTracker: MemoryUsageTracker;
  /** Stops following turns for memory usage. */
  readonly stopMemoryUsage: () => void;
  readonly powerManager: PowerManager;
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
}

/**
 * The envelope source of a turn event the process's own Orchestrator emitted
 * (core/orchestrator-runtime.ts createEmitterContext). A relay of another
 * process's turn (the Agent's hosted-turn bus bridge) carries its own source.
 */
const ORCHESTRATOR_SOURCE = 'orchestrator';

/**
 * Count memory use for every turn this process ran, so decay ranks memories
 * the same way in every product. A turn is counted where it ran: a relayed
 * turn end (a client showing a turn its daemon ran) is not this process's, and
 * the tracker counts one turn id once. Costs one decision-model request per
 * completed turn that carried memories, after the turn's result is out and
 * bounded by the decision deadline; none with decision models off. A new
 * turn abandons a reading still in flight; shutdown abandons all.
 */
function followTurnMemoryUsage(bus: RuntimeEventBus, tracker: MemoryUsageTracker): () => void {
  const ran = (envelope: { readonly source?: string | undefined }): boolean => envelope.source === ORCHESTRATOR_SOURCE;
  const unsubscribes = [
    bus.on<Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>>('TURN_SUBMITTED', () => tracker.dropPendingReadings()),
    bus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', (envelope) => {
      if (!ran(envelope)) return;
      const { payload } = envelope;
      tracker.onComposed(payload.turnId, payload.metadata?.memory?.recordIds ?? []);
      void tracker.onTurnCompleted(payload.turnId, payload.response).catch((error: unknown) => {
        logger.debug('Memory usage counters were not written', { error: summarizeError(error) });
      });
    }),
    bus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', (envelope) => { if (ran(envelope)) tracker.onTurnAborted(envelope.payload.turnId); }),
    bus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', (envelope) => { if (ran(envelope)) tracker.onTurnAborted(envelope.payload.turnId); }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    tracker.dispose();
  };
}

/** Construct (and start) the idle-consolidation scheduler, power manager, and live-turn holder. */
export function wireIdlePowerAndLiveTurn(deps: IdlePowerServicesDeps): IdlePowerServices {
  const consolidationReceiptStore = new FeatureAnnouncementStore(featureAnnouncementsPath(deps.configManager));
  const memoryConsolidationScheduler = new MemoryConsolidationScheduler({
    memoryRegistry: deps.memoryRegistry,
    configSource: deps.configManager,
    isIdle: deps.isIdle,
    ...(deps.workAdmitted ? { workAdmitted: deps.workAdmitted } : {}),
    onReceipt: deps.onConsolidationReceipt ?? ((receipt) => {
      const text = formatConsolidationReceipt(receipt);
      if (text) consolidationReceiptStore.notify(`memory-consolidation:${receipt.runId}`, text);
    }),
  });
  memoryConsolidationScheduler.start();
  const memoryUsageTracker = new MemoryUsageTracker(deps.usageRegistry ?? deps.memoryRegistry);
  const stopMemoryUsage = followTurnMemoryUsage(deps.runtimeBus, memoryUsageTracker);
  const sessionLiveTurnControls = new SessionLiveTurnControlsHolder();
  const powerManager = wireRuntimePower({
    readConfig: (key) => deps.configManager.get(key as Parameters<typeof deps.configManager.get>[0]),
    writeConfig: (key, value) => deps.configManager.setDynamic(key as Parameters<typeof deps.configManager.setDynamic>[0], value),
    // Live config subscription: an external edit to power.keepAwake (a settings-
    // modal toggle, a hand-edited settings file) applies LIVE to the in-process
    // manager, acquires/releases the inhibitor and lights the chip with no
    // restart. power.keepAwake is daemon-owned: a client reads it from the
    // daemon tier it overlays, so this is the same value the daemon holds.
    subscribeConfig: (key, cb) => (deps.configManager.subscribe as unknown as (k: string, c: (v: unknown) => void) => () => void)(key, (newValue) => cb(newValue)),
    // power.keepAwake is the daemon's: with the daemon this process works with on
    // another machine, the value is that machine's and this one's inhibitor does not follow it.
    holdsKeepAwake: () => {
      const origin = configuredDaemonOrigin(deps.configManager);
      return origin === null || classifyDaemonOrigin(origin, deps.configManager) !== 'no';
    },
    runtimeBus: deps.runtimeBus,
    sleepCheckpoint: deps.snapshotTick,
    wakeCatchUp: [() => memoryConsolidationScheduler.runNow(), deps.snapshotTick, deps.heartbeat],
    // Non-spawning default (see powerSeam doc above): without an explicit opt-in
    // the seam is the honest unavailable one, NOT the spawning host seam that
    // wireRuntimePower would otherwise pick for an undefined seam.
    seam: deps.powerSeam ?? createUnavailablePowerSeam('runtime services constructed without a host power seam'),
  });
  return { memoryConsolidationScheduler, memoryUsageTracker, stopMemoryUsage, powerManager, sessionLiveTurnControls };
}
