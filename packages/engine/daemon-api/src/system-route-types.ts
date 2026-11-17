import type { Refusal } from '@goodvibes-jev/engine/errors';
import type { JsonRecord } from './route-helpers.js';
import { AUTOMATION_SURFACE_KINDS, type AutomationSurfaceKind } from './runtime-route-types.js';
export type { AutomationSurfaceKind };

export type DaemonApiClientKind =
  | 'web'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix'
  | 'daemon';

/** The surfaces a route binding can name (the platform's transport surfaces). */
export const ROUTE_BINDING_SURFACE_KINDS = AUTOMATION_SURFACE_KINDS;
export type RouteBindingSurfaceKind = AutomationSurfaceKind;
export const ROUTE_BINDING_KINDS = ['session', 'thread', 'channel', 'message'] as const;
export type AutomationRouteBindingKind = typeof ROUTE_BINDING_KINDS[number];
export const AUTOMATION_SESSION_POLICIES = ['create-or-bind', 'continue-existing', 'require-existing'] as const;
export type AutomationSessionPolicy = typeof AUTOMATION_SESSION_POLICIES[number];
export const AUTOMATION_THREAD_POLICIES = ['preserve', 'replace', 'detached'] as const;
export type AutomationThreadPolicy = typeof AUTOMATION_THREAD_POLICIES[number];
export const AUTOMATION_DELIVERY_GUARANTEES = ['best-effort', 'at-least-once'] as const;
export type AutomationDeliveryGuarantee = typeof AUTOMATION_DELIVERY_GUARANTEES[number];
export const WATCHER_KINDS = ['webhook', 'polling', 'filesystem', 'socket', 'integration', 'manual'] as const;
export type WatcherKind = typeof WATCHER_KINDS[number];
export const WATCHER_SOURCE_KINDS = ['schedule', 'manual', 'hook', 'webhook', 'surface', 'watcher'] as const;
export type WatcherSourceKind = typeof WATCHER_SOURCE_KINDS[number];

export interface ConfigManagerLike {
  get(key: string): unknown;
  getAll(): Record<string, unknown>;
  setDynamic(key: string, value: unknown): void;
  /**
   * Several settings as one update: every change is admitted before anything
   * is written, each settings file is written once, and the revision moves once.
   */
  setMany?(
    changes: readonly { readonly key: string; readonly value: unknown }[],
    by: { readonly kind: 'owner'; readonly surface: string },
  ):
    | { readonly ok: true; readonly revision: number; readonly saved: readonly string[] }
    | { readonly ok: false; readonly refusal: Refusal; readonly saved: readonly string[] };
  /** Remove the explicit value of one key (every key when omitted) so it reads as its default again, in every tier that holds it. */
  reset?(key?: string): void;
  /**
   * Absolute path of the settings file this manager writes to.
   *
   * Reported back on every config write. A caller and the host it is talking to
   * routinely own DIFFERENT surface-scoped stores (`~/.goodvibes/agent/` versus
   * `~/.goodvibes/tui/`), so "the setting was saved" is ambiguous until the file
   * is named: a value written to the connected host is invisible to the caller's
   * own store and vice versa, and reading it back locally shows the old value.
   */
  getConfigPath?(): string;
  /**
   * Which store the key resolves from and whether the DAEMON owns it.
   *
   * Ownership, not the caller's identity, decides where a value belongs: a
   * daemon-owned key (chat surfaces, control-plane binding, watchers, device
   * grants, retention) has exactly one home regardless of which client asked.
   * Reported on every write so a caller never has to infer it from a path.
   */
  describeConfigKeySource?(key: string): {
    readonly tier: string;
    readonly effectiveOrigin?: string;
    readonly daemonOwned: boolean;
    readonly daemonTierPath: string | null;
  };
}

export interface IntegrationApprovalSnapshotSourceLike {
  getApprovalSnapshot(approvalId?: string): unknown;
}

export interface PlatformServiceManagerLike {
  status(): Record<string, unknown>;
  install(): unknown;
  start(): unknown;
  stop(): unknown;
  restart(): unknown;
  uninstall(): unknown;
}

