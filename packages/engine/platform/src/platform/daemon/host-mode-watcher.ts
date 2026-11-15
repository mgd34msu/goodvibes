/**
 * host-mode-watcher.ts
 *
 * Shared helpers for host-mode restart logic: a config-key watcher, and the
 * restart controller that owns the cycle itself (single-flight, a queued
 * change, the awaitable in-flight promise, and "listener is down after a
 * failed rebind").
 *
 * Both facade.ts and http-listener.ts delegate to these, passing only what
 * differs: how to tell a listener is bound, and how to run one detach-and-bind
 * pass. Extracted so the cycle's guarantees (a settled promise is never left
 * published, a change queued mid-cycle is never lost, a listener that is down
 * stays restartable) are held in one place and can be tested independently of
 * DaemonServer or HttpListener.
 */

import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema.js';

export interface HostModeWatcherOptions {
  /** The ConfigManager to subscribe on. */
  configManager: ConfigManager;
  /** Config keys that should trigger a restart when changed. */
  keys: ConfigKey[];
  /**
   * Called when a key change is detected and the server is running.
   * The implementation is responsible for performing stop + restart.
   * The caller is responsible for re-entrancy / dirty-flag semantics: if a
   * new change arrives while a prior restart is in progress, `onRestart`
   * will be invoked again. The caller must either guard against overlapping
   * cycles or queue the second cycle via its own dirty-flag mechanism.
   */
  onRestart: () => void;
  /** Returns true when the server/listener is currently running. */
  getIsRunning: () => boolean;
}

export interface HostModeWatcherHandle {
  /** Detach all subscriptions, safe to call multiple times. */
  unsubscribe: () => void;
}

/**
 * Create a host-mode restart watcher.
 *
 * Behaviour:
 * - Subscribes to each key in `keys`.
 * - When a key changes and `getIsRunning()` is true, calls `onRestart()`.
 * - The caller's `onRestart` implementation handles re-entrancy / dirty-flag
 *   logic internally (the watcher does NOT duplicate that logic).
 * - `unsubscribe()` removes all subscriptions; subsequent key changes do not
 *   trigger restarts.
 *
 * @param opts - Watcher configuration.
 * @returns A handle with an `unsubscribe` method.
 */
export function createHostModeRestartWatcher(opts: HostModeWatcherOptions): HostModeWatcherHandle {
  const { configManager, keys, onRestart, getIsRunning } = opts;

  const listener = (): void => {
    if (!getIsRunning()) return;
    onRestart();
  };

  const unsubs = keys.map((key) => configManager.subscribe(key, listener));

  return {
    unsubscribe: () => {
      for (const u of unsubs) u();
      // Clear the array so subsequent calls are no-ops.
      unsubs.length = 0;
    },
  };
}

export interface RestartControllerOptions {
  /** True while a listener is bound. */
  isRunning: () => boolean;
  /**
   * One detach-and-bind pass. It may call `takeDirty()` to consume changes it
   * has already folded in; whatever is still queued when it settles starts the
   * next pass.
   */
  run: () => Promise<void>;
  /** A pass threw. The cycle still settles and the listener stays restartable. */
  onError: (error: unknown) => void;
}

/**
 * The restart cycle shared by the control-plane listener and the HTTP
 * listener. `request()` is what a config watcher calls.
 */
export class RestartController {
  private _restarting = false;
  private _dirty = false;
  private _closed = false;
  private _down = false;
  private _pending: Promise<void> | null = null;

  constructor(private readonly options: RestartControllerOptions) {}

  /** A cycle is in flight. Changes arriving now are queued, not started. */
  get restarting(): boolean { return this._restarting; }
  /** A change arrived while a cycle was running and has not been consumed. */
  get dirty(): boolean { return this._dirty; }
  /** Admission is permanently closed: nothing starts, nothing is queued. */
  get closed(): boolean { return this._closed; }
  /** The last pass ended with nothing bound; a corrected setting must still rebind. */
  get down(): boolean { return this._down; }
  /** The in-flight cycle, or null when idle. Never a settled promise. */
  get pending(): Promise<void> | null { return this._pending; }
  /** Whether a config change should reach `request()`: bound, mid-cycle, or down after a failed cycle. */
  get active(): boolean { return this.options.isRunning() || this._restarting || this._down; }

  /**
   * The owner says whether a listener is down after a failed pass. The owner
   * decides, not the controller: a pass that ends because the daemon is
   * stopping also leaves nothing bound, and that must not look restartable.
   */
  setDown(down: boolean): void { this._down = down; }

  /** Read and clear the queued-change flag. */
  takeDirty(): boolean {
    const was = this._dirty;
    this._dirty = false;
    return was;
  }

  /** An intentional stop: forget a queued change and a down listener. Not while a cycle runs. */
  reset(): void {
    this._dirty = false;
    this._down = false;
  }

  /** Permanently close admission. Work already admitted stays awaitable through `pending`. */
  fence(): void {
    this._closed = true;
    this._dirty = false;
  }

  request(): void {
    if (this._closed) return;
    if (this._restarting) {
      // A change arrived mid-cycle: queue exactly one more pass. Checked
      // before `isRunning`, a pass detaches the listener before it rebinds.
      this._dirty = true;
      return;
    }
    if (!this.options.isRunning() && !this._down) return;
    this._restarting = true;
    this._pending = (async () => {
      try {
        await this.options.run();
      } catch (error) {
        this.options.onError(error);
      } finally {
        this._restarting = false;
        // Retire this cycle before starting a queued one: request() may
        // decline, and a settled promise left published would spin every
        // waiter that loops on `pending`.
        this._pending = null;
        const again = this._dirty && !this._closed;
        this._dirty = false;
        if (again) this.request();
      }
    })();
  }
}
