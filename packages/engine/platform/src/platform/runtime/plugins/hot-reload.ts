/**
 * Safe hot-reload protocol for plugins.
 *
 * Implements the 6-phase hot-reload sequence:
 *   1. Quiesce  , refuse new calls into the plugin and drain in-flight ones
 *   2. Unregister, remove plugin's registrations (commands, tools, hooks)
 *   3. Unload    - deactivate and clean up the previous plugin instance
 *   4. Reload   , load the new version with a cache-bust timestamp
 *   5. Re-register, new instance calls init/activate (registers naturally)
 *   6. Health check → active (healthy) or degraded (unhealthy)
 */

import { logger } from '../../utils/logger.js';
import type { PluginLoaderDeps } from '../../plugins/loader.js';
import type { LoadedPlugin } from '../../plugins/loader.js';
import type { PluginHealthCheckResult, PluginManifestV2 } from './types.js';
import type { PluginLifecycleManager } from './manager.js';
import { isReloadable } from './lifecycle.js';
import { summarizeError } from '../../utils/error-display.js';
import { DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS } from '../../plugins/in-flight.js';

/**
 * Options for a single plugin hot-reload operation.
 */
export interface HotReloadOptions {
  /**
   * Callback to retrieve the current loaded plugin instance by name.
   * Used to call deactivate() and run cleanup before unloading.
   */
  getLoadedPlugin: (name: string) => LoadedPlugin | undefined;

  /**
   * Callback to remove a plugin's loaded instance from the host's registry.
   * Called after unload to clean up the host-side reference.
   */
  removeLoadedPlugin: (name: string) => void;

  /**
   * Callback to store the newly loaded plugin instance in the host's registry.
   * Called after a successful reload.
   */
  storeLoadedPlugin: (name: string, plugin: LoadedPlugin) => void;

  /**
   * Optional health check callback invoked after re-registration.
   * Return a PluginHealthCheckResult to indicate whether the plugin is healthy.
   * Defaults to a trivial healthy check.
   */
  healthCheck?: ((name: string) => Promise<PluginHealthCheckResult>) | undefined;

  /**
   * Maximum time (ms) to wait for the health check before timing out.
   * Defaults to 5000ms.
   */
  healthCheckTimeoutMs?: number | undefined;

  /**
   * Maximum time (ms) phase 1 waits for calls already running in the plugin to
   * finish before unloading it. When it passes with calls still running, the
   * reload stops with failedPhase 'quiesce' and the plugin stays loaded and
   * serving. Defaults to DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS (30000ms).
   */
  quiesceTimeoutMs?: number | undefined;
}

/**
 * Result of a hot-reload operation.
 */
export interface HotReloadResult {
  /** Whether the reload completed successfully and the plugin is healthy. */
  success: boolean;
  /** Phase that failed (if success === false). */
  failedPhase?: 'quiesce' | 'unregister' | 'unload' | 'reload' | 're-register' | 'health-check' | undefined;
  /** Error message (if success === false). */
  error?: string | undefined;
  /** Duration of the reload in milliseconds. */
  durationMs: number;
  /** Whether the plugin ended in degraded state (partial success). */
  degraded: boolean;
}

/** Default trivial health check, always returns healthy. */
async function defaultHealthCheck(name: string): Promise<PluginHealthCheckResult> {
  return {
    healthy: true,
    message: `${name}: health check passed (default)`,
    durationMs: 0,
  };
}

let lastCacheBust = 0;

/** Strictly increasing, so two reloads inside one millisecond never share an import URL and reuse the module the first one cached. */
function nextCacheBust(): number {
  lastCacheBust = Math.max(Date.now(), lastCacheBust + 1);
  return lastCacheBust;
}

/**
 * runHotReload, Execute the safe 6-phase hot-reload protocol for a single
 * plugin.
 *
 * @param name      - Plugin name.
 * @param manifest  - Current manifest for the plugin.
 * @param pluginDir - Absolute path to the plugin directory.
 * @param deps      - Loader dependencies (runtime bus, registries, etc.).
 * @param lcm       - PluginLifecycleManager to track state transitions.
 * @param options   - Host-side callbacks and configuration.
 * @returns HotReloadResult describing the outcome.
 */