export interface RouteBindingRecordInput {
  readonly id?: string | undefined;
  readonly kind: AutomationRouteBindingKind;
  readonly surfaceKind: RouteBindingSurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly sessionPolicy?: AutomationSessionPolicy | undefined;
  readonly threadPolicy?: AutomationThreadPolicy | undefined;
  readonly deliveryGuarantee?: AutomationDeliveryGuarantee | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly runId?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

/** A change to a binding; `null` clears a session, job or run link. */
export interface RouteBindingPatchInput {
  readonly sessionPolicy?: AutomationSessionPolicy | undefined;
  readonly threadPolicy?: AutomationThreadPolicy | undefined;
  readonly deliveryGuarantee?: AutomationDeliveryGuarantee | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | null | undefined;
  readonly jobId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** Function-typed properties, so the platform's manager is checked against them strictly. */
export interface RouteBindingManagerLike {
  readonly listBindings: () => readonly unknown[];
  readonly upsertBinding: (input: RouteBindingRecordInput) => Promise<unknown>;
  readonly patchBinding: (bindingId: string, input: RouteBindingPatchInput) => Promise<unknown | null>;
  readonly removeBinding: (bindingId: string) => Promise<boolean>;
}

export interface WatcherSourceRecord {
  readonly id: string;
  readonly kind: WatcherSourceKind;
  readonly label: string;
  readonly surfaceKind?: RouteBindingSurfaceKind | undefined;
  readonly routeId?: string | undefined;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSeenAt?: number | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface WatcherRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: WatcherKind;
  readonly source: WatcherSourceRecord;
  readonly intervalMs?: number | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface WatcherRegistration {
  readonly id: string;
  readonly label: string;
  readonly kind: WatcherKind;
  readonly source: WatcherSourceRecord;
  readonly intervalMs: number;
  readonly metadata: Record<string, unknown>;
  readonly run?: (() => string) | undefined;
}

/** The watcher store could not be saved: the change holds until the next restart. */
export interface WatcherSnapshotSaveFailure {
  readonly filePath: string;
  readonly code?: string | undefined;
  readonly error: string;
}

/** Function-typed properties, so the platform's registry is checked against them strictly. */
export interface WatcherRegistryLike {
  readonly list: () => readonly unknown[];
  readonly removeWatcher: (watcherId: string) => boolean;
  readonly registerWatcher: (input: WatcherRegistration) => WatcherRecord;
  readonly getWatcher: (watcherId: string) => WatcherRecord | null;
  readonly startWatcher: (watcherId: string) => WatcherRecord | null;
  readonly stopWatcher: (watcherId: string, reason: string) => WatcherRecord | null;
  readonly runWatcherNow: (watcherId: string) => Promise<WatcherRecord | null>;
  /** Present when the host reports a failed save of the watcher store. */
  readonly snapshotSaveFailure?: (() => WatcherSnapshotSaveFailure | undefined) | undefined;
}

/**
 * How far an approval decision reaches. Mirrors the broker's remember-tier
 * union (a generalizing tier persists a durable rule and sweeps queued asks
 * it covers; 'session' is the classic in-memory cache). Kept in sync with
 * the operator contract's rememberTier enum.
 */
export type ApprovalRememberTier = 'session' | 'exact' | 'command-class' | 'path' | 'tool';

export const APPROVAL_REMEMBER_TIERS: readonly ApprovalRememberTier[] = ['session', 'exact', 'command-class', 'path', 'tool'];

export interface ApprovalBrokerLike {
  claimApproval(approvalId: string, actor: string, actorSurface: string, note?: string, outcome?: { applied?: boolean | undefined }): Promise<unknown | null>;
  cancelApproval(approvalId: string, actor: string, actorSurface: string, note?: string, outcome?: { applied?: boolean | undefined }): Promise<unknown | null>;
  releaseApproval?(approvalId: string, actor: string, actorSurface: string, note?: string, outcome?: { applied?: boolean | undefined }, holdId?: string): Promise<unknown | null>;
  resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      /** Explicit producer evidence; absent on legacy callback reports. */
      readonly disposition?: 'approved' | 'denied' | 'amended' | undefined;
      readonly remember: boolean;
      readonly actor: string;
      readonly actorSurface: string;
      readonly note?: string | undefined;
      /**
       * Optional per-hunk selection (edit-tool approvals only). The broker
       * filters the approval's own edit list to these indices server-side. An
       * out-of-range index or a non-edit approval throws a 400-tagged error the
       * route layer converts to an HTTP 400.
       */
      readonly selectedHunks?: readonly number[] | undefined;
      /** How far this decision reaches; a generalizing tier persists a durable rule. */
      readonly rememberTier?: ApprovalRememberTier | undefined;
      /** User free-text; on deny it rides the structured declined result. */
      readonly reason?: string | undefined;
      /**
       * Argument-modifying approval payload (e.g. the typed answer to a
       * command's terminal prompt). selectedHunks, when present, supersedes it.
       */
      readonly modifiedArgs?: Record<string, unknown> | undefined;
      /** Set by the broker to whether this call itself moved the record. */
      readonly outcome?: { applied?: boolean | undefined } | undefined;
    },
  ): Promise<unknown | null>;
}

export interface WorkspaceSwapManagerLike {
  getCurrentWorkingDir(): string;
  /** Optional for older embedders; scoped intake requires this synchronous fence. */
  subscribeBeforeSwap?(listener: () => void): () => void;
  /** Monotonic admitted-transition epoch, including failed and same-path swaps. */
  getWorkspaceRevision?(): number;
  requestSwap(newWorkingDir: string): Promise<
    | {
      ok: true;
      previous: string;
      current: string;
      /** False when the new path could not be saved, so it will not survive a restart. */
      persisted?: boolean | undefined;
      /** Subsystems that keep using the previous working directory until restart. */
      requiresRestart?: readonly string[] | undefined;
    }
    | { ok: false; code: 'INVALID_PATH'; reason: string }
    | { ok: false; code: 'REROOT_FAILED'; reason: string }
  >;
}

/**
 * Secret-free status metadata for a single credential held in the daemon's
 * shared store (or overridden by an environment variable). This is the ONLY
 * shape the credential-read wire method (`credentials.get`) ever returns, the
 * plaintext secret value never crosses the wire. `usable` reflects a real
 * in-process resolution attempt, so a configured-but-unresolvable reference
 * (e.g. a broken `op://` ref) reports `configured: true, usable: false`.
 */
export interface CredentialStatusRecord {
  readonly key: string;
  /** Provider associations declared by the credential catalog; never inferred from the key. */
  readonly providerIds?: readonly string[] | undefined;
  /** A value exists in the shared store (or, for a named probe, in env). */
  readonly configured: boolean;
  /** The value/reference resolved to non-empty plaintext in-process. */
  readonly usable: boolean;
  /** Where the value was found: 'env' | 'daemon-secure' | 'user-secure' | … */
  readonly source: string;
  /** 'daemon' | 'user' | 'project' | 'env'. */
  readonly scope: string;
  /** Backed by an encrypted store (vs plaintext). */
  readonly secure: boolean;
  /** A same-named environment variable overrides the stored value. */
  readonly overriddenByEnv: boolean;
  /** External-reference provider, when the stored value is a secret ref. */
  readonly refSource?: string | undefined;
}

/**
 * Reads credential STATUS (never plaintext) from the daemon's shared secret
 * store. Enumeration (`list`) is over stored keys only, never `process.env`,
 * so it cannot leak the names of unrelated environment variables. A named probe
 * (`get`) may consult env for that one caller-named key.
 */
export interface CredentialStatusProviderLike {
  list(): Promise<readonly CredentialStatusRecord[]>;
  get(key: string): Promise<CredentialStatusRecord | null>;
}

export interface DaemonSystemRouteContext {
  /** Optional adopted lane; absent hosts fail closed without changing legacy writes. */
  readonly settingsPrecondition?: import('./settings-precondition.js').SettingsPreconditionHandler | undefined;
  readonly settingsImportPrecondition?: import('./settings-import-precondition.js').SettingsImportPreconditionHandler | undefined;
  readonly approvalBroker: ApprovalBrokerLike;
  readonly configManager: ConfigManagerLike;
  /**
   * Secret-free credential-status source for `credentials.get`. Null when the
   * daemon host wires no shared secret store, the handler then reports an
   * honest 503 rather than a false "no credentials".
   */
  readonly credentialStatus: CredentialStatusProviderLike | null;
  readonly integrationHelpers: IntegrationApprovalSnapshotSourceLike | null;
  readonly inspectInboundTls: (surface: 'controlPlane' | 'httpListener') => unknown;
  readonly inspectOutboundTls: () => unknown;
  readonly isValidConfigKey: (key: string) => boolean;
  /**
   * Whether a config key holds credential material. When supplied, the legacy
   * single-key write refuses a literal for such a key and the config read
   * redacts it. Absent hosts keep today's behaviour.
   */
  readonly isSecretBearingConfigKey?: ((key: string) => boolean) | undefined;
  /**
   * The manager's own normalization of a requested value (permission-mode
   * aliases, money strings). The config write compares the held value against
   * this, so a value that was normalized on the way in is reported as applied.
   */
  readonly coerceConfigValue?: ((key: string, value: unknown) => unknown) | undefined;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly platformServiceManager: PlatformServiceManagerLike;
  readonly recordApiResponse: (
    req: Request,
    path: string,
    response: Response,
    clientKind?: DaemonApiClientKind,
  ) => Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  /** The principal the gate authenticated; approval decisions are attributed to it. */
  readonly resolveAuthenticatedPrincipal?: ((req: Request) => { readonly principalId: string } | null) | undefined;
  readonly routeBindings: RouteBindingManagerLike;
  /** Manages runtime.workingDir swaps. Null when workspace swapping is not available. */
  readonly swapManager: WorkspaceSwapManagerLike | null;
  readonly watcherRegistry: WatcherRegistryLike;
}
