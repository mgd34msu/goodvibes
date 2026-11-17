import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes-jev/judgment/decisions';
import { postalConfigKey, POSTAL_PARTS, PostalAddressHeldError, type ProfilePostalReader, type PostalKind, type PostalReadOptions, type PreparedPostalAddress, type PostalParts } from './postal-address.js';
import { DurablePolicyEpochOwner } from './durable-policy-epoch.js';
import { PreparedSettingsTarget, settingsFileIdentity } from './prepared-target.js';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDeepStrictEqual } from 'node:util';
import { VERSION } from '../version.js';
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic, isClassicOperation, withDecisionModelPolicy } from '../runtime/decision-policy.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { ProcessLockBusyError } from '../utils/process-lock.js';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from './schema.js';
import { CONFIG_SCHEMA } from './schema.js';
import { ConfigError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookEvent } from '../hooks/types.js';
import { attachOwnedConfigHook } from './hook-attachment.js';
import { getManagedSettingLock } from '../runtime/settings/control-plane.js';
import { readHostManagedSettingLock, readHostManagedSettingLocks, readStrictManagedSettingLock } from '../runtime/settings/host-setting-policy-read.js';
import { requireSurfaceRoot, resolveSharedDirectory, resolveSurfaceDirectory, resolveSurfaceSharedFile } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import {
  SHARED_CONFIG_KEYS,
  isSharedConfigKey,
  readDotPath,
  readSharedTierFile,
  withSettingsFileLock,
} from './shared-config-tier.js';
import {
  deleteRawDotPath,
  readRawSettingsFile,
  writeRawDotPath,
} from './settings-io.js';
import { watchConfigFiles, reloadAndNotifyChanges, type ConfigFileWatchHandle } from './config-file-watcher.js';
import { isDaemonOwnedConfigKey, listDaemonOwnedConfigPaths, type DaemonOwnedConfigPath } from './config-ownership.js';
import { resolveOrCreateDaemonPath } from './daemon-tier-paths.js';
import { daemonConfigPath, overlayDaemonTierFrom, readDaemonTierFile } from './daemon-config-tier.js';
import { describeKeySource, type ConfigKeySource } from './manager-key-source.js';
import { DEFAULT_CONFIG_SNAPSHOT, cloneDefaultConfig, coerceSchemaValue, ensureSharedConfig, requireAbsoluteOwnedPath, sanitizeConfigShape } from './manager-bootstrap.js';
import { resolveWithProfileFallback, type ConfigProfileFallbackReader } from './profile-fallback.js';
import { ingestManagerSettings, toConfigLoadFailure, UnknownSettingFormsQueue, type IngestionNoticeSink, type SettingsIngestionNotice } from './manager-ingestion.js';
import { persistCategoryKeyRemoval, persistCategoryPatch, type CategoryIoDeps } from './manager-category-io.js';
import { configKeyFacts } from './config-key-facts.js';
import { refusal as buildRefusal, type Refusal } from '@goodvibes-jev/engine/errors';
import type { ToolDecision } from '../types/tools.js';
import { HostSettings, type HostBooleanSettingHandle, type HostManagedSettingLocks, type HostSetting, type HostSettingValue, type HostSettingValues } from './host-settings.js';
import { HostSettingsReadError, hostSettingsFileExists, readHostSettingValues, readHostSettingsFile, recoverHostSettingsWriteFailure } from './manager-host-settings.js';
import { ConfigRuntimeState, captureRuntimeValue } from './manager-runtime-state.js';
import { announceIngestionNotice } from './settings-ingestion.js';
import { SETTINGS_FLOOR_MARKER_KEY } from './settings-reader-floor.js';
import { isProjectRestrictedKey, restrictProjectLayer } from './project-layer-restrictions.js';
import { credentialValueRefusal, memoryBudgetRefusal, memoryTierOrderRefusal, nonSchemaKeyRefusal, schemaTypeRefusal } from './write-admission.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { freezePreparedData, normalizePreparedValue, preparedMutationLifecycle, preparedSchemaSignature, PreparedMutationRefusal, type PreparedMutationRecord,
  type PreparedConfigMutation, type PreparedConfigMutationTransition, type PreparedConfigMutationRequest,
  type PreparedConfigMutationFacts, type PreparedConfigMutationDestination,
  type PreparedConfigMutationTransitionFacts, type PreparedConfigMutationReceipt } from './prepared-mutation.js';
export type { PreparedConfigMutation, PreparedConfigMutationTransition, PreparedConfigMutationRequest,
  PreparedConfigMutationFacts, PreparedConfigMutationDestination, PreparedConfigMutationTransitionFacts,
  PreparedConfigMutationReceipt } from './prepared-mutation.js';

// Keep schema identity stable for prepared settings and catalog ownership checks.
const visibleConfigSchema = CONFIG_SCHEMA.filter(setting => !setting.deprecated);

type SelectedScalar = string | number | boolean | null | undefined;
export interface ConfigScalarSelection { readonly key: string; readonly value: unknown; }
/**
 * Runs the caller's boundary check at entry and exit, confirming after each
 * that the selected settings still hold the captured values. Throws
 * JudgmentAuthorityRetiredError when a setting changed; returns true otherwise.
 */
export type ConfigSelectedScalarGuard = (assertBoundary: () => void) => boolean;

/** Native permission state has one owner and one revision across all mutations. */
export interface PermissionConfigurationOwner {
  readMode(): Readonly<{ mode: GoodVibesConfig['permissions']['mode']; autoApprove: boolean }>;
  captureRevision(): () => boolean;
}
let permissionConfigurationOwner: (receiver: unknown, snapshotAccessor: unknown) => PermissionConfigurationOwner | undefined;

/** Available only for the real manager and its original permission snapshot accessor. */
export function retainPermissionConfigurationOwner(receiver: unknown, snapshotAccessor: unknown): PermissionConfigurationOwner | undefined {
  return permissionConfigurationOwner(receiver, snapshotAccessor);
}

/**
 * Capture a few scalar settings once. Every change, reload and save moves the
 * configuration revision, so the guard compares one integer instead of the
 * values. Works for any reader with `get` and `getConfigurationIncarnation`,
 * including a wrapped manager; undefined when a value already differs.
 */
export function captureConfigSelectedScalars(receiver: unknown, selections: readonly ConfigScalarSelection[]): ConfigSelectedScalarGuard | undefined {
  const reader = receiver as { readonly get?: unknown; readonly getConfigurationIncarnation?: unknown } | null;
  if (reader === null || typeof reader !== 'object' || typeof reader.get !== 'function'
    || typeof reader.getConfigurationIncarnation !== 'function' || !Array.isArray(selections) || selections.length === 0) return undefined;
  const get = (reader.get as (key: string) => unknown).bind(reader);
  const revisionOf = (reader.getConfigurationIncarnation as () => number).bind(reader);
  const revision = revisionOf();
  try {
    if (!selections.every(({ key, value }) => scalarValue(value) && Object.is(get(key), value))) return undefined;
  } catch { return undefined; }
  // The caller's boundary runs at entry and exit; either may change settings.
  return assertBoundary => {
    assertBoundary();
    if (revisionOf() !== revision) throw new JudgmentAuthorityRetiredError();
    assertBoundary();
    if (revisionOf() !== revision) throw new JudgmentAuthorityRetiredError();
    return true;
  };
}
function scalarValue(value: unknown): value is SelectedScalar {
  return value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
/** Typed values for a single daemon-settings update; scope is checked at runtime. */
export type DaemonConfigPatch = { readonly [K in ConfigKey]?: ConfigValue<K> };

/** Internal native composition reference; no caller-selected project identity. */
export interface ConfiguredWorkspaceReference {
  readonly directory: string | null;
  readonly configDirectory: string;
  readonly assertCurrent: () => void;
}

/** Deep immutable type, prevents mutation of nested objects returned from getAll(). */
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/** Constructor overrides for CLI args and programmatic instantiation. */
interface ConfigCliOverrides {
  /** Installation-admitted data publisher, supplied by the actual executable root. */
  readonly nativeDataWriter?: import('../runtime/native-reader-compatibility.js').NativeDataWriteOwner | undefined;
  /** Per-instance surface-owned scalar leaves; a policy-sensitive one declares a restrictive default. */
  hostSettings?: readonly HostSetting[] | undefined;
  /** Read without filesystem effects; persistent mutators refuse, runtime inputs are allowed. */
  readOnly?: boolean | undefined;
  /** Withhold borrowed parse-error text from unreadable-settings diagnostics; private errors retain it. */
  diagnosticMode?: 'default' | 'structural' | undefined;
  model?: string | undefined;
  autoApprove?: boolean | undefined;
  systemPromptFile?: string | undefined;
  workingDir?: string | undefined;
  surfaceRoot?: string | undefined;
  /**
   * True only in the daemon composition, which OWNS the daemon tier file. A
   * client only READS it; the default is that non-writing answer.
   */
  ownsDaemonTier?: boolean | undefined;
}

export type ConfigOverrides = ConfigCliOverrides & (
  | {
    configDir: string;
    homeDir?: string | undefined;
    sharedConfigPath?: string | undefined;
    sharedTierPath?: string | undefined;
    daemonTierPath?: string | undefined;
  }
  | {
    homeDir: string;
    configDir?: string | undefined;
    sharedConfigPath?: string | undefined;
    sharedTierPath?: string | undefined;
    daemonTierPath?: string | undefined;
  }
);

interface ConfigRoots {
  configDir?: string | undefined;
  homeDir?: string | undefined;
  sharedConfigPath?: string | undefined;
  sharedTierPath?: string | undefined;
  daemonTierPath?: string | undefined;
  surfaceRoot?: string | undefined;
}

/**
 * The tier a value resolved from, and the full source report. `daemon` is the
 * daemon's own store, the single home of every daemon-owned key (see
 * config-ownership.ts), overlaid last so a value left behind in a surface silo
 * can never shadow it. Defined in manager-key-source.ts; re-exported here so
 * existing importers keep working.
 */
export type { ConfigKeyTier, ConfigKeySource } from './manager-key-source.js';

export interface ConfigSetOptions {
  bypassManagedLock?: boolean | undefined;
  /**
   * The caller established that no daemon is running to apply a daemon-owned
   * setting, so it is written to the daemon's settings file for the daemon to
   * read when it starts. Only the routed write (daemon-config-route.ts and the
   * settings screens' offline branch) states this.
   */
  daemonNotRunning?: boolean | undefined;
}

/**
 * How a process that does not own the daemon's settings file writes a
 * daemon-owned setting while the daemon is reachable: through the daemon
 * (`config.set` / `config.reset`), never into the daemon's file.
 */
export interface DaemonWriteRoute {
  /** Whether the daemon can take a write now; no request is made. */
  reachable(): boolean;
  write(key: string, value: unknown): Promise<void>;
  reset?(key: string): Promise<void>;
  /** The daemon refused a forwarded write; this process's view of the key was put back. */
  refused?(key: string, error: unknown): void;
}

/** One setting in a {@link ConfigManager.setMany} update. */
export interface ConfigChange {
  readonly key: ConfigKey;
  readonly value: unknown;
}

/** Who asked for a settings write; decides whether a change that loosens security is admitted. */
export type WriteOrigin =
  /** A person at a command surface: a settings screen, `/config set`, a CLI command. */
  | { readonly kind: 'owner'; readonly surface: string }
  /**
   * An agent's tool call. `decision` is the gate's decision on that call; a
   * change that loosens security is admitted only when the owner, the owner's
   * standing rule or the mode settled it, never on Jev's reading alone.
   */
  | { readonly kind: 'agent'; readonly surface: string; readonly decision?: ToolDecision | undefined }
  /** The program itself: a migration, a product default, a command that applies a fixed set of values. */
  | { readonly kind: 'system'; readonly purpose: string };

/**
 * The outcome of {@link ConfigManager.setMany}. `saved` names every key that
 * reached its settings file; on a refusal it is empty unless a later file
 * could not be written after an earlier one was.
 */
export type SetResult =
  | { readonly ok: true; readonly revision: number; readonly saved: readonly ConfigKey[] }
  | { readonly ok: false; readonly refusal: Refusal; readonly saved: readonly ConfigKey[] };

type SetTier = 'daemon' | 'shared' | 'project' | 'global';
const SET_TIER_ORDER: readonly SetTier[] = ['daemon', 'shared', 'project', 'global'];
const SET_TIER_LABEL: Readonly<Record<SetTier, string>> = {
  daemon: "daemon's", shared: 'shared', project: 'project', global: "this surface's",
};
interface AdmittedChange { readonly key: ConfigKey; readonly value: unknown; tier: SetTier }

const SCHEMA_BY_KEY: ReadonlyMap<string, ConfigSetting> = new Map(CONFIG_SCHEMA.map(setting => [setting.key, setting]));

/** An agent's loosening change stands only on the owner's word, the owner's rule, or the mode. */
function ownerSettled(decision: ToolDecision | undefined): boolean {
  return decision?.state === 'allowed'
    && (decision.decidedBy === 'owner' || decision.decidedBy === 'rule' || decision.decidedBy === 'mode');
}

/** One setting as a committed prepared change wrote it, read from the document it persisted. */
export interface PreparedSettingWrite { readonly path: string; readonly key: string; readonly present: boolean; readonly value?: unknown }
/** A prepared change's receipt with what it wrote; `written` is present on a committed change. */
export type PreparedConfigMutationCommit = PreparedConfigMutationReceipt & { readonly written?: readonly PreparedSettingWrite[] };
/** What a committed prepared change wrote, so a caller reports it without reading the files again. */
export function preparedReceiptWrites(receipt: object): readonly PreparedSettingWrite[] {
  return (receipt as { readonly written?: readonly PreparedSettingWrite[] }).written ?? [];
}

/** Digest of the shipped defaults, taken once: part of the durable revision, since a new build may ship new defaults. */
let defaultsDigest: string | undefined;
function shippedDefaultsDigest(): string {
  return defaultsDigest ??= createHash('sha256').update(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT)).digest('hex');
}

/** Refused write of a daemon-owned setting from a process that does not own the daemon's file. */
function daemonOwnedRefusal(key: string): ConfigError {
  return new ConfigError(`${key} is a daemon setting, and only the daemon writes its settings file. `
    + `Change it with \`goodvibes-daemon config set ${key} <value>\`, or with /config or the settings screen in a terminal app, `
    + 'which send it to the daemon (or, with no daemon running, write it for the daemon to read when it starts).');
}

/** Callback invoked when a watched config key changes. */
export type ConfigChangeCallback<K extends ConfigKey> = (newValue: ConfigValue<K>, oldValue: ConfigValue<K>) => void;

