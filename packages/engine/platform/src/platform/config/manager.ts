import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes-jev/judgment/decisions';
import { POSTAL_PARTS, PostalAddressHeldError, type ProfilePostalReader, type PostalKind, type PostalReadOptions, type PreparedPostalAddress, type PostalParts } from './postal-address.js';
import { DurablePolicyEpochOwner } from './durable-policy-epoch.js';
import { PreparedSettingsTarget, settingsFileIdentity } from './prepared-target.js';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isDeepStrictEqual } from 'node:util';
import { VERSION } from '../version.js';
import { JudgmentAuthorityRetiredError, RefusalError } from '@goodvibes-jev/engine/errors';
import { unboundCredentialDestinationRefusal } from './credential-destination-keys.js';
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
import { describeKeySource, type ConfigKeyTier, type ConfigKeySource } from './manager-key-source.js';
import { DEFAULT_CONFIG_SNAPSHOT, cloneDefaultConfig, ensureSharedConfig, requireAbsoluteOwnedPath, sanitizeConfigShape } from './manager-bootstrap.js';
import { resolveWithProfileFallback, type ConfigProfileFallbackReader } from './profile-fallback.js';
import { ingestManagerSettings, toConfigLoadFailure, type IngestionNoticeSink, type SettingsIngestionNotice } from './manager-ingestion.js';
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
import { admitSettingValue, credentialValueRefusal, stricterProjectValueRefusal, type SettingAdmissionContext } from './write-admission.js';
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
   * The surface whose `settings.json` files (global and project) hold this
   * manager's client-scoped keys. Omitted: `surfaceRoot`. The daemon keeps its
   * own, so a preference set in one terminal app (such as `permissions.mode`)
   * does not become the daemon's, while its state stays under `surfaceRoot`.
   */
  settingsSurfaceRoot?: string | undefined;
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
  /**
   * Several keys as one request the daemon admits whole (`config.setMany`):
   * every key is written or none is. Without it, the keys of one update go
   * one request each.
   */
  writeMany?(changes: readonly { readonly key: string; readonly value: unknown }[]): Promise<void>;
  reset?(key: string): Promise<void>;
  /** The daemon refused a forwarded write; this process's view of the key was put back. */
  refused?(key: string, error: unknown): void;
}

/**
 * Whether a forwarded write failed because nothing accepted the connection
 * (Bun names it `ConnectionRefused`, Node `ECONNREFUSED`), so nothing was sent.
 * The code may sit on a transport error's cause chain.
 */
function nothingListening(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === 'ECONNREFUSED' || code === 'ConnectionRefused') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A daemon-owned write the daemon refused; this process's view of the key is back at what it was. */
export interface DaemonWriteRefusal {
  readonly key: string;
  readonly error: unknown;
}

/**
 * Keys an update sent to the daemon and shows already: `settle()` resolves
 * once the daemon has answered, to the keys it refused (empty when it took
 * them all). A refusal returned here counts as reported to the caller.
 */
export interface DaemonWritePending {
  readonly keys: readonly ConfigKey[];
  settle(): Promise<readonly DaemonWriteRefusal[]>;
}

/**
 * A host's rule on one setting's new value, for a fact only the host knows
 * (the daemon refusing to require step-up while no passkey is registered).
 * Synchronous: it reads what the host already holds. Returns why the value is
 * refused and what to do, or null to admit it.
 */
export type SettingWriteAdmission = (value: unknown, current: unknown) =>
  { readonly reason: string; readonly next: readonly string[] } | null;

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
 * reached its settings file or was sent to the daemon; on a refusal it is
 * empty unless a later file could not be written after an earlier one was.
 * `pending`, present when keys went to the daemon, is what a caller reporting
 * to a person awaits: those keys stand only once its answer has none refused.
 */
