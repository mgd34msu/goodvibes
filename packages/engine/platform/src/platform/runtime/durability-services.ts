/**
 * durability-services.ts, the data-safety and remembered-decision stores a
 * host composition wires, alongside createRuntimeServices:
 *
 *  - StoreSnapshotScheduler: a daily snapshot of the store that holds
 *    primary data (the memory store; the vector and code indexes are derived
 *    and get one copy before a migration instead), bounded by the retention
 *    engine. Timers are unref'd so an undisposed
 *    scheduler cannot pin the event loop; hosts that tear down a runtime
 *    stop() it themselves.
 *  - UserPermissionRuleStore: durable user-origin permission rules
 *    (remembered approvals), one store per project, shared by every
 *    PermissionManager built on this runtime; permissions.rules.*
 *    lists/deletes. Background init is fail-safe (asks just prompt).
 *  - One credential chain (env -> secrets -> subscription): boot applies
 *    secrets-backed keys; every secrets write/delete re-registers builtins
 *    LIVE (no restart), badges/picker/chat read the same instances.
 *  - Start-time retention janitor: one best-effort append-only sweep over
 *    EVERY root the composition knows (working dir, surface root, home,
 *    logDir, telemetryDir), omitting logDir/telemetryDir/home would silently
 *    skip the activity-log, telemetry-ledger, and recovery-snapshot stores.
 *  - Durability housekeeping: the crash-residue reclaim the retention janitor
 *    above does NOT cover, lock files of sessions a crashed process left,
 *    `.unrecognized` quarantine files, and anchor sidecars whose session is
 *    gone (see durability-housekeeping.ts). It runs at startup AND
 *    on a repeating unref'd timer, because a long-lived process that only
 *    sweeps at boot never sweeps; the returned disposer stops that timer.
 *  - Live config-file watch: external edits to the settings file apply through
 *    the same subscribe() pipeline an in-process set() uses, no restart. The
 *    underlying watchers are unref'd, so this never pins the event loop.
 */
import { AppendOnlyRetentionScheduler, runStartupAppendOnlySweep } from './retention/append-only-registry.js';
import { StoreSnapshotScheduler } from '../state/store-snapshots.js';
import { ownerPermissionRulesPath, UserPermissionRuleStore } from '../permissions/user-rule-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { startDurabilityHousekeeping } from './durability-housekeeping.js';
import { hasLiveCredentialRefresh } from './provider-stack.js';
import type { SessionSurface } from './session-surface.js';

export interface DurabilityServicesInput {
  readonly configManager: {
    getControlPlaneConfigDir(): string;
    getHomeDirectory(): string | null;
    get(key: never): unknown;
    watchConfigFiles(options?: { intervalMs?: number }): () => void;
  };
  readonly secretsManager: { onDidChange(listener: (key: string) => void): () => void };
  readonly providerRegistry: { refreshProviderCredentials(): Promise<void> };
  readonly memoryDbPath: string;
  /** Accepted for hosts that still pass it; the code index is derived and gets no daily snapshot. */
  readonly codeIndexDbPath?: string | undefined;
  /**
   * The product's declare-once storage handle. The retention-sweep roots below
   * are read straight off it rather than re-declared here, so the janitor can
   * never sweep a different scope than the one sessions and recovery
   * snapshots are actually written to.
   */
  readonly surface: SessionSurface;
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
  /** Where this product writes its activity log; default `<home>/.goodvibes/logs`. */
  readonly logDir?: string | undefined;
  /** Where this product writes its telemetry ledger; default `<home>/.goodvibes/telemetry`. */
  readonly telemetryDir?: string | undefined;
  /**
   * Resolves the live session id, read fresh on every crash-residue sweep so
   * the running session's anchor sidecar is exempt from reaping (its session
   * lock is held by this process, so the lock sweep cannot take it anyway).
   *
   * A getter, not a value: the id is reassigned in place when a recovery
   * snapshot is accepted, and this sweep repeats for the life of the process.
   */
  readonly currentSessionId?: () => string | null;
  /** Whether new work is admitted (daemon/work-admission.ts); the timed retention sweeps skip a tick while it is not. */
  readonly workAdmitted?: (() => boolean) | undefined;
}

export interface DurabilityServices {
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  /**
   * Re-sweeps every registered append-only store on a cadence. The start-time
   * sweep alone never prunes again in a process that stays up, which is the
   * window in which those stores grow. Unref'd timers; teardown stop()s it.
   */
  readonly appendOnlyRetentionScheduler: AppendOnlyRetentionScheduler;
  readonly userPermissionRuleStore: UserPermissionRuleStore;
  /**
   * Stops the repeating crash-residue sweep. The timer is unref'd, so a host
   * that never calls this is not held open by it; teardown calls it to stop
   * the work rather than to release the loop.
   */
  readonly stopDurabilityHousekeeping: () => void;
  /**
   * Stops the live external-change watches this factory started: the config-file
   * watch and the secrets-change listener that refreshes provider credentials.
   * After it runs a late secrets change no longer reaches the provider registry.
   */
  readonly stopConfigWatch: () => void;
}

