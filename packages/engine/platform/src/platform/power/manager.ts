/**
 * power/manager.ts, sleep ownership policy over the platform seam.
 *
 * Three responsibilities, per the recorded ruling:
 *
 * 1. AUTOMATIC work inhibition: while real work runs (a running turn, an
 *    active agent/fleet node, a schedule about to fire, callers hold/release
 *    named work holds), an idle+sleep inhibitor is held, hard time-capped
 *    (honest, configurable cap) and released when work drains. State is
 *    always inspectable as "held because X".
 * 2. SLEEP-EDGE honesty: on PrepareForSleep(true) every registered checkpoint
 *    callback runs (checkpoint what's checkpointable); on wake the catch-up
 *    callbacks run (re-arm timers, reconnect, deliver missed-run receipts
 *    through each job's own path).
 * 3. THE OWNER TOGGLE (keep-awake): daemon-held, INDEPENDENT of work state,
 *    it survives surfaces closing; covers idle + sleep + lid-switch classes
 *    where grantable and states the split honestly where the lid-switch block
 *    is refused ("idle sleep blocked; lid-close suspend is controlled by your
 *    OS here"). NO timers, NO AC-only sub-options, the always-visible chip
 *    (served from getState over the contract) is the safety mechanism.
 */
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { isSleepWatcherReaper } from './child-hygiene.js';
import type { PowerInhibitClass, PowerInhibitHandle, PowerPlatformSeam } from './types.js';
import { bindPowerWorkSignals, type PowerWorkSignalBus } from './work-signals.js';

const WORK_CLASSES: readonly PowerInhibitClass[] = ['idle', 'sleep'];
const KEEP_AWAKE_CLASSES: readonly PowerInhibitClass[] = ['idle', 'sleep', 'handle-lid-switch'];
/** The ruling's honest-split line when a lid-switch block is not grantable. */
export const LID_SWITCH_HONEST_SPLIT = 'idle sleep blocked; lid-close suspend is controlled by your OS here';
/** Served as the keep-awake note while the toggle is on but the OS granted no inhibitor. */
export const KEEP_AWAKE_NOT_HELD = 'keep-awake is on, but the OS refused the sleep inhibitor, so this host can still sleep; it retries on wake and whenever keep-awake is turned on again';
/** Served as the keep-awake note while the toggle is on but this host has no sleep-inhibit support at all. */
export function keepAwakeUnsupportedNote(platform: string): string {
  return `keep-awake is on, but this host has no sleep-inhibit support (${platform}), so it can still sleep; nothing will retry until that changes`;
}
/** Appended to the keep-awake note when the toggle took effect but could not be saved. */
export const KEEP_AWAKE_NOT_SAVED = 'keep-awake is applied now but could not be saved, so it reverts to the saved setting when the daemon restarts';
/** Served as the keep-awake note when a toggle request reached a manager that has already stopped. */
export const KEEP_AWAKE_REQUEST_NOT_APPLIED = 'the power manager has stopped, so this keep-awake request was not applied';

/**
 * What the keep-awake toggle is actually doing, derived from the served view so
 * every surface says the same thing: `refused` is on-but-not-holding, and
 * `held-partial` holds with some class (usually lid-close) refused.
 */
export type KeepAwakeCondition = 'off' | 'held' | 'held-partial' | 'refused';

export function keepAwakeCondition(view: Pick<PowerInhibitorView, 'held' | 'deniedClasses'> & { readonly enabled: boolean }): KeepAwakeCondition {
  if (!view.enabled) return 'off';
  if (!view.held) return 'refused';
  return view.deniedClasses.length > 0 ? 'held-partial' : 'held';
}

export interface PowerInhibitorView {
  readonly held: boolean;
  readonly grantedClasses: readonly PowerInhibitClass[];
  readonly deniedClasses: readonly PowerInhibitClass[];
}

