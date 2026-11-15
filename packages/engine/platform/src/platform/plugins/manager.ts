import { assertSecurityReadSource, captureSecurityReadBindings, captureSecurityReadData, captureSecurityPluginFiles, retainSecurityReadData } from '../security/read-source.js';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { resolve, sep } from 'node:path';
import {
  discoverAllPlugins,
  discoverPlugins,
  getPluginDirectories,
  getUserPluginDirectory,
  loadPlugin,
  unloadPlugin,
  PluginCleanupError,
  type DiscoveredPlugin,
  type LoadedPlugin,
  type PluginLoaderDeps,
  type PluginPathOptions,
} from './loader.js';
import {
  PluginTrustStore,
  type PluginTrustTier,
  type PluginTrustRecord,
  type SignatureValidationResult,
} from '../runtime/plugins/trust.js';
import { PluginQuarantineEngine, type QuarantineRecord } from '../runtime/plugins/quarantine.js';
import { isHighRiskCapability, resolveCapabilityManifest } from '../runtime/plugins/manifest.js';
import type { PluginCapability, PluginManifestV2 } from '../runtime/plugins/types.js';
import { summarizeError } from '../utils/error-display.js';
import { DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS, PluginClosedError, PluginInFlightTracker } from './in-flight.js';

/**
 * PluginState, Persisted state for all plugins.
 */
interface PluginState {
  /** Map of plugin name → enabled boolean. */
  enabled: Record<string, boolean>;
  /**
   * Map of plugin name → directory the plugin was enabled from. An enabled
   * flag belongs to that directory only: a same-named plugin in another
   * search directory (a repository's `.goodvibes/plugins`) is not loaded
   * under it. Absent for a plugin enabled before this was recorded; it is
   * bound to the directory it is first found in.
   */
  enabledDirs: Record<string, string>;
  /** Map of plugin name → plugin-specific config. */
  config: Record<string, Record<string, unknown>>;
  /** Map of plugin name → trust record. */
  trust: Record<string, PluginTrustRecord>;
  /** Map of plugin name → quarantine record. */
  quarantine: Record<string, QuarantineRecord>;
}

/**
 * PluginStatus, Public-facing plugin info for /plugin list.
 */
export interface PluginStatus {
  name: string;
  version: string;
  description: string;
  author?: string | undefined;
  enabled: boolean;
  active: boolean;
  /** Trust tier for this plugin. */
  trustTier: PluginTrustTier;
  /** Whether this plugin is currently quarantined. */
  quarantined: boolean;
}

export interface PluginManagerObserver {
  subscribe(callback: () => void): () => void;
  list(): PluginStatus[];
  capabilities(name: string): {
    ok: boolean;
    error?: string | undefined;
    requested: string[];
    highRisk: string[];
    safe: string[];
    tier: PluginTrustTier;
    blocked: string[];
  } | null;
  getTrustRecord(name: string): Readonly<PluginTrustRecord> | undefined;
  getQuarantineRecord(name: string): Readonly<QuarantineRecord> | undefined;
}

const DEFAULT_STATE: PluginState = { enabled: {}, enabledDirs: {}, config: {}, trust: {}, quarantine: {} };

export interface PluginManagerOptions {
  readonly pathOptions: PluginPathOptions;
  readonly stateFilePath?: string | undefined;
}

/** Outcome of PluginManager.reload(). */
export interface PluginReloadSummary {
  reloaded: number;
  /** Plugins that failed to load, plus every plugin in notDrained. */
  failed: number;
  /**
   * Plugins left loaded on their current instance because calls into them
   * were still running when the quiesce timeout passed.
   */
  notDrained: string[];
  /** Enabled plugins skipped because they are quarantined; lift the quarantine and reload to load them. */
  quarantined?: string[] | undefined;
  /** Plugins that were unloaded but whose cleanup callbacks threw; they were still reloaded. */
  cleanupFailed?: string[] | undefined;
  /** Plugins that did not start, each with the reason it gave. */
  loadFailed?: { readonly name: string; readonly reason: string }[] | undefined;
}

/** Result of a plugin lifecycle verb that persists operator state. */
export interface PluginQuarantineResult {
  ok: boolean;
  error?: string;
  /**
   * Settles once any instance of the quarantined plugin, including one still
   * starting when the quarantine was applied, has been unloaded.
   */
  unloading?: Promise<void> | undefined;
}