export async function runHotReload(
  name: string,
  manifest: PluginManifestV2,
  pluginDir: string,
  deps: PluginLoaderDeps,
  lcm: PluginLifecycleManager,
  options: HotReloadOptions,
): Promise<HotReloadResult> {
  const startTs = Date.now();
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const timeoutMs = options.healthCheckTimeoutMs ?? 5000;

  const record = lcm.getRecord(name);
  if (!record) {
    return {
      success: false,
      failedPhase: 'quiesce',
      error: `Plugin '${name}' is not tracked by the lifecycle manager`,
      durationMs: Date.now() - startTs,
      degraded: false,
    };
  }

  // A plugin that is disabled, loading or unloading has no running instance to swap: reloading it
  // would "reload" something that is not there.
  if (!isReloadable(record.state)) {
    return failure(
      'quiesce',
      `Plugin '${name}' is in state '${record.state}' and cannot be hot-reloaded (reloadable states: active, loaded, degraded, error)`,
      startTs,
    );
  }

  const tracker = deps.inFlight;
  if (!tracker) {
    return failure(
      'quiesce',
      `Plugin '${name}' calls are not counted (PluginLoaderDeps.inFlight is not set), so they cannot be drained before unload`,
      startTs,
    );
  }
  const quiesceTimeoutMs = options.quiesceTimeoutMs ?? DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS;
  /** Accept calls again and clear the reloading flag (every exit path). */
  const endReload = (): void => {
    tracker.resume(name);
    lcm.setReloading(name, false);
  };
  /**
   * The old instance is gone and no new one is serving: the record must say so, not keep showing an
   * active plugin that does not exist.
   */
  const failAfterUnload = (phase: 'unload' | 'reload', error: string): HotReloadResult => {
    endReload();
    lcm.recordError(name, `Hot-reload failed in the ${phase} phase: ${error}`, true);
    return failure(phase, error, startTs);
  };

  logger.info(`[plugin-hot-reload] ${name}: starting hot-reload`);

  // ── Phase 1: Quiesce ────────────────────────────────────────────────────
  // Mark the plugin as reloading, refuse new calls into it (commands, tools,
  // gateway methods and event hooks it registered), and wait for the calls
  // already running to finish, bounded by quiesceTimeoutMs.
  lcm.setReloading(name, true);
  const drain = await tracker.quiesce(name, quiesceTimeoutMs);
  if (!drain.drained) {
    endReload();
    return failure(
      'quiesce',
      `${drain.inFlight} call(s) into plugin '${name}' still running after ${quiesceTimeoutMs}ms; the plugin was left loaded and serving`,
      startTs,
    );
  }
  logger.debug(`[plugin-hot-reload] ${name}: phase 1/6 quiesced (drained in ${drain.waitedMs}ms)`);

  // ── Phase 2: Prepare unregister ──────────────────────────────────────────
  // The existing plugin's cleanup callbacks handle un-registration during
  // unload, so there is no separate hook dispatch here.
  logger.debug(`[plugin-hot-reload] ${name}: phase 2/6 unregister scheduled with unload cleanup`);

  // ── Phase 3: Unload ─────────────────────────────────────────────────────
  try {
    const loaded = options.getLoadedPlugin(name);
    if (loaded) {
      const { unloadPlugin } = await import('../../plugins/loader.js');
      await unloadPlugin(loaded);
    }
    options.removeLoadedPlugin(name);
    logger.debug(`[plugin-hot-reload] ${name}: phase 3/6 unloaded`);
  } catch (err) {
    return failAfterUnload('unload', summarizeError(err));
  }

  // ── Phase 4 + 5: Reload + Re-register ──────────────────────────────────
  // loadPlugin calls init() and activate() which re-registers everything.
  let reloadedPlugin: import('../../plugins/loader.js').LoadedPlugin | null = null;
  try {
    const { loadPlugin } = await import('../../plugins/loader.js');
    const cacheBust = nextCacheBust();
    reloadedPlugin = await loadPlugin({ manifest, pluginDir }, deps, cacheBust);
    if (!reloadedPlugin) {
      return failAfterUnload('reload', 'loadPlugin returned null');
    }
    options.storeLoadedPlugin(name, reloadedPlugin);
    logger.debug(`[plugin-hot-reload] ${name}: phases 4+5/6 reloaded + re-registered`);
  } catch (err) {
    return failAfterUnload('reload', summarizeError(err));
  }
  // The new instance is registered: calls into it are accepted from here on,
  // so the health check can exercise it.
  tracker.resume(name);
  // A plugin left in `error` by a failed earlier reload (or `degraded`) is running again: record it
  // before the health check so a failing check can degrade it and a passing one leaves it active.
  lcm.recordReloaded(name);

  // ── Phase 6: Health check ────────────────────────────────────────────────
  let healthResult: PluginHealthCheckResult;
  try {
    healthResult = await Promise.race([
      healthCheck(name),
      new Promise<PluginHealthCheckResult>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    healthResult = {
      healthy: false,
      message: summarizeError(err),
      durationMs: Date.now() - startTs,
    };
  }

  endReload();

  if (healthResult.healthy) {
    logger.info(`[plugin-hot-reload] ${name}: hot-reload complete, active (${Date.now() - startTs}ms)`);
    return {
      success: true,
      durationMs: Date.now() - startTs,
      degraded: false,
    };
  } else {
    // Plugin loaded but health check failed → degraded.
    lcm.degradePlugin(name, `Health check failed: ${healthResult.message}`);
    logger.warn(`[plugin-hot-reload] ${name}: hot-reload complete, degraded (${healthResult.message})`);
    return {
      success: true, // reload succeeded; just in degraded state
      durationMs: Date.now() - startTs,
      degraded: true,
    };
  }
}

/** Build a failure result for a named phase. */
function failure(
  phase: HotReloadResult['failedPhase'],
  error: string,
  startTs: number,
): HotReloadResult {
  logger.error(`[plugin-hot-reload] phase '${String(phase)}' failed: ${error}`);
  return {
    success: false,
    failedPhase: phase,
    error,
    durationMs: Date.now() - startTs,
    degraded: false,
  };
}