/** The full state the contract serves (surfaces render the chip from this). */
export interface PowerState {
  readonly platform: string;
  readonly work: PowerInhibitorView & {
    /** The live reasons the inhibitor is held ("held because X"). */
    readonly reasons: readonly string[];
    readonly heldSince: number | null;
    readonly capMinutes: number;
    /** When the hard cap will force-release the WORK inhibitor (never the toggle). */
    readonly capExpiresAt: number | null;
    /** True while work the cap released is still listed in `reasons` (honest). */
    readonly capExpired: boolean;
  };
  readonly keepAwake: PowerInhibitorView & {
    readonly enabled: boolean;
    /** The honest-split note when part of the requested coverage was refused, or KEEP_AWAKE_NOT_HELD when none was granted. */
    readonly note: string | null;
  };
}

export interface PowerSleepEdgeHooks {
  /** Checkpoint what's checkpointable, runs on PrepareForSleep(true). */
  readonly onSleep?: (() => void | Promise<void>) | undefined;
  /** Catch-up: re-arm timers, reconnect, deliver missed receipts, runs on wake. */
  readonly onWake?: (() => void | Promise<void>) | undefined;
}

export interface PowerManagerOptions {
  readonly seam: PowerPlatformSeam;
  /** Live config reads (power.* keys); absent keys use the shipped defaults. */
  readonly readConfig?: ((key: string) => unknown) | undefined;
  /** Persist the keep-awake toggle (power.keepAwake) when set over the wire. */
  readonly writeConfig?: ((key: string, value: boolean) => void) | undefined;
  /**
   * Subscribe to live config changes (ConfigManager.subscribe shape). When
   * present, a power.keepAwake change, from any writer, including an external
   * settings edit, applies LIVE, not just at start().
   */
  readonly subscribeConfig?: ((key: string, cb: (newValue: unknown) => void) => () => void) | undefined;
  /** Emits the state-change event surfaces subscribe the chip to. */
  readonly onStateChanged?: ((state: PowerState) => void) | undefined;
  /**
   * Process exit/signal hook registration seam (injectable for tests).
   * Default registers on the real `process`. The registered cleanup releases
   * every held inhibitor so the out-of-process inhibit children die with us,
   * an exiting daemon must never leave a hold blocking host sleep.
   */
  readonly registerProcessExitHooks?: ((cleanup: () => void) => () => void) | undefined;
  /** Bus whose turn/agent/schedule events hold work; bound for this manager's life and unbound by stop(). */
  readonly workSignalBus?: PowerWorkSignalBus | undefined;
  readonly now?: (() => number) | undefined;
  /** Timer seam for the work hard cap; tests drive it instead of waiting. */
  readonly timers?: { readonly setTimeout: typeof setTimeout; readonly clearTimeout: typeof clearTimeout } | undefined;
}

/** The slice of `process` the default exit hook uses (injectable for tests). */
export type PowerExitProcess = Pick<NodeJS.Process, 'on' | 'once' | 'removeListener' | 'listeners' | 'kill' | 'pid'>;

/**
 * Default process-exit hook registration: the 'exit' event (normal exits and
 * handled-signal exits) plus SIGINT/SIGTERM/SIGHUP once-handlers.
 *
 * A signal handler acts ONLY when it is the sole listener: nothing else owns
 * shutdown, so it releases the holds and re-raises the signal for the default
 * action. When a host application also handles the signal, that handler owns
 * shutdown and may well keep running (a surface that treats SIGINT as cancel,
 * a daemon that ignores SIGHUP), so releasing there would silently drop a hold
 * the state still reports. A host that does exit reaches the 'exit' hook, or
 * calls stop().
 */