/** Mechanical progress evidence for a caller awaiting plugin shutdown. */
export interface PluginShutdownStatus {
  readonly state: 'open' | 'closing' | 'closed' | 'failed';
  readonly lifecycleOperations: number;
  readonly pendingInstances: number;
  readonly activeCalls: readonly { readonly pluginName: string; readonly count: number }[];
  readonly cleanupFailures: number;
}

/**
 * PluginManager, orchestrates plugin discovery, loading, and persistence.
 */
const pluginReadSources = new WeakMap<PluginManager, () => () => void>();
const getPluginReadSources = pluginReadSources.get.bind(pluginReadSources);
const setPluginReadSources = pluginReadSources.set.bind(pluginReadSources);
export function capturePluginSecurityReadSource(manager: PluginManager): () => void {
  const capture = getPluginReadSources(manager); assertSecurityReadSource(capture !== undefined); return capture();
}
export class PluginManager {
  private readRevision = 0;
  private plugins = new Map<string, LoadedPlugin>();
  private state: PluginState = { ...DEFAULT_STATE, enabled: {}, enabledDirs: {}, config: {}, trust: {}, quarantine: {} };
  /** Lifecycle operations run one at a time, in the order they were asked for. */
  private operationTail: Promise<unknown> = Promise.resolve();
  private deps: PluginLoaderDeps | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private closeSettled = false;
  private closeFailures = 0;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly acquired = new Set<LoadedPlugin>();
  private readonly unloading = new WeakMap<LoadedPlugin, Promise<void>>();
  private readonly ownedCalls = new Map<PluginInFlightTracker, Set<string>>();
  private readonly cleanupErrors = new Set<PluginCleanupError>();
  /** Counts calls into loaded plugins so a reload can drain them first. */
  private inFlight = new PluginInFlightTracker();

  /** Trust store, manages tier records for all plugins. */
  private readonly trustStore = new PluginTrustStore();
  /** Quarantine engine, manages plugin quarantine state. */
  private readonly quarantineEngine = new PluginQuarantineEngine();
  private readonly subscribers = new Set<() => void>();
  private readonly pathOptions: PluginPathOptions;
  private readonly stateFilePath: string;

  constructor(options: PluginManagerOptions) {
    this.pathOptions = options.pathOptions;
    if (!options.stateFilePath) {
      throw new Error('PluginManager requires an explicit stateFilePath.');
    }
    this.stateFilePath = options.stateFilePath;
    setPluginReadSources(this, () => {
      const binding = captureSecurityReadBindings(this, ['closed', 'operations', 'readRevision', 'state', 'plugins', 'pathOptions', 'stateFilePath', 'trustStore', 'quarantineEngine', 'list', 'discoverPlugins']);
      assertSecurityReadSource(!this.closed && this.operations.size === 0);
      const revision = this.readRevision;
      const rawCurrent = retainSecurityReadData([this.state, this.pathOptions]);
      const filesCurrent = captureSecurityPluginFiles(getPluginDirectories(this.pathOptions));
      const statusCurrent = captureSecurityReadData(() => this.list());
      return () => {
        binding(); rawCurrent(); filesCurrent(); statusCurrent();
        assertSecurityReadSource(!this.closed && this.operations.size === 0 && this.readRevision === revision);
      };
    });
  }

  /**
   * init, Must be called once at startup with application dependencies.
   * Loads state from disk, then discovers and loads all enabled plugins.
   */
  init(deps: PluginLoaderDeps): Promise<void> {
    return this.ownOperation(async () => {
      if (deps.inFlight) this.inFlight = deps.inFlight;
      this.deps = { ...deps, inFlight: this.inFlight };
      this.loadState();
      await this.loadEnabledPlugins();
    });
  }

  /** Returns status for all discovered plugins (enabled or not). */
  list(): PluginStatus[] {
    const discovered = this.discoverPlugins();
    return discovered.map((d) => {
      const loaded = this.plugins.get(d.manifest.name);
      return {
        name: d.manifest.name,
        version: d.manifest.version,
        description: d.manifest.description,
        author: d.manifest.author,
        enabled: this.isEnabled(d.manifest.name),
        active: loaded?.active ?? false,
        trustTier: this.trustStore.getTier(d.manifest.name),
        quarantined: this.quarantineEngine.isQuarantined(d.manifest.name),
      };
    });
  }