export type SetResult =
  | { readonly ok: true; readonly revision: number; readonly saved: readonly ConfigKey[]; readonly pending?: DaemonWritePending | undefined }
  | { readonly ok: false; readonly refusal: Refusal; readonly saved: readonly ConfigKey[]; readonly pending?: DaemonWritePending | undefined };

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
/** Every leaf of a settings document by dotted path (a non-empty object is a branch; anything else, arrays included, a leaf). */
function settingsLeaves(document: Record<string, unknown>): Map<string, unknown> {
  const leaves = new Map<string, unknown>();
  const walk = (value: unknown, prefix: string): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
      for (const [field, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${field}` : field);
    } else if (prefix) leaves.set(prefix, value);
  };
  walk(document, '');
  return leaves;
}

/**
 * Three-way merge of a bulk settings save: `baseline` is what the file held
 * when the save's snapshot (`ours`) was taken, `theirs` what it holds now.
 * Per leaf, the side that changed it wins; both changing it to different
 * values is a conflict, named.
 */
function mergeBulkSettingsSave(baseline: Record<string, unknown>, ours: Record<string, unknown>, theirs: Record<string, unknown>):
  { readonly result: Record<string, unknown>; readonly conflicts: string[] } {
  const base = settingsLeaves(baseline), mine = settingsLeaves(ours), other = settingsLeaves(theirs);
  const result: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const key of new Set([...base.keys(), ...mine.keys(), ...other.keys()])) {
    const b = base.get(key), o = mine.get(key), t = other.get(key);
    const chosen = isDeepStrictEqual(o, b) ? { present: other.has(key), value: t }
      : isDeepStrictEqual(t, b) || isDeepStrictEqual(o, t) ? { present: mine.has(key), value: o }
        : undefined;
    if (!chosen) { conflicts.push(key); continue; }
    if (chosen.present) writeRawDotPath(result, key, structuredClone(chosen.value));
  }
  return { result, conflicts };
}

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
  /** Host rules on one setting's new value, registered by the composition that owns the fact they read. */
  readonly #writeAdmissions = new Map<string, SettingWriteAdmission>();
  private readonly _listeners = new Map<string, Set<(newVal: unknown, oldVal: unknown) => void>>();
  /** Active config-file watch handle (external-edit live reload), or null. */
  private _fileWatch: ConfigFileWatchHandle | null = null;
  /** Settings the last load could not ingest. See ./settings-ingestion.ts. */
  private ingestionNotices: SettingsIngestionNotice[] = [];
  private readonly ingestionNoticeListeners = new Set<(notice: SettingsIngestionNotice) => void>();

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
    const settingsSurfaceRoot = overrides.settingsSurfaceRoot
      ? requireSurfaceRoot(overrides.settingsSurfaceRoot, 'ConfigManager settingsSurfaceRoot') : surfaceRoot;
    this.configDir = base;
    this.configPath = !configDir && settingsSurfaceRoot && settingsSurfaceRoot !== surfaceRoot
      ? resolveSurfaceDirectory(homeDirectory!, settingsSurfaceRoot, 'settings.json')
      : join(base, 'settings.json');
    this.workingDirectory = workingDirectory;
    this.homeDirectory = homeDirectory;
    this.projectConfigPath = this.workingDirectory
      ? resolveSurfaceDirectory(this.workingDirectory, settingsSurfaceRoot!, 'settings.json')
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
      // The reader owns both paths: with no decision model in use it returns
      // the profile text's fields unchecked and says so (`profileText`).
      const readProfile = () => reader && POSTAL_PARTS.some(part => stored[part] === '')
        ? reader(kind, { ...options, assertCurrent: check }) : Promise.resolve(null);
      const fallback = await decisionOrClassic<PreparedPostalAddress | null>(readProfile, readProfile);
      check(); fallback?.assertCurrent();
      const value = Object.freeze(Object.fromEntries(POSTAL_PARTS.map(part => [part, stored[part] || fallback?.value?.[part] || ''])) as unknown as PostalParts);
      const splitParts = fallback?.profileText === 'split-unchecked'
        ? POSTAL_PARTS.filter(part => stored[part] === '' && (fallback.value?.[part] ?? '') !== '') : [];
      return Object.freeze({ value: POSTAL_PARTS.some(part => value[part] !== '') ? value : null,
        ...(isClassicOperation() ? { provenance: 'classic' as const, profileAssessment: 'not-evaluated' as const } : {}),
        ...(splitParts.length > 0 ? { profileText: 'split-unchecked' as const, splitParts: Object.freeze(splitParts) }
          : fallback?.profileText === 'not-split' ? { profileText: 'not-split' as const } : {}),
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
   * Get a config value by dot-path key: the setting as stored (or its
   * default). Never the owner profile, so a settings row, dump, snapshot or
   * export carries only what was set; see `resolveForConsumer`.
   */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.#resolvePath(key);
    return detachedConfigValue(parent[field]) as ConfigValue<K>;
  }

  /**
   * The value a feature acts on: the stored setting, or, when it is unset and
   * the owner profile records the fact (the owner's zone, currency, quiet hours
   * or preferred channel), the profile's value. One keyed read by the consumer
   * that needs it; never used for a listing or export. See ./profile-fallback.ts.
   */
  resolveForConsumer<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.#resolvePath(key);
    return detachedConfigValue(resolveWithProfileFallback(key, parent[field], this.profileFallback)) as ConfigValue<K>;
  }

  /** Whether a settings file or a runtime override holds this key, rather than the shipped default. One map lookup. */
  isExplicitlySet(key: ConfigKey): boolean {
    return this.runtimeState.sources.has(key) || this.runtimeState.overrides.has(key);
  }

  /**
   * Where the loaded value of a key comes from: the shipped default, the
   * global file, the project file, the shared tier, the daemon, or this
   * program's own host setting. Read from what the load recorded (a map read,
   * no file read), so no caller reads a settings file itself to learn whether
   * a key was stated.
   */
  sourceOf(key: ConfigKey): ConfigKeyTier | 'host' {
    const tier = this.runtimeState.sources.get(key);
    if (tier !== undefined) return tier;
    if (this.hostSettings.has(key)) return 'host';
    return 'default';
  }

  /**
   * Set `key` to `next` only while it still holds `expected` (compared by
   * value): a deferred change that failed restores only keys nothing has
   * changed since. 'superseded' when another write got there first; nothing
   * is written then.
   */
  setIfUnchanged<K extends ConfigKey>(key: K, expected: unknown, next: ConfigValue<K>, options: ConfigSetOptions = {}): 'set' | 'superseded' {
    if (JSON.stringify(this.get(key)) !== JSON.stringify(expected)) return 'superseded';
    (this.set as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, next, options);
    return 'set';
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

  private prepareSingleSettingMutation(request: PreparedConfigMutationRequest, projected?: Record<string, unknown>): PreparedConfigMutation {
    this.requireWritable();
    const incarnation = this.#permissionIncarnation;
    if (request.operation !== 'set' && request.operation !== 'reset') throw new ConfigError('Unsupported prepared operation.');
    const { schema, identity } = this.preparedSchema(request.key);
    const signature = preparedSchemaSignature(schema);
    const validator = schema.validate;
    const requested = this.preparedRequestedValue(request);
    const destinations = this.preparedDestinations(request.operation, request.key);
    // The same admission set() and setMany() apply: the rules across settings
    // (against the whole plan) and, for a write to this surface's own file,
    // the stricter project value that would undo it at the next start.
    const value = normalizePreparedValue(request.key, schema, requested, this.preparedAdmissionContext(request.key, destinations, projected));
    if (request.operation === 'set') {
      const hostRefusal = this.hostWriteRefusal(request.key, value);
      if (hostRefusal) throw new ConfigError(`${request.key} was not changed: ${hostRefusal.reason} ${hostRefusal.next.join(' ')}`);
    }
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
    this.#refuseUnboundDestination(requests.map(request => ({ key: request.key,
      value: request.operation === 'reset' ? readDotPath(DEFAULT_CONFIG_SNAPSHOT, request.key).value : request.value })));
    if (requests.length === 1) return this.prepareSingleSettingMutation(requests[0]!);
    const projected = this.preparedProjection(requests.map(request => ({ key: request.key, value: this.preparedRequestedValue(request) })));
    const steps = Object.freeze(requests.map(request => this.prepareSingleSettingMutation(request, projected)));
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
      const currents = record.steps ? record.steps.map(step => this.preparedRecord(step)) : [record];
      const projected = this.preparedProjection(currents.map(current => ({ key: current.facts.key, value: current.facts.value })));
      for (const current of currents) {
        const { schema } = this.preparedSchema(current.facts.key);
        const next = normalizePreparedValue(current.facts.key, schema, current.facts.value,
          this.preparedAdmissionContext(current.facts.key, current.facts.destinations, projected));
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

  /** The value a prepared request would write: its own for a set, the default for a reset. */
  private preparedRequestedValue(request: PreparedConfigMutationRequest): unknown {
    if (request.operation === 'set') return request.value;
    return this.hostSettings.has(request.key) ? this.preparedSchema(request.key).schema.default : readDotPath(DEFAULT_CONFIG_SNAPSHOT, request.key).value;
  }

  /** The live config with every change of a plan in place, which the rules across settings read. */
  private preparedProjection(changes: readonly { readonly key: string; readonly value: unknown }[]): Record<string, unknown> {
    const projected = structuredClone(this.#config) as unknown as Record<string, unknown>;
    for (const change of changes) writeRawDotPath(projected, change.key, structuredClone(change.value));
    return projected;
  }

  /**
   * The admission context of a prepared write. A non-schema key is checked
   * against the live config (its path must exist there); the project hold
   * applies only to a write that lands in this surface's own file.
   */
  private preparedAdmissionContext(key: string, destinations: readonly PreparedConfigMutationDestination[], projected?: Record<string, unknown>): SettingAdmissionContext {
    const schemaKey = this.hostSettings.has(key) || SCHEMA_BY_KEY.has(key);
    const config = schemaKey ? projected ?? this.#config : this.#config;
    const ownFileOnly = destinations.length > 0 && destinations.every(destination => destination.tier === 'global' && destination.operation === 'set');
    return { config, projectConfigPath: ownFileOnly ? this.#outrankingProjectPath() : null };
  }

  private preparedDestinations(operation: 'set' | 'reset', key: ConfigKey): PreparedConfigMutationDestination[] {
    const destination = (path: string, tier: PreparedConfigMutationDestination['tier'], effect: 'set' | 'remove'): PreparedConfigMutationDestination => ({ path, tier, operation: effect });
    if (this.hostSettings.has(key)) {
      const project = this.hostSettingHasProjectValue(key);
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
    this.#applyAllInView([{ key, value }], tier);
  }

  /** Set keys in the in-memory view only (no file), publish once, and notify each like a persisted change. */
  #applyAllInView(changes: readonly { readonly key: ConfigKey; readonly value: unknown }[], tier: 'daemon' | undefined): void {
    const previous = changes.map(change => readDotPath(this.#config, change.key).value);
    const staged = this.runtimeState.fork();
    for (const change of changes) {
      const { parent, field } = this.#resolvePath(change.key, staged.nonRuntime);
      parent[field] = structuredClone(change.value);
      staged.retire(change.key);
      staged.mark(change.key, tier);
    }
    this.publishState(staged, staged.compose());
    changes.forEach((change, index) => this.notifyPersistedChange(change.key, previous[index]));
  }

  /** Daemon writes sent from this process whose answer has not arrived; each settles to its refusals. */
  readonly #forwarding = new Set<Promise<readonly DaemonWriteRefusal[]>>();
  /** Open {@link watchDaemonWrites} watches; each collects the writes sent while it is open. */
  readonly #forwardWatches = new Set<Promise<readonly DaemonWriteRefusal[]>[]>();

  /**
   * Send daemon-owned writes through the daemon and show them in this process
   * at once. Several keys go as one request the daemon admits whole when the
   * route can; a refusal puts each refused key back if it still holds the
   * value sent. Settles to the refusals.
   */
  #forwardDaemonWrites(route: DaemonWriteRoute, changes: readonly { readonly key: ConfigKey; readonly value: unknown }[], reset: boolean): Promise<readonly DaemonWriteRefusal[]> {
    const previous = changes.map(change => readDotPath(this.#config, change.key).value);
    this.#applyAllInView(changes, reset ? undefined : 'daemon');
    const refuse = (index: number, error: unknown): DaemonWriteRefusal => {
      const change = changes[index]!;
      if (JSON.stringify(readDotPath(this.#config, change.key).value) === JSON.stringify(change.value)) {
        try { this.#applyInView(change.key, previous[index], 'daemon'); } catch { /* the reload from the daemon's file reconciles */ }
      }
      try { route.refused?.(change.key, error); } catch { /* reporting cannot change the outcome */ }
      return { key: change.key, error };
    };
    // A refused connection means no daemon listens where this process sends
    // its writes, and nothing was sent: the daemon's file is what a daemon
    // reads when it starts, so the value goes there (as with no route at all)
    // instead of being reported as refused by a daemon that is not running.
    const settle = (index: number, error: unknown): DaemonWriteRefusal | null => {
      if (!nothingListening(error)) return refuse(index, error);
      const change = changes[index]!;
      try {
        if (reset) this.reset(change.key, { daemonNotRunning: true });
        else this.set(change.key, change.value as never, { daemonNotRunning: true });
        return null;
      } catch (fileError) {
        return refuse(index, fileError);
      }
    };
    const settled: Promise<readonly (DaemonWriteRefusal | null)[]> = changes.length > 1 && !reset && route.writeMany
      ? route.writeMany(changes).then(() => [], (error: unknown) => changes.map((_, index) => settle(index, error)))
      : Promise.all(changes.map((change, index) => (reset && route.reset ? route.reset(change.key) : route.write(change.key, change.value))
        .then(() => null, (error: unknown) => settle(index, error))));
    const outcome: Promise<readonly DaemonWriteRefusal[]> = settled
      .then(results => results.filter((result): result is DaemonWriteRefusal => result !== null));
    this.#forwarding.add(outcome);
    for (const watch of this.#forwardWatches) watch.push(outcome);
    void outcome.finally(() => { this.#forwarding.delete(outcome); });
    return outcome;
  }

  /**
   * Wait for the daemon's answer to every daemon-owned write this process has
   * sent and not heard back on; returns the ones it refused (each already put
   * back in this process's view). For a command that wrote through code which
   * cannot await, so it can report what the daemon did.
   */
  async settleDaemonWrites(): Promise<readonly DaemonWriteRefusal[]> {
    const results = await Promise.all([...this.#forwarding]);
    return this.#markReported(results.flat());
  }

  /** Refusals a caller has been given, so a dispatcher's watch does not report them a second time. */
  readonly #reportedRefusals = new WeakSet<DaemonWriteRefusal>();

  #markReported(refusals: readonly DaemonWriteRefusal[]): readonly DaemonWriteRefusal[] {
    for (const refusal of refusals) this.#reportedRefusals.add(refusal);
    return refusals;
  }

  /**
   * Start collecting the daemon-owned writes sent from now on. The returned
   * function stops collecting, waits for the daemon's answer to each one
   * collected and returns the refusals: a command dispatcher calls it after a
   * handler ran so the person is told what the daemon refused, and only that.
   * Costs nothing while no write is sent.
   */
  watchDaemonWrites(): () => Promise<readonly DaemonWriteRefusal[]> {
    const collected: Promise<readonly DaemonWriteRefusal[]>[] = [];
    this.#forwardWatches.add(collected);
    return async () => {
      this.#forwardWatches.delete(collected);
      const refusals = (await Promise.all(collected)).flat();
      return this.#markReported(refusals.filter(refusal => !this.#reportedRefusals.has(refusal)));
    };
  }

  validateDynamic(key: ConfigKey, value: unknown, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.validateSetValue(key, value, options, true);
  }

  /**
   * The one admission of a value (write-admission.ts): its type, schema,
   * credential form, and the rules across settings read against `config` with
   * the value in place. A value is checked against what the loader insists on,
   * so a write cannot be reported as saved and then skipped at the next start.
   * The refusal never echoes the value.
   */
  private validateSetValue(key: ConfigKey, value: unknown, options: ConfigSetOptions, purePolicyRead: boolean): unknown {
    const schema = this.hostSettings.schema(key) ?? SCHEMA_BY_KEY.get(key);
    const admission = admitSettingValue(key, schema, value, { config: this.#config });
    if (!admission.ok) {
      throw new ConfigError(credentialValueRefusal(key, value) ? admission.reason : `Invalid value for ${key} (${admission.reason})`);
    }
    const hostRefusal = this.hostWriteRefusal(key, admission.value);
    if (hostRefusal) throw new ConfigError(`${key} was not changed: ${hostRefusal.reason} ${hostRefusal.next.join(' ')}`);
    if (!options.bypassManagedLock) {
      const lock = purePolicyRead ? readStrictManagedSettingLock(key, this.configDir) : getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
    }
    this.#resolvePath(key);
    return admission.value;
  }

  /**
   * Add a host rule on one setting's new value, checked by set(), setDynamic(),
   * setMany() and prepared changes after the value's own admission. One rule
   * per key; registering again replaces it. Returns the removal.
   */
  registerWriteAdmission(key: ConfigKey, admit: SettingWriteAdmission): () => void {
    this.#writeAdmissions.set(key, admit);
    return () => { if (this.#writeAdmissions.get(key) === admit) this.#writeAdmissions.delete(key); };
  }

  /** The registered host rule's refusal of `value` for `key`, or null. */
  private hostWriteRefusal(key: string, value: unknown): { readonly reason: string; readonly next: readonly string[] } | null {
    const admit = this.#writeAdmissions.get(key);
    return admit ? admit(value, readDotPath(this.#config, key).value) : null;
  }

  /**
   * The project file this surface's own file is outranked by, for the
   * stricter-project-value hold (write-admission.ts), or null when there is
   * none apart from the file being written.
   */
  #outrankingProjectPath(): string | null {
    return this.projectConfigPath && this.projectConfigPath !== this.configPath ? this.projectConfigPath : null;
  }

  /** Refuses a write to this surface's own file that the project file's stricter value would undo at the next start. */
  #refuseHeldByProject(key: string, value: unknown): void {
    const projectPath = this.#outrankingProjectPath();
    const held = projectPath ? stricterProjectValueRefusal(key, value, this.#config, projectPath) : null;
    if (held) throw new ConfigError(`Setting ${key} is ${held}.`);
  }

  /**
   * What changing `key` to `value` would loosen (a security, permission,
   * judgment or payment setting), in words, or null when it would not. Weighed
   * against the value features act on: an unset setting the owner profile
   * fills (the zone, the currency) is loosened from that value. With
   * `toDefault`, the change is a reset to the key's shipped default and
   * `value` is not read.
   */
  describeLoosening(key: string, value: unknown, options: { readonly toDefault?: boolean } = {}): string | null {
    const facts = configKeyFacts(key);
    if (!facts.loosens) return null;
    const next = options.toDefault === true ? SCHEMA_BY_KEY.get(key)?.default : value;
    const current = resolveWithProfileFallback(key, readDotPath(this.#config, key).value, this.profileFallback);
    return facts.loosens(current, next) ? (facts.loosening ?? 'loosen security') : null;
  }

  /**
   * Refuses (CREDENTIAL_DESTINATION_UNBOUND) an update that moves where a
   * configured credential is sent without stating that credential in the
   * same update (credential-destination-keys.ts). `changes` holds each key
   * with the value it will have afterwards.
   */
  #refuseUnboundDestination(changes: readonly { readonly key: string; readonly value: unknown }[]): void {
    const refused = unboundCredentialDestinationRefusal(changes, key => readDotPath(this.#config, key).value);
    if (refused) throw new RefusalError(refused, { category: 'config', source: 'config' });
  }

  /** Why {@link reset} of `key` would be refused for moving a credential's destination, or null: for a caller that asks before it acts. */
  resetRefusal(key: string): Refusal | null {
    return unboundCredentialDestinationRefusal([{ key, value: readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value }],
      current => readDotPath(this.#config, current).value);
  }

  /** Set a config value by dot-path key and auto-save to disk. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.#refuseUnboundDestination([{ key, value }]);
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
      void this.#forwardDaemonWrites(route, [{ key, value }], false);
      return;
    }
    this.#refuseDaemonFileWrite(key, options);
    const useDaemonTier = this.daemonTierPath !== null && isDaemonOwnedConfigKey(key);
    this.#refuseHeldByProject(key, value);

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
   * when the owner, the owner's rule or the mode settled the call. An agent's
   * settings tool writes here with that origin and the gate's decision on its
   * call (gate/admitted-decision.ts, read by tools/goodvibes-runtime/config-routing.ts);
   * a write routed to the daemon was admitted by this process's gate before it left.
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
    const unbound = unboundCredentialDestinationRefusal(batch, key => readDotPath(this.#config, key).value);
    if (unbound) return { ok: false, saved: [], refusal: unbound };

    const invalid =(key: string, detail: string): SetResult =>
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
      // The one admission (write-admission.ts), per key here; a schema key's
      // rules across settings run below against the whole update.
      const admission = admitSettingValue(key, schema, change.value, schema ? {} : { config: this.#config });
      if (!admission.ok) {
        const credential = credentialValueRefusal(key, change.value);
        if (credential) return refuse({ code: credential.code, reason: credential.reason, next: [credential.next], status: 400 });
        return invalid(key, admission.reason);
      }
      const value = admission.value;
      const hostRefusal = this.hostWriteRefusal(key, value);
      if (hostRefusal) return refuse({ code: 'CONFIG_HOST_REFUSED', reason: `${key} was not changed: ${hostRefusal.reason}`, next: hostRefusal.next, status: 409 });
      if (!options.bypassManagedLock) {
        const lock = getManagedSettingLock(key, this.configDir);
        if (lock) {
          return refuse({ code: 'CONFIG_MANAGED', reason: `${key} is managed by ${lock.source} and cannot be changed: ${lock.reason}`, next: [`Change it where ${lock.source} sets it.`], status: 403 });
        }
      }
      try { this.#resolvePath(key); }
      catch { return invalid(key, 'no such setting; check the spelling against the settings list'); }
      // Weighed against the value features act on: an unset setting the owner
      // profile fills (the zone, the currency) is loosened from that value.
      if (by.kind === 'agent' && this.describeLoosening(key, value) !== null && !ownerSettled(by.decision)) {
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
      const schema = this.hostSettings.schema(key) ?? SCHEMA_BY_KEY.get(key);
      const across = schema ? admitSettingValue(key, schema, value, { config: projected }) : null;
      if (across && !across.ok) return invalid(key, across.reason);
      try {
        if (this.hostSettings.has(key) && this.hostSettingHasProjectValue(key)) change.tier = 'project';
        else if (this.daemonTierPath !== null && isDaemonOwnedConfigKey(key)) change.tier = 'daemon';
        else if (this.sharedTierPath !== null && isSharedConfigKey(key)) change.tier = 'shared';
        else if (this.projectOverridesKey(key)) change.tier = 'project';
        else this.#refuseHeldByProject(key, value);
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
    let pending: DaemonWritePending | undefined;
    if (route) {
      // One request for every daemon key of this update, admitted whole by the daemon.
      const daemonChanges = admitted.filter(entry => entry.tier === 'daemon').map(({ key, value }) => ({ key, value }));
      forwarded.push(...daemonChanges.map(change => change.key));
      const answer = this.#forwardDaemonWrites(route, daemonChanges, false);
      pending = { keys: [...forwarded], settle: async () => this.#markReported(await answer) };
      admitted.splice(0, admitted.length, ...admitted.filter(entry => entry.tier !== 'daemon'));
    }
    const withPending = (result: SetResult): SetResult => pending ? { ...result, pending } : result;

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
        return withPending(refuse({ code: 'CONFIG_BUSY', reason: `Another process is saving the ${SET_TIER_LABEL[failedTier]} settings file right now; ${unsaved.join(', ')} ${unsaved.length === 1 ? 'was' : 'were'} not applied.`,
          next: ['Send the unsaved settings again in a moment.'], retryable: true, status: 409 }, saved));
      }
      return withPending(refuse({ code: 'CONFIG_WRITE_FAILED',
        reason: `Could not save the ${SET_TIER_LABEL[failedTier]} settings file; ${unsaved.join(', ')} ${unsaved.length === 1 ? 'was' : 'were'} not applied.`,
        next: ['Check that the settings directory is writable, then send the unsaved settings again.'], status: 500 }, saved));
    }
    if (hostRefreshFailed) {
      return withPending(refuse({ code: 'CONFIG_HOST_READ_FAILED', reason: 'The settings were saved, but this surface could not read its own settings back; its registered settings use their restrictive defaults.',
        next: ['Check the settings file named in the startup notice, then reload settings.'], status: 500 }, saved));
    }
    return withPending({ ok: true, revision: this.#permissionIncarnation, saved });
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
    this.#refuseUnboundDestination([{ key, value }]);
    this.invalidateLifetimes();
    if (!this.projectConfigPath) {
      (this.set as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    value = this.validateSetValue(key, value, options, false) as ConfigValue<K>;
    // One admission for write and reload: a value the project layer would skip when the file
    // is read again is refused here, before anything is written.
    if (this.projectConfigPath !== this.configPath) {
      const layer: Record<string, unknown> = {};
      writeRawDotPath(layer, key, structuredClone(value));
      const admitted = restrictProjectLayer(layer, this.#config, this.projectConfigPath, this.hostSettings);
      const refused = admitted.notices[0];
      if (refused) throw new Error(`${key} was not saved to the project settings file: ${refused.reason}. ${refused.remedy}.`);
    }
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

  /**
   * A key's value as the settings files and defaults hold it, under any runtime
   * override (a session's Shift+Tab mode, a `--config` flag). One path read.
   */
  getSavedValue(key: ConfigKey): unknown {
    return structuredClone(readDotPath(this.runtimeState.nonRuntime, key).value);
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
    const baseline: Record<string, unknown> = {};
    const minimal = this.destinationSnapshot('global', this.configPath, baseline);
    this.preserveHostSettingsForBulkSave(minimal, this.configPath);
    const staged = this.runtimeState.fork();
    staged.acceptBulkSnapshot(this.withoutDaemonOwned(minimal), 'global', this.hostSettings.keys());
    const effective = staged.compose();
    this.#saveBulkSnapshot(this.configPath, minimal, baseline);
    this.publishState(staged, effective);
  }

  /**
   * Write a bulk save's snapshot under the file's lock, compared with what the
   * file held when the snapshot was taken (`baseline`, read once after the
   * watcher was polled). Unchanged since: the snapshot replaces it. Changed by
   * another writer in between: per key, a key this save did not change keeps
   * the other writer's value, a key only this save changed takes this save's,
   * and a key both changed differently refuses the whole save, naming it,
   * with nothing written; the other writer's change is then loaded. Costs no
   * read beyond the one the lock already does.
   */
  #saveBulkSnapshot(path: string, ours: Record<string, unknown>, baseline: Record<string, unknown>): void {
    let conflicts: string[] = [];
    try {
      this.#updateSettingsFile(path, raw => {
        let next = ours;
        if (!isDeepStrictEqual(raw, baseline)) {
          const merged = mergeBulkSettingsSave(baseline, ours, raw);
          if (merged.conflicts.length > 0) { conflicts = merged.conflicts; throw new Error('bulk save conflict'); }
          next = merged.result;
        }
        for (const key of Object.keys(raw)) delete raw[key];
        Object.assign(raw, next);
      });
    } catch (error) {
      if (conflicts.length === 0) throw error;
      this._fileWatch?.poll();
      throw new Error(`Settings were not saved: another process changed ${conflicts.join(', ')} in ${path} after this one loaded it, and this save changes ${conflicts.length === 1 ? 'it' : 'them'} too. `
        + 'Nothing was written and the other change is loaded now; set the value again to keep yours.');
    }
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
  private destinationSnapshot(tier: 'global' | 'project', path: string, baseline: Record<string, unknown>): Record<string, unknown> {
    // Read without quarantining: an unreadable file contributes nothing here, and
    // the write below replaces it exactly as a bulk save always has. What was
    // read is also `baseline`, the state the save compares with under the lock.
    let disk: Record<string, unknown> = {};
    try {
      const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) disk = parsed as Record<string, unknown>;
    } catch { /* unreadable: nothing to preserve */ }
    Object.assign(baseline, structuredClone(disk));
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
    const baseline: Record<string, unknown> = {};
    const minimal = this.destinationSnapshot('project', this.projectConfigPath, baseline);
    this.preserveHostSettingsForBulkSave(minimal, this.projectConfigPath);
    const staged = this.runtimeState.fork();
    staged.acceptBulkSnapshot(this.withoutDaemonOwned(minimal), 'project', this.hostSettings.keys());
    const effective = staged.compose();
    this.#saveBulkSnapshot(this.projectConfigPath, minimal, baseline);
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
  /** Where an ingestion notice is filed; see ./manager-ingestion.ts. */
  private ingestionSink(): IngestionNoticeSink {
    return {
      diagnosticMode: this.diagnosticMode,
      record: (entry) => { this.recordIngestionNotice(entry); },
      receipt: (id, text) => { this.migrationReceipt(id, text); },
      forgetReceipts: (selects) => { if (!this.readOnly) new FeatureAnnouncementStore(featureAnnouncementsPath(this)).forgetMatching(selects); },
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
    // Beside a daemon's file, a daemon key in this app's or project's file is not in effect: left out, with a notice.
    const besideDaemon = this.daemonTierPath !== null && !this.daemonTierOwner && file !== this.daemonTierPath
      && (file === this.configPath || file === this.projectConfigPath);
    const ingested = ingestManagerSettings(parsed, file, this.ingestionSink(), new Set(this.hostSettings.keys()), besideDaemon ? isDaemonOwnedConfigKey : undefined);
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
      // One file serving as both layers (a program started in the home directory) is the global file, loaded above:
      // read again as a project file, the owner's own settings would be refused as repository content.
      if (this.projectConfigPath && this.projectConfigPath !== this.configPath
        && (this.hostSettings.active ? hostSettingsFileExists(this.projectConfigPath) : existsSync(this.projectConfigPath))) {
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
      value: this.get(key),
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

  /**
   * Whether a write of host setting `key` belongs in the project file: only
   * when the setting is declared project-settable (the load side reads the
   * project file for nothing else) and that file names it. Otherwise the
   * owner's value goes to their own file, where it takes effect, and never
   * into repository content.
   */
  private hostSettingHasProjectValue(key: string): boolean {
    if (!this.hostSettings.projectSettable(key)) return false;
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
    // The rules across settings read the config with the whole patch in place.
    const projected = structuredClone(this.#config) as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(ownedPatch)) {
      if (value !== undefined) writeRawDotPath(projected, `${String(category)}.${field}`, structuredClone(value));
    }
    for (const [field, value] of Object.entries(ownedPatch)) {
      if (value === undefined) continue;
      const path = `${String(category)}.${field}`;
      refuseCredentialLeaves(path, value);
      // A category patch cannot be sent to the daemon key by key, so a daemon-owned
      // field is written here only where this process may write the daemon's file.
      this.#refuseDaemonFileWrite(path, {});
      const schema = SCHEMA_BY_KEY.get(path);
      if (schema) {
        const admission = admitSettingValue(path, schema, value, { config: projected });
        if (!admission.ok) throw new ConfigError(`Invalid value for ${path} (${admission.reason})`);
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
    // Resetting a destination moves it to the default destination: the same change as setting it there.
    if (key !== undefined) this.#refuseUnboundDestination([{ key, value: readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value }]);
    const route = key !== undefined ? this.#routedDaemonWrite(key, options) : null;
    if (key !== undefined && route) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      this.invalidateLifetimes();
      void this.#forwardDaemonWrites(route, [{ key, value: structuredClone(readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value) }], true);
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