/** Unsubscribe handle returned by ConfigManager.subscribe(). */
export type ConfigUnsubscribe = () => void;

/**
 * ConfigManager, Layered, mutable, persistent config system.
 *
 * Load order: shipped defaults < frontend defaults < global < project < shared < daemon < invocation overrides
 * API keys are never persisted, loaded from env vars only.
 */
export class ConfigManager {
  readonly #workspaceOwner: Readonly<{
    workingDirectory: string | null;
    configDir: string;
    projectConfigPath: string | null;
    homeDirectory: string | null;
  }>;
  static {
    const permissionSnapshot = ConfigManager.prototype.getAutonomousPermissionSnapshot;
    permissionConfigurationOwner = (receiver, accessor) => {
      if (receiver === null || typeof receiver !== 'object' || !(#config in receiver)
        || accessor !== permissionSnapshot) return undefined;
      return Object.freeze({
        readMode: () => ({ mode: receiver.#config.permissions.mode, autoApprove: receiver.#config.behavior.autoApprove }),
        captureRevision: () => {
          const revision = receiver.#permissionIncarnation;
          return () => receiver.#permissionIncarnation === revision;
        },
      });
    };
  }
  private profilePostalReader: ProfilePostalReader | null = null;
  private profilePostalEpoch = 0;
  private readonly readOnly: boolean;
  private readonly diagnosticMode: 'default' | 'structural';
  private readonly hostSettings: HostSettings;
  private hostLoadValues: HostSettingValues | null = null;
  private hostLoadSources: Map<string, Record<string, unknown>> | null = null;
  /** Host defaults projected by malformed/unreadable input, independently of accepted underlay tiers. */
  private hostDefaultOrigins = new Set<string>();
  #config: GoodVibesConfig;
  private runtimeState: ConfigRuntimeState;
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly projectConfigPath: string | null;
  private readonly workingDirectory: string | null;
  private readonly homeDirectory: string | null;
  /** Surface-root-independent shared settings file (~/.goodvibes/shared/settings.json), or null. */
  private readonly sharedTierPath: string | null;
  /** The daemon's own settings store (`~/.goodvibes/daemon/settings.json`), or null. */
  private readonly daemonTierPath: string | null;
  /** True only in the daemon composition, the runtime allowed to REWRITE that store. */
  private readonly daemonTierOwner: boolean;
  /** Attached by a client's composition: while the daemon is reachable, its settings are written only through it. */
  #daemonRoute: DaemonWriteRoute | null = null;
  /** Shared keys whose value the last load actually sourced from the shared tier file. */
  private readonly sharedKeysPresent = new Set<ConfigKey>();
  /** Daemon-owned keys the last load sourced from the daemon store. */
  private readonly daemonKeysPresent = new Set<DaemonOwnedConfigPath>();
  private hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null;
  /** Owner-profile read fallback for UNSET keys. Injected; null unless installed. */
  private profileFallback: ConfigProfileFallbackReader | null = null;
  private readonly invalidationListeners = new Set<() => void>();
  #permissionIncarnation = 0;
  readonly #revisionSource = revisionSource('settings', () => this.#permissionIncarnation);
  /** The durable revision of the settings files this manager reads. */
  private readonly durablePolicy: DurablePolicyEpochOwner;
  /** This process wrote a settings file; the durable revision moves before it is next read. */
  #durableDirty = false;
  /** The durable revision has read the files since the last load. */
  #durableObserved = false;
  #durableCache: { readonly incarnation: number; readonly value: string } | undefined;
  readonly #catalogDigests = new WeakMap<object, string>();
  private hydrating = true;
  private readonly incarnationListeners = new Set<() => void>();
  // Private identities contain no authority grant and cannot be copied or forged.
  readonly #preparedMutations = new WeakMap<PreparedConfigMutation, PreparedMutationRecord>();
  readonly #preparedTransitions = new WeakMap<PreparedConfigMutationTransition, PreparedConfigMutation>();
  private readonly _listeners = new Map<string, Set<(newVal: unknown, oldVal: unknown) => void>>();
  /** Active config-file watch handle (external-edit live reload), or null. */
  private _fileWatch: ConfigFileWatchHandle | null = null;
  /** Settings the last load could not ingest. See ./settings-ingestion.ts. */
  private ingestionNotices: SettingsIngestionNotice[] = [];
  private readonly ingestionNoticeListeners = new Set<(notice: SettingsIngestionNotice) => void>();
  private readonly unknownSettingForms = new UnknownSettingFormsQueue();

  private readonly nativeDataWriter: import('../runtime/native-reader-compatibility.js').NativeDataWriteOwner | undefined;

  /** Native installation ownership stays attached to the actual configuration owner. */
  getNativeDataWriter(): import('../runtime/native-reader-compatibility.js').NativeDataWriteOwner | undefined { return this.nativeDataWriter; }

  constructor(overrides: ConfigOverrides) {
    this.nativeDataWriter = overrides.nativeDataWriter;
    this.readOnly = overrides.readOnly ?? false;
    this.diagnosticMode = overrides.diagnosticMode ?? 'default';
    this.hostSettings = new HostSettings(overrides.hostSettings);
    const roots = overrides as ConfigRoots;
    const configDir = requireAbsoluteOwnedPath(roots.configDir, 'configDir');
    const homeDirectory = requireAbsoluteOwnedPath(roots.homeDir, 'homeDir') ?? null;
    const workingDirectory = requireAbsoluteOwnedPath(overrides.workingDir, 'workingDir') ?? null;
    const sharedConfigPath = requireAbsoluteOwnedPath(roots.sharedConfigPath, 'sharedConfigPath');
    const surfaceRoot = roots.surfaceRoot ? requireSurfaceRoot(roots.surfaceRoot, 'ConfigManager surfaceRoot') : null;
    if ((!configDir || workingDirectory || homeDirectory) && !surfaceRoot) {
      throw new Error('ConfigManager surfaceRoot is required when deriving config paths from homeDir/workingDir.');
    }
    const base = configDir ?? resolveSurfaceDirectory(homeDirectory!, surfaceRoot!);
    this.configDir = base;
    this.configPath = join(base, 'settings.json');
    this.workingDirectory = workingDirectory;
    this.homeDirectory = homeDirectory;
    this.projectConfigPath = this.workingDirectory
      ? resolveSurfaceDirectory(this.workingDirectory, surfaceRoot!, 'settings.json')
      : null;
    this.#workspaceOwner = Object.freeze({ workingDirectory, configDir: base,
      projectConfigPath: this.projectConfigPath, homeDirectory });
    this.#config = cloneDefaultConfig();
    this.hostSettings.apply(this.#config, this.hostSettings.defaults());
    this.runtimeState = new ConfigRuntimeState(structuredClone(this.#config));

    const ownedSharedConfigPath = sharedConfigPath ?? (
      this.homeDirectory ? resolveSurfaceSharedFile(this.homeDirectory, surfaceRoot!) : null
    );
    if (ownedSharedConfigPath && !this.readOnly) {
      ensureSharedConfig(ownedSharedConfigPath);
    }

    // The surface-root-INDEPENDENT shared tier for cross-surface keys (tts.*):
    // an explicit override, else derived from homeDir as ~/.goodvibes/shared/
    // settings.json. A configDir-only construction (no homeDir) has no shared tier.
    const sharedTierPath = requireAbsoluteOwnedPath(roots.sharedTierPath, 'sharedTierPath');
    this.sharedTierPath = sharedTierPath ?? (
      this.homeDirectory ? resolveSharedDirectory(this.homeDirectory, 'shared', 'settings.json') : null
    );

    // The daemon tier: every daemon-owned key's single home, shared by every
    // product on this machine. Surface-root-independent, exactly like the
    // shared tier, the daemon is a peer runtime, not a guest in the TUI's
    // storage root. A configDir-only construction (no homeDir) has none.
    const daemonTierPath = requireAbsoluteOwnedPath(roots.daemonTierPath, 'daemonTierPath');
    this.daemonTierPath = daemonTierPath ?? (
      this.homeDirectory ? daemonConfigPath(this.homeDirectory) : null
    );
    // Set BEFORE load(): that load is where the daemon-tier migration asks.
    this.daemonTierOwner = !this.readOnly && overrides.ownsDaemonTier === true;

    this.durablePolicy = new DurablePolicyEpochOwner([this.configPath, this.projectConfigPath, this.sharedTierPath, this.daemonTierPath, join(this.configDir, 'settings-sync.json')]
      .filter((path): path is string => path !== null), !this.readOnly);
    try { this.load(); } finally { this.hydrating = false; }

    // Apply constructor overrides (CLI args, etc.) after load
    if (overrides.model !== undefined) {
      this.setRuntimeOverride('provider.model', overrides.model);
    }
    if (overrides.autoApprove !== undefined) {
      this.setRuntimeOverride('behavior.autoApprove', overrides.autoApprove);
    }
    if (overrides.systemPromptFile !== undefined) {
      this.setRuntimeOverride('provider.systemPromptFile', overrides.systemPromptFile);
    }
  }

  getControlPlaneConfigDir(): string {
    return this.configDir;
  }

  /** One owned, synchronous permission frame; no listeners/hooks run while it is copied. */
  getAutonomousPermissionSnapshot(): Readonly<{ permissions: GoodVibesConfig['permissions']; autoApprove: boolean; directory: string | null; incarnation: number }> {
    // Preserve the public detached-copy contract. Admission captures its own
    // deeply frozen frame through snapshotJudgmentInput before any await.
    return structuredClone({ permissions: this.#config.permissions, autoApprove: this.#config.behavior.autoApprove,
      directory: this.workingDirectory, incarnation: this.#permissionIncarnation });
  }

  getWorkingDirectory(): string | null {
    return this.workingDirectory;
  }

  /**
   * The directories this manager was built for. They are fixed at construction,
   * so `assertCurrent` has nothing to re-check; it stays for callers that hold
   * the reference across awaits.
   */
  retainConfiguredWorkspace(): ConfiguredWorkspaceReference {
    const owner = this.#workspaceOwner;
    return Object.freeze({ directory: owner.workingDirectory, configDirectory: owner.configDir, assertCurrent: () => {} });
  }

  getHomeDirectory(): string | null {
    return this.homeDirectory;
  }

  /** Absolute global surface settings path. */
  getConfigPath(): string {
    return this.configPath;
  }

  /** Project settings path, when a working directory was supplied. */
  getProjectConfigPath(): string | undefined {
    return this.projectConfigPath ?? undefined;
  }

  attachHookDispatcher(hookDispatcher: Pick<HookDispatcher, 'fire'> | null): () => void {
    return attachOwnedConfigHook(this, dispatcher => { this.hookDispatcher = dispatcher; }, hookDispatcher);
  }

  /** Install (or clear) the owner-profile read fallback. See ./profile-fallback.ts. */
  attachProfileFallback(reader: ConfigProfileFallbackReader | null): void {
    if (this.profileFallback === reader) return;
    this.profileFallback = reader;
    // Unset keys now read through a different fallback. Nothing is persisted,
    // so the durable revision stays; only the in-memory incarnation moves.
    this.#permissionIncarnation++;
    for (const listener of [...this.incarnationListeners]) {
      try { listener(); } catch { /* A lifetime observer cannot defeat revocation. */ }
    }
  }

  /** Owned async seam; a previous composition cannot clear its replacement. */
  attachProfilePostalFallback(reader: ProfilePostalReader): () => void {
    const epoch = ++this.profilePostalEpoch;
    this.profilePostalReader = reader;
    return () => { if (this.profilePostalEpoch === epoch) { this.profilePostalEpoch += 1; this.profilePostalReader = null; } };
  }

  /** One named address only. Never used by a dump/category/listing. */
  async preparePostalAddress(kind: PostalKind, options: PostalReadOptions = {}): Promise<PreparedPostalAddress> {
    return withDecisionModelPolicy(() => this.get('judgment.policy'), async () => {
      const revision = this.getConfigurationIncarnation();
      const reader = this.profilePostalReader;
      const installation = this.profilePostalEpoch;
      const stored = Object.fromEntries(POSTAL_PARTS.map(part => {
        const { parent, field } = this.#resolvePath(`payments.${kind}Address.${part}` as ConfigKey);
        return [part, typeof parent[field] === 'string' ? (parent[field] as string).trim() : ''];
      })) as Record<typeof POSTAL_PARTS[number], string>;
      const check = () => {
        options.signal?.throwIfAborted();
        assertSynchronousJudgmentGuard(() => options.assertCurrent?.(), () => new PostalAddressHeldError());
        if (this.getConfigurationIncarnation() !== revision || this.profilePostalReader !== reader || this.profilePostalEpoch !== installation) throw new PostalAddressHeldError();
      };
      check();
      const fallback = await decisionOrClassic<PreparedPostalAddress | null>(
        () => reader && POSTAL_PARTS.some(part => stored[part] === '')
          ? reader(kind, { ...options, assertCurrent: check }) : Promise.resolve(null),
        () => null);
      check(); fallback?.assertCurrent();
      const value = Object.freeze(Object.fromEntries(POSTAL_PARTS.map(part => [part, stored[part] || fallback?.value?.[part] || ''])) as unknown as PostalParts);
      return Object.freeze({ value: POSTAL_PARTS.some(part => value[part] !== '') ? value : null,
        ...(isClassicOperation() ? { provenance: 'classic' as const, profileAssessment: 'not-evaluated' as const } : {}),
        assertCurrent: () => { check(); fallback?.assertCurrent(); } });
    });
  }

  #resolvePath(
    key: DaemonOwnedConfigPath,
    config: GoodVibesConfig = this.#config,
  ): { parent: Record<string, unknown>; field: string } {
    const parts = key.split('.');
    let cursor: unknown = config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (cursor == null || typeof cursor !== 'object' || !(part in (cursor as Record<string, unknown>))) {
        throw new Error(`Invalid config path: section '${parts.slice(0, i + 1).join('.')}' does not exist`);
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }

    if (cursor == null || typeof cursor !== 'object') {
      throw new Error(`Invalid config path: section '${parts.slice(0, -1).join('.')}' does not exist`);
    }

    return {
      parent: cursor as Record<string, unknown>,
      field: parts[parts.length - 1]!,
    };
  }

  /**
   * Get a config value by dot-path key.
   *
   * An UNSET key may resolve from the owner profile when a fallback reader is
   * installed, one keyed read by a consumer that needs the value. Deliberately
   * not applied by `getAll()` or any category/dump path: see ./profile-fallback.ts.
   */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.#resolvePath(key);
    return detachedConfigValue(resolveWithProfileFallback(key, parent[field], this.profileFallback)) as ConfigValue<K>;
  }

  /** Explicit stored value for settings edit/clear receipts, without profile disclosure. */
  getStored<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.#resolvePath(key);
    return detachedConfigValue(parent[field]) as ConfigValue<K>;
  }

  /** Validate registration and return an immutable, manager-bound boolean handle. */
  getHostBooleanSetting(key: string): HostBooleanSettingHandle {
    const definition = this.hostSettings.definitions.find(entry => entry.key === key);
    if (definition?.type !== 'boolean') throw new ConfigError(`Host boolean setting ${key} is not registered on this manager.`);
    const registeredKey = key as ConfigKey;
    const handle: HostBooleanSettingHandle = {
      key,
      get: () => this.get(registeredKey) as boolean,
      getResolved: (locks) => {
        const value = this.get(registeredKey) as boolean;
        return Object.freeze({ key, value, defaultValue: definition.default, source: value === definition.default ? 'default' : 'local',
          managedLock: locks ? locks.get(key) ?? null : readHostManagedSettingLock(key, this.configDir) });
      },
      set: (value, options) => this.setDynamic(registeredKey, value, options),
      setProjectValue: (value, options) => this.setProjectValue(registeredKey, value as never, options),
      subscribe: (callback) => this.subscribe(registeredKey, (next, previous) => callback(next as boolean, previous as boolean)),
      reset: () => this.reset(registeredKey),
    };
    return Object.freeze(handle);
  }

  /**
   * Every managed lock from one read of the policy file, for a caller that
   * resolves several host settings at once (pass it to `getResolved`).
   * Unreadable policy throws, as `getResolved` does.
   */
  readHostManagedSettingLocks(): HostManagedSettingLocks {
    return readHostManagedSettingLocks(this.configDir);
  }

  /** Opaque pre-mutation lifetime signal, including category changes and reloads.
   * Conservative: a failed or no-op mutation may invalidate too. No values leak.
   */
  onDidInvalidate(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => { this.invalidationListeners.delete(listener); };
  }

  /** Value-free owner revision, including save and failed/no-op mutation intent. */
  getConfigurationIncarnation(): number { return this.#permissionIncarnation; }

  /** The configuration incarnation as a revision source: every setting change, reload from disk and save moves it. */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  /**
   * The durable configuration revision: equal across restarts while every
   * settings file holds the same bytes and the process runs with the same
   * invocation values and build; different after any change, even one that was
   * later undone. A grant saved under it compares this string; never a
   * permission grant by itself. One string compare per check; the files are
   * read only the first time after a load. `version` is accepted for callers
   * that still pass it: a grant saved in the historical format compares
   * unequal and is issued again.
   */
  getDurableConfigurationIncarnation(_version?: 1 | 2): string {
    if (this.#durableDirty) { this.#durableDirty = false; this.durablePolicy.advance(); this.#durableObserved = true; this.#durableCache = undefined; }
    if (!this.#durableObserved) { this.durablePolicy.observe(); this.#durableObserved = true; this.#durableCache = undefined; }
    const cached = this.#durableCache;
    if (cached?.incarnation === this.#permissionIncarnation) return cached.value;
    const value = `${this.durablePolicy.current()}:${this.#invocationDigest()}`;
    this.#durableCache = { incarnation: this.#permissionIncarnation, value };
    return value;
  }

  /** The same revision, read when a new grant is issued. */
  captureDurableConfigurationIncarnation(): string { return this.getDurableConfigurationIncarnation(); }

  /** What the files do not hold: the build, the registered host defaults and the invocation values. */
  #invocationDigest(): string {
    const overlays: Array<readonly [string, string, unknown]> = [];
    for (const [kind, values] of [['default', this.runtimeState.defaults], ['override', this.runtimeState.overrides]] as const) {
      for (const [key, value] of values) {
        if (kind === 'default' && this.runtimeState.sources.has(key)) continue;
        if (isDeepStrictEqual(readDotPath(this.runtimeState.nonRuntime, key).value, value)) continue;
        overlays.push([kind, key, value]);
      }
    }
    overlays.sort(([a, keyA], [b, keyB]) => a.localeCompare(b) || keyA.localeCompare(keyB));
    const hostDefaults = [...this.hostSettings.defaults()].sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify([VERSION, shippedDefaultsDigest(), hostDefaults, overlays])).digest('hex').slice(0, 32);
  }

  /**
   * A gateway catalog's revision: its registered descriptors bound to the
   * durable configuration revision. The catalog hands over one frozen snapshot
   * per registration state, so it is hashed once and later checks are lookups.
   */
  getDurableGatewayPolicyRevision(snapshot: unknown): string {
    const held = snapshot !== null && typeof snapshot === 'object' ? this.#catalogDigests.get(snapshot) : undefined;
    const catalog = held ?? createHash('sha256').update(JSON.stringify(snapshot) ?? '').digest('hex').slice(0, 32);
    if (held === undefined && snapshot !== null && typeof snapshot === 'object') this.#catalogDigests.set(snapshot, catalog);
    return `${catalog}:${this.getDurableConfigurationIncarnation()}`;
  }

  /**
   * A policy outside the settings files (the gateway catalog) is about to
   * change: move the durable revision now, so a grant saved under the old
   * policy is refused after a restart even if the policy changes back.
   */
  invalidateExternalPolicy(): void {
    this.invalidateLifetimes();
    this.durablePolicy.advance();
    this.#durableDirty = false; this.#durableObserved = true; this.#durableCache = undefined;
  }

  /** Observe every revision without changing existing setting/invalidation subscriptions. */
  onDidChangeIncarnation(listener: () => void): () => void {
    this.incarnationListeners.add(listener);
    return () => { this.incarnationListeners.delete(listener); };
  }

  private advanceConfigurationIncarnation(): void {
    this.#permissionIncarnation++;
    for (const listener of [...this.incarnationListeners]) {
      try { listener(); } catch { /* A lifetime observer cannot defeat revocation. */ }
    }
  }

  private invalidateLifetimes(): void {
    // Publish before observers run, even if a mutation subsequently restores
    // the same value. Outstanding admission cannot survive an A -> B -> A turn.
    this.advanceConfigurationIncarnation();
    for (const listener of [...this.invalidationListeners]) {
      try { listener(); } catch { /* One subscriber must not defeat revocation. */ }
    }
  }

  /**
   * Capture an exact, detached mutation on this owner. This is not admission:
   * callers must authenticate their execution separately before begin/finish.
   * Preparation never recovers, quarantines, cleans up, or writes a store.
   */
  prepareSettingMutation(request: PreparedConfigMutationRequest): PreparedConfigMutation {
    return this.prepareSettingMutationPlan([request]);
  }

  private prepareSingleSettingMutation(request: PreparedConfigMutationRequest): PreparedConfigMutation {
    this.requireWritable();
    const incarnation = this.#permissionIncarnation;
    if (request.operation !== 'set' && request.operation !== 'reset') throw new ConfigError('Unsupported prepared operation.');
    const { schema, identity } = this.preparedSchema(request.key);
    const signature = preparedSchemaSignature(schema);
    const validator = schema.validate;
    const requested = request.operation === 'set' ? request.value
      : this.hostSettings.has(request.key) ? schema.default : readDotPath(DEFAULT_CONFIG_SNAPSHOT, request.key).value;
    const value = normalizePreparedValue(request.key, schema, requested);
    const destinations = this.preparedDestinations(request.operation, request.key);
    const handle = Object.freeze({}) as PreparedConfigMutation;
    const record: PreparedMutationRecord = {
      facts: freezePreparedData({ operation: request.operation, key: request.key, value, destinations, incarnation }),
      schemaIdentity: identity, schemaSignature: signature, validator,
      normalizedJson: JSON.stringify(value), phase: 'prepared',
    };
    this.#preparedMutations.set(handle, record);
    try { this.assertPreparedCurrent(record, incarnation); }
    catch (error) { this.spendPrepared(record); throw error; }
    return handle;
  }

  /** Capture every companion before admission; never re-prepare after an earlier effect. */
  prepareSettingMutationPlan(requests: readonly PreparedConfigMutationRequest[]): PreparedConfigMutation {
    if (requests.some(request => request.key === 'permissions.mode' && request.operation === 'set')
      && this.get('behavior.autoApprove')) {
      const override = requests.find(request => request.key === 'behavior.autoApprove');
      if (override && (override.operation !== 'set' || override.value !== false)) {
        throw new ConfigError('Selecting an execution mode must clear the legacy auto-approve override.');
      }
      // Clear the override first: if a later step fails, the partial result is
      // the previous mode without auto-approve, never the new mode still in yolo.
      requests = [{ operation: 'set', key: 'behavior.autoApprove', value: false }, ...requests.filter(request => request !== override)];
    }
    const knownKeys = new Set([...CONFIG_SCHEMA, ...this.getHostSettingsSchema()].map(setting => setting.key));
    if (requests.length < 1 || requests.length > knownKeys.size || new Set(requests.map(request => request.key)).size !== requests.length
      || requests.some(request => !knownKeys.has(request.key))) {
      throw new ConfigError('Invalid prepared settings plan.');
    }
    if (requests.length === 1) return this.prepareSingleSettingMutation(requests[0]!);
    const steps = Object.freeze(requests.map(request => this.prepareSingleSettingMutation(request)));
    const first = this.preparedRecord(steps[0]!);
    const effects = steps.map(step => this.inspectPreparedMutation(step));
    const handle = Object.freeze({}) as PreparedConfigMutation;
    this.#preparedMutations.set(handle, { ...first, steps,
      facts: freezePreparedData({ ...first.facts, effects, destinations: effects.flatMap(effect => [...effect.destinations]) }) });
    this.assertPreparedMutation(handle);
    return handle;
  }

  /** Detached proposed values are private substrate data, not redacted evidence. */
  inspectPreparedMutation(handle: PreparedConfigMutation): PreparedConfigMutationFacts {
    return freezePreparedData(structuredClone(this.preparedRecord(handle).facts));
  }

  assertPreparedMutation(handle: PreparedConfigMutation): void {
    const record = this.preparedRecord(handle);
    this.requirePreparedMove(record, 'beginning');
    this.assertPreparedCurrent(record, record.facts.incarnation);
  }

  /** The refusal for a move the lifecycle does not allow; names the phase and what would be allowed. */
  private requirePreparedMove(record: PreparedMutationRecord, to: PreparedMutationRecord['phase']): void {
    const check = preparedMutationLifecycle.check(record.phase, to);
    if (!check.ok) throw new PreparedMutationRefusal('spent', check.reason);
  }
  private movePrepared(record: PreparedMutationRecord, to: PreparedMutationRecord['phase']): void {
    this.requirePreparedMove(record, to);
    record.phase = to;
  }
  /** Failure paths settle whatever phase they interrupted; a record that is already spent stays so. */
  private spendPrepared(record: PreparedMutationRecord): void {
    if (record.phase !== 'spent') record.phase = 'spent';
  }

  /** Run all reentrant work before exposing the one exact owner transition. */
  beginPreparedMutation(handle: PreparedConfigMutation): PreparedConfigMutationTransition {
    const record = this.preparedRecord(handle);
    this.movePrepared(record, 'beginning');
    try {
      this.assertPreparedCurrent(record, record.facts.incarnation);
      for (const current of record.steps ? record.steps.map(step => this.preparedRecord(step)) : [record]) {
        const { schema } = this.preparedSchema(current.facts.key);
        const next = normalizePreparedValue(current.facts.key, schema, current.facts.value);
        if (JSON.stringify(next) !== current.normalizedJson) throw new ConfigError('Prepared value changed.');
      }
      this.invalidateLifetimes();
      // Invalidation listeners run caller code; nothing they did may have moved the owner.
      this.assertPreparedCurrent(record, record.facts.incarnation + 1);
      const transition = Object.freeze({}) as PreparedConfigMutationTransition;
      this.movePrepared(record, 'begun'); record.transition = transition;
      this.#preparedTransitions.set(transition, handle);
      return transition;
    } catch (error) { this.spendPrepared(record); throw error; }
  }

  inspectPreparedMutationTransition(handle: PreparedConfigMutation, transition: PreparedConfigMutationTransition): PreparedConfigMutationTransitionFacts {
    this.assertPreparedMutationTransition(handle, transition);
    const record = this.preparedRecord(handle);
    return Object.freeze({ beforeIncarnation: record.facts.incarnation, afterIncarnation: record.facts.incarnation + 1 });
  }

  assertPreparedMutationTransition(handle: PreparedConfigMutation, transition: PreparedConfigMutationTransition): void {
    const record = this.preparedRecord(handle);
    if ((record.phase !== 'begun' && record.phase !== 'committing') || record.transition !== transition || this.#preparedTransitions.get(transition) !== handle) {
      throw new PreparedMutationRefusal('spent', 'Prepared mutation transition is not authentic or has been spent.');
    }
    this.assertPreparedCurrent(record, record.facts.incarnation + 1);
  }

  /** Exact native result, including physical stores, remains restrictive after publication. */
  inspectCompletedMutation(handle: PreparedConfigMutation): PreparedConfigMutationTransitionFacts {
    this.assertCompletedMutation(handle);
    const record = this.#preparedMutations.get(handle)!;
    return Object.freeze({ beforeIncarnation: record.facts.incarnation, afterIncarnation: record.completion!.incarnation });
  }

  /** Compound credential/subscription effects retain this settings owner's read-only restriction. */
  assertSettingsWritable(): void { this.requireWritable(); }

  /** Registration adds a source restriction; bare legacy prepared writes retain their merge contract. */
  protectPreparedMutationTargets(handle: PreparedConfigMutation): void {
    this.assertPreparedMutation(handle);
    const record = this.preparedRecord(handle);
    if (record.targets) return;
    const records = record.steps ? record.steps.map(step => this.preparedRecord(step)) : [record];
    const paths = new Map<string, string[]>();
    for (const step of records) for (const destination of step.facts.destinations) {
      const keys = paths.get(destination.path) ?? []; keys.push(step.facts.key); paths.set(destination.path, keys);
    }
    const targets = Object.freeze([...paths].map(([path, keys]) => new PreparedSettingsTarget(path, keys)));
    record.targets = targets;
    for (const step of records) step.targets = targets;
    this.assertPreparedMutation(handle);
  }

  assertCompletedMutation(handle: PreparedConfigMutation): void {
    const record = this.#preparedMutations.get(handle), completion = record?.completion;
    if (!record || record.phase !== 'spent' || !completion || completion.receipt.status !== 'committed'
      || completion.incarnation !== record.facts.incarnation + 1 || this.#permissionIncarnation !== completion.incarnation
      || JSON.stringify(this.#config) !== completion.runtimeJson) throw new ConfigError('Prepared mutation completion is stale.');
    this.assertPreparedCurrent(record, completion.incarnation);
    if (record.steps) for (const step of record.steps) {
      const child = this.#preparedMutations.get(step);
      if (child?.phase !== 'spent' || child.completion?.receipt.status !== 'committed'
        || child.completion.incarnation !== completion.incarnation) throw new ConfigError('Prepared plan completion is stale.');
    }
    for (const store of completion.stores) if (settingsFileIdentity(store.path) !== store.stamp) {
      throw new ConfigError('Prepared mutation completion store changed.');
    }
  }

  private capturePreparedCompletion(record: PreparedMutationRecord, receipt: PreparedConfigMutationReceipt): void {
    if (receipt.status !== 'committed' || this.#permissionIncarnation !== record.facts.incarnation + 1) return;
    try {
      record.completion = { receipt, incarnation: this.#permissionIncarnation, runtimeJson: JSON.stringify(this.#config),
        stores: [...new Set([this.configPath, this.projectConfigPath, this.sharedTierPath, this.daemonTierPath,
          ...record.facts.destinations.map(destination => destination.path)].filter((path): path is string => path !== null))]
          .map(path => ({ path, stamp: settingsFileIdentity(path) })) };
    } catch { /* A receipt remains honest when resulting owner currentness cannot be retained. */ }
  }

  /**
   * After the caller's final authority check, commit synchronously with no
   * validator, invalidation subscriber or notification in the publication tail.
   * Existing whole-file last-writer-wins semantics remain; this is not file CAS.
   */
  finishPreparedMutation(handle: PreparedConfigMutation, transition: PreparedConfigMutationTransition, beforeEffect?: () => void): PreparedConfigMutationReceipt {
    const record = this.preparedRecord(handle);
    // A forged transition cannot consume a different authentic operation.
    if (record.transition !== transition || this.#preparedTransitions.get(transition) !== handle) {
      throw new PreparedMutationRefusal('spent', 'Prepared mutation transition is not authentic.');
    }
    if (record.steps) {
      this.requirePreparedMove(record, 'committing');
      this.assertPreparedMutationTransition(handle, transition);
      // Only the transition guard remains usable while committing. Reentrant
      // finish calls cannot repeat a step; unrelated mutation stops the tail.
      this.movePrepared(record, 'committing');
      const completedPaths: string[] = [];
      const written: PreparedSettingWrite[] = [];
      for (const step of record.steps) {
        const child = this.preparedRecord(step);
        let receipt: PreparedConfigMutationReceipt;
        try {
          beforeEffect?.();
          this.assertPreparedCurrent(child, record.facts.incarnation + 1);
          const childTransition = Object.freeze({}) as PreparedConfigMutationTransition;
          this.movePrepared(child, 'begun'); child.transition = childTransition;
          this.#preparedTransitions.set(childTransition, step);
          receipt = this.finishPreparedMutation(step, childTransition, beforeEffect);
        } catch {
          this.spendPrepared(record);
          return freezePreparedData({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths,
            ...(child.facts.destinations[0] ? { uncertainPath: child.facts.destinations[0].path } : {}) });
        }
        completedPaths.push(...receipt.completedPaths);
        written.push(...preparedReceiptWrites(receipt));
        if (receipt.status !== 'committed') { this.spendPrepared(record); return freezePreparedData({ ...receipt,
          status: completedPaths.length ? 'partial' : 'unknown', completedPaths, written }); }
      }
      this.spendPrepared(record);
      const receipt: PreparedConfigMutationCommit = freezePreparedData({ status: 'committed', completedPaths, written });
      this.capturePreparedCompletion(record, receipt);
      return receipt;
    }
    // A finish re-entered from its own beforeEffect callback must not publish twice.
    this.requirePreparedMove(record, 'committing');
    try { this.assertPreparedMutationTransition(handle, transition); }
    catch (error) { this.spendPrepared(record); throw error; }
    this.movePrepared(record, 'committing');
    const { key, value, destinations } = record.facts;
    const previousValue = this.#resolvePath(key).parent[this.#resolvePath(key).field];
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.#config) : null;
    // Pure detached staging: never run validators, invalidation callbacks, or
    // runtime admission in the sealed publication tail. Unknown/no-write
    // receipts retain this owner's previous runtime authority.
    const staged = this.runtimeState.fork();
    writeRawDotPath(staged.nonRuntime as unknown as Record<string, unknown>, key, structuredClone(value));
    staged.retire(key);
    staged.mark(key, record.facts.operation === 'set' ? destinations[0]!.tier : undefined);
    const effective = staged.compose();
    // Each destination is read once, under its lock, right before it is written.
    const stores = new Map<string, Record<string, unknown>>();
    const completedPaths: string[] = [];
    const written: PreparedSettingWrite[] = [];
    let uncertainPath: string | undefined;
    for (const destination of destinations) {
      let skipped = false, read = false;
      try {
        const raw = this.#updateSettingsFile(destination.path, candidate => {
          read = true;
          beforeEffect?.(); this.assertPreparedMutationTransition(handle, transition);
          const removed = destination.operation === 'remove' ? deleteRawDotPath(candidate, key) : false;
          if (destination.operation === 'set') writeRawDotPath(candidate, key, structuredClone(value));
          // Legacy local reset always rewrites global; tier reset skips absent keys.
          else if (!removed && destination.tier !== 'global') { skipped = true; return false; }
        }, readHostSettingsFile);
        stores.set(destination.path, raw);
        if (destination.tier === 'daemon') {
          if (destination.operation === 'set') this.daemonKeysPresent.add(key);
          else this.daemonKeysPresent.delete(key);
        }
        if (destination.tier === 'shared') {
          if (destination.operation === 'set') this.sharedKeysPresent.add(key);
          else this.sharedKeysPresent.delete(key);
        }
        if (skipped) continue;
        completedPaths.push(destination.path);
        const found = readDotPath(raw, key);
        written.push(Object.freeze({ path: destination.path, key, present: found.present, ...(found.present ? { value: structuredClone(found.value) } : {}) }));
        record.targets?.find(target => target.path === destination.path)?.acceptPublication(key, destination.operation === 'set', value);
      } catch (error) {
        // A destination that could not be read was not written: with nothing written yet, that is a refusal.
        if (!read && completedPaths.length === 0) { this.spendPrepared(record); throw error; }
        uncertainPath = destination.path; break;
      }
    }
    // Record the actual effect BEFORE any user callback. A later subscriber
    // failure, cancellation or supersession cannot rewrite this receipt.
    const receipt: PreparedConfigMutationCommit = freezePreparedData({
      status: uncertainPath === undefined ? 'committed' : completedPaths.length > 0 ? 'partial' : 'unknown',
      completedPaths, ...(uncertainPath === undefined ? {} : { uncertainPath }), written,
    });
    this.spendPrepared(record);
    if (receipt.status === 'committed' || completedPaths.length > 0) {
      if (previousHost) {
        // A host mutation also preserves the current effective project/global
        // resolution, without running ingestion announcements or recovery hooks.
        let hostStores: Map<string, Record<string, unknown>> | undefined = stores;
        try {
          for (const path of [this.configPath, this.projectConfigPath]) {
            if (path && !hostStores.has(path)) hostStores.set(path, readHostSettingsFile(path));
          }
        } catch { hostStores = undefined; }
        if (hostStores) {
          const values = this.hostSettings.defaults();
          this.hostSettings.overlay(values, hostStores.get(this.configPath)!);
          if (this.projectConfigPath) this.hostSettings.overlay(values, hostStores.get(this.projectConfigPath)!, this.hostLayerOf(this.projectConfigPath));
          this.hostSettings.apply(staged.nonRuntime, values);
          const hostDefaultOrigins = this.updateHostSources(staged, hostStores);
          this.publishState(staged, staged.compose());
          this.capturePreparedCompletion(record, receipt);
          // No callback may escape after persistence, including logging failures.
          try { this.applyHostValues(values, previousHost, true, hostDefaultOrigins); } catch { /* Receipt remains truthful. */ }
        } else {
          // The file was written but cannot be read back: registered host settings fall back to their restrictive defaults.
          this.publishState(staged, effective);
          try { this.refreshHostSettings(previousHost, true); } catch { /* Receipt remains truthful. */ }
        }
      } else {
        this.publishState(staged, effective);
        this.capturePreparedCompletion(record, receipt);
        try {
          this.notifyPersistedChange(key, previousValue);
        } catch { /* Publication already completed; never report a false refusal. */ }
      }
    }
    return receipt;
  }

  private preparedRecord(handle: PreparedConfigMutation): PreparedMutationRecord {
    const record = this.#preparedMutations.get(handle);
    if (!record || record.phase === 'spent') throw new PreparedMutationRefusal('spent', 'Prepared mutation is not authentic or has been spent.');
    return record;
  }

  private preparedSchema(key: ConfigKey): { schema: Omit<ConfigSetting, 'key'>; identity: object } {
    const host = this.hostSettings.definitions.find(definition => definition.key === key);
    if (host) return { schema: this.hostSettings.schema(key)!, identity: host };
    const schema = CONFIG_SCHEMA.find(entry => entry.key === key);
    if (!schema) throw new ConfigError('Unknown prepared setting key.');
    this.#resolvePath(key);
    return { schema, identity: schema };
  }

  private preparedDestinations(operation: 'set' | 'reset', key: ConfigKey): PreparedConfigMutationDestination[] {
    const destination = (path: string, tier: PreparedConfigMutationDestination['tier'], effect: 'set' | 'remove'): PreparedConfigMutationDestination => ({ path, tier, operation: effect });
    if (this.hostSettings.has(key)) {
      const project = this.projectConfigPath !== null && readDotPath(readHostSettingsFile(this.projectConfigPath), key).present;
      if (operation === 'set') return [destination(project ? this.projectConfigPath! : this.configPath, project ? 'project' : 'global', 'set')];
      return [...(project ? [destination(this.projectConfigPath!, 'project', 'set')] : []), destination(this.configPath, 'global', 'set')];
    }
    const project = this.projectOverridesKey(key);
    if (operation === 'set') {
      if (this.daemonTierPath && isDaemonOwnedConfigKey(key)) return [destination(this.daemonTierPath, 'daemon', 'set')];
      if (this.sharedTierPath && isSharedConfigKey(key)) return [destination(this.sharedTierPath, 'shared', 'set')];
      if (project) return [destination(this.projectConfigPath!, 'project', 'set')];
      return [destination(this.configPath, 'global', 'set')];
    }
    return [destination(this.configPath, 'global', 'remove'),
      ...(project ? [destination(this.projectConfigPath!, 'project', 'remove')] : []),
      ...(this.daemonTierPath && isDaemonOwnedConfigKey(key) ? [destination(this.daemonTierPath, 'daemon', 'remove')] : []),
      ...(this.sharedTierPath && isSharedConfigKey(key) ? [destination(this.sharedTierPath, 'shared', 'remove')] : [])];
  }

  private assertPreparedCurrent(record: PreparedMutationRecord, incarnation: number): void {
    this.requireWritable();
    for (const target of record.targets ?? []) target.assertCurrent();
    if (record.steps) {
      for (const step of record.steps) this.assertPreparedCurrent(this.#preparedMutations.get(step)!, incarnation);
      return;
    }
    const { key, operation } = record.facts;
    const { schema, identity } = this.preparedSchema(key);
    // Host validators are freshly allocated by the legacy accessor; the frozen
    // per-instance host descriptor is their stable identity.
    if (identity !== record.schemaIdentity || preparedSchemaSignature(schema) !== record.schemaSignature
      || (!this.hostSettings.has(key) && schema.validate !== record.validator)) throw new PreparedMutationRefusal('stale', 'Prepared setting schema changed.');
    if (JSON.stringify(this.preparedDestinations(operation, key)) !== JSON.stringify(record.facts.destinations)) {
      throw new PreparedMutationRefusal('stale', 'Prepared setting destination changed.');
    }
    if (readHostManagedSettingLock(key, this.configDir)) throw new PreparedMutationRefusal('managed', 'Prepared setting is managed and cannot be changed.');
    if (this.#permissionIncarnation !== incarnation) throw new PreparedMutationRefusal('stale', 'Prepared setting owner changed.');
  }

  /**
   * Register an invocation-only value without filesystem effects, even on a
   * read-only manager. Survives loads until an explicit mutation supersedes it.
   * Managed policy is checked on admission; standalone lock changes do not
   * reconcile existing invocation authority.
   */
  setRuntimeOverride<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    this.setRuntimeInput(key, value, false);
  }

  /** Register a frontend default below every accepted persisted value and invocation override. */
  setRuntimeDefault<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    this.setRuntimeInput(key, value, true);
  }

  private setRuntimeInput(key: ConfigKey, value: unknown, isDefault: boolean): void {
    this.invalidateLifetimes();
    const owned = captureRuntimeValue(key, value);
    if (readStrictManagedSettingLock(key, this.configDir)) {
      throw new ConfigError(`Setting ${key} is managed and cannot be changed.`);
    }
    if (!isDefault && key === 'permissions.mode' && this.get('behavior.autoApprove')) {
      this.setRuntimeInput('behavior.autoApprove', false, false);
    }
    const previous = readDotPath(this.#config, key).value;
    const staged = this.runtimeState.fork();
    (isDefault ? staged.defaults : staged.overrides).set(key, owned);
    const effective = staged.compose();
    this.runtimeState = staged;
    this.#config = effective;
    const next = readDotPath(effective, key).value;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.notifyListeners(key, previous, next);
      this.emitConfigHook(key, previous, next);
    }
  }

  /** Publish every part of a staged mutation before any observer can run. */
  private publishState(staged: ConfigRuntimeState, effective: GoodVibesConfig): void {
    this.#settleDurable();
    this.runtimeState = staged;
    this.#config = effective;
    this.sharedKeysPresent.clear();
    this.daemonKeysPresent.clear();
    for (const [key, tier] of staged.sources) {
      if (tier === 'shared') this.sharedKeysPresent.add(key as ConfigKey);
      if (tier === 'daemon') this.daemonKeysPresent.add(key as DaemonOwnedConfigPath);
    }
  }

  /** Move the durable revision once for everything this process wrote since it last moved. */
  #settleDurable(): void {
    if (!this.#durableDirty) return;
    this.#durableDirty = false; this.#durableObserved = true; this.#durableCache = undefined;
    this.durablePolicy.advance();
  }

  /**
   * The one writer of every settings file: under the file's lock, read it,
   * apply `mutate` (return false to write nothing), write it atomically, and
   * mark the durable revision to move. When the file held a change this
   * manager had not loaded yet (an edit by hand or by another process since
   * the watcher last looked), that change was merged on disk with this one;
   * the write is then not acknowledged and the watcher is polled right after
   * the caller publishes, so memory matches the file and the change's
   * subscribers are told. Returns the document as written.
   */
  #updateSettingsFile(path: string, mutate: (raw: Record<string, unknown>) => boolean | void,
    read: (path: string) => Record<string, unknown> = this.#readerFor(path)): Record<string, unknown> {
    return withSettingsFileLock(path, () => {
      const foreign = this._fileWatch?.changedSinceBaseline(path) ?? false;
      const raw = read(path);
      if (mutate(raw) === false) return raw;
      writeJsonFileAtomic(path, raw);
      this.#durableDirty = true;
      if (!foreign) this._fileWatch?.acknowledge(path);
      else queueMicrotask(() => this._fileWatch?.poll());
      return raw;
    });
  }

  /** The tier files refuse an unreadable file; the surface and project files set one aside and start fresh. */
  #readerFor(path: string): (path: string) => Record<string, unknown> {
    if (path === this.daemonTierPath) return readDaemonTierFile;
    if (path === this.sharedTierPath) return readSharedTierFile;
    return readRawSettingsFile;
  }

  private notifyPersistedChange(key: ConfigKey, previous: unknown): void {
    const next = readDotPath(this.#config, key).value;
    // Preserve legacy explicit-write notifications, including same-value writes.
    this.notifyListeners(key, previous, next);
    this.emitConfigHook(key, previous, next);
  }

  /**
   * Non-mutating preflight using the ordinary dynamic setter's schema, path,
   * managed-policy, and read-only checks. Does not grant future admission or
   * promise persistence; callers must still commit through setDynamic().
   * Policy reads are strict and never repair or quarantine a file.
   */
  /**
   * Attach the connected daemon. While it is reachable, a daemon-owned
   * setting written in this process goes to the daemon (the one writer of its
   * settings file) and this process's view takes the value at once; a refusal
   * puts the previous value back and is reported through `route.refused`.
   * With no daemon reachable, the daemon's settings file is written for it to
   * read when it starts. Returns a detach function.
   */
  attachDaemonRoute(route: DaemonWriteRoute | null): () => void {
    this.#daemonRoute = route;
    return () => { if (this.#daemonRoute === route) this.#daemonRoute = null; };
  }

  /** The route a daemon-owned write takes from this process instead of the daemon's file, or null for a file write. */
  #routedDaemonWrite(key: string, options: ConfigSetOptions): DaemonWriteRoute | null {
    if (this.daemonTierPath === null || this.daemonTierOwner || options.daemonNotRunning === true || !isDaemonOwnedConfigKey(key)) return null;
    const route = this.#daemonRoute;
    return route !== null && route.reachable() ? route : null;
  }

  /**
   * Whether this process may write a daemon-owned key into the daemon's file
   * itself: it owns that file, the caller states no daemon is running, or its
   * attached daemon route finds none to send the write to (the file is then
   * what the daemon reads when it starts). A process that never attached a
   * route cannot tell a running daemon from none, so it may not.
   */
  #mayWriteDaemonFile(options: ConfigSetOptions): boolean {
    if (this.daemonTierOwner || options.daemonNotRunning === true) return true;
    const route = this.#daemonRoute;
    return route !== null && !route.reachable();
  }

  /** Refuses a daemon-owned write this process may not put in the daemon's file (see {@link #mayWriteDaemonFile}). */
  #refuseDaemonFileWrite(key: string, options: ConfigSetOptions): void {
    if (this.daemonTierPath !== null && isDaemonOwnedConfigKey(key) && !this.#mayWriteDaemonFile(options)) throw daemonOwnedRefusal(key);
  }

  /**
   * Take a daemon-owned value the daemon now holds into this process's view,
   * without writing any file: for a caller that already wrote it through the
   * daemon and awaited the answer.
   */
  adoptDaemonValue(key: ConfigKey, value: unknown): void {
    if (!isDaemonOwnedConfigKey(key)) throw new ConfigError(`${key} is not a daemon setting.`);
    this.#applyInView(key, value, 'daemon');
  }

  /** Set one key in the in-memory view only (no file), publish, and notify like a persisted change. */
  #applyInView(key: ConfigKey, value: unknown, tier: 'daemon' | undefined): void {
    const previousValue = readDotPath(this.#config, key).value;
    const staged = this.runtimeState.fork();
    const { parent, field } = this.#resolvePath(key, staged.nonRuntime);
    parent[field] = structuredClone(value);
    staged.retire(key);
    staged.mark(key, tier);
    this.publishState(staged, staged.compose());
    this.notifyPersistedChange(key, previousValue);
  }

  /** Daemon writes sent from this process whose answer has not arrived; each settles to its refusal, if any. */
  readonly #forwarding = new Set<Promise<{ readonly key: string; readonly error: unknown } | null>>();

  /** Send one daemon-owned write through the daemon; on refusal put the previous value back if it is still the one sent. */
  #forwardDaemonWrite(route: DaemonWriteRoute, key: ConfigKey, value: unknown, previous: unknown, reset: boolean): void {
    this.#applyInView(key, value, reset ? undefined : 'daemon');
    const sent = reset && route.reset ? route.reset(key) : route.write(key, value);
    const outcome = sent.then(() => null, (error: unknown) => {
      if (JSON.stringify(readDotPath(this.#config, key).value) === JSON.stringify(value)) {
        try { this.#applyInView(key, previous, 'daemon'); } catch { /* the reload from the daemon's file reconciles */ }
      }
      try { route.refused?.(key, error); } catch { /* reporting cannot change the outcome */ }
      return { key, error };
    });
    this.#forwarding.add(outcome);
    void outcome.finally(() => { this.#forwarding.delete(outcome); });
  }

  /**
   * Wait for the daemon's answer to every daemon-owned write this process has
   * sent and not heard back on; returns the ones it refused (each already put
   * back in this process's view). For a command that wrote through code which
   * cannot await, so it can report what the daemon did.
   */
  async settleDaemonWrites(): Promise<readonly { readonly key: string; readonly error: unknown }[]> {
    const results = await Promise.all([...this.#forwarding]);
    return results.filter((result): result is { readonly key: string; readonly error: unknown } => result !== null);
  }

  validateDynamic(key: ConfigKey, value: unknown, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.validateSetValue(key, value, options, true);
  }

  private validateSetValue(key: ConfigKey, value: unknown, options: ConfigSetOptions, purePolicyRead: boolean): unknown {
    const schema = this.hostSettings.schema(key) ?? CONFIG_SCHEMA.find(s => s.key === key);
    value = coerceSchemaValue(key, schema, value);
    const credential = credentialValueRefusal(key, value);
    if (credential) throw new ConfigError(`${credential.reason} ${credential.next}`);
    if (schema?.validate && !schema.validate(value)) {
      const hint = schema.validationHint ? ` (${schema.validationHint})` : '';
      if (key === 'provider.decisionRouter' || key === 'judgment.fallbacks' || key === 'judgment.backend' || key === 'judgment.keyName') {
        throw new ConfigError(`Invalid value for ${key}${hint}`);
      }
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}${hint}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }
    if (!options.bypassManagedLock) {
      const lock = purePolicyRead ? readStrictManagedSettingLock(key, this.configDir) : getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
    }

    this.#resolvePath(key);
    // A value is checked against the same type the loader will insist on, so a
    // write cannot be reported as saved and then skipped at the next start.
    const refusal = schema
      ? (schema.type === 'enum' ? null : schemaTypeRefusal(schema, value)) ?? memoryTierOrderRefusal(key, value, this.#config) ?? memoryBudgetRefusal(key, value, this.#config)
      : nonSchemaKeyRefusal(key, value, this.#config);
    if (refusal) throw new ConfigError(`Invalid value for ${key}: ${String(value)} (${refusal})`);
    return value;
  }

  /**
   * A project file may only tighten a restricted key, and its stricter value
   * outranks the global file at every load. Writing a different global value
   * would show as live now and be undone at the next start, so it is refused.
   */
  private refuseBehindStricterProjectValue(key: string, value: unknown): void {
    if (!isProjectRestrictedKey(key) || !this.projectConfigPath || this.projectConfigPath === this.configPath) return;
    if (!existsSync(this.projectConfigPath)) return;
    let projectValue: { present: boolean; value: unknown };
    try { projectValue = readDotPath(JSON.parse(readFileSync(this.projectConfigPath, 'utf-8')), key); }
    catch { return; }
    if (!projectValue.present || JSON.stringify(projectValue.value) === JSON.stringify(value)) return;
    const baseline = structuredClone(this.#config) as unknown as Record<string, unknown>;
    writeRawDotPath(baseline, key, structuredClone(value));
    const layer: Record<string, unknown> = {};
    writeRawDotPath(layer, key, structuredClone(projectValue.value));
    if (restrictProjectLayer(layer, baseline, this.projectConfigPath).notices.length > 0) return;
    throw new ConfigError(
      `Setting ${key} is held at ${JSON.stringify(projectValue.value)} by the project settings file ${this.projectConfigPath}, `
      + 'which may only make it stricter and would override the new value at the next start. '
      + 'Remove the key from that file (or reset it) first, then set it again.');
  }

  /** Set a config value by dot-path key and auto-save to disk. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (this.hostSettings.has(key) && this.hostSettingHasProjectValue(key)) {
      (this.setProjectValue as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    // A project file that holds the key outranks the global file at every load,
    // so the value is written where it will actually win.
    if (this.projectOverridesKey(key)) {
      (this.setProjectValue as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    value = this.validateSetValue(key, value, options, false) as ConfigValue<K>;
    const route = this.#routedDaemonWrite(key, options);
    if (route) {
      this.#forwardDaemonWrite(route, key, value, readDotPath(this.#config, key).value, false);
      return;
    }
    this.#refuseDaemonFileWrite(key, options);
    const useDaemonTier = this.daemonTierPath !== null && isDaemonOwnedConfigKey(key);
    this.refuseBehindStricterProjectValue(key, value);

    if (key === 'permissions.mode' && this.get('behavior.autoApprove')) {
      this.set('behavior.autoApprove', false, options);
    }

    const previousValue = readDotPath(this.#config, key).value;
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.#config) : null;
    const staged = this.runtimeState.fork();
    const { parent, field } = this.#resolvePath(key, staged.nonRuntime);
    parent[field] = structuredClone(value);
    const useSharedTier = !useDaemonTier && this.sharedTierPath !== null && isSharedConfigKey(key);
    staged.retire(key);
    staged.mark(key, useDaemonTier ? 'daemon' : useSharedTier ? 'shared' : 'global');
    const effective = staged.compose();
    try {
      const target = useDaemonTier ? this.daemonTierPath! : useSharedTier ? this.sharedTierPath! : this.configPath;
      this.#updateSettingsFile(target, raw => { writeRawDotPath(raw, key, structuredClone(parent[field])); });
    } catch (error) {
      if (previousHost) recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previousHost, true));
      throw error;
    }
    this.publishState(staged, effective);
    if (previousHost) this.refreshHostSettings(previousHost, true);
    else this.notifyPersistedChange(key, previousValue);
  }

  /**
   * Update daemon-owned, non-credential settings in the daemon's one settings
   * file, through {@link setMany}: one admission, one write, one revision.
   * Throws a ConfigError naming the setting and the reason; never echoes a value.
   */
  setDaemonValues(patch: DaemonConfigPatch, by: WriteOrigin = { kind: 'owner', surface: 'daemon' }): void {
    this.requireWritable();
    if (!this.daemonTierPath) throw new ConfigError('A daemon settings file is required for this update.');
    const changes: ConfigChange[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const facts = configKeyFacts(key);
      if (!facts.inSchema || facts.owner !== 'daemon' || facts.secret || facts.cardMaterial) {
        throw new ConfigError('The update contains an unsupported daemon setting.');
      }
      changes.push({ key: key as ConfigKey, value });
    }
    const result = this.setMany(changes, by);
    if (!result.ok) throw new ConfigError(result.refusal.reason);
  }

  /**
   * Set several settings as one update: every change is admitted before
   * anything is written, each settings file the changes land in is written
   * once, and the configuration revision moves once. A refusal names the
   * setting, the reason and the next step, and never echoes a value.
   *
   * Admission reads the key's facts (config-key-facts.ts): card material is
   * refused, a credential is accepted only as a `goodvibes://secrets/…`
   * reference, and a change that loosens security from an agent stands only
   * when the owner, the owner's rule or the mode settled the call.
   *
   * Changes landing in different files (daemon, shared, project, this
   * surface's) are written one file after another; if a later file cannot be
   * written, what reached disk is published and named in `saved`.
   */
  setMany(changes: readonly ConfigChange[], by: WriteOrigin, options: ConfigSetOptions = {}): SetResult {
    const refuse = (init: { code: string; reason: string; next: readonly string[]; retryable?: boolean; status?: number },
      saved: readonly ConfigKey[] = []): SetResult => ({
      ok: false, saved,
      refusal: buildRefusal({ ...init, state: saved.length > 0 ? `saved ${saved.join(', ')}; the rest was not saved` : 'nothing was saved' }),
    });
    if (this.readOnly) {
      return refuse({ code: 'CONFIG_READ_ONLY', reason: 'Settings are read-only in this process.', next: ['Change the setting from a terminal app or the daemon, which own their settings files.'], status: 409 });
    }
    if (changes.length === 0) return { ok: true, revision: this.#permissionIncarnation, saved: [] };
    const keys = new Set<string>();
    for (const change of changes) {
      if (keys.has(change.key)) {
        return refuse({ code: 'CONFIG_INVALID', reason: `${change.key} appears more than once in one update.`, next: ['Send each setting once.'], status: 400 });
      }
      keys.add(change.key);
    }
    // Choosing a mode retires the legacy auto-approve override in the same write.
    const batch: readonly ConfigChange[] = keys.has('permissions.mode') && !keys.has('behavior.autoApprove') && this.get('behavior.autoApprove')
      ? [{ key: 'behavior.autoApprove', value: false }, ...changes] : changes;

    const invalid = (key: string, detail: string): SetResult =>
      refuse({ code: 'CONFIG_INVALID', reason: `Invalid value for ${key} (${detail}).`, next: [`Check ${key} against the settings list and send a valid value.`], status: 400 });
    const admitted: AdmittedChange[] = [];
    const projected = structuredClone(this.#config) as unknown as Record<string, unknown>;
    for (const change of batch) {
      const key = change.key;
      const facts = configKeyFacts(key);
      if (facts.cardMaterial) {
        const card = credentialValueRefusal(key, change.value)!;
        return refuse({ code: card.code, reason: card.reason, next: [card.next], status: 400 });
      }
      const schema = this.hostSettings.schema(key) ?? SCHEMA_BY_KEY.get(key);
      let value: unknown;
      try {
        const encoded = JSON.stringify(coerceSchemaValue(key, schema, change.value));
        if (encoded === undefined) return invalid(key, 'needs a value');
        value = JSON.parse(encoded);
      } catch {
        return invalid(key, 'not a value a settings file can hold');
      }
      if (schema?.validate && !schema.validate(value)) return invalid(key, schema.validationHint ?? 'rejected by its schema');
      if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
        return invalid(key, `allowed: ${schema.enumValues.join(', ')}`);
      }
      const typeRefusal = schema && schema.type !== 'enum' ? schemaTypeRefusal(schema, value) : null;
      if (typeRefusal) return invalid(key, typeRefusal);
      if (!options.bypassManagedLock) {
        const lock = getManagedSettingLock(key, this.configDir);
        if (lock) {
          return refuse({ code: 'CONFIG_MANAGED', reason: `${key} is managed by ${lock.source} and cannot be changed: ${lock.reason}`, next: [`Change it where ${lock.source} sets it.`], status: 403 });
        }
      }
      try { this.#resolvePath(key); }
      catch { return invalid(key, 'no such setting; check the spelling against the settings list'); }
      const credential = credentialValueRefusal(key, value);
      if (credential) return refuse({ code: credential.code, reason: credential.reason, next: [credential.next], status: 400 });
      if (by.kind === 'agent' && facts.loosens?.(readDotPath(this.#config, key).value, value) && !ownerSettled(by.decision)) {
        return refuse({ code: 'OWNER_ONLY', reason: `Changing ${key} would ${facts.loosening ?? 'loosen security'}, which only the owner decides.`,
          next: ['Ask the owner to make this change, or to approve it when asked.'], status: 403 });
      }
      writeRawDotPath(projected, key, structuredClone(value));
      admitted.push({ key, value, tier: 'global' });
    }

    // Checks across settings see the whole update, so a set of values that is
    // valid together is not refused one key at a time.
    for (const change of admitted) {
      const { key, value } = change;
      const crossRefusal = SCHEMA_BY_KEY.has(key) || this.hostSettings.has(key)
        ? memoryTierOrderRefusal(key, value, projected) ?? memoryBudgetRefusal(key, value, projected)
        : nonSchemaKeyRefusal(key, value, this.#config);
      if (crossRefusal) return invalid(key, crossRefusal);
      try {
        if (this.hostSettings.has(key) && this.hostSettingHasProjectValue(key)) change.tier = 'project';
        else if (this.daemonTierPath !== null && isDaemonOwnedConfigKey(key)) change.tier = 'daemon';
        else if (this.sharedTierPath !== null && isSharedConfigKey(key)) change.tier = 'shared';
        else if (this.projectOverridesKey(key)) change.tier = 'project';
        else this.refuseBehindStricterProjectValue(key, value);
      } catch (error) {
        return refuse({ code: 'CONFIG_HELD', reason: error instanceof Error ? error.message : `${key} cannot be written now.`,
          next: ['Remove the key from the project settings file, then set it again.'], status: 409 });
      }
    }

    // While the daemon is reachable it is the one writer of its settings: its
    // changes go through it. With none running, a person's write lands in its
    // file for it to read at start; an agent's waits for the daemon.
    const daemonChange = admitted.find(change => change.tier === 'daemon');
    const route = daemonChange ? this.#routedDaemonWrite(daemonChange.key, options) : null;
    const fileWritable = this.daemonTierOwner || options.daemonNotRunning === true || (by.kind === 'owner' && this.#mayWriteDaemonFile(options));
    if (daemonChange && !route && !fileWritable) {
      return refuse({ code: 'CONFIG_DAEMON_OWNED', reason: daemonOwnedRefusal(daemonChange.key).message,
        next: [`goodvibes-daemon config set ${daemonChange.key} <value>`], status: 409 });
    }
    this.invalidateLifetimes();
    const forwarded: ConfigKey[] = [];
    if (route) {
      for (const change of admitted.filter(entry => entry.tier === 'daemon')) {
        this.#forwardDaemonWrite(route, change.key, change.value, readDotPath(this.#config, change.key).value, false);
        forwarded.push(change.key);
      }
      admitted.splice(0, admitted.length, ...admitted.filter(entry => entry.tier !== 'daemon'));
    }

    const previousHost = admitted.some(change => this.hostSettings.has(change.key)) ? this.hostSettings.snapshot(this.#config) : null;
    const previous = new Map(admitted.map(change => [change.key, readDotPath(this.#config, change.key).value] as const));
    const written: AdmittedChange[] = [];
    let failedTier: SetTier | undefined, busy = false;
    for (const tier of SET_TIER_ORDER) {
      const group = admitted.filter(change => change.tier === tier);
      if (group.length === 0) continue;
      try { this.#writeSettingsFile(tier, group); }
      catch (error) { failedTier = tier; busy = error instanceof ProcessLockBusyError; break; }
      written.push(...group);
    }

    if (written.length > 0) {
      const staged = this.runtimeState.fork();
      for (const change of written) {
        writeRawDotPath(staged.nonRuntime as unknown as Record<string, unknown>, change.key, structuredClone(change.value));
        staged.retire(change.key);
        staged.mark(change.key, change.tier);
      }
      this.publishState(staged, staged.compose());
    }
    const saved = [...forwarded, ...written.map(change => change.key)];
    let hostRefreshFailed = false;
    if (previousHost) {
      try { this.refreshHostSettings(previousHost, true); }
      catch { hostRefreshFailed = true; }
    }
    for (const change of written) {
      if (!this.hostSettings.has(change.key)) this.notifyPersistedChange(change.key, previous.get(change.key));
    }
    if (failedTier !== undefined) {
      const unsaved = admitted.filter(change => !written.includes(change)).map(change => change.key);
      if (busy) {
        return refuse({ code: 'CONFIG_BUSY', reason: `Another process is saving the ${SET_TIER_LABEL[failedTier]} settings file right now; ${unsaved.join(', ')} ${unsaved.length === 1 ? 'was' : 'were'} not applied.`,
          next: ['Send the unsaved settings again in a moment.'], retryable: true, status: 409 }, saved);
      }
      return refuse({ code: 'CONFIG_WRITE_FAILED',
        reason: `Could not save the ${SET_TIER_LABEL[failedTier]} settings file; ${unsaved.join(', ')} ${unsaved.length === 1 ? 'was' : 'were'} not applied.`,
        next: ['Check that the settings directory is writable, then send the unsaved settings again.'], status: 500 }, saved);
    }
    if (hostRefreshFailed) {
      return refuse({ code: 'CONFIG_HOST_READ_FAILED', reason: 'The settings were saved, but this surface could not read its own settings back; its registered settings use their restrictive defaults.',
        next: ['Check the settings file named in the startup notice, then reload settings.'], status: 500 }, saved);
    }
    return { ok: true, revision: this.#permissionIncarnation, saved };
  }

  /** Write one settings file with every change of one update that lands in it. */
  #writeSettingsFile(tier: SetTier, changes: readonly AdmittedChange[]): void {
    const path = tier === 'daemon' ? this.daemonTierPath! : tier === 'shared' ? this.sharedTierPath!
      : tier === 'project' ? this.projectConfigPath! : this.configPath;
    this.#updateSettingsFile(path, raw => { for (const change of changes) writeRawDotPath(raw, change.key, structuredClone(change.value)); });
  }

  /**
   * Set a single key and persist it to the PROJECT settings overlay (merged
   * into the raw on-disk shape, keeping only explicit keys), leaving the global
   * file untouched, so an approval like fetch.allowLocalhost scopes to this
   * project and survives restarts. Falls back to set() with no project path.
   */
  setProjectValue<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (!this.projectConfigPath) {
      (this.set as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    value = this.validateSetValue(key, value, options, false) as ConfigValue<K>;
    if (key === 'permissions.mode' && this.get('behavior.autoApprove')) {
      this.setProjectValue('behavior.autoApprove', false, options);
    }
    const previousValue = readDotPath(this.#config, key).value;
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.#config) : null;
    const staged = this.runtimeState.fork();
    const { parent, field } = this.#resolvePath(key, staged.nonRuntime);
    parent[field] = structuredClone(value);
    staged.retire(key);
    staged.mark(key, 'project');
    const effective = staged.compose();
    // Raw-file preparation is inside the same refusal boundary as the write.
    try {
      this.#updateSettingsFile(this.projectConfigPath, raw => { writeRawDotPath(raw, key, structuredClone(parent[field])); });
    } catch (error) {
      if (previousHost) recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previousHost, true));
      throw error;
    }
    this.publishState(staged, effective);
    if (previousHost) this.refreshHostSettings(previousHost, true);
    else this.notifyPersistedChange(key, previousValue);
  }

  /** Subscribe to changes on a config key; returns an unsubscribe function. */
  subscribe<K extends ConfigKey>(key: K, cb: ConfigChangeCallback<K>): ConfigUnsubscribe {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    // Cast via unknown to avoid deeply-recursive ConfigValue<K> comparison that
    // exceeds TypeScript's stack depth on the 100-entry conditional type.
    const wrapped = (newVal: unknown, oldVal: unknown) => (cb as (n: unknown, o: unknown) => void)(newVal, oldVal);
    this._listeners.get(key)?.add(wrapped);
    return () => {
      this._listeners.get(key)?.delete(wrapped);
    };
  }

  /**
   * Watch the on-disk config files (global, project, shared-tier) for EXTERNAL
   * edits and apply them live through the same subscribe() pipeline an
   * in-process set() uses, no restart. Returns a stop function.
   */
  watchConfigFiles(options: { intervalMs?: number } = {}): () => void {
    this.stopWatchingConfigFiles();
    const paths = [this.configPath, this.projectConfigPath, this.sharedTierPath, this.daemonTierPath].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    this._fileWatch = watchConfigFiles(paths, () => this.reloadFromDiskAndNotify(), options.intervalMs, this.hostSettings.active);
    return () => this.stopWatchingConfigFiles();
  }

  /** Drain disk generations already visible to the live watcher before readiness. */
  flushConfigFileChanges(): void {
    this._fileWatch?.poll();
  }

  /** Stop watching all config files opened by watchConfigFiles(). */
  stopWatchingConfigFiles(): void {
    this._fileWatch?.stop();
    this._fileWatch = null;
  }

  /** Re-read config from disk and fire subscribers for every watched key that changed. */
  private reloadFromDiskAndNotify(): void {
    reloadAndNotifyChanges({
      // Registered host leaves notify inside load(), including failed reads.
      listenerKeys: [...this._listeners.keys()].filter((key) => !this.hostSettings.has(key)),
      get: (key) => this.get(key as ConfigKey),
      load: () => this.load(),
      notify: (key, oldValue, newValue) => {
        this.notifyListeners(key as ConfigKey, oldValue, newValue);
        this.emitConfigHook(key as ConfigKey, oldValue, newValue);
      },
    });
  }

  /** Notify synchronous subscribers of a key change. */
  private notifyListeners(key: ConfigKey, oldValue: unknown, newValue: unknown): void {
    const set = this._listeners.get(key);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(detachedConfigValue(newValue), detachedConfigValue(oldValue));
      } catch (error) {
        logger.warn('Config listener failed during setting update', {
          key,
          error: summarizeError(error),
        });
      }
    }
  }

  /** Fire the Change:config hook for a config key change. */
  private emitConfigHook(key: ConfigKey, previousValue: unknown, newValue: unknown): void {
    if (!this.hookDispatcher) return;
    try {
      const event: HookEvent = {
        path: `Change:config:${key}`,
        phase: 'Change',
        category: 'config',
        specific: key,
        sessionId: '',
        timestamp: Date.now(),
        payload: { key, value: detachedConfigValue(newValue), previousValue: detachedConfigValue(previousValue) },
      };
      this.hookDispatcher.fire(event).catch((error: unknown) => {
        logger.warn('[config] Change hook failed', {
          key,
          error: summarizeError(error),
        });
      });
    } catch (error) {
      logger.warn('[config] Change hook dispatch failed', {
        key,
        error: summarizeError(error),
      });
    }
  }

  /**
   * Set a config value from a validated ConfigKey with unknown value type (when
   * iterating schema entries). Runtime validation still applies via set().
   */
  setDynamic(key: ConfigKey, value: unknown, options: ConfigSetOptions = {}): void {
    this.set(key, value as never, options);
  }

  /** Return a deep-readonly snapshot of the full config. Nested objects are immutable. */
  getAll(): DeepReadonly<GoodVibesConfig> {
    return structuredClone(this.#config) as DeepReadonly<GoodVibesConfig>;
  }

  /** Return a deep-cloned snapshot of a config category. */
  getCategory<C extends keyof GoodVibesConfig>(category: C): Readonly<GoodVibesConfig[C]> {
    return structuredClone(this.#config[category]);
  }

  /** Return a deep-cloned snapshot of the live config (read-only consumers). */
  getRaw(): Readonly<GoodVibesConfig> {
    return structuredClone(this.#config) as Readonly<GoodVibesConfig>;
  }

  /** Return the builtin schema; host descriptors are a separate typed surface. */
  getSchema(): ConfigSetting[] {
    return visibleConfigSchema;
  }

  /** Immutable descriptors for the settings registered by this host. */
  getHostSettingsSchema(): readonly HostSetting[] { return this.hostSettings.definitions; }

  /**
   * True when the project settings file explicitly holds a key whose ordinary
   * write goes to the global file. The project tier outranks global at load, so
   * a global-only write would report success and then flip back. Daemon and
   * shared keys sit above the project tier, and the keys a project file may only
   * tighten (see project-layer-restrictions.ts) keep their stricter project value
   * by design. Read without side effects: a corrupt project file is not this
   * method's to quarantine.
   */
  private projectOverridesKey(key: string, includeRestricted = false): boolean {
    if (!this.projectConfigPath || !existsSync(this.projectConfigPath)) return false;
    // One file serving as both layers (a product whose project settings are its own settings file) is the global
    // file: a write to it must not turn the same key into a project-layer value between prepare and commit.
    if (this.projectConfigPath === this.configPath) return false;
    if (this.daemonTierPath && isDaemonOwnedConfigKey(key)) return false;
    if (this.sharedTierPath && isSharedConfigKey(key)) return false;
    if (!includeRestricted && isProjectRestrictedKey(key)) return false;
    try { return readDotPath(JSON.parse(readFileSync(this.projectConfigPath, 'utf-8')), key).present; }
    catch { return false; }
  }

  /** Replace a settings file's whole content (a bulk save or a full reset), under its lock. */
  #replaceSettingsFile(path: string, content: () => Record<string, unknown>): void {
    this.#updateSettingsFile(path, raw => {
      const next = content();
      for (const key of Object.keys(raw)) delete raw[key];
      Object.assign(raw, next);
    });
  }

  /**
   * Persist the non-runtime working view, excluding invocation inputs and
   * frontend defaults. Preserve explicit values that suppress a registered
   * frontend default; runtime authority is neither persisted nor retired.
   */
  save(): void {
    this.requireWritable();
    // A bulk save writes the working view: load any outside edit first, so it is kept, not erased.
    this._fileWatch?.poll();
    this.advanceConfigurationIncarnation();
    const minimal = this.destinationSnapshot('global', this.configPath);
    this.preserveHostSettingsForBulkSave(minimal, this.configPath);
    const staged = this.runtimeState.fork();
    staged.acceptBulkSnapshot(this.withoutDaemonOwned(minimal), 'global', this.hostSettings.keys());
    const effective = staged.compose();
    this.#replaceSettingsFile(this.configPath, () => minimal);
    this.publishState(staged, effective);
  }

  /**
   * The working view as one destination file should hold it. The view merges
   * every tier, so a value another tier owns is replaced here by what the
   * destination file already holds (or dropped), never copied across: a project
   * approval must not become a global setting, and shared or daemon values keep
   * their one file.
   * The reader-floor marker and values the loader could not read are kept as
   * they are on disk, so a bulk save never erases what it did not understand.
   */
  private destinationSnapshot(tier: 'global' | 'project', path: string): Record<string, unknown> {
    // Read without quarantining: an unreadable file contributes nothing here, and
    // the write below replaces it exactly as a bulk save always has.
    let disk: Record<string, unknown> = {};
    try {
      const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) disk = parsed as Record<string, unknown>;
    } catch { /* unreadable: nothing to preserve */ }
    const snapshot = this.runtimeState.bulkSnapshot();
    // A project save is the explicit "write the effective config here" snapshot,
    // so global values may come along; values owned by the shared and daemon
    // tiers never do, and a global save never takes a project value.
    const foreign = (source: string | undefined): boolean => source === 'shared' || source === 'daemon'
      || (tier === 'global' && source === 'project');
    const leaves: string[] = [];
    const walk = (value: unknown, prefix: string): void => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
        for (const [field, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${field}` : field);
      } else if (prefix) leaves.push(prefix);
    };
    walk(snapshot, '');
    for (const leaf of leaves) {
      if (!foreign(this.runtimeState.sources.get(leaf))) continue;
      const held = readDotPath(disk, leaf);
      if (held.present) writeRawDotPath(snapshot, leaf, structuredClone(held.value));
      else deleteRawDotPath(snapshot, leaf);
    }
    for (const notice of this.ingestionNotices) {
      if (notice.file !== path || notice.key === path) continue;
      const held = readDotPath(disk, notice.key);
      if (held.present && !readDotPath(snapshot, notice.key).present) writeRawDotPath(snapshot, notice.key, structuredClone(held.value));
    }
    if (SETTINGS_FLOOR_MARKER_KEY in disk) snapshot[SETTINGS_FLOOR_MARKER_KEY] = structuredClone(disk[SETTINGS_FLOOR_MARKER_KEY]);
    return snapshot;
  }

  /**
   * Drop every daemon-owned key from a whole-config dump. A surface file must
   * never carry a daemon-owned value again, one writer per key means a
   * whole-config save cannot quietly re-seed the duplication the daemon config
   * migration just removed.
   */
  private withoutDaemonOwned(raw: Record<string, unknown>): Record<string, unknown> {
    if (!this.daemonTierPath) return raw;
    for (const key of listDaemonOwnedConfigPaths()) deleteRawDotPath(raw, key);
    return raw;
  }

  /** Persist the non-runtime working view to project settings. Runtime maps survive. */
  saveProject(): void {
    this.requireWritable();
    this._fileWatch?.poll();
    this.advanceConfigurationIncarnation();
    if (!this.projectConfigPath) {
      throw new Error('ConfigManager.saveProject requires an explicit workingDir.');
    }
    const minimal = this.destinationSnapshot('project', this.projectConfigPath);
    this.preserveHostSettingsForBulkSave(minimal, this.projectConfigPath);
    const staged = this.runtimeState.fork();
    staged.acceptBulkSnapshot(this.withoutDaemonOwned(minimal), 'project', this.hostSettings.keys());
    const effective = staged.compose();
    this.#replaceSettingsFile(this.projectConfigPath, () => minimal);
    this.publishState(staged, effective);
  }

  /**
   * Every setting the last load could not ingest, with the file, the key and
   * the reason, the owner-visible signal behind the startup notice. Empty when
   * every settings file was read whole. See ./settings-ingestion.ts.
   */
  getIngestionQuarantine(): readonly SettingsIngestionNotice[] {
    return this.ingestionNotices;
  }
  /** Live diagnostic notices for this manager; the terminal host owns the returned subscription. */
  subscribeIngestionNotices(listener: (notice: SettingsIngestionNotice) => void): () => void {
    this.ingestionNoticeListeners.add(listener);
    return () => { this.ingestionNoticeListeners.delete(listener); };
  }
  private recordIngestionNotice(notice: SettingsIngestionNotice): void {
    this.ingestionNotices.push(notice);
    for (const listener of this.ingestionNoticeListeners) {
      try { drainOwned(listener(Object.freeze({ ...notice }))); }
      catch (error) { drainOwned(error); } // A diagnostic observer cannot change settings admission.
    }
  }
  /** Once a judgment port is installed: announces unknown keys that read as newer forms of known settings. */
  announceUnknownSettingForms(): Promise<void> { return this.unknownSettingForms.start(this.ingestionSink()); }
  /** Where an ingestion notice is filed; see ./manager-ingestion.ts. */
  private ingestionSink(): IngestionNoticeSink {
    return {
      diagnosticMode: this.diagnosticMode,
      record: (entry) => { this.recordIngestionNotice(entry); },
      receipt: (id, text) => { this.migrationReceipt(id, text); },
      forgetReceipts: (selects) => { if (!this.readOnly) new FeatureAnnouncementStore(featureAnnouncementsPath(this)).forgetMatching(selects); },
      unknown: (file, keys) => { this.unknownSettingForms.keep(file, keys, this.ingestionSink()); },
    };
  }
  private ingest(parsed: Record<string, unknown>, file: string): Record<string, unknown> {
    // Existing ingestion/migration may remove malformed categories in place.
    // Capture the host's restrictive projection first, but commit it only
    // AFTER that same persisted-setting validation gate accepts the layer.
    const nextHost = this.hostLoadValues && (file === this.configPath || file === this.projectConfigPath)
      ? new Map(this.hostLoadValues) : null;
    const hostSource = nextHost ? structuredClone(parsed) : null;
    const malformedHostKeys = nextHost ? this.hostSettings.overlay(nextHost, parsed, this.hostLayerOf(file)) : [];
    const ingested = ingestManagerSettings(parsed, file, this.ingestionSink(), new Set(this.hostSettings.keys()));
    if (nextHost) {
      this.hostLoadValues = nextHost;
      if (hostSource) this.hostLoadSources?.set(file, hostSource);
      for (const key of malformedHostKeys) {
        const notice: SettingsIngestionNotice = {
          file, key, action: 'skipped', reason: 'Host setting value is not of its declared type and range, or its section is not an object',
          remedy: 'Fix the stored value; until then this host setting uses its declared restrictive default',
        };
        announceIngestionNotice(notice);
        this.recordIngestionNotice(notice);
      }
    }
    return ingested;
  }
  private loadFailure(label: string, file: string, err: unknown): ConfigError {
    return toConfigLoadFailure(label, file, err, this.ingestionSink());
  }

  /** Reconstruct accepted non-runtime layers from fresh defaults, then compose active runtime inputs. */
  load(): void {
    this.invalidateLifetimes();
    const previousHost = this.hostSettings.snapshot(this.#config);
    const staged = this.runtimeState.fork();
    staged.nonRuntime = cloneDefaultConfig();
    staged.sources.clear();
    staged.globalLayer = {};
    this.hostLoadValues = this.hostSettings.active ? this.hostSettings.defaults() : null;
    this.hostLoadSources = this.hostSettings.active ? new Map() : null;
    try {
      this.ingestionNotices = [];
      if (this.hostSettings.active ? hostSettingsFileExists(this.configPath) : existsSync(this.configPath)) {
        try {
          const migrated = this.ingest(JSON.parse(readFileSync(this.configPath, 'utf-8')) as Record<string, unknown>, this.configPath);
          staged.nonRuntime = sanitizeConfigShape(deepMerge(staged.nonRuntime, migrated) as GoodVibesConfig);
          staged.recordLayer(migrated, 'global');
        } catch (error) { throw this.loadFailure('Global', this.configPath, error); }
      }
      if (this.projectConfigPath && (this.hostSettings.active ? hostSettingsFileExists(this.projectConfigPath) : existsSync(this.projectConfigPath))) {
        try {
          const ingested = this.ingest(JSON.parse(readFileSync(this.projectConfigPath, 'utf-8')) as Record<string, unknown>, this.projectConfigPath);
          const restricted = restrictProjectLayer(ingested, staged.nonRuntime, this.projectConfigPath, this.hostSettings);
          for (const notice of restricted.notices) { announceIngestionNotice(notice); this.recordIngestionNotice(notice); }
          const migrated = restricted.layer;
          staged.nonRuntime = sanitizeConfigShape(deepMerge(staged.nonRuntime, migrated) as GoodVibesConfig);
          staged.recordLayer(migrated, 'project');
        } catch (error) { throw this.loadFailure('Project', this.projectConfigPath, error); }
      }
      this.loadSharedTier(staged);
      this.loadDaemonTier(staged);
      if (this.hostLoadValues) this.hostSettings.apply(staged.nonRuntime, this.hostLoadValues);
      const hostDefaultOrigins = this.hostLoadSources ? this.updateHostSources(staged, this.hostLoadSources) : new Set<string>();
      const effective = staged.compose();
      this.publishState(staged, effective);
      // A later load (a file changed outside this process) reads the files for
      // the durable revision at once; the first one leaves it to the first read.
      this.#durableCache = undefined;
      if (this.hydrating) this.#durableObserved = false;
      else { this.durablePolicy.observe(); this.#durableObserved = true; }
      if (this.hostLoadValues) this.applyHostValues(this.hostLoadValues, previousHost, true, hostDefaultOrigins);
    } catch (error) {
      // Candidate values, invocation maps, and accepted origins were never
      // published. Keep diagnostic/incarnation changes; host permission leaves
      // alone project restrictive defaults into both live and non-runtime state.
      this.applyHostValues(this.hostSettings.defaults(), previousHost, true, new Set(this.hostSettings.keys()));
      throw error instanceof HostSettingsReadError ? this.loadFailure('Host', error.file, error) : error;
    } finally { this.hostLoadValues = null; this.hostLoadSources = null; }
  }

  /** Overlay only daemon-owned keys into the local candidate. */
  private loadDaemonTier(staged: ConfigRuntimeState): void {
    if (!this.daemonTierPath) return;
    try {
      const stored = this.ingest(readDaemonTierFile(this.daemonTierPath), this.daemonTierPath);
      const applied = overlayDaemonTierFrom(stored, (key, value) => {
        const { parent, field } = resolveOrCreateDaemonPath(staged.nonRuntime as unknown as Record<string, unknown>, key);
        parent[field] = value;
      });
      for (const key of applied) staged.sources.set(key, 'daemon');
    } catch (error) { throw this.loadFailure('Daemon', this.daemonTierPath, error); }
  }

  /** The daemon store path, or null when no daemon tier is configured. */
  getDaemonTierPath(): string | null {
    return this.daemonTierPath;
  }

  /**
   * Overlay shared-tier values for the shared keys onto the resolved config; a
   * shared key absent from the file is left at its surface-local value. Records
   * which keys were sourced from the shared tier so describeConfigKeySource is
   * honest.
   */
  private loadSharedTier(staged: ConfigRuntimeState): void {
    if (!this.sharedTierPath) return;
    let shared: Record<string, unknown>;
    try { shared = this.ingest(readSharedTierFile(this.sharedTierPath), this.sharedTierPath); }
    catch (error) { throw this.loadFailure('Shared', this.sharedTierPath, error); }
    for (const key of SHARED_CONFIG_KEYS) {
      const found = readDotPath(shared, key);
      if (!found.present) continue;
      const { parent, field } = this.#resolvePath(key, staged.nonRuntime);
      parent[field] = found.value;
      staged.sources.set(key, 'shared');
    }
  }

  /** The shared-tier settings file path, or null when no shared tier is configured. */
  getSharedTierPath(): string | null {
    return this.sharedTierPath;
  }

  /**
   * Report the accepted/post-write underlay tier and the effective origin.
   * Runtime provenance never rereads disk or reveals invocation history.
   */
  describeConfigKeySource(key: ConfigKey): ConfigKeySource {
    return describeKeySource({
      key,
      value: postalConfigKey(key) ? (() => { const { parent, field } = this.#resolvePath(key); return parent[field]; })() : this.get(key),
      shareable: isSharedConfigKey(key),
      daemonOwned: isDaemonOwnedConfigKey(key),
      sharedTierPath: this.sharedTierPath,
      daemonTierPath: this.daemonTierPath,
      projectConfigPath: this.projectConfigPath,
      configPath: this.configPath,
      sharedKeysPresent: this.sharedKeysPresent,
      daemonKeysPresent: this.daemonKeysPresent,
      acceptedTier: this.runtimeState.sources.get(key) ?? 'default',
      effectiveOrigin: this.hostDefaultOrigins.has(key) ? 'default'
        : this.runtimeState.overrides.has(key) ? 'runtime'
        : this.runtimeState.defaults.has(key) && !this.runtimeState.sources.has(key) ? 'runtime-default'
        : this.runtimeState.sources.get(key) ?? 'default',
    });
  }

  private requireWritable(): void {
    if (this.readOnly) throw new PreparedMutationRefusal('read-only', 'ConfigManager is read-only.');
  }
  /** File a receipt against this config's own announce-once store. */
  private migrationReceipt(id: string, text: string): void {
    if (this.readOnly) return;
    new FeatureAnnouncementStore(featureAnnouncementsPath(this)).record(id, text);
  }

  /** A surface's own settings are read from the project file (repository content) only where declared for projects. */
  private hostLayerOf(path: string): 'global' | 'project' {
    return path === this.projectConfigPath && path !== this.configPath ? 'project' : 'global';
  }

  /** Derive host provenance from the same accepted raw layers that produced its values. */
  private updateHostSources(staged: ConfigRuntimeState, stores: ReadonlyMap<string, Record<string, unknown>>): Set<string> {
    const defaultOrigins = new Set<string>();
    for (const key of this.hostSettings.keys()) staged.mark(key);
    for (const [path, tier] of [[this.configPath, 'global'], [this.projectConfigPath, 'project']] as const) {
      const raw = path ? stores.get(path) : undefined;
      if (!path || !raw) continue;
      const layer = this.hostLayerOf(path);
      for (const key of this.hostSettings.overlay(this.hostSettings.defaults(), raw, layer)) defaultOrigins.add(key);
      for (const key of this.hostSettings.keys()) {
        if (layer === 'project' && !this.hostSettings.projectSettable(key)) continue;
        const found = readDotPath(raw, key);
        if (!found.present) continue;
        staged.mark(key, tier);
        if (this.hostSettings.accepts(key, found.value)) defaultOrigins.delete(key);
      }
    }
    return defaultOrigins;
  }

  private applyHostValues(values: HostSettingValues, previous: HostSettingValues, emitHooks = false,
    defaultOrigins: ReadonlySet<string> = new Set()): void {
    this.hostDefaultOrigins = new Set(defaultOrigins);
    this.hostSettings.apply(this.#config, values);
    this.hostSettings.apply(this.runtimeState.nonRuntime, values);
    for (const [key, value] of values) {
      if (previous.get(key) === value) continue;
      this.notifyListeners(key as ConfigKey, previous.get(key), value);
      if (emitHooks) this.emitConfigHook(key as ConfigKey, previous.get(key), value);
    }
  }

  private refreshHostSettings(previous: HostSettingValues, emitHooks = false): void {
    this.ingestionNotices = this.ingestionNotices.filter((notice) => notice.file !== this.configPath && notice.file !== this.projectConfigPath);
    try {
      const stores = new Map<string, Record<string, unknown>>();
      const values = readHostSettingValues(this.hostSettings, this.configPath, this.projectConfigPath,
        (raw, path) => { const captured = structuredClone(raw); this.ingest(raw, path); stores.set(path, captured); });
      const staged = this.runtimeState.fork();
      this.hostSettings.apply(staged.nonRuntime, values);
      const hostDefaultOrigins = this.updateHostSources(staged, stores);
      this.publishState(staged, staged.compose());
      this.applyHostValues(values, previous, emitHooks, hostDefaultOrigins);
    } catch (error) {
      this.applyHostValues(this.hostSettings.defaults(), previous, true, new Set(this.hostSettings.keys()));
      throw error instanceof HostSettingsReadError ? this.loadFailure('Host', error.file, error) : error;
    }
  }

  private preserveHostSettingsForBulkSave(snapshot: Record<string, unknown>, path: string): void {
    if (!this.hostSettings.active) return;
    try {
      this.hostSettings.preserveDestination(snapshot, readHostSettingsFile(path));
    } catch (error) {
      this.applyHostValues(this.hostSettings.defaults(), this.hostSettings.snapshot(this.#config), true, new Set(this.hostSettings.keys()));
      throw error;
    }
  }

  private hostSettingHasProjectValue(key: string): boolean {
    try { return this.projectConfigPath !== null && readDotPath(readHostSettingsFile(this.projectConfigPath), key).present; }
    catch (error) {
      recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(this.hostSettings.snapshot(this.#config), true));
    }
  }

  private resetHostSetting(key: ConfigKey, value: HostSettingValue): void {
    if (this.hostSettingHasProjectValue(key)) this.setProjectValue(key, value as never);
    const lock = getManagedSettingLock(key, this.configDir);
    if (lock) throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
    const previous = this.hostSettings.snapshot(this.#config);
    // Reset must revoke the global copy too even when ordinary host set() edits
    // an existing higher-priority project leaf. This is the same owned scalar
    // persistence used by set(), with its read-only and managed-lock guards.
    try { this.#updateSettingsFile(this.configPath, raw => { writeRawDotPath(raw, key, value); }); }
    catch (error) { recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previous, true)); }
    this.refreshHostSettings(previous, true);
  }

  /**
   * Merge a partial patch into a config category and auto-save, the correct
   * way to update array/object fields that cannot be expressed as a scalar
   * dot-path key (e.g. notifications.webhookUrls). Shallow-merged.
   */
  mergeCategory<C extends keyof GoodVibesConfig>(category: C, patch: Partial<GoodVibesConfig[C]>): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (Object.keys(patch).some((key) => this.hostSettings.has(`${String(category)}.${key}`))) {
      throw new ConfigError('Registered host settings require the guarded scalar set API.');
    }
    const ownedPatch = structuredClone(patch) as Record<string, unknown>;
    // Every field is admitted before any is written: the same lock and schema
    // checks as set(), so this path cannot change what set() would refuse.
    const previous = new Map<string, unknown>();
    // A credential or card field nested anywhere in the patch is refused like a
    // scalar write of it: one facts lookup per leaf.
    const refuseCredentialLeaves = (path: string, value: unknown): void => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [field, child] of Object.entries(value)) refuseCredentialLeaves(`${path}.${field}`, child);
        return;
      }
      const credential = credentialValueRefusal(path, value);
      if (credential) throw new ConfigError(`${credential.reason} ${credential.next}`);
    };
    for (const [field, value] of Object.entries(ownedPatch)) {
      if (value === undefined) continue;
      const path = `${String(category)}.${field}`;
      refuseCredentialLeaves(path, value);
      // A category patch cannot be sent to the daemon key by key, so a daemon-owned
      // field is written here only where this process may write the daemon's file.
      this.#refuseDaemonFileWrite(path, {});
      const schema = CONFIG_SCHEMA.find(setting => setting.key === path);
      if (schema) {
        const refusal = (schema.validate && !schema.validate(value) ? 'does not satisfy this setting\'s rules' : null)
          ?? (schema.type === 'enum' ? (schema.enumValues?.includes(value as string) ? null : `allowed: ${schema.enumValues?.join(', ')}`) : schemaTypeRefusal(schema, value));
        if (refusal) throw new ConfigError(`Invalid value for ${path} (${refusal})`);
      }
      const lock = getManagedSettingLock(path as ConfigKey, this.configDir);
      if (lock) throw new ConfigError(`Setting ${path} is locked by ${lock.source}: ${lock.reason}`);
      previous.set(path, readDotPath(this.#config, path).value);
    }
    const staged = this.runtimeState.fork();
    const current = staged.nonRuntime[category] as Record<string, unknown>;
    for (const [field, value] of Object.entries(ownedPatch)) {
      if (value === undefined) continue;
      const path = `${String(category)}.${field}`;
      current[field] = value;
      staged.retire(path);
      staged.mark(path, this.daemonTierPath && isDaemonOwnedConfigKey(path) ? 'daemon' : 'global');
    }
    const effective = staged.compose();
    persistCategoryPatch(String(category), ownedPatch, current, this.categoryIoDeps(staged));
    this.publishState(staged, effective);
    for (const [path, before] of previous) this.notifyPersistedChange(path as ConfigKey, before);
  }

  /**
   * Remove a key from an object-shaped category and auto-save. mergeCategory
   * can only set keys, so clearing an override (e.g. a feature-flag entry back
   * to its default) requires this explicit removal.
   */
  removeCategoryKey<C extends keyof GoodVibesConfig>(category: C, key: string): void {
    this.requireWritable();
    this.invalidateLifetimes();
    const hostKey = `${String(category)}.${key}`;
    if (this.hostSettings.has(hostKey)) { this.reset(hostKey as ConfigKey); return; }
    const staged = this.runtimeState.fork();
    const current = staged.nonRuntime[category] as Record<string, unknown>;
    if (!(key in current) && ![...staged.overrides.keys()].some(entry => entry === hostKey || entry.startsWith(`${hostKey}.`))) return;
    const lock = getManagedSettingLock(hostKey as ConfigKey, this.configDir);
    if (lock) throw new ConfigError(`Setting ${hostKey} is locked by ${lock.source}: ${lock.reason}`);
    this.#refuseDaemonFileWrite(hostKey, {});
    const previousValue = readDotPath(this.#config, hostKey).value;
    delete current[key];
    staged.retire(hostKey);
    staged.mark(hostKey);
    const effective = staged.compose();
    persistCategoryKeyRemoval(String(category), key, this.categoryIoDeps(staged));
    this.publishState(staged, effective);
    this.notifyPersistedChange(hostKey as ConfigKey, previousValue);
  }

  private categoryIoDeps(staged: ConfigRuntimeState): CategoryIoDeps {
    return {
      configPath: this.configPath,
      daemonTierPath: this.daemonTierPath,
      update: (path, mutate) => this.#updateSettingsFile(path, mutate),
      markDaemonKey: (key, present) => { staged.mark(key, present ? 'daemon' : undefined); },
    };
  }

  private resetDynamicToolPermission(key: ConfigKey): void {
    this.invalidateLifetimes();
    this.#updateSettingsFile(this.configPath, raw => { deleteRawDotPath(raw, key); });
    if (this.projectOverridesKey(key, true)) this.#updateSettingsFile(this.projectConfigPath!, raw => deleteRawDotPath(raw, key));
    this.load();
  }

  /** Remove explicit preferences; full reset retains this frontend's defaults. Cross-tier disk writes are not transactional. */
  reset(key?: ConfigKey, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    const route = key !== undefined ? this.#routedDaemonWrite(key, options) : null;
    if (key !== undefined && route) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      this.invalidateLifetimes();
      this.#forwardDaemonWrite(route, key, structuredClone(readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value), readDotPath(this.#config, key).value, true);
      return;
    }
    // A managed-policy lock refuses a reset the same way it refuses a write.
    if (key !== undefined) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      this.#refuseDaemonFileWrite(key, options);
    }
    // A per-tool permission has no schema row (tools register at runtime) but is still written by set() and can be
    // held by the project file, whose refusal tells the user to reset it.
    if (key !== undefined && key.startsWith('permissions.tools.') && !CONFIG_SCHEMA.some(setting => setting.key === key)) {
      this.resetDynamicToolPermission(key);
      return;
    }
    // A full reset from another process resets this surface's settings and
    // leaves the daemon's file alone: only the daemon resets all of its settings.
    const clearsDaemonTier = this.daemonTierPath !== null && (this.daemonTierOwner || key !== undefined);
    this.invalidateLifetimes();
    for (const definition of this.hostSettings.definitions) {
      if (key !== undefined && key !== definition.key) continue;
      this.resetHostSetting(definition.key as ConfigKey, definition.default);
      if (key !== undefined) return;
    }
    const previousValues = CONFIG_SCHEMA.filter(setting => !this.hostSettings.has(setting.key) && (key === undefined || setting.key === key))
      .map(setting => ({ key: setting.key, value: detachedConfigValue(readDotPath(this.#config, setting.key).value) }));
    const staged = this.runtimeState.fork();
    staged.retire(key);
    if (key === undefined) {
      staged.nonRuntime = cloneDefaultConfig();
      this.hostSettings.apply(staged.nonRuntime, this.hostSettings.defaults());
      staged.sources.clear();
      staged.globalLayer = {};
      for (const hostKey of this.hostSettings.keys()) {
        if (this.runtimeState.sources.get(hostKey) === 'project') staged.sources.set(hostKey, 'project');
      }
    } else {
      const schema = CONFIG_SCHEMA.find(setting => setting.key === key);
      if (!schema) throw new ConfigError(`Unknown config key: ${key}`);
      const path = this.#resolvePath(key, staged.nonRuntime);
      path.parent[path.field] = structuredClone(readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value);
      staged.mark(key);
    }
    const effective = staged.compose();
    if (key === undefined) this.#replaceSettingsFile(this.configPath, () => ({}));
    else {
      this.#updateSettingsFile(this.configPath, raw => { deleteRawDotPath(raw, key); });
      // A project value would put the key straight back at the next load.
      if (this.projectOverridesKey(key, true)) this.#updateSettingsFile(this.projectConfigPath!, raw => deleteRawDotPath(raw, key));
    }
    const daemonKeys: readonly string[] = key === undefined ? listDaemonOwnedConfigPaths() : isDaemonOwnedConfigKey(key) ? [key] : [];
    if (this.daemonTierPath && clearsDaemonTier && daemonKeys.length > 0) {
      this.#updateSettingsFile(this.daemonTierPath, raw => daemonKeys.map(entry => deleteRawDotPath(raw, entry)).some(Boolean));
    }
    if (this.sharedTierPath) {
      const resetKeys: readonly string[] = key === undefined ? SHARED_CONFIG_KEYS : (isSharedConfigKey(key) ? [key] : []);
      if (resetKeys.length > 0) this.#updateSettingsFile(this.sharedTierPath, raw => resetKeys.map(entry => deleteRawDotPath(raw, entry)).some(Boolean));
    }
    // Earlier files can have been replaced if a later write throws. Preserve
    // the complete live state; the next accepted load reconciles those bytes.
    this.publishState(staged, effective);
    for (const previous of previousValues) this.notifyPersistedChange(previous.key, previous.value);
    // A full reset leaves the project file (and, from another process, the
    // daemon's file) alone, and their values win at every load: show them now.
    const keptFile = (this.projectConfigPath && this.projectConfigPath !== this.configPath && existsSync(this.projectConfigPath))
      || (this.daemonTierPath !== null && !clearsDaemonTier);
    if (key === undefined && keptFile) {
      try { this.load(); } catch { /* the reset is written; an unreadable file is reported by the next load */ }
    }
  }
}

const nativeWorkspaceReader = ConfigManager.prototype.retainConfiguredWorkspace;
/** Internal module bridge deliberately absent from the public config barrel. */
export function retainConfiguredWorkspace(configManager: ConfigManager): ConfiguredWorkspaceReference {
  return nativeWorkspaceReader.call(configManager);
}

/** Deep-merge source into target. Returns a new object. Source non-objects are ignored, target clone is returned.
 * Non-object source values will not overwrite object target values (type-safe merge). */
function deepMerge(target: unknown, source: unknown): unknown {
  const result: Record<string, unknown> = isObject(target)
    ? structuredClone(target) as Record<string, unknown>
    : {};
  if (!isObject(source)) return result;
  for (const key of Object.keys(source)) {
    const sv = source[key]!;
    const tv = result[key]!;
    if (isObject(sv) && isObject(tv)) {
      result[key] = deepMerge(tv, sv);
    } else if (sv !== undefined && !isObject(tv)) {
      // Only overwrite non-object target values, never replace an object with a scalar.
      // Clone assigned values so config instances never share mutable references.
      result[key] = structuredClone(sv);
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/** Caller-owned values at every read/observer boundary, including individual listeners. */
function detachedConfigValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}