  subscribe(callback: () => void): () => void {
    if (this.closed) return () => undefined;
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getTrustRecord(name: string): Readonly<PluginTrustRecord> | undefined {
    return this.trustStore.getRecord(name);
  }

  getQuarantineRecord(name: string): Readonly<QuarantineRecord> | undefined {
    return this.quarantineEngine.getRecord(name);
  }

  /**
   * trust, Set the trust tier for a plugin.
   *
   * For the `trusted` tier, prefer `trustSigned()` which also validates the
   * signature. This method is for operator-forced tier assignment.
   */
  trust(
    name: string,
    tier: PluginTrustTier,
    note?: string | undefined,
  ): { ok: boolean; error?: string } {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    // Warn if trying to manually set 'trusted' without a signed manifest.
    if (tier === 'trusted') {
      const manifest = discovered.manifest as { signature?: string };
      if (!manifest.signature) {
        logger.warn(
          `[plugins] '${name}' set to 'trusted' tier without a signed manifest, ` +
          'consider using /plugin verify first',
        );
      }
    }

    // Build the record off to the side and publish it only once it is on disk,
    // so a refused write leaves the live tier as it was.
    const record = new PluginTrustStore().setTier(name, tier, { note });
    const failure = this.commitState(() => { this.state.trust[name] = record; }, this.undoTrust(name));
    if (failure) return { ok: false, error: `Trust tier for '${name}' was not saved, ${failure}` };
    this.trustStore.importRecords({ [name]: record });
    logger.info(`[plugins] ${name}: trust tier set to '${tier}'`);
    this.notifySubscribers();
    return { ok: true };
  }

  /**
   * trustSigned, Elevate a plugin to `trusted` after validating its manifest signature.
   */
  trustSigned(
    name: string,
    publicKey?: string,
  ): { ok: boolean; fingerprint?: string | undefined; error?: string } {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    const manifest = discovered.manifest as {
      name: string;
      version: string;
      capabilities?: string[] | undefined;
      signature?: string | undefined;
    };

    const result = new PluginTrustStore().trustSigned(name, manifest, publicKey);
    if (!result.ok) {
      return { ok: false, error: result.reason };
    }

    const failure = this.commitState(() => { this.state.trust[name] = result.record; }, this.undoTrust(name));
    if (failure) return { ok: false, error: `Trust tier for '${name}' was not saved, ${failure}` };
    this.trustStore.importRecords({ [name]: result.record });
    this.notifySubscribers();
    return { ok: true, fingerprint: result.record.signatureFingerprint };
  }

  /**
   * verify, Inspect a plugin's manifest signature without changing its tier.
   */
  verify(name: string, publicKey?: string): { ok: boolean } & SignatureValidationResult {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, valid: false, reason: this.notFoundError(name) };
    }

    const manifest = discovered.manifest as {
      name: string;
      version: string;
      capabilities?: string[] | undefined;
      signature?: string | undefined;
    };