export function defaultRegisterProcessExitHooks(cleanup: () => void, proc: PowerExitProcess = process): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onExit = (): void => cleanup();
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  proc.on('exit', onExit);
  for (const signal of signals) {
    const handler = (): void => {
      // `once` has already removed this listener, so no other listener means nobody else is handling the signal.
      // The sleep watchers' reaper is not a host owner: it never exits the process, and counting it would
      // make it and this handler each wait for the other.
      if (proc.listeners(signal).some((listener) => !isSleepWatcherReaper(listener))) return;
      cleanup();
      proc.kill(proc.pid, signal);
    };
    signalHandlers.set(signal, handler);
    proc.once(signal, handler);
  }
  return () => {
    proc.removeListener('exit', onExit);
    for (const [signal, handler] of signalHandlers) proc.removeListener(signal, handler);
  };
}

const DEFAULT_WORK_CAP_MINUTES = 180;

export class PowerManager {
  private readonly workReasons = new Map<string, string>();
  private workHandle: PowerInhibitHandle | null = null;
  private workHeldSince: number | null = null;
  private workCapTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Work the hard cap already released. It stays listed (honestly) until it
   * drains, but never holds the inhibitor again: otherwise any later work would
   * re-acquire and the wedged reason would keep it held for a fresh full cap.
   */
  private readonly cappedWork = new Set<string>();
  /** When each named hold began, so the cap releases only work that has really run that long. */
  private readonly workStartedAt = new Map<string, number>();
  /** Set by stop(): a stopped manager never acquires again (its exit hooks are gone). */
  private stopped = false;
  private unbindWorkSignals: (() => void) | null = null;
  private keepAwakeHandle: PowerInhibitHandle | null = null;
  private keepAwakeEnabled = false;
  /** Whether the last attempt to save the toggle failed (the toggle then reverts on restart). */
  private keepAwakePersistFailed = false;
  /** Whether the seam can hold inhibitors at all; null until start() has asked. */
  private seamAvailable: boolean | null = null;
  private readonly sleepHooks: PowerSleepEdgeHooks[] = [];
  private unsubscribeSleepEdge: (() => void) | null = null;
  private unsubscribeKeepAwakeConfig: (() => void) | null = null;
  private unregisterExitHooks: (() => void) | null = null;
  /** Serializes acquire/release transitions so async seam calls never race. */
  private transition: Promise<void> = Promise.resolve();
  /** Sleep and wake edges run one after another: a wake hook must not overlap the sleep hooks before it. */
  private sleepEdges: Promise<void> = Promise.resolve();