export function createDurabilityServices(input: DurabilityServicesInput): DurabilityServices {
  const { configManager, secretsManager, providerRegistry } = input;
  // Credential refreshes run one at a time, in the order they were asked for, so
  // a secrets change during the boot refresh cannot finish before it and leave
  // the older credentials in place. A refresh queued before teardown is skipped
  // once the graph is stopped.
  let credentialWatchStopped = false;
  let credentialRefreshes: Promise<void> = Promise.resolve();
  const refreshCredentials = (label: string): void => {
    credentialRefreshes = credentialRefreshes.then(async () => {
      if (credentialWatchStopped) return;
      try {
        await providerRegistry.refreshProviderCredentials();
      } catch (error) {
        logger.warn(`${label} credential refresh failed`, { error: summarizeError(error) });
      }
    });
  };
  // A registry the provider stack already refreshes (boot and every secrets change) needs no second listener.
  const ownsCredentialRefresh = !hasLiveCredentialRefresh(providerRegistry);
  const stopCredentialWatch = ownsCredentialRefresh ? secretsManager.onDidChange(() => refreshCredentials('live')) : () => undefined;
  if (ownsCredentialRefresh) refreshCredentials('boot');

  // Primary data only: the memory vector index and the code index are derived and
  // rebuilt; they get one copy before a schema migration and no daily copy.
  const storeSnapshotScheduler = new StoreSnapshotScheduler({
    stores: [{ name: 'memory store', dbPath: input.memoryDbPath }],
    ...(input.workAdmitted ? { workAdmitted: input.workAdmitted } : {}),
  });
  storeSnapshotScheduler.start();

  // Start-time retention janitor: pass EVERY root the composition knows so the
  // activity-log, telemetry-ledger, and recovery-snapshot stores are all swept.
  // Best-effort, a retention failure never takes startup down (the sweep
  // swallows its own errors).
  const appendOnlyRetentionRoots = {
    workingDirectory: input.surface.workingDirectory,
    surfaceRoot: input.surface.surfaceRoot,
    homeDirectory: input.surface.homeDirectory,
    logDir: input.logDir ?? input.shellPaths.resolveUserPath('logs'),
    telemetryDir: input.telemetryDir ?? input.shellPaths.resolveUserPath('telemetry'),
  };
  const appendOnlyRetentionConfigGet = (k: string): unknown => configManager.get(k as never);
  runStartupAppendOnlySweep(appendOnlyRetentionRoots, appendOnlyRetentionConfigGet);
  // ...and again on a cadence for as long as this process lives. A start-time
  // sweep alone never prunes a long-lived session again after boot, which is
  // exactly the window in which these stores grow. Unref'd timers; the disposer
  // below stops it, same posture as storeSnapshotScheduler.
  const appendOnlyRetentionScheduler = new AppendOnlyRetentionScheduler({
    roots: appendOnlyRetentionRoots,
    configGet: appendOnlyRetentionConfigGet,
    ...(input.workAdmitted ? { workAdmitted: input.workAdmitted } : {}),
  });
  appendOnlyRetentionScheduler.start();
  // Crash-residue reclaim the sweep above does not cover (session lock files,
  // .unrecognized quarantine files, anchor
  // sidecars whose session file is gone). Runs once now and every few hours
  // after that; the timer is unref'd and the disposer stops it.
  const stopDurabilityHousekeeping = startDurabilityHousekeeping({
    surface: input.surface,
    ...(input.currentSessionId ? { currentSessionId: input.currentSessionId } : {}),
    extraQuarantineDirs: [configManager.getControlPlaneConfigDir()],
  }, input.workAdmitted ? { workAdmitted: input.workAdmitted } : {});
  // External config edits apply LIVE through the same subscribe() pipeline an
  // in-process set() uses; the underlying watchers are unref'd. The returned
  // handle is the only way to stop them, dropping it left a 250ms poll running
  // for the life of the process after the graph that started it was gone.
  const stopConfigFileWatch = configManager.watchConfigFiles();
  const stopConfigWatch = (): void => {
    credentialWatchStopped = true;
    stopCredentialWatch();
    stopConfigFileWatch();
  };

  const userPermissionRuleStore = new UserPermissionRuleStore(ownerPermissionRulesPath(configManager));
  void userPermissionRuleStore.init().catch((error) => logger.warn('user permission rule store init failed; asks will prompt', { error: summarizeError(error) }));

  return { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch };
}