    const result = this.trustStore.verify(manifest, publicKey);
    return { ok: result.valid, ...result };
  }

  /**
   * capabilities, Return the capability information for a plugin.
   *
   * Returns the full set: requested, granted (based on current trust tier),
   * denied, and which capabilities are high-risk. `blocked` reports what the
   * trust tier withholds; plugins run in this process, so only quarantine
   * (which stops the plugin loading) is enforced, not per-capability blocks.
   */
  capabilities(name: string): {
    ok: boolean;
    error?: string | undefined;
    requested: string[];
    highRisk: string[];
    safe: string[];
    tier: PluginTrustTier;
    blocked: string[];
  } | null {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return null;
    }

    const manifest = discovered.manifest as { capabilities?: string[] };
    const requested = (manifest.capabilities ?? []) as PluginCapability[];
    const tier = this.trustStore.getTier(name);
    const highRisk = requested.filter((c) => isHighRiskCapability(c));
    const safe = requested.filter((c) => !isHighRiskCapability(c));
    // Capabilities blocked by current trust tier
    const blocked = tier !== 'trusted' ? highRisk : [];

    return { ok: true, requested, highRisk, safe, tier, blocked };
  }

  /**
   * quarantine, Apply quarantine to a plugin.
   *
   * This is the high-level operator path. It resolves the plugin's declared
   * capability manifest using the current trust tier, then applies quarantine
   * immediately to the resolved capability set.
   */
  quarantine(
    name: string,
    reason: string,
  ): PluginQuarantineResult {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    if (this.quarantineEngine.isQuarantined(name)) {
      return { ok: false, error: `Plugin '${name}' is already quarantined` };
    }

    const trustTier = this.trustStore.getTier(name);
    const capabilityManifest = resolveCapabilityManifest(
      name,
      discovered.manifest as PluginManifestV2,
      undefined,
      trustTier,
    );

    const record = new PluginQuarantineEngine().quarantine(name, capabilityManifest, reason);
    if (!record) {
      return { ok: false, error: `Failed to quarantine '${name}'` };
    }

    const stored = { ...record, revokedCapabilities: [...record.revokedCapabilities] };
    const failure = this.commitState(() => { this.state.quarantine[name] = stored; }, this.undoQuarantine(name));
    if (failure) return { ok: false, error: `Quarantine of '${name}' was not saved, ${failure}` };
    this.quarantineEngine.importRecords({ [name]: stored });
    logger.warn(`[plugins] ${name}: quarantined, ${reason}`);

    // Plugins run in this process, so quarantine means "not running". The
    // unload joins the operation queue so a reload cannot start it again first.
    // Whether an instance exists is decided inside the queued operation: an
    // enable or reload that is still initialising has not stored its instance
    // yet, and it must be unloaded once it has.
    const unloading = this.ownOperation(async () => {
      const loaded = this.plugins.get(name);
      if (!loaded) return;
      try {
        await this.unload(loaded);
      } finally {
        this.plugins.delete(name);
        this.notifySubscribers();
      }
    });
    this.notifySubscribers();
    return { ok: true, unloading };
  }

  /**
   * liftQuarantine, Remove quarantine from a plugin.
   */
  liftQuarantine(name: string): { ok: boolean; error?: string } {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    if (!this.quarantineEngine.isQuarantined(name)) {
      return { ok: false, error: `Plugin '${name}' is not quarantined` };
    }
    const current = this.quarantineEngine.getRecord(name);
    if (!current) return { ok: false, error: `Plugin '${name}' is not quarantined` };
    const lifted = { ...current, revokedCapabilities: [...current.revokedCapabilities], lifted: true, liftedAt: Date.now() };
    const failure = this.commitState(() => { this.state.quarantine[name] = lifted; }, this.undoQuarantine(name));
    if (failure) return { ok: false, error: `Lifting the quarantine of '${name}' was not saved, ${failure}` };
    this.quarantineEngine.importRecords({ [name]: lifted });
    logger.info(`[plugins] ${name}: quarantine lifted`);
    this.notifySubscribers();
    return { ok: true };
  }

  /** Enable a plugin by name. Loads it immediately if deps are available. */
  enable(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.ownOperation(async () => {
      // A flag with no recorded directory is one the repository copy was refused
      // under; enabling again is how the owner chooses a copy.
      if (this.isEnabled(name) && (this.plugins.has(name) || this.state.enabledDirs[name] !== undefined)) {
        return { ok: false, error: `Plugin '${name}' is already enabled` };
      }

      const discovered = this.findDiscoveredPlugin(name);
      if (!discovered) {
        return { ok: false, error: this.notFoundError(name) };
      }

      if (this.quarantineEngine.isQuarantined(name)) {
        return { ok: false, error: `Plugin '${name}' is quarantined and will not load; lift the quarantine first` };
      }

      const failure = this.commitState(() => {
        this.state.enabled[name] = true;
        this.state.enabledDirs[name] = resolve(discovered.pluginDir);
      }, this.undoEnabled(name));
      if (failure) return { ok: false, error: `Plugin '${name}' was not enabled, the change could not be saved: ${failure}` };

      if (this.deps) {
        const { loaded, failure } = await this.acquireOrFail(discovered, this.deps);
        if (loaded) {
          this.plugins.set(name, loaded);
          this.notifySubscribers();
        } else {
          // The admitted operator preference was already saved. Shutdown can
          // refuse registrations during init; retain that intent for restart.
          if (this.closed) return { ok: false, error: 'Plugin manager closed during enable; enabled preference retained' };
          // Revert enable on load failure
          delete this.state.enabled[name];
          delete this.state.enabledDirs[name];
          this.saveState();
          return { ok: false, error: `Plugin '${name}' did not start and was left disabled: ${failure ?? 'see the log for the reason'}` };
        }
      }

      return this.closed ? { ok: false, error: 'Plugin manager closed during enable' } : { ok: true };
    });
  }

  /** Disable a plugin by name. Deactivates it immediately if active. */
  disable(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.ownOperation(async () => {
      if (!this.isEnabled(name)) {
        return { ok: false, error: `Plugin '${name}' is not enabled` };
      }

      // A cleanup callback that throws still leaves the plugin unloaded, so
      // the plugin is disabled either way; the error is raised after the
      // state is consistent.
      let cleanupError: unknown;
      const loaded = this.plugins.get(name);
      if (loaded) {
        try {
          await this.unload(loaded);
        } catch (error) {
          cleanupError = error;
        }
        this.plugins.delete(name);
      }

      delete this.state.enabled[name];
      delete this.state.enabledDirs[name];
      const failure = this.saveState();
      this.notifySubscribers();
      if (cleanupError !== undefined) throw cleanupError;
      // The plugin is stopped now, but a state file that was not written
      // would enable it again at the next start; say so rather than report success.
      if (failure !== undefined) return { ok: false, error: `Plugin '${name}' was stopped, but the change could not be saved and it will be enabled again on restart: ${failure}` };
      return { ok: true };
    });
  }

  /**
   * Reload all currently enabled plugins (deactivate then reactivate). Each
   * loaded plugin is quiesced first: new calls into it are refused and the
   * calls already running get up to `quiesceTimeoutMs` to finish. A plugin
   * still busy at the timeout is not reloaded; it stays on its current
   * instance and is reported in `notDrained`. A quarantined plugin is not
   * loaded and is reported in `quarantined`.
   */
  reload(options: { readonly quiesceTimeoutMs?: number | undefined } = {}): Promise<PluginReloadSummary> {
    return this.ownOperation(async () => {
      const quiesceTimeoutMs = options.quiesceTimeoutMs ?? DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS;
      const names = Object.keys(this.state.enabled).filter((n) => this.state.enabled[n]);
      const loadedNames = names.filter((name) => this.plugins.has(name));
      let reloaded = 0;
      let failed = 0;
      const cleanupFailed: string[] = [];
      const quarantined: string[] = [];
      const loadFailed: { name: string; reason: string }[] = [];

      const drains = await Promise.all(loadedNames.map(async (name) => ({
        name,
        drain: await this.inFlight.quiesce(name, quiesceTimeoutMs),
      })));
      if (this.closed) throw new PluginClosedError('manager');
      const notDrained = new Set<string>();
      for (const { name, drain } of drains) {
        if (drain.drained) continue;
        notDrained.add(name);
        this.inFlight.resume(name);
        logger.warn(`[plugins] ${name}: not reloaded, ${drain.inFlight} call(s) still running after ${quiesceTimeoutMs}ms`);
      }

      try {
        // Deactivate every drained plugin. One whose cleanup throws is already
        // inactive, so it is dropped and the rest of the reload still runs.
        for (const name of names) {
          if (notDrained.has(name)) continue;
          const loaded = this.plugins.get(name);
          if (loaded) {
            try {
              await this.unload(loaded);
            } catch (error) {
              cleanupFailed.push(name);
              if (error instanceof PluginCleanupError) this.cleanupErrors.add(error);
            }
            this.plugins.delete(name);
          }
        }

        // Reactivate with cache busting, append timestamp to force fresh import
        if (this.deps) {
          const cacheBust = Date.now();
          for (const d of this.enabledCandidates()) {
            if (this.closed) break;
            if (notDrained.has(d.manifest.name)) continue;
            if (this.quarantineEngine.isQuarantined(d.manifest.name)) {
              quarantined.push(d.manifest.name);
              logger.warn(`[plugins] ${d.manifest.name}: not loaded, plugin is quarantined`);
              continue;
            }
            // Pass cacheBust so loadPlugin appends ?t=<timestamp> to the import URL,
            // forcing Bun to bypass its module cache and re-execute the file.
            const { loaded, failure } = await this.acquireOrFail(d, this.deps, cacheBust);
            if (loaded) {
              this.plugins.set(d.manifest.name, loaded);
              reloaded++;
            } else {
              failed++;
              loadFailed.push({ name: d.manifest.name, reason: failure ?? 'see the log for the reason' });
            }
          }
        }
      } finally {
        for (const { name } of drains) this.inFlight.resume(name);
      }
      failed += notDrained.size;
      this.notifySubscribers();
      return {
        reloaded,
        failed,
        notDrained: [...notDrained],
        ...(quarantined.length > 0 ? { quarantined } : {}),
        ...(cleanupFailed.length > 0 ? { cleanupFailed } : {}),
        ...(loadFailed.length > 0 ? { loadFailed } : {}),
      };
    });
  }

  /** Returns whether a plugin is marked as enabled in persisted state. */
  isEnabled(name: string): boolean {
    return this.state.enabled[name] === true;
  }

  /** Returns plugin-specific config for a given plugin name. */
  getPluginConfig(name: string): Record<string, unknown> {
    return this.state.config[name] ?? {};
  }

  /**
   * Stop this manager's admission, await admitted lifecycle work and calls,
   * then release every acquired instance. Operator enable/trust/config state
   * stays unchanged. Unsettled plugin callbacks keep close pending; cleanup
   * failures reject after all instances have been attempted.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.readRevision++;
    this.closed = true;
    this.subscribers.clear();
    const drains: Promise<void>[] = [];
    for (const [tracker, names] of this.ownedCalls) {
      for (const name of names) drains.push(tracker.close(name));
    }
    const operations = [...this.operations];
    this.closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...drains, ...operations]);
      const errors: unknown[] = [...this.cleanupErrors];
      for (const loaded of [...this.acquired]) {
        try {
          await this.unload(loaded);
        } catch (error) {
          errors.push(error);
        }
      }
      this.plugins.clear();
      this.deps = undefined;
      this.closeFailures = errors.length;
      if (errors.length > 0) throw new AggregateError(errors, 'Plugin manager shutdown cleanup did not complete');
    });
    void this.closePromise.then(
      () => { this.closeSettled = true; },
      () => { this.closeSettled = true; },
    );
    return this.closePromise;
  }

  shutdownStatus(): PluginShutdownStatus {
    const counts = new Map<string, number>();
    for (const [tracker, names] of this.ownedCalls) {
      for (const name of names) {
        const count = tracker.inFlight(name);
        if (count > 0) counts.set(name, (counts.get(name) ?? 0) + count);
      }
    }
    return {
      state: !this.closed ? 'open' : !this.closeSettled ? 'closing' : this.closeFailures > 0 ? 'failed' : 'closed',
      lifecycleOperations: this.operations.size,
      pendingInstances: this.acquired.size,
      activeCalls: [...counts].map(([pluginName, count]) => ({ pluginName, count })),
      cleanupFailures: Math.max(this.closeFailures, this.cleanupErrors.size),
    };
  }

  private ownOperation<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new PluginClosedError('manager'));
    this.readRevision++;
    // Operations await across loads and unloads; running them one at a time
    // keeps a reload from loading a second instance of a plugin an enable is
    // still starting.
    const pending = this.operationTail.then(() => {
      if (this.closed) throw new PluginClosedError('manager');
      return action();
    });
    this.operationTail = pending.then(() => undefined, () => undefined);
    this.operations.add(pending);
    void pending.then(
      () => this.operations.delete(pending),
      (error: unknown) => {
        this.operations.delete(pending);
        if (error instanceof PluginCleanupError) this.cleanupErrors.add(error);
      },
    );
    return pending;
  }

  private async acquire(
    discovered: Parameters<typeof loadPlugin>[0],
    deps: PluginLoaderDeps,
    cacheBust?: number,
    onFailure?: (reason: string) => void,
  ): Promise<LoadedPlugin | null> {
    if (this.closed) { onFailure?.('the plugin manager is shutting down'); return null; }
    const tracker = deps.inFlight ?? this.inFlight;
    const names = this.ownedCalls.get(tracker) ?? new Set<string>();
    this.ownedCalls.set(tracker, names);
    names.add(discovered.manifest.name);
    const loaded = await loadPlugin(discovered, deps, cacheBust, { throwOnCleanupError: true, onFailure });
    if (loaded) this.acquired.add(loaded);
    return loaded;
  }

  /**
   * acquire for callers that carry on after one plugin fails: a load whose
   * cleanup also threw is still a failed load, and the cleanup error stays on
   * record for shutdown.
   */
  private async acquireOrFail(
    discovered: DiscoveredPlugin,
    deps: PluginLoaderDeps,
    cacheBust?: number,
  ): Promise<{ loaded: LoadedPlugin | null; cleanupError?: PluginCleanupError; failure?: string }> {
    let failure: string | undefined;
    const onFailure = (reason: string): void => { failure ??= reason; };
    try {
      const loaded = await this.acquire(discovered, deps, cacheBust, onFailure);
      return loaded ? { loaded } : { loaded, ...(failure !== undefined ? { failure } : {}) };
    } catch (error) {
      if (!(error instanceof PluginCleanupError)) throw error;
      this.cleanupErrors.add(error);
      return { loaded: null, cleanupError: error, ...(failure !== undefined ? { failure } : {}) };
    }
  }

  private unload(loaded: LoadedPlugin): Promise<void> {
    const prior = this.unloading.get(loaded);
    if (prior) return prior;
    const pending = Promise.resolve().then(async () => {
      try {
        await unloadPlugin(loaded, { throwOnCleanupError: true });
      } finally {
        this.acquired.delete(loaded);
        // A settled unload is not cached: the instance is inactive after it,
        // so a repeat is a no-op instead of replaying this call's rejection.
        this.unloading.delete(loaded);
      }
    });
    this.unloading.set(loaded, pending);
    return pending;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async loadEnabledPlugins(): Promise<void> {
    if (!this.deps) return;
    let firstCleanupError: PluginCleanupError | undefined;
    for (const d of this.enabledCandidates()) {
      if (this.closed) break;
      if (this.quarantineEngine.isQuarantined(d.manifest.name)) {
        logger.warn(`[plugins] ${d.manifest.name}: not loaded, plugin is quarantined`);
        continue;
      }
      const { loaded, cleanupError } = await this.acquireOrFail(d, this.deps);
      if (loaded) {
        this.plugins.set(d.manifest.name, loaded);
      }
      firstCleanupError ??= cleanupError;
    }
    this.notifySubscribers();
    // The remaining plugins were still loaded; the lifetime owner is told.
    if (firstCleanupError) throw firstCleanupError;
  }

  /**
   * The discovered copy of each enabled plugin, in search order. An enabled
   * flag belongs to the directory the plugin was enabled from, so a same-named
   * plugin elsewhere (a repository's own `.goodvibes/plugins`) is not run
   * under it. A plugin enabled before the directory was recorded is bound to
   * the directory it is found in now.
   */
  private enabledCandidates(): DiscoveredPlugin[] {
    const all = discoverAllPlugins(this.pathOptions);
    const chosen: DiscoveredPlugin[] = [];
    const seen = new Set<string>();
    const refused = new Set<string>();
    let adopted = false;
    for (const candidate of all) {
      const name = candidate.manifest.name;
      if (seen.has(name) || !this.isEnabled(name)) continue;
      const bound = this.state.enabledDirs[name];
      if (bound === undefined) {
        // An enable recorded before directories were kept never said which copy
        // the owner meant. A copy inside the repository was not chosen by them,
        // so it is not run until they enable it themselves.
        if (this.isRepositoryCopy(candidate)) {
          if (!refused.has(name)) logger.warn(`[plugins] ${name}: not loaded, the copy found in this repository was never enabled by you; enable it again to run it`);
          refused.add(name);
          continue;
        }
        this.state.enabledDirs[name] = resolve(candidate.pluginDir);
        adopted = true;
        seen.add(name);
        chosen.push(candidate);
        continue;
      }
      if (resolve(candidate.pluginDir) !== bound) continue;
      seen.add(name);
      chosen.push(candidate);
    }
    for (const name of Object.keys(this.state.enabled)) {
      if (this.state.enabled[name] && !seen.has(name) && !refused.has(name) && all.some((p) => p.manifest.name === name)) {
        logger.warn(`[plugins] ${name}: not loaded, it was enabled from '${this.state.enabledDirs[name]}' and that copy is no longer present; enable it again to use the copy found now`);
      }
    }
    if (adopted) this.saveState();
    return chosen;
  }

  /** True for a plugin under the working directory's own plugin folder rather than the user's. */
  private isRepositoryCopy(candidate: DiscoveredPlugin): boolean {
    const [repositoryRoot] = getPluginDirectories(this.pathOptions);
    if (repositoryRoot === undefined || resolve(repositoryRoot) === resolve(getUserPluginDirectory(this.pathOptions))) return false;
    const dir = resolve(candidate.pluginDir);
    return dir === resolve(repositoryRoot) || dir.startsWith(`${resolve(repositoryRoot)}${sep}`);
  }

  private loadState(): void {
    this.readRevision++;
    try {
      const parsed = readJsonFileOrQuarantine<Partial<PluginState>>(this.stateFilePath, {
        label: 'plugins/state',
        recovery: 'Every plugin returns to its default enabled state, trust decisions must be made again, and any recorded quarantine is cleared.',
        validate: (raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('plugin state file is not a JSON object');
          }
          return raw as Partial<PluginState>;
        },
      });
      if (parsed) {
        this.state.enabled = parsed.enabled ?? {};
        this.state.enabledDirs = parsed.enabledDirs ?? {};
        this.state.config = parsed.config ?? {};
        this.state.trust = parsed.trust ?? {};
        this.state.quarantine = parsed.quarantine ?? {};
        // Restore trust and quarantine state into their engines.
        if (Object.keys(this.state.trust).length > 0) {
          this.trustStore.importRecords(this.state.trust);
        }
        if (Object.keys(this.state.quarantine).length > 0) {
          this.quarantineEngine.importRecords(this.state.quarantine);
        }
      }
    } catch (err) {
      logger.warn(`[plugins] Could not load state: ${summarizeError(err)}`);
    }
  }

  /** Writes the state file; returns the reason when it could not be written. */
  private saveState(): string | undefined {
    this.readRevision++;
    try {
      writeJsonFileAtomic(this.stateFilePath, this.state, { trailingNewline: false });
      return undefined;
    } catch (err) {
      const reason = summarizeError(err);
      logger.warn(`[plugins] Could not save state: ${reason}`);
      return reason;
    }
  }

  /** Applies a state change and saves it; on a failed save the change is undone and the reason returned. */
  private commitState(apply: () => void, undo: () => void): string | undefined {
    apply();
    const failure = this.saveState();
    if (failure !== undefined) undo();
    return failure;
  }

  private undoTrust(name: string): () => void {
    const prior = this.state.trust[name];
    return () => { if (prior) this.state.trust[name] = prior; else delete this.state.trust[name]; };
  }

  private undoQuarantine(name: string): () => void {
    const prior = this.state.quarantine[name];
    return () => { if (prior) this.state.quarantine[name] = prior; else delete this.state.quarantine[name]; };
  }

  private undoEnabled(name: string): () => void {
    const priorEnabled = this.state.enabled[name];
    const priorDir = this.state.enabledDirs[name];
    return () => {
      if (priorEnabled === undefined) delete this.state.enabled[name]; else this.state.enabled[name] = priorEnabled;
      if (priorDir === undefined) delete this.state.enabledDirs[name]; else this.state.enabledDirs[name] = priorDir;
    };
  }

  private discoverPlugins() {
    return discoverPlugins(this.pathOptions);
  }

  private findDiscoveredPlugin(name: string) {
    return this.discoverPlugins().find((plugin) => plugin.manifest.name === name);
  }

  private notFoundError(name: string): string {
    return `Plugin '${name}' not found in configured plugin search directories (${this.describeSearchDirectories()})`;
  }

  private describeSearchDirectories(): string {
    return getPluginDirectories(this.pathOptions).join(', ');
  }

  private notifySubscribers(): void {
    this.readRevision++;
    if (this.closed) return;
    for (const callback of this.subscribers) {
      try {
        callback();
      } catch (err) {
        logger.warn('[plugins] subscriber callback failed', {
          error: summarizeError(err),
        });
      }
    }
  }

}