  constructor(private readonly options: PowerManagerOptions) {
    if (options.workSignalBus) this.unbindWorkSignals = bindPowerWorkSignals(options.workSignalBus, this);
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.options.timers?.setTimeout ?? setTimeout)(fn, ms);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    (this.options.timers?.clearTimeout ?? clearTimeout)(timer);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private readBool(key: string, fallback: boolean): boolean {
    const value = this.options.readConfig?.(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  private capMinutes(): number {
    const value = this.options.readConfig?.('power.workInhibitMaxMinutes');
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_WORK_CAP_MINUTES;
  }

  /**
   * Start: reap dead-owner orphan inhibitors, register exit/signal cleanup,
   * apply the persisted keep-awake toggle, watch the sleep edge, and subscribe
   * keep-awake to live config changes.
   */
  async start(): Promise<void> {
    // A previous process that CRASHED could not release its inhibit children;
    // stamped holds let this start reap exactly those (never a live owner's).
    if (this.stopped) return;
    try {
      await this.options.seam.reapOrphans?.();
    } catch (error) {
      logger.warn('[power] orphan-inhibitor reap failed', { error: summarizeError(error) });
    }
    // stop() may have run while the reap was in flight.
    if (this.stopped) return;
    try {
      this.seamAvailable = await this.options.seam.isAvailable();
    } catch (error) {
      logger.warn('[power] availability check failed; assuming the host can hold inhibitors', { error: summarizeError(error) });
    }
    if (this.stopped) return;
    if (this.options.seam.onPrepareForSleep) {
      this.unsubscribeSleepEdge = this.options.seam.onPrepareForSleep((sleeping) => {
        void this.queueSleepEdge(sleeping);
      });
    }
    // Exit/signal cleanup at the source: an exiting process must never leave
    // an inhibitor blocking host sleep with no owner.
    this.unregisterExitHooks ??= (this.options.registerProcessExitHooks ?? defaultRegisterProcessExitHooks)(
      () => this.releaseAllHoldsNow(),
    );
    if (this.readBool('power.keepAwake', false)) {
      await this.setKeepAwake(true, { persist: false });
    }
    if (this.stopped) return;
    // Live-apply: a persist-only settings write (or an external file edit
    // applied by the config watcher) flips the real inhibitor, not just disk.
    this.unsubscribeKeepAwakeConfig ??= this.options.subscribeConfig?.('power.keepAwake', (newValue) => {
      const enabled = newValue === true;
      if (enabled === this.keepAwakeEnabled) return;
      void this.setKeepAwake(enabled, { persist: false }).catch((error) => {
        logger.warn('[power] live keep-awake apply failed', { error: summarizeError(error) });
      });
    }) ?? null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unbindWorkSignals?.();
    this.unbindWorkSignals = null;
    this.workReasons.clear();
    this.workStartedAt.clear();
    this.cappedWork.clear();
    this.unsubscribeSleepEdge?.();
    this.unsubscribeSleepEdge = null;
    this.unsubscribeKeepAwakeConfig?.();
    this.unsubscribeKeepAwakeConfig = null;
    this.unregisterExitHooks?.();
    this.unregisterExitHooks = null;
    if (this.workCapTimer) this.clearTimer(this.workCapTimer);
    this.workCapTimer = null;
    await this.enqueue(async () => {
      await this.workHandle?.release();
      this.workHandle = null;
      this.workHeldSince = null;
      await this.keepAwakeHandle?.release();
      this.keepAwakeHandle = null;
    });
  }

  /**
   * Release every held inhibitor NOW, without awaiting, for process-exit
   * paths where only synchronous work runs. The seam handles kill their
   * inhibit children synchronously before their first await, so the children
   * are signalled even from an 'exit' handler.
   */
  releaseAllHoldsNow(): void {
    if (this.workCapTimer) {
      this.clearTimer(this.workCapTimer);
      this.workCapTimer = null;
    }
    const work = this.workHandle;
    const keepAwake = this.keepAwakeHandle;
    this.workHandle = null;
    this.workHeldSince = null;
    this.keepAwakeHandle = null;
    void work?.release().catch(() => undefined);
    void keepAwake?.release().catch(() => undefined);
  }

  /** Register sleep-edge hooks (checkpoint on sleep, catch-up on wake). */
  onSleepEdge(hooks: PowerSleepEdgeHooks): () => void {
    this.sleepHooks.push(hooks);
    return () => {
      const index = this.sleepHooks.indexOf(hooks);
      if (index >= 0) this.sleepHooks.splice(index, 1);
    };
  }

  /**
   * Hold the work inhibitor for a named piece of real work. Idempotent per id;
   * the state lists every live reason. No-op when power.inhibitWhileWorking
   * is off or the platform has no inhibitor support.
   */
  holdWork(id: string, reason: string): void {
    if (this.stopped || !this.readBool('power.inhibitWhileWorking', true)) return;
    if (!this.workReasons.has(id)) this.workStartedAt.set(id, this.now());
    this.workReasons.set(id, reason);
    void this.enqueue(() => this.reconcileWork());
  }

  /** Release one named work hold; the inhibitor drops when the last drains. */
  releaseWork(id: string): void {
    this.cappedWork.delete(id);
    this.workStartedAt.delete(id);
    if (!this.workReasons.delete(id) || this.stopped) return;
    void this.enqueue(() => this.reconcileWork());
  }

  /**
   * The owner toggle: daemon-held keep-awake, independent of work state.
   * Persisted (power.keepAwake) so it survives restarts and surface closes.
   */
  async setKeepAwake(enabled: boolean, options: { persist?: boolean } = {}): Promise<PowerState> {
    if (this.stopped) {
      const state = this.getState();
      return { ...state, keepAwake: { ...state.keepAwake, note: KEEP_AWAKE_REQUEST_NOT_APPLIED } };
    }
    this.keepAwakeEnabled = enabled;
    if (options.persist !== false) {
      try {
        this.options.writeConfig?.('power.keepAwake', enabled);
        this.keepAwakePersistFailed = false;
      } catch (error) {
        this.keepAwakePersistFailed = true;
        logger.warn('[power] keep-awake persist failed', { error: summarizeError(error) });
      }
    }
    await this.enqueue(async () => {
      if (enabled) await this.acquireKeepAwake();
      else if (this.keepAwakeHandle) {
        await this.keepAwakeHandle.release();
        this.keepAwakeHandle = null;
      }
    });
    this.emitState();
    return this.getState();
  }

  /** Acquire the keep-awake inhibitor when the toggle wants one and none is held (also the retry). */
  private async acquireKeepAwake(): Promise<void> {
    if (this.stopped || !this.keepAwakeEnabled || this.keepAwakeHandle) return;
    const handle = await this.options.seam.inhibit({
      classes: KEEP_AWAKE_CLASSES,
      who: 'goodvibes keep-awake',
      why: 'owner keep-awake toggle: stay reachable after work finishes',
    });
    // Turned off or stopped while the OS was answering: give the grant straight back.
    if (handle && (this.stopped || !this.keepAwakeEnabled)) { await handle.release(); return; }
    this.keepAwakeHandle = handle;
    if (handle) this.watchForLoss(handle, 'keep-awake');
  }

  /**
   * An OS hold that ends on its own (inhibit child killed, logind restarted)
   * must stop being reported as held; the lost hold is then re-acquired when
   * the toggle or the work still wants it.
   */
  private watchForLoss(handle: PowerInhibitHandle, kind: 'work' | 'keep-awake'): void {
    handle.onLost?.(() => {
      void this.enqueue(async () => {
        if (kind === 'work') {
          if (this.workHandle !== handle) return;
          logger.warn('[power] the work inhibitor was lost; re-acquiring if work is still running');
          this.workHandle = null;
          this.workHeldSince = null;
          if (this.workCapTimer) {
            this.clearTimer(this.workCapTimer);
            this.workCapTimer = null;
          }
          await this.reconcileWork();
          return;
        }
        if (this.keepAwakeHandle !== handle) return;
        logger.warn('[power] the keep-awake inhibitor was lost; re-acquiring');
        this.keepAwakeHandle = null;
        await this.acquireKeepAwake();
        this.emitState();
      });
    });
  }

  /** The state the contract serves; surfaces render the always-visible chip from it. */
  getState(): PowerState {
    const capMinutes = this.capMinutes();
    const keepAwakeDenied = this.keepAwakeHandle?.deniedClasses ?? [];
    return {
      platform: this.options.seam.platform,
      work: {
        held: this.workHandle !== null,
        grantedClasses: this.workHandle?.grantedClasses ?? [],
        deniedClasses: this.workHandle?.deniedClasses ?? [],
        reasons: [...this.workReasons.values()],
        heldSince: this.workHeldSince,
        capMinutes,
        capExpiresAt: this.workHeldSince !== null ? this.workHeldSince + capMinutes * 60_000 : null,
        capExpired: this.cappedWork.size > 0,
      },
      keepAwake: {
        enabled: this.keepAwakeEnabled,
        held: this.keepAwakeHandle !== null,
        grantedClasses: this.keepAwakeHandle?.grantedClasses ?? [],
        deniedClasses: keepAwakeDenied,
        note: this.keepAwakeNote(keepAwakeDenied),
      },
    };
  }

  private keepAwakeNote(denied: readonly PowerInhibitClass[]): string | null {
    const parts: string[] = [];
    if (this.keepAwakeEnabled && !this.keepAwakeHandle) {
      parts.push(this.seamAvailable === false ? keepAwakeUnsupportedNote(this.options.seam.platform) : KEEP_AWAKE_NOT_HELD);
    } else if (this.keepAwakeHandle && denied.includes('handle-lid-switch')) {
      parts.push(LID_SWITCH_HONEST_SPLIT);
    }
    if (this.keepAwakePersistFailed) parts.push(KEEP_AWAKE_NOT_SAVED);
    return parts.length > 0 ? parts.join('; ') : null;
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(step).catch((error) => {
      logger.warn('[power] inhibitor transition failed', { error: summarizeError(error) });
    });
    return this.transition;
  }

  private async reconcileWork(): Promise<void> {
    if (this.stopped) return;
    const live = [...this.workReasons].filter(([id]) => !this.cappedWork.has(id));
    const shouldHold = live.length > 0;
    if (shouldHold && !this.workHandle) {
      const handle = await this.options.seam.inhibit({
        classes: WORK_CLASSES,
        who: 'goodvibes work',
        why: live.map(([, reason]) => reason).join('; ') || 'work running',
      });
      if (handle && this.stopped) { await handle.release(); return; }
      this.workHandle = handle;
      if (this.workHandle) {
        this.workHeldSince = this.now();
        this.armWorkCap();
        this.watchForLoss(this.workHandle, 'work');
      }
    } else if (!shouldHold && this.workHandle) {
      await this.workHandle.release();
      this.workHandle = null;
      this.workHeldSince = null;
      if (this.workCapTimer) {
        this.clearTimer(this.workCapTimer);
        this.workCapTimer = null;
      }
    }
    this.emitState();
  }

  /** The hard cap: a wedged hold cannot pin the host awake forever. */
  private armWorkCap(): void {
    if (this.workCapTimer) this.clearTimer(this.workCapTimer);
    const capped = this.workHandle;
    const capMs = this.capMinutes() * 60_000;
    this.workCapTimer = this.setTimer(() => {
      this.workCapTimer = null;
      void this.enqueue(async () => {
        // A drain and re-acquire queued ahead of this release owns a fresh handle and its own cap.
        if (this.workHandle !== capped || this.stopped) return;
        const now = this.now();
        for (const [id, startedAt] of this.workStartedAt) if (now - startedAt >= capMs) this.cappedWork.add(id);
        logger.warn('[power] work inhibitor hard cap reached; releasing (work holds remain listed honestly)', {
          capMinutes: this.capMinutes(),
          reasons: [...this.workReasons].filter(([id]) => this.cappedWork.has(id)).map(([, reason]) => reason),
        });
        await capped?.release();
        this.workHandle = null;
        this.workHeldSince = null;
        // Work that started recently is not wedged: it gets its own hold and cap.
        await this.reconcileWork();
      });
    }, capMs);
    (this.workCapTimer as { unref?: () => void }).unref?.();
  }

  private queueSleepEdge(sleeping: boolean): Promise<void> {
    // handleSleepEdge never rejects, so the chain cannot wedge.
    this.sleepEdges = this.sleepEdges.then(() => this.handleSleepEdge(sleeping));
    return this.sleepEdges;
  }

  private async handleSleepEdge(sleeping: boolean): Promise<void> {
    // A keep-awake the OS refused earlier gets another try once the host is back.
    if (!sleeping) await this.enqueue(() => this.acquireKeepAwake());
    for (const hooks of [...this.sleepHooks]) {
      try {
        if (sleeping) await hooks.onSleep?.();
        else await hooks.onWake?.();
      } catch (error) {
        logger.warn('[power] sleep-edge hook failed', { sleeping, error: summarizeError(error) });
      }
    }
    this.emitState();
  }

  private emitState(): void {
    try {
      this.options.onStateChanged?.(this.getState());
    } catch (error) {
      logger.warn('[power] state-change emit failed', { error: summarizeError(error) });
    }
  }
}
