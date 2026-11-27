import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { assertSecurityReadSource } from '../security/read-source.js';
import { Secret } from '../security/secret.js';
import { noteProcessSecretStore } from './secret-store-unreadable.js';
/**
 * SecretsManager, hierarchy-aware secret resolution and persistence.
 *
 * Resolution order:
 *   1. Environment variable (process.env[key])
 *   2. Daemon stores (~/.goodvibes/daemon/secrets.enc, then secrets.json)
 *   3. User secure store (~/.goodvibes/<surface>/secrets.enc)
 *   4. User plaintext store (~/.goodvibes/<surface>.secrets.json)
 *   5. The project root's stores (<root>/.goodvibes/<surface>/secrets.enc, then
 *      <root>/.goodvibes/<surface>.secrets.json), never a parent directory's, and
 *      a key there only once the user stored or confirmed it
 *   6. If a resolved value is a SecretRef, resolve through the referenced provider
 *      (a password-manager reference once per credential revision)
 *
 * Each store file is read once and kept; a lookup costs one `stat` per store,
 * and a file another process rewrote is noticed by that `stat` or the store watch.
 *
 * The three scopes and the files behind them are documented in
 * secrets-store-paths.ts. The daemon tier leads because a credential the daemon
 * executes with has one home and a surface silo can only hold a stale copy of
 * it; the tier is empty until something writes to it, so a store with no daemon
 * secrets resolves exactly as it did before the tier existed.
 *
 * The active policy decides whether plaintext stores are eligible:
 *   - plaintext_allowed  → read/write plaintext or secure
 *   - preferred_secure   → prefer secure, allow plaintext fallback with warning
 *   - require_secure     → never read/write plaintext
 *
 * Encryption keys come from a random keyfile (~/.goodvibes/secrets.key,
 * 0600 in a 0700 directory), generated on first need, never from host
 * identity, so stores survive hostname/username changes and machine moves.
 * Only the versioned keyfile format is supported. A store that
 * exists but cannot be decrypted is a distinct, surfaced error state, it is
 * never treated as empty and never overwritten.
 *
 * Secret values are never logged.
 */

import { dirname, join, basename } from 'path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, statSync, watch, type FSWatcher, type Stats } from 'fs';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import type { ConfigManager, DaemonWritePress } from './manager.js';
import type { SettingAct } from '@goodvibes/engine/daemon-api/control-routes';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  SecretStoreUnreadableError,
  SECRETS_STORE_FORMAT_VERSION,
  assertCachedKeyIsCurrent,
  decryptStore as decrypt,
  encryptStore as encrypt,
  loadExistingKeyfile,
  loadOrCreateKeyfile,
  type EncryptedStoreEnvelope,
} from './secrets-keyfile.js';
export { SecretStoreUnreadableError } from './secrets-keyfile.js';
import { requireAbsoluteOwnedPath } from './manager-bootstrap.js';
import { decodeLiteralSecret, encodeLiteralSecret, shouldStoreAsLiteral } from './secret-literal-codec.js';
import { getSecretRefSource, isSecretRefInput, normalizeSecretRef, readSecretProviderHostConfig, resolveSecretRef, type SecretProviderHostConfig } from './secret-refs.js';
import { ProjectSecretApprovals } from './project-secret-approvals.js';
import { BUILTIN_PROVIDER_ENV_KEYS } from './provider-credential-catalog.js';
import { logger } from '../utils/logger.js';
import { requireSurfaceRoot, resolveSharedDirectory } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';
import { describeCredentialScope, isDaemonNeededSecretKey } from './credential-scope-registry.js';
import {
  allSecretStores,
  defaultDaemonSecretHome,
  secretReadOrder,
  secretWriteTarget,
  type SecretStoreLayout,
  type SecretStorePath,
} from './secrets-store-paths.js';

export type SecretStorageMode = 'plaintext_allowed' | 'preferred_secure' | 'require_secure';
export type {
  SecretScope,
  SecretSource,
  SecretStorageMedium,
  SecretStorePath,
} from './secrets-store-paths.js';
import type { SecretScope, SecretSource, SecretStorageMedium } from './secrets-store-paths.js';

/** Every environment variable name a built-in provider declares for its credential. */
const DECLARED_PROVIDER_ENV_NAMES: ReadonlySet<string> = new Set(Object.values(BUILTIN_PROVIDER_ENV_KEYS).flat());

export interface SecretRecord {
  readonly key: string;
  readonly source: SecretSource;
  readonly scope: SecretScope | 'env';
  readonly secure: boolean;
  readonly path?: string | undefined;
  readonly overriddenByEnv: boolean;
  readonly refSource?: string | undefined;
  /** A key in this project's store that is not used until the user confirms it (`/secrets trust`). */
  readonly unconfirmed?: true | undefined;
}

export class SecretWriteCommittedError extends Error {
  constructor() { super('The credential write committed, but its owner changed afterward.'); this.name = 'SecretWriteCommittedError'; }
}

declare const secretWriteTransitionBrand: unique symbol;
/** One project store a key was confirmed in, and what its value points at when it is a pointer. */
export interface ConfirmedProjectSecret {
  readonly path: string;
  /** The stored pointer (`goodvibes://secrets/...`) when the confirmed value is one, not a credential. */
  readonly pointsAt?: string | undefined;
}
export interface SecretWriteTransition { readonly [secretWriteTransitionBrand]: true }
export interface SecretWriteTransitionFacts {
  readonly key: string;
  readonly scope: SecretScope;
  readonly paths: readonly string[];
  readonly beforeGeneration: number;
  readonly phase: 'prepared' | 'pending' | 'committed';
}
export interface SecretWriteEffectOwner {
  readonly assertCurrent: () => void;
  readonly committed: () => void;
}
export interface SecretWriteOptions {
  /** Optional exact effect transaction; never grants permission by itself. */
  readonly effect?: ((transition: SecretWriteTransition) => SecretWriteEffectOwner) | undefined;
  /** Retained caller authority, checked again after queued store-lock acquisition. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
  /**
   * Who decided this write (the same press the settings writers carry, ConfigSetOptions `press`): in the daemon its
   * `act` (who made it and how it was decided) is held while the change notice goes out (`writeAct()`), so a machine
   * group keeps it with the credential's change and carries it to every member.
   */
  readonly press?: DaemonWritePress | undefined;
}

/** What a scope's own write stores hold for one key, as stored, per medium (null: no entry). */
export interface WriteScopeEntries {
  readonly secure: Secret | null;
  readonly plaintext: Secret | null;
}

export interface SecretDeleteOptions {
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
  /** As SecretWriteOptions `press`: who decided the removal, held while its change notice goes out. */
  readonly press?: DaemonWritePress | undefined;
}

/** One store a deletion removed the key from. */
export interface SecretDeletion {
  readonly scope: SecretScope;
  readonly medium: SecretStorageMedium;
  readonly source: Exclude<SecretSource, 'env'>;
}

export interface SecretStorageReview {
  readonly policy: SecretStorageMode;
  readonly secureAvailable: boolean;
  readonly storedKeys: number;
  readonly envBackedKeys: number;
  readonly secureKeys: number;
  readonly plaintextKeys: number;
  readonly warnings: readonly string[];
  readonly locations: readonly {
    readonly source: Exclude<SecretSource, 'env'>;
    readonly path: string;
    readonly exists: boolean;
    readonly readable: boolean;
  }[];
  /** Every record the review read (the same list `listDetailed` answers), so a caller needs no second read. */
  readonly records?: readonly SecretRecord[] | undefined;
}

type SecureStoreReadResult =
  | { readonly status: 'ok'; readonly secrets: Readonly<Record<string, string>> }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

type PlaintextStoreReadResult =
  | { readonly status: 'ok'; readonly secrets: Readonly<Record<string, string>> }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

interface PlaintextStore {
  readonly version: 1;
  readonly secrets: Record<string, string>;
}

export interface SecretsManagerOptions {
  readonly projectRoot: string;
  readonly globalHome: string;
  readonly surfaceRoot: string;
  /** Withhold borrowed secret-provider/store failure text from read diagnostics. */
  readonly diagnosticMode?: 'default' | 'structural' | undefined;
  /**
   * The daemon's state root, holding the daemon-scoped stores. Defaults to
   * `<globalHome>/.goodvibes/daemon`; a caller that honors `--daemon-home` or
   * `GOODVIBES_DAEMON_HOME` resolves it first and passes it here, so the daemon
   * and its clients agree on one file.
   */
  readonly daemonHome?: string | undefined;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  readonly policy?: SecretStorageMode | undefined;
  readonly secureProjectFilePath?: string | undefined;
  readonly secureUserFilePath?: string | undefined;
  readonly secureDaemonFilePath?: string | undefined;
  readonly plaintextProjectFilePath?: string | undefined;
  readonly plaintextUserFilePath?: string | undefined;
  readonly plaintextDaemonFilePath?: string | undefined;
  /** Override the keyfile location (defaults to <globalHome>/.goodvibes/secrets.key). */
  readonly keyFilePath?: string | undefined;
}

function normalizeOptionalOwnedPath(path: string | undefined, name: string): string | undefined {
  return requireAbsoluteOwnedPath(path, name, 'SecretsManager');
}

function loadConfiguredSecretPolicy(configManager?: Pick<ConfigManager, 'get'>): SecretStorageMode {
  try {
    return (configManager?.get('storage.secretPolicy') as SecretStorageMode | undefined) ?? 'preferred_secure';
  } catch {
    return 'preferred_secure';
  }
}

/**
 * Where a write lands when the caller did not name a scope.
 *
 * A credential a daemon-owned config path names is one the daemon executes
 * with, so its home is the daemon tier, the same rule config-ownership.ts
 * applies to the setting that points at it. Getting this wrong is not cosmetic:
 * a replicated surface token written to the project store lands under whatever
 * directory the daemon happened to start in, and the next start from a
 * different directory reads a store that does not have it.
 *
 * Everything that is not daemon-owned keeps the historical default.
 */
function defaultScopeForKey(key: string): SecretScope {
  return isDaemonNeededSecretKey(key) ? 'daemon' : 'project';
}

/**
 * Where a write to `key` will actually go, given what the caller asked for.
 *
 * **Daemon ownership beats an explicit scope, deliberately.** It used to be the
 * other way round, an explicit `scope` won, and that made the routing above
 * defeatable by the ordinary path a person takes to store a credential:
 * `/secrets set` passes a scope on every call, so a daemon-owned password went
 * into a client silo the daemon never reads. The credential reported success
 * and did nothing, which is the exact failure the ownership rule exists to
 * prevent.
 *
 * The alternative, refusing the write and telling the caller to pick a
 * different scope, was rejected: it turns a storage bug into a wall in front
 * of the credentials people most need to set, and the caller's scope argument
 * is nearly always a default it never thought about rather than an intent.
 *
 * So the write is honoured and RELOCATED, never dropped, and the relocation is
 * disclosed rather than silent: `set()` logs it naming both scopes, and this
 * function is exported so a surface can tell the operator where a credential is
 * going BEFORE it asks for it.
 */
export function resolveSecretWriteScope(key: string, requested?: SecretScope | undefined): SecretScope {
  if (isDaemonNeededSecretKey(key)) return 'daemon';
  return requested ?? defaultScopeForKey(key);
}

/**
 * The tiers a delete of `key` sweeps: `undefined` is every tier. A credential
 * the daemon reads lives in the daemon tier whatever scope the caller named, so
 * a delete narrowed to that scope would report success and leave the live copy.
 */
export function resolveSecretDeleteScope(key: string, requested?: SecretScope | undefined): SecretScope | undefined {
  return isDaemonNeededSecretKey(key) ? undefined : requested;
}

/** True when `requested` would have sent a daemon-owned credential somewhere the daemon cannot read. */
export function secretWriteScopeWasOverridden(key: string, requested?: SecretScope | undefined): boolean {
  return requested !== undefined && requested !== 'daemon' && isDaemonNeededSecretKey(key);
}

/** Why `key` was filed where it was. Safe to display: names only, never values. */
export function describeSecretWriteScope(key: string): string {
  return describeCredentialScope(key);
}

declare const scopedDeletionBrand: unique symbol;
export interface PreparedScopedSecretDeletion { readonly [scopedDeletionBrand]: true; }
export interface PreparedScopedSecretDeletionFacts {
  readonly operation: 'delete'; readonly key: string; readonly scope: SecretScope;
  readonly destinations: readonly { readonly path: string; readonly operation: 'remove'; readonly tier: SecretScope }[];
}
interface ScopedDeletionRecord {
  readonly facts: PreparedScopedSecretDeletionFacts;
  readonly generation: number;
  readonly policy: SecretStorageMode;
  readonly observations: readonly { path: string; stamp: string }[];
  readonly publications: readonly { path: string; payload: unknown }[];
  spent: boolean;
  completed?: { generation: number; observations: readonly { path: string; stamp: string }[] };
}
function deletionFileObservation(path: string): { stamp: string; raw: string | null } {
  try {
    const before = statSync(path, { bigint: true }); const raw = readFileSync(path, 'utf8');
    const after = statSync(path, { bigint: true });
    const identity = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
    if (identity(before) !== identity(after)) throw new Error('Secret store changed.');
    return { stamp: identity(after) + ':' + raw, raw };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stamp: 'absent', raw: null }; throw error; }
}

/** A check that the stored credentials did not change while a status read ran. */
export function captureSecretsReadSource(owner: SecretsManager): () => void {
  return owner.captureReadSource();
}

/** Reference sources that run a password-manager or other command to resolve. */
const COMMAND_BACKED_SOURCES: ReadonlySet<string> = new Set(['exec', '1password', 'onepassword', 'bitwarden', 'vaultwarden', 'bitwarden-secrets-manager', 'bws']);

/** Whether resolving a reference of this source runs a command (a password manager or `exec`). */
export function isCommandBackedSecretSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && COMMAND_BACKED_SOURCES.has(source);
}

/** An environment value only when `key` is really a variable, so names such as `__proto__` never read an inherited property. */
function ownEnvValue(key: string): string | undefined {
  return Object.hasOwn(process.env, key) ? process.env[key] : undefined;
}

/**
 * The longest a value resolved from a password-manager reference is served
 * without asking the manager again: one command per credential per window,
 * and a key rotated in the manager is in use within it.
 */
const RESOLVED_REFERENCE_MAX_AGE_MS = 10 * 60_000;

export class SecretsManager {
  /** Restriction only, captured from this manager's actual native stores. */
  /**
   * A check that the stored credentials did not change while a status read ran:
   * integer compares of this owner's revision (its own writes, and another
   * process's writes seen by the store watch) and the storage policy.
   */
  captureReadSource(): () => void {
    assertSecurityReadSource(!this.pendingLocalMutations.size, 'secret store');
    this.#startWatching(true);
    const revision = this.#revisionSource.revision(), policy = this.getPolicy();
    return () => assertSecurityReadSource(!this.pendingLocalMutations.size && this.#revisionSource.revision() === revision
      && this.getPolicy() === policy, 'secret store');
  }
  /** Change listeners, fired after a successful set() or delete() so credential consumers (e.g. the provider registry) re-resolve LIVE, no restart. */
  private readonly changeListeners = new Set<(key: string) => void>();

  /** Subscribe to secret writes/deletes. Returns an unsubscribe function. */
  onDidChange(listener: (key: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private notifyChanged(key: string): void {
    for (const listener of [...this.changeListeners]) {
      try { listener(key); } catch (error) {
        logger.warn('SecretsManager: change listener failed', { key, error: summarizeError(error) });
      }
    }
  }

  private readonly ownedMutationPaths = new Set<string>();
  // An owner must not admit the old credential while its replacement/revoke
  // waits for filesystem ownership. Counts keep overlapping writes fenced.
  private credentialMutationGeneration = 0;
  private readonly credentialInvalidationListeners = new Set<() => void>();
  private readonly pendingLocalMutations = new Map<string, number>();
  // Private, bounded observations: revisions name this owner's actual lookup
  // results. Credential bytes never become a public identity or persisted key.
  readonly #credentialSnapshotOwner = randomUUID();
  #credentialSnapshotSequence = 0;
  readonly #credentialSnapshots = new Map<string, { readonly chain: readonly unknown[]; readonly revision: string }>();
  /** Identity of each store file as this owner last read or wrote it; a different one on a later read is another process's write. */
  readonly #storeIdentities = new Map<string, string>();
  #foreignStoreWrites = 0;
  readonly #revisionSource = revisionSource('credentials', () => this.credentialMutationGeneration + this.#foreignStoreWrites);

  /**
   * Stored credentials as a revision source: every set, delete, import and
   * daemon-key creation here, and a store file another process rewrote once
   * this owner reads it. Environment variables and secret references resolved
   * elsewhere are not covered.
   */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  #observeStore(filePath: string, identity: string, ownWrite: boolean): void {
    const previous = this.#storeIdentities.get(filePath);
    this.#storeIdentities.set(filePath, identity);
    if (!ownWrite && previous !== undefined && previous !== identity) this.#foreignStoreWrites++;
  }

  #noteOwnWrite(filePath: string): void {
    this.#storeCache.delete(filePath);
    try { this.#observeStore(filePath, storeIdentity(statSync(filePath)), true); }
    catch { this.#storeIdentities.delete(filePath); }
  }

  /** Parsed contents per store file, valid while the file keeps the identity it was read with. */
  readonly #storeCache = new Map<string, { readonly identity: string; readonly secrets: Readonly<Record<string, string>> }>();

  /**
   * One `stat` of a store file. Its contents are re-read only when the identity
   * moved, which is also how a write by another process is noticed.
   */
  #statStore(filePath: string): { readonly status: 'present'; readonly identity: string } | { readonly status: 'missing' } | { readonly status: 'unreadable'; readonly reason: string } {
    try {
      const identity = storeIdentity(statSync(filePath));
      this.#observeStore(filePath, identity, false);
      return { status: 'present', identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unreadable', reason: summarizeError(error) };
      this.#observeStore(filePath, 'absent', false);
      this.#storeCache.delete(filePath);
      return { status: 'missing' };
    }
  }

  #cachedStore(filePath: string, identity: string): Readonly<Record<string, string>> | undefined {
    const cached = this.#storeCache.get(filePath);
    return cached && cached.identity === identity ? cached.secrets : undefined;
  }

  #keepStore(filePath: string, identity: string, secrets: Record<string, string>): Readonly<Record<string, string>> {
    const kept = Object.freeze(secrets);
    this.#storeCache.set(filePath, { identity, secrets: kept });
    return kept;
  }

  /**
   * Watches the store directories, so a store another process rewrites moves
   * this owner's revision and tells its subscribers at once, instead of every
   * holder re-reading the disk to find out. Started on the first subscription
   * or capture; the watches never keep the process alive. A directory that
   * does not exist yet is not watched; the `stat` on the next read notices it.
   *
   * Each watch's callback holds this manager, so the watches end with it:
   * {@link close} (run by the disposal scope that built the manager) closes
   * them for good, and when the last subscriber leaves and no capture asked
   * for them they are closed until the next subscription.
   */
  #watchers: FSWatcher[] | null = null;
  /** A capture relies on the watch to move the revision; it stays until {@link close}. */
  #watchForCaptures = false;
  #closed = false;
  #startWatching(forCapture = false): void {
    if (forCapture) this.#watchForCaptures = true;
    if (this.#watchers || this.#closed) return;
    this.#watchers = [];
    const directories = new Map<string, Set<string>>();
    for (const path of [...this.getAllCandidateStores().map((store) => store.path), this.keyFilePath]) {
      const names = directories.get(dirname(path)) ?? new Set<string>();
      names.add(basename(path));
      directories.set(dirname(path), names);
    }
    for (const [directory, names] of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, (_event, name) => {
          const changed = !name ? [...names] : names.has(String(name)) ? [String(name)] : [];
          if (changed.length) this.#noticeStoreChange(changed.map((entry) => join(directory, entry)));
        });
        watcher.on('error', () => { try { watcher.close(); } catch { /* already closed */ } });
        (watcher as FSWatcher & { unref?: () => void }).unref?.();
        this.#watchers.push(watcher);
      } catch { /* not watchable now; reads still compare identities */ }
    }
  }

  #stopWatching(): void {
    const watchers = this.#watchers;
    this.#watchers = null;
    for (const watcher of watchers ?? []) {
      try { watcher.close(); } catch { /* already closed */ }
    }
  }

  /** Closes the store watches when no subscriber or capture needs them any more. */
  #releaseWatch(): void {
    if (this.#watchForCaptures || this.#elsewhereListeners.size || this.credentialInvalidationListeners.size) return;
    this.#stopWatching();
  }

  /**
   * Ends this manager's store watches for good. A manager built for a hosted
   * workspace or a one-shot command calls this from the disposal scope that
   * built it, so neither the watches nor the decrypted store cache they keep
   * reachable outlive it. Reads still work after it; they compare file
   * identities on each read instead of being told by a watch.
   */
  close(): void {
    this.#closed = true;
    this.#stopWatching();
    this.#storeCache.clear();
    this.#resolvedReferences.clear();
  }

  #noticeStoreChange(paths: readonly string[]): void {
    const before = this.#foreignStoreWrites;
    for (const path of paths) {
      if (path === this.keyFilePath) { this.#foreignStoreWrites++; continue; }
      const known = this.#storeIdentities.get(path);
      let identity = 'absent';
      try { identity = storeIdentity(statSync(path)); } catch { /* removed */ }
      if (known === undefined || known === identity) continue;
      this.#storeCache.delete(path);
      this.#observeStore(path, identity, false);
    }
    if (this.#foreignStoreWrites === before) return;
    this.notifyCredentialInvalidation();
    for (const listener of [...this.#elsewhereListeners]) {
      try { listener(); } catch { /* One observer cannot hide a foreign write from another. */ }
    }
  }

  readonly #elsewhereListeners = new Set<() => void>();

  /**
   * Another process rewrote a secret store this manager reads (the store
   * watcher saw it; which key changed is not known). In-process writes are
   * reported by key through {@link onDidChange}.
   */
  onDidChangeElsewhere(listener: () => void): () => void {
    this.#startWatching();
    this.#elsewhereListeners.add(listener);
    return () => { this.#elsewhereListeners.delete(listener); this.#releaseWatch(); };
  }

  /**
   * Re-`stat` every store file this owner has read (one `stat` each) and count a
   * rewrite by another process exactly as the directory watch does when it fires,
   * telling the invalidation subscribers. For a reader whose stores another
   * process writes, where a missed or unavailable watch would otherwise keep a
   * rotated or removed credential in use. Returns the owner's credential revision.
   */
  checkStoresChangedElsewhere(): number {
    this.#noticeStoreChange([...this.#storeIdentities.keys()].filter((path) => path !== this.keyFilePath));
    return this.credentialMutationGeneration + this.#foreignStoreWrites;
  }

  /** Value-free local owner state; no credential names, paths, bytes or hashes. */
  getCredentialMutationState(): Readonly<{ generation: number; pending: boolean }> {
    return Object.freeze({ generation: this.credentialMutationGeneration, pending: this.pendingLocalMutations.size > 0 });
  }

  /** Pre-effect and settlement notifications, including failed or no-op writes. */
  onDidInvalidateCredentials(listener: () => void): () => void {
    this.#startWatching();
    this.credentialInvalidationListeners.add(listener);
    return () => { this.credentialInvalidationListeners.delete(listener); this.#releaseWatch(); };
  }

  private notifyCredentialInvalidation(): void {
    this.#credentialSnapshots.clear();
    this.#resolvedReferences.clear();
    this.#inFlightReferences.clear();
    for (const listener of [...this.credentialInvalidationListeners]) {
      try { listener(); } catch { /* An observer cannot defeat credential revocation. */ }
    }
  }

  private async withCredentialMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.credentialMutationGeneration++;
    this.pendingLocalMutations.set(key, (this.pendingLocalMutations.get(key) ?? 0) + 1);
    this.notifyCredentialInvalidation();
    try { return await operation(); }
    finally {
      this.credentialMutationGeneration++;
      const remaining = this.pendingLocalMutations.get(key)! - 1;
      if (remaining === 0) this.pendingLocalMutations.delete(key);
      else this.pendingLocalMutations.set(key, remaining);
      this.notifyCredentialInvalidation();
    }
  }
  private readonly preparedScopedDeletions = new WeakMap<PreparedScopedSecretDeletion, ScopedDeletionRecord>();

  /**
   * A check that the stored credentials are still the ones read now: integer
   * compares of this owner's revision (its own writes, and another process's
   * writes seen by the store watch) and the storage policy. No disk access.
   */
  captureLocalCredentialReadset(): () => void {
    if (this.pendingLocalMutations.size) throw new Error('Credential owner is busy.');
    this.#startWatching(true);
    const revision = this.#revisionSource.revision(), policy = this.getPolicy();
    return () => {
      if (this.pendingLocalMutations.size || this.#revisionSource.revision() !== revision || this.getPolicy() !== policy) throw new Error('Credential source changed.');
    };
  }

  /** Exact physical scope only. Capture never resolves refs, repairs stores or creates a keyfile. */
  prepareScopedDeletion(key: string, scope: SecretScope): PreparedScopedSecretDeletion {
    if (!key || !['project', 'user', 'daemon'].includes(scope)) throw new Error('Invalid scoped secret deletion.');
    const state = this.getCredentialMutationState();
    if (state.pending) throw new Error('Credential owner is busy.');
    const policy = this.getPolicy();
    const stores = [this.resolveWriteTarget(scope, 'secure'), this.resolveWriteTarget(scope, 'plaintext')];
    const observations: { path: string; stamp: string }[] = [];
    const publications: { path: string; payload: unknown }[] = [];
    const keyObservation = deletionFileObservation(this.keyFilePath);
    observations.push({ path: this.keyFilePath, stamp: keyObservation.stamp });
    for (const store of stores) {
      const observed = deletionFileObservation(store.path); observations.push({ path: store.path, stamp: observed.stamp });
      if (observed.raw === null) continue;
      const parsed = JSON.parse(observed.raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Secret store unavailable.');
      let values: Record<string, string>; let encryptionKey: Buffer | undefined;
      if (store.secure) {
        if (parsed.version !== SECRETS_STORE_FORMAT_VERSION || !keyObservation.raw || !/^[0-9a-f]{64}$/i.test(keyObservation.raw.trim())) throw new Error('Secret store unavailable.');
        encryptionKey = Buffer.from(keyObservation.raw.trim(), 'hex');
        values = JSON.parse(decrypt(parsed as unknown as EncryptedStoreEnvelope, encryptionKey)) as Record<string, string>;
      } else values = ('version' in parsed && 'secrets' in parsed ? parsed.secrets : parsed) as Record<string, string>;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Secret store unavailable.');
      if (!Object.hasOwn(values, key)) continue;
      const next = { ...values }; delete next[key];
      let payload: unknown = { version: 1, secrets: next };
      if (encryptionKey) {
        const encrypted = encrypt(JSON.stringify(next), encryptionKey);
        payload = encrypted;
      }
      publications.push({ path: store.path, payload });
    }
    const handle = Object.freeze({}) as PreparedScopedSecretDeletion;
    const facts = Object.freeze({ operation: 'delete' as const, key, scope, destinations: Object.freeze(publications.map(item => Object.freeze({ path: item.path, operation: 'remove' as const, tier: scope }))) });
    this.preparedScopedDeletions.set(handle, { facts, generation: state.generation, policy, observations, publications, spent: false });
    this.assertPreparedScopedDeletion(handle); return handle;
  }

  inspectPreparedScopedDeletion(handle: PreparedScopedSecretDeletion): PreparedScopedSecretDeletionFacts {
    const entry = this.preparedScopedDeletions.get(handle); if (!entry) throw new Error('Secret deletion is not authentic.'); return entry.facts;
  }
  assertPreparedScopedDeletion(handle: PreparedScopedSecretDeletion): void {
    const entry = this.preparedScopedDeletions.get(handle);
    if (!entry || entry.spent || this.getCredentialMutationState().pending || this.credentialMutationGeneration !== entry.generation || this.getPolicy() !== entry.policy) throw new Error('Secret deletion is stale.');
    for (const observation of entry.observations) if (deletionFileObservation(observation.path).stamp !== observation.stamp) throw new Error('Secret deletion store changed.');
  }

  /** Acquire the captured file namespace outside the synchronous final owner boundary. */
  async withPreparedScopedDeletion<T>(handle: PreparedScopedSecretDeletion,
    operation: (finish: (assertCurrent: () => void) => import('./prepared-mutation.js').PreparedConfigMutationReceipt) => T): Promise<T> {
    this.assertPreparedScopedDeletion(handle);
    const entry = this.preparedScopedDeletions.get(handle)!; entry.spent = true;
    return this.withStoreMutations(entry.publications.map(item => item.path), () => {
      let consumed = false; let active = true;
      try { return operation((assertCurrent) => {
        if (!active || consumed) throw new Error('Secret deletion is spent.'); consumed = true;
        const completedPaths: string[] = []; let uncertainPath: string | undefined;
        const observations = entry.observations.map(item => ({ ...item }));
        let begun = false;
        try {
          assertCurrent();
          if (this.credentialMutationGeneration !== entry.generation || this.pendingLocalMutations.size || this.getPolicy() !== entry.policy) throw new Error('Credential owner changed.');
          this.credentialMutationGeneration++; this.pendingLocalMutations.set(entry.facts.key, 1); begun = true;
          this.notifyCredentialInvalidation();
          const current = () => {
            assertCurrent();
            if (this.credentialMutationGeneration !== entry.generation + 1 || this.pendingLocalMutations.size !== 1 || this.pendingLocalMutations.get(entry.facts.key) !== 1 || this.getPolicy() !== entry.policy) throw new Error('Credential owner changed.');
            for (const observation of observations) if (deletionFileObservation(observation.path).stamp !== observation.stamp) throw new Error('Secret deletion store changed.');
          };
          current();
          for (const publication of entry.publications) {
            current();
            writeJsonFileAtomic(publication.path, publication.payload, { mode: 0o600, durable: true, cleanupStaleTemps: false });
            this.#noteOwnWrite(publication.path);
            completedPaths.push(publication.path);
            observations.find(item => item.path === publication.path)!.stamp = deletionFileObservation(publication.path).stamp;
          }
        } catch {
          uncertainPath = entry.publications[completedPaths.length]?.path;
          return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths), ...(uncertainPath ? { uncertainPath } : {}) });
        } finally {
          if (begun) {
            this.credentialMutationGeneration++;
            const remaining = (this.pendingLocalMutations.get(entry.facts.key) ?? 1) - 1;
            if (remaining) this.pendingLocalMutations.set(entry.facts.key, remaining); else this.pendingLocalMutations.delete(entry.facts.key);
            this.notifyCredentialInvalidation();
          }
          if (completedPaths.length) { try { this.notifyChanged(entry.facts.key); } catch { /* Receipt stays truthful. */ } }
        }
        entry.completed = { generation: entry.generation + 2, observations };
        return Object.freeze({ status: 'committed', completedPaths: Object.freeze(completedPaths) });
      }); } finally { active = false; }
    });
  }

  /** Restriction-only post-effect fence; never re-captures a changed credential as this plan's effect. */
  assertCompletedScopedDeletion(handle: PreparedScopedSecretDeletion): void {
    const entry = this.preparedScopedDeletions.get(handle); const completed = entry?.completed;
    if (!entry || !completed || this.credentialMutationGeneration !== completed.generation || this.pendingLocalMutations.size || this.getPolicy() !== entry.policy) throw new Error('Completed secret deletion changed.');
    for (const observation of completed.observations) if (deletionFileObservation(observation.path).stamp !== observation.stamp) throw new Error('Completed secret deletion store changed.');
  }

  private encKey: Buffer | null = null;
  private readonly keyFilePath: string;
  private readonly options: SecretsManagerOptions;
  private readonly surfaceRoot: string;
  private readonly reportedUnreadableStores = new Set<string>();

  private readonly layout: SecretStoreLayout;
  /** Keys of this project's store the user confirmed, kept beside the user store. */
  readonly #approvals: ProjectSecretApprovals;
  readonly #reportedUnconfirmed = new Set<string>();
  /**
   * Values of references that run a password-manager command, resolved once per
   * credential revision. Any set, delete, import or store change clears them,
   * a reader that saw the value refused clears them
   * ({@link releaseResolvedReferences}), and each is held at most
   * {@link RESOLVED_REFERENCE_MAX_AGE_MS}, so a key rotated in the password
   * manager is picked up even by a reader that cannot tell a refusal apart.
   */
  readonly #resolvedReferences = new Map<string, { readonly value: string; readonly at: number }>();
  /** Command-backed resolutions still running, by the same key; a credential change drops them so later reads start afresh. */
  readonly #inFlightReferences = new Map<string, Promise<string | null>>();

  /**
   * Drop the values held for password-manager references, so the next read of
   * each runs the manager again: for a caller whose provider refused the value
   * (a rotated or revoked key). `key` drops only that key's entries.
   */
  releaseResolvedReferences(key?: string): void {
    if (key === undefined) { this.#resolvedReferences.clear(); return; }
    for (const cacheKey of [...this.#resolvedReferences.keys()]) {
      if (cacheKey.startsWith(`${key}\0`)) this.#resolvedReferences.delete(cacheKey);
    }
  }

  constructor(options: SecretsManagerOptions) {
    // Known to readers with no store of their own, so a store that cannot be read is never taken for "no key".
    noteProcessSecretStore(this);
    this.surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'SecretsManager surfaceRoot');
    const globalHome = requireAbsoluteOwnedPath(options.globalHome, 'globalHome', 'SecretsManager');
    this.options = {
      ...options,
      projectRoot: requireAbsoluteOwnedPath(options.projectRoot, 'projectRoot', 'SecretsManager'),
      globalHome,
      daemonHome: normalizeOptionalOwnedPath(options.daemonHome, 'daemonHome')
        ?? defaultDaemonSecretHome(globalHome),
      secureProjectFilePath: normalizeOptionalOwnedPath(options.secureProjectFilePath, 'secureProjectFilePath'),
      secureUserFilePath: normalizeOptionalOwnedPath(options.secureUserFilePath, 'secureUserFilePath'),
      secureDaemonFilePath: normalizeOptionalOwnedPath(options.secureDaemonFilePath, 'secureDaemonFilePath'),
      plaintextProjectFilePath: normalizeOptionalOwnedPath(options.plaintextProjectFilePath, 'plaintextProjectFilePath'),
      plaintextUserFilePath: normalizeOptionalOwnedPath(options.plaintextUserFilePath, 'plaintextUserFilePath'),
      plaintextDaemonFilePath: normalizeOptionalOwnedPath(options.plaintextDaemonFilePath, 'plaintextDaemonFilePath'),
    };
    this.layout = {
      projectRoot: this.options.projectRoot,
      globalHome: this.options.globalHome,
      daemonHome: this.options.daemonHome ?? defaultDaemonSecretHome(globalHome),
      surfaceRoot: this.surfaceRoot,
      secureProjectFilePath: this.options.secureProjectFilePath,
      secureUserFilePath: this.options.secureUserFilePath,
      secureDaemonFilePath: this.options.secureDaemonFilePath,
      plaintextProjectFilePath: this.options.plaintextProjectFilePath,
      plaintextUserFilePath: this.options.plaintextUserFilePath,
      plaintextDaemonFilePath: this.options.plaintextDaemonFilePath,
    };
    this.keyFilePath = normalizeOptionalOwnedPath(options.keyFilePath, 'keyFilePath')
      ?? resolveSharedDirectory(this.options.globalHome, 'secrets.key');
    this.#approvals = new ProjectSecretApprovals(join(dirname(secretWriteTarget(this.layout, 'user', 'secure').path), 'project-secret-approvals.json'));
  }

  /** Load the encryption key, generating a fresh one exclusively on first need, see secrets-keyfile.ts. */
  private getEncryptionKey(): Buffer {
    this.encKey ??= loadOrCreateKeyfile(this.keyFilePath);
    return this.encKey;
  }

  /** The key for reading a store: never mints a keyfile, since a read must not create durable state. */
  private getReadEncryptionKey(): Buffer | null {
    this.encKey ??= loadExistingKeyfile(this.keyFilePath);
    return this.encKey;
  }

  getGlobalHome(): string {
    return this.options.globalHome;
  }

  /**
   * The password-manager host settings of this store's owner, read now from
   * its settings; undefined when it was built without settings (each provider
   * then runs with its own defaults). Passed as `providers` by every
   * resolution made on this store's behalf.
   */
  getSecretProviderHostConfig(): SecretProviderHostConfig | undefined {
    const configManager = this.options.configManager;
    return configManager ? readSecretProviderHostConfig(configManager) : undefined;
  }

  /**
   * True unless `store` is this project's store and `key` in it was not
   * confirmed with this stored value (a value changed since, a pointer
   * included, is unconfirmed again).
   */
  #usable(store: SecretStorePath, key: string, storedValue: unknown, report = false): boolean {
    if (store.scope !== 'project') return true;
    if (typeof storedValue === 'string' && this.#approvals.isApproved(store.path, key, storedValue)) return true;
    const id = `${store.path}\0${key}`;
    if (report && !this.#reportedUnconfirmed.has(id)) {
      this.#reportedUnconfirmed.add(id);
      logger.warn('SecretsManager: a key in this project\'s secret store is not used until you confirm it', {
        key, path: store.path, next: `"Use a secret from this project's store" on ${key} (Permissions and safety, Secrets), or store it for all your projects`,
      });
    }
    return false;
  }

  #approveProjectWrite(store: SecretStorePath, keys: readonly string[]): void {
    if (store.scope !== 'project' || keys.length === 0) return;
    try {
      // Bound to the values as this program just stored them.
      const stored = (store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path)) ?? {};
      const values: Record<string, string> = {};
      for (const key of keys) if (typeof stored[key] === 'string') values[key] = stored[key]!;
      this.#approvals.approve(store.path, values);
    }
    catch (error) {
      logger.warn('SecretsManager: stored in the project store, but the confirmation could not be recorded; confirm it with "Use a secret from this project\'s store" (Permissions and safety, Secrets)', {
        keys, path: store.path, error: summarizeError(error),
      });
    }
  }

  /**
   * The user confirms `key` found in this project's secret store, with the
   * value it holds now, so it is used from now on (until that value changes).
   * Returns each store file it was confirmed in and, when the value is a
   * pointer, what it points at; empty when this project's store does not hold the key.
   */
  confirmProjectSecret(key: string): readonly ConfirmedProjectSecret[] {
    const confirmed: ConfirmedProjectSecret[] = [];
    for (const store of this.getAllCandidateStores()) {
      if (store.scope !== 'project') continue;
      const values = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
      if (!values || !Object.hasOwn(values, key) || typeof values[key] !== 'string') continue;
      const value = values[key]!;
      this.#approvals.approve(store.path, { [key]: value });
      const pointer = decodeLiteralSecret(value) === null && isSecretRefInput(value) ? value : undefined;
      confirmed.push({ path: store.path, ...(pointer !== undefined ? { pointsAt: pointer } : {}) });
    }
    if (confirmed.length) {
      this.credentialMutationGeneration += 2;
      this.notifyCredentialInvalidation();
      this.notifyChanged(key);
    }
    return confirmed;
  }

  /**
   * The value that would be used for `key`, as a `Secret` (security/secret.ts):
   * it prints `[secret <key>]` everywhere and its text comes out only through
   * `reveal(purpose)` at the sink it is for (a request to its service, a
   * child's environment, the store, or an owner's explicit "show").
   */
  async get(key: string): Promise<Secret | null> {
    const value = await this.getInternal(key, new Set([key]));
    return value === null ? null : Secret.of(value, key);
  }

  /**
   * `key` as the stores hold it, in read order, never the environment: the
   * value that is still there after a restart without the variable. A literal
   * is decoded; a stored reference is returned as stored, not followed. An
   * unreadable store throws, so a caller never reads it as "not stored".
   */
  async getStored(key: string): Promise<Secret | null> {
    for (const path of this.getReadOrder()) {
      const result = path.secure ? this.readEncryptedStore(path.path) : this.readPlaintextStore(path.path);
      if (result.status === 'unreadable') {
        throw new SecretStoreUnreadableError(`The secrets store at ${path.path} exists but cannot be read (${result.reason}).`, result.reason);
      }
      if (result.status !== 'ok' || !Object.hasOwn(result.secrets, key) || !this.#usable(path, key, result.secrets[key])) continue;
      const stored = result.secrets[key];
      if (typeof stored !== 'string') continue;
      return Secret.of(decodeLiteralSecret(stored) ?? stored, key);
    }
    return null;
  }

  /** Atomic first creation for daemon-owned material, shared across process creators.
   * References and unreadable tiers cannot be treated as missing material.
   * This does not authorize replacing an existing key or changing its scope.
   */
  async getOrCreateDaemonSecret(key: string, create: () => string, assertCurrent?: () => void): Promise<Secret> {
    const guard = () => {
      assertSynchronousJudgmentGuard(assertCurrent, () => new Error('Daemon key ownership must be checked synchronously.'));
    };
    guard();
    const policy = this.getPolicy();
    const paths = this.writeStorePaths('daemon', 'secure', policy);
    return this.withStoreMutations(paths, () => {
      guard();
      if (this.getPolicy() !== policy) throw new Error('Secret storage policy changed during acquisition');
      const current = this.resolveLocalSecretSync(key);
      if (current.state === 'unsupported') throw new Error('Daemon key material is unavailable; existing material was preserved.');
      if (current.state === 'resolved') return current.value;
      const value = create();
      guard();
      this.credentialMutationGeneration++;
      try { this.setOwned(key, value, { scope: 'daemon', medium: 'secure' }, assertCurrent ? { beforeWrite: guard, committed: () => {} } : undefined); }
      finally { this.credentialMutationGeneration++; }
      return Secret.of(value, key);
    }, paths.slice(1), guard);
  }

  /**
   * Synchronous credential-owner fence for a local literal only. This follows
   * the same local precedence as get(), but never follows references, launches
   * commands, or contacts a secret provider. Keep the value inside credential
   * ownership; it is not an identity or provenance snapshot.
   */
  resolveLocalSecretSync(key: string):
    | { readonly state: 'resolved'; readonly value: Secret }
    | { readonly state: 'absent' | 'unsupported' } {
    const capture = (value: unknown): ReturnType<SecretsManager['resolveLocalSecretSync']> => {
      if (typeof value !== 'string') return { state: 'unsupported' };
      const literal = decodeLiteralSecret(value);
      if (literal !== null) return { state: 'resolved', value: Secret.of(literal, key) };
      return isSecretRefInput(value) ? { state: 'unsupported' } : { state: 'resolved', value: Secret.of(value, key) };
    };
    const envValue = ownEnvValue(key);
    if (envValue !== undefined) return capture(envValue);
    if (this.pendingLocalMutations.has(key)) return { state: 'unsupported' };
    for (const path of this.getReadOrder()) {
      const result = path.secure ? this.readEncryptedStore(path.path) : this.readPlaintextStore(path.path);
      if (result.status === 'unreadable') return { state: 'unsupported' };
      if (result.status === 'ok' && Object.hasOwn(result.secrets, key) && this.#usable(path, key, result.secrets[key])) return capture(result.secrets[key]);
    }
    return { state: 'absent' };
  }

  /** Local alias-aware observation. Private credential bytes never become judgment facts. */
  resolveLocalCredentialSnapshot(key: string):
    | { readonly state: 'resolved'; readonly value: Secret; readonly revision: string }
    | { readonly state: 'absent'; readonly revision: string }
    | { readonly state: 'unsupported'; readonly reason: string } {
    const chain: unknown[] = [this.getPolicy(), this.credentialMutationGeneration];
    const seen = new Set<string>();
    const revision = () => {
      const previous = this.#credentialSnapshots.get(key);
      if (previous && isDeepStrictEqual(previous.chain, chain)) return previous.revision;
      // Eviction can only retire an old observation, never admit stale state.
      if (this.#credentialSnapshots.size >= 128) this.#credentialSnapshots.clear();
      const value = `${this.#credentialSnapshotOwner}:${(++this.#credentialSnapshotSequence).toString(36)}`;
      this.#credentialSnapshots.set(key, { chain, revision: value });
      return value;
    };
    let current = key;
    // A pointer read from a project store is followed only inside that same
    // store: a checkout cannot name the user's own credentials or environment.
    let within: SecretStorePath | null = null;
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current)) return { state: 'unsupported', reason: 'stored references form a loop' };
      if (this.pendingLocalMutations.has(current)) return { state: 'unsupported', reason: 'write pending' };
      if (within === null && ownEnvValue(current) !== undefined) return { state: 'unsupported', reason: 'set in the environment' };
      seen.add(current);
      let value: string | undefined;
      let from: SecretStorePath | undefined;
      for (const path of within ? [within] : this.getReadOrder()) {
        const result = path.secure ? this.readEncryptedStore(path.path) : this.readPlaintextStore(path.path);
        if (result.status === 'unreadable') return { state: 'unsupported', reason: 'store unreadable' };
        const found = result.status === 'ok' && Object.hasOwn(result.secrets, current) && this.#usable(path, current, result.secrets[current]);
        chain.push([current, path.path, path.secure, found]);
        if (found) { value = result.secrets[current]; from = path; break; }
      }
      if (from?.scope === 'project') within = from;
      if (value === undefined) {
        return depth === 0 ? { state: 'absent', revision: revision() } : { state: 'unsupported', reason: 'stored reference names a secret that is not stored' };
      }
      if (typeof value !== 'string') return { state: 'unsupported', reason: 'stored value is not text' };
      chain.push(value);
      const literal = decodeLiteralSecret(value);
      if (literal !== null) return { state: 'resolved', value: Secret.of(literal, key), revision: revision() };
      if (!isSecretRefInput(value)) return { state: 'resolved', value: Secret.of(value, key), revision: revision() };
      const ref = normalizeSecretRef(value);
      if (!ref || ref.source !== 'goodvibes') return { state: 'unsupported', reason: 'held by an external secret provider' };
      current = ref.id;
    }
    return { state: 'unsupported', reason: 'stored references nest too deeply' };
  }

  /**
   * Read `key` from ONE tier, ignoring the read order and the environment.
   *
   * `get()` answers "what value would be used", which is the right question
   * almost everywhere and the wrong one for a read-back of a write: a copy read
   * through `get()` returns whatever the DAEMON tier holds, because the daemon
   * tier leads.
   *
   * Returns the value exactly as stored. A `goodvibes://` reference is NOT
   * followed: a read-back compares the stored bytes.
   */
  async getFromScope(key: string, scope: SecretScope): Promise<Secret | null> {
    for (const path of this.getAllCandidateStores()) {
      if (path.scope !== scope) continue;
      const secrets = path.secure ? this.readEncryptedFile(path.path) : this.readPlaintextFile(path.path);
      if (secrets !== null && Object.hasOwn(secrets, key)) {
        const value = secrets[key];
        return value === undefined ? null : Secret.of(value, key);
      }
    }
    return null;
  }

  /**
   * The entry `set(key, _, { scope })` replaces, exactly as stored: the
   * scope's own write stores (secure first, as reads see them), never the
   * environment, another tier, another surface's silo or a followed reference.
   * A caller that must undo a failed write restores this, not the effective
   * value `get()` would resolve. An unreadable store throws rather than
   * reading as "no entry", so an undo never deletes what it could not see.
   */
  async getWriteScopeEntry(key: string, scope: SecretScope): Promise<Secret | null> {
    for (const medium of ['secure', 'plaintext'] as const) {
      const target = this.resolveWriteTarget(scope, medium);
      const result = target.secure ? this.readEncryptedStore(target.path) : this.readPlaintextStore(target.path);
      if (result.status === 'unreadable') {
        throw new SecretStoreUnreadableError(`The secrets store at ${target.path} exists but cannot be read (${result.reason}).`);
      }
      if (result.status === 'ok' && Object.hasOwn(result.secrets, key)) {
        const stored = result.secrets[key];
        return stored === undefined ? null : Secret.of(stored, key);
      }
    }
    return null;
  }

  /** Remove `key` from the scope's own write stores only; the counterpart of {@link getWriteScopeEntry}. */
  async deleteWriteScopeEntry(key: string, scope: SecretScope): Promise<void> {
    const stores = (['secure', 'plaintext'] as const)
      .map((medium) => this.resolveWriteTarget(scope, medium))
      .filter((store) => existsSync(store.path) && this.storeContainsKey(store, key));
    if (stores.length === 0) return;
    await this.withCredentialMutation(key, () => this.withStoreMutations(stores.map(store => store.path), () => this.deleteFromScopeOwned(key, stores)));
  }

  /**
   * What each of the scope's own write stores holds for `key`, exactly as
   * stored, per medium: the state an undo puts back, so a value read from the
   * secure store is never restored into the plaintext one. An unreadable store
   * throws, as {@link getWriteScopeEntry} does.
   */
  async readWriteScopeEntries(key: string, scope: SecretScope): Promise<WriteScopeEntries> {
    const entries: { secure: Secret | null; plaintext: Secret | null } = { secure: null, plaintext: null };
    for (const medium of ['secure', 'plaintext'] as const) {
      const target = this.resolveWriteTarget(scope, medium);
      const result = target.secure ? this.readEncryptedStore(target.path) : this.readPlaintextStore(target.path);
      if (result.status === 'unreadable') {
        throw new SecretStoreUnreadableError(`The secrets store at ${target.path} exists but cannot be read (${result.reason}).`);
      }
      if (result.status === 'ok' && Object.hasOwn(result.secrets, key)) {
        const stored = result.secrets[key];
        entries[medium] = stored === undefined ? null : Secret.of(stored, key);
      }
    }
    return Object.freeze(entries);
  }

  /**
   * Undo a write of `key` in `scope`: put each medium's entry back to
   * `previous` (as stored, in the medium it came from), but only while every
   * entry that differs from `previous` still holds `wrote`, the value the
   * undoing caller stored. The compare and the restore run under the same store locks, so a
   * value another writer stored after that write is never rolled back:
   * `newer` says so and changes nothing. `unchanged` when the stores already
   * hold `previous` (the write never landed); `restored` when they hold it now.
   */
  async restoreWriteScopeEntriesIf(key: string, scope: SecretScope, wrote: string, previous: WriteScopeEntries): Promise<'restored' | 'unchanged' | 'newer'> {
    const stores = (['secure', 'plaintext'] as const).map((medium) => ({ medium, store: this.resolveWriteTarget(scope, medium) }));
    return this.withCredentialMutation(key, () => this.withStoreMutations(stores.map(({ store }) => store.path), () => {
      const now = stores.map(({ medium, store }) => ({ medium, store, values: this.readStoreForWrite(store) }));
      // The entries are compared and written back as stored, inside the store.
      const prior = { secure: previous.secure?.reveal('store-write') ?? null, plaintext: previous.plaintext?.reveal('store-write') ?? null };
      const held = (values: Record<string, string>): string | null => (Object.hasOwn(values, key) ? values[key]! : null);
      const moved = now.filter(({ medium, values }) => held(values) !== prior[medium]);
      if (moved.length === 0) return 'unchanged' as const;
      // Every medium that differs from before must hold exactly what this caller wrote; anything else is another writer's.
      const ours = (value: string | null): boolean => value !== null && (value === wrote || decodeLiteralSecret(value) === wrote);
      if (!moved.every(({ values }) => ours(held(values)))) return 'newer' as const;
      let changed = false;
      try {
        for (const { medium, store, values } of now) {
          const before = prior[medium];
          const held = Object.hasOwn(values, key) ? values[key]! : null;
          if (held === before) continue;
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          if (before === null) delete values[key];
          else values[key] = before;
          if (store.secure) this.writeEncryptedFile(store.path, values);
          else this.writePlaintextFile(store.path, values);
          changed = true;
        }
      } finally {
        if (changed) this.notifyChanged(key);
      }
      return 'restored' as const;
    }, [stores[1]!.store.path]));
  }

  private async getInternal(key: string, seen: Set<string>): Promise<string | null> {
    const envValue = ownEnvValue(key);
    if (envValue !== undefined) {
      logger.debug('SecretsManager: resolved from env', { key });
      // An environment value is the credential itself; only a goodvibes:// pointer is followed.
      if (shouldStoreAsLiteral(envValue)) return decodeLiteralSecret(envValue) ?? envValue;
      return this.resolveMaybeReferencedValue(key, envValue, seen);
    }

    for (const path of this.getReadOrder()) {
      const secrets = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (secrets !== null && Object.hasOwn(secrets, key)) {
        if (!this.#usable(path, key, secrets[key], true)) continue;
        logger.debug('SecretsManager: resolved from store', { key, source: path.source });
        const value = secrets[key]!;
        if (value === undefined) return null;
        // A wrapped literal is the credential itself, never a pointer to follow.
        const literal = decodeLiteralSecret(value);
        if (literal !== null) return literal;
        return this.resolveMaybeReferencedValue(key, value, seen, path.scope === 'project' ? path : undefined);
      }
    }

    return null;
  }

  /** A GoodVibes pointer read from a project store, resolved against that store alone. */
  private async resolveWithinProjectStore(key: string, value: string, seen: Set<string>, store: SecretStorePath): Promise<string | null> {
    const ref = normalizeSecretRef(value);
    if (!ref || ref.source !== 'goodvibes') return null;
    const next = ref.id;
    if (seen.has(next)) throw new Error(`Recursive GoodVibes secret reference for ${next}`);
    const secrets = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
    if (!secrets || !Object.hasOwn(secrets, next) || !this.#usable(store, next, secrets[next], true)) {
      logger.warn('SecretsManager: a pointer in this project\'s secret store names a key that store does not hold (confirmed); a project pointer never reaches your own store or environment', { key, target: next });
      return null;
    }
    const target = secrets[next]!;
    const literal = decodeLiteralSecret(target);
    if (literal !== null) return literal;
    const nextSeen = new Set(seen);
    nextSeen.add(next);
    return this.resolveMaybeReferencedValue(next, target, nextSeen, store);
  }

  private async resolveMaybeReferencedValue(key: string, value: string, seen: Set<string>, projectStore?: SecretStorePath): Promise<string | null> {
    if (!isSecretRefInput(value)) return value;

    // A project store lives inside a directory that may have been cloned from
    // anywhere, so it is data, not a place to run commands or read files from.
    // Only a GoodVibes pointer follows, and only to another key of the same
    // project store: an env: reference, or a pointer into the user's own store
    // (which reads the environment first), would let a checkout name the
    // user's credentials.
    const refSource = getSecretRefSource(value);
    if (projectStore && refSource === 'goodvibes') return this.resolveWithinProjectStore(key, value, seen, projectStore);
    if (projectStore) {
      logger.warn('SecretsManager: refused a secret reference found in a project store; move it to the user store (scope user) to use it', {
        key,
        refSource: refSource ?? 'unknown',
      });
      return null;
    }

    const commandBacked = refSource !== null && COMMAND_BACKED_SOURCES.has(refSource);
    const cacheKey = `${key}\0${value}`;
    const cached = commandBacked ? this.#resolvedReferences.get(cacheKey) : undefined;
    if (cached !== undefined && Date.now() - cached.at < RESOLVED_REFERENCE_MAX_AGE_MS) return cached.value;
    if (!commandBacked) return this.resolveReference(key, value, seen, false, cacheKey);
    // Concurrent reads of one command-backed key share one run: one process,
    // one password-manager prompt.
    const running = this.#inFlightReferences.get(cacheKey);
    if (running) return running;
    const resolution = this.resolveReference(key, value, seen, true, cacheKey)
      .finally(() => { if (this.#inFlightReferences.get(cacheKey) === resolution) this.#inFlightReferences.delete(cacheKey); });
    this.#inFlightReferences.set(cacheKey, resolution);
    return resolution;
  }

  private async resolveReference(key: string, value: string, seen: Set<string>, commandBacked: boolean, cacheKey: string): Promise<string | null> {
    const revision = this.#revisionSource.revision();
    try {
      const resolved = await resolveSecretRef(value, {
        resolveLocalSecret: async (nextKey) => {
          if (seen.has(nextKey)) {
            throw new Error(`Recursive GoodVibes secret reference for ${nextKey}`);
          }
          const nextSeen = new Set(seen);
          nextSeen.add(nextKey);
          return this.getInternal(nextKey, nextSeen);
        },
        homeDirectory: this.options.globalHome,
        providers: this.getSecretProviderHostConfig(),
      });
      logger.debug('SecretsManager: resolved secret reference', { key, refSource: resolved.source });
      // Taken out once, inside the store, to be wrapped again as the Secret `get` returns.
      const text = resolved.value === null ? null : resolved.value.reveal('store-write');
      if (commandBacked && text !== null && this.#revisionSource.revision() === revision) {
        if (this.#resolvedReferences.size >= 256) this.#resolvedReferences.clear();
        this.#resolvedReferences.set(cacheKey, { value: text, at: Date.now() });
      }
      return text;
    } catch (error) {
      logger.warn('SecretsManager: failed to resolve secret reference', {
        key,
        refSource: getSecretRefSource(value) ?? 'unknown',
        ...(this.options.diagnosticMode === 'structural' ? { reason: 'resolution-failed' } : { error: summarizeError(error) }),
      });
      return null;
    }
  }

  private readonly writeTransitions = new WeakMap<SecretWriteTransition, { readonly assertCurrent: () => void; readonly facts: () => SecretWriteTransitionFacts }>();
  assertWriteTransition(transition: SecretWriteTransition): void {
    const record = this.writeTransitions.get(transition);
    if (!record) throw new Error('Secret write transition is not authentic.');
    record.assertCurrent();
  }
  inspectWriteTransition(transition: SecretWriteTransition): SecretWriteTransitionFacts {
    this.assertWriteTransition(transition);
    return this.writeTransitions.get(transition)!.facts();
  }

  /** Who made the write whose change notice is being delivered (SecretWriteOptions `press.act`), per write. */
  readonly #writeActs = new AsyncLocalStorage<SettingAct | undefined>();

  /**
   * Who made the write a change notice is being delivered for, and how it was decided, or undefined when the write
   * stated none. Read by a listener while it is called (the machine group keeps it with the credential's change).
   */
  writeAct(): SettingAct | undefined {
    return this.#writeActs.getStore();
  }

  async set(key: string, value: string, options: SecretWriteOptions = {}): Promise<void> {
    const act = options.press?.act;
    if (act) return this.#writeActs.run(act, () => this.#set(key, value, options));
    return this.#set(key, value, options);
  }

  async #set(key: string, value: string, options: SecretWriteOptions): Promise<void> {
    const assertCurrent = options.assertCurrent;
    const current = () => {
      assertSynchronousJudgmentGuard(assertCurrent, () => new Error('Secret write ownership must be checked synchronously.'));
    };
    current();
    const scope = resolveSecretWriteScope(key, options.scope);
    const policy = this.getPolicy();
    const medium = options.medium ?? this.getDefaultWriteMedium(policy);
    if (policy === 'require_secure' && medium === 'plaintext') throw new Error('Secret policy require_secure forbids plaintext persistence');
    const paths = this.writeStorePaths(scope, medium, policy);
    const effect = options.effect;
    if (!effect) {
      await this.withCredentialMutation(key, () => this.withStoreMutations(paths, () => {
        current();
        if (this.getPolicy() !== policy) throw new Error('Secret storage policy changed during acquisition');
        this.setOwned(key, value, { ...options, medium });
      }, paths.slice(1)));
      return;
    }
    const before = this.getCredentialMutationState();
    if (before.pending) throw new Error('Credential owner is busy.');
    const observed = [...new Set([...paths, this.keyFilePath])].map(path => ({ path, stamp: deletionFileObservation(path).stamp }));
    let phase: 'prepared' | 'pending' | 'committed' | 'failed' = 'prepared';
    const transition = Object.freeze({}) as SecretWriteTransition;
    const assertTransition = () => {
      const state = this.getCredentialMutationState();
      const offset = phase === 'pending' ? 1 : phase === 'committed' ? 2 : 0;
      if (phase === 'failed' || this.getPolicy() !== policy || state.generation !== before.generation + offset
        || (phase === 'pending' ? this.pendingLocalMutations.size !== 1 || this.pendingLocalMutations.get(key) !== 1 : state.pending)) throw new Error('Secret write owner changed.');
      for (const item of observed) if (deletionFileObservation(item.path).stamp !== item.stamp) throw new Error('Secret write destination changed.');
    };
    this.writeTransitions.set(transition, { assertCurrent: assertTransition,
      facts: () => Object.freeze({ key, scope, paths: Object.freeze([...paths]), beforeGeneration: before.generation, phase: phase as 'prepared' | 'pending' | 'committed' }),
    });
    let published = false;
    try {
      assertTransition();
      const owner = effect(transition), assertEffect = owner.assertCurrent, committed = owner.committed;
      const checkEffect = () => {
        assertSynchronousJudgmentGuard(assertEffect, () => new Error('Secret write effect ownership must be synchronous.'));
      };
      checkEffect(); assertTransition();
      phase = 'pending';
      await this.withCredentialMutation(key, () => {
        assertTransition(); checkEffect(); assertTransition();
        return this.withStoreMutations(paths, () => {
        // Intent and its invalidation notifications already happened. Only this
        // exact +1 mutation may remain pending; listeners cannot add a rival.
        assertTransition(); checkEffect(); assertTransition();
        this.setOwned(key, value, { scope, medium }, {
          beforeWrite: () => { assertTransition(); checkEffect(); assertTransition(); },
          committed: () => { published = true; for (const item of observed) item.stamp = deletionFileObservation(item.path).stamp; },
        });
        }, paths.slice(1));
      });
      phase = 'committed'; assertTransition();
      // Receipt is consumed only after the matching settlement generation.
      assertSynchronousJudgmentGuard(committed, () => new Error('Secret write settlement must be synchronous.'));
    } catch (error) {
      phase = 'failed';
      if (published) throw new SecretWriteCommittedError();
      throw error;
    }

  }

  /**
   * The stores a write locks: its target first, then the optional other store
   * of the same scope it may touch (the plaintext fallback of a secure write,
   * or the secure store a plaintext write removes an older copy from).
   */
  private writeStorePaths(scope: SecretScope, medium: SecretStorageMedium, policy: SecretStorageMode): string[] {
    const target = this.resolveWriteTarget(scope, medium);
    if (!target.secure) return [target.path, this.resolveWriteTarget(scope, 'secure').path];
    return [target.path, ...(policy === 'preferred_secure' ? [this.resolveWriteTarget(scope, 'plaintext').path] : [])];
  }

  /** Lock actual whole-file mutation targets; independent homes may share a tier. */
  private async withStoreMutations<T>(paths: readonly string[], operation: () => T, optionalPaths: readonly string[] = [], assertCurrent?: () => void): Promise<T> {
    const owned: string[] = [];
    const releases: Array<() => void> = [];
    try {
      for (const path of [...new Set(paths)].sort()) {
        assertCurrent?.();
        try {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          releases.push(await acquireCrossProcessLock(`${path}.mutation.lock`, { totalTimeoutMs: 10_000 }));
          assertCurrent?.();
          owned.push(path);
        } catch (error) {
          // An unusable fallback must not prevent a valid secure write. A busy
          // lock is never bypassed, and this target remains unwritable below.
          if (path === paths[0] || !optionalPaths.includes(path)
            || !['EEXIST', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      for (const path of owned) this.ownedMutationPaths.add(path);
      return operation();
    } finally {
      for (const path of owned) this.ownedMutationPaths.delete(path);
      for (const release of releases.reverse()) release();
    }
  }

  private setOwned(key: string, value: string, options: SecretWriteOptions, effect?: { readonly beforeWrite: () => void; readonly committed: () => void }): void {
    const policy = this.getPolicy();
    const medium = options.medium ?? this.getDefaultWriteMedium(policy);
    const scope = resolveSecretWriteScope(key, options.scope);
    if (secretWriteScopeWasOverridden(key, options.scope)) {
      // Disclosed, not silent: the caller asked for one home and the credential
      // went to another, and it did so because the other one is the only home
      // the daemon reads. See resolveSecretWriteScope.
      logger.info('SecretsManager: daemon-owned credential filed in the daemon tier', {
        key,
        requestedScope: options.scope,
        actualScope: scope,
        reason: describeCredentialScope(key),
      });
    }

    if (policy === 'require_secure' && medium === 'plaintext') {
      throw new Error('Secret policy require_secure forbids plaintext persistence');
    }

    const target = this.resolveWriteTarget(scope, medium);
    const existing = this.readStoreForWrite(target);
    const replacesSecureCopy = target.secure && Object.hasOwn(existing, key);
    // A credential whose text merely looks like a reference (`op://…`, a JSON
    // ref) is stored wrapped, so every read hands back the credential instead of
    // running a password-manager command; `goodvibes://secrets/…` stays a pointer.
    const stored = shouldStoreAsLiteral(value) ? encodeLiteralSecret(value) : value;
    existing[key] = stored;
    // Reads consult a scope's secure store before its plaintext one, so a
    // plaintext write removes this key's secure copy in the same scope, or is
    // refused before anything is written when that copy cannot be removed.
    const secureCopy = target.secure ? null : this.#secureCopyToRemove(key, scope);

    try {
      effect?.beforeWrite();
      if (target.secure) {
        this.writeEncryptedFile(target.path, existing);
      } else {
        this.writePlaintextFile(target.path, existing);
      }
      if (secureCopy) {
        try { this.writeEncryptedFile(secureCopy.path, secureCopy.values); } catch (error) {
          throw new Error(
            `Secret ${key} was written to ${target.path}, but its old secure copy in ${secureCopy.path} could not be removed (${summarizeError(error)}), so the old value is still the one read. Fix the secure store and set ${key} again.`,
            { cause: error },
          );
        }
      }
      effect?.committed();
      logger.debug('SecretsManager: stored secret', { key, source: target.source });
      this.#approveProjectWrite(target, [key]);
      this.notifyChanged(key);
      return;
    } catch (error) {
      if (policy === 'preferred_secure' && target.secure && !(error instanceof SecretStoreUnreadableError)) {
        const fallback = this.resolveWriteTarget(scope, 'plaintext');
        if (!this.ownedMutationPaths.has(fallback.path)) throw error;
        // Reads consult the secure store before the plaintext one, so a plaintext
        // copy written beside an existing secure copy would be saved but never
        // read, leaving the old (possibly rotated-out) credential in force.
        if (replacesSecureCopy) {
          throw new Error(
            `Secret ${key} was not changed: the secure store write failed (${summarizeError(error)}) and a plaintext fallback would be ignored while the old secure copy exists. Fix the secure store and retry.`,
            { cause: error },
          );
        }
        const fallbackExisting = this.readStoreForWrite(fallback);
        fallbackExisting[key] = stored;
        effect?.beforeWrite();
        this.writePlaintextFile(fallback.path, fallbackExisting);
        effect?.committed();
        this.#approveProjectWrite(fallback, [key]);
        logger.warn('SecretsManager: secure write failed, fell back to plaintext', {
          key,
          path: fallback.path,
          error: summarizeError(error),
        });
        this.notifyChanged(key);
        return;
      }
      throw error;
    }
  }

  /**
   * For a plaintext write of `key` in `scope`: the same scope's secure store
   * without `key` when it holds a copy (to be written after the plaintext one),
   * or null when it holds none. Throws, before anything is written, when that
   * store cannot be read or was not locked for this write, since its copy would
   * still be read in place of the new value.
   */
  #secureCopyToRemove(key: string, scope: SecretScope): { readonly path: string; readonly values: Record<string, string> } | null {
    const secure = this.resolveWriteTarget(scope, 'secure');
    const refuse = (why: string, cause?: unknown): Error => new Error(
      `Secret ${key} was not changed: ${why}, and a secure copy there is read before the plaintext one. Fix the secure store and retry.`,
      cause === undefined ? undefined : { cause },
    );
    let values: Record<string, string>;
    try { values = this.readStoreForWrite(secure); } catch (error) {
      throw refuse(`the secure store at ${secure.path} cannot be read (${summarizeError(error)})`, error);
    }
    if (!Object.hasOwn(values, key)) return null;
    if (!this.ownedMutationPaths.has(secure.path)) throw refuse(`the secure store at ${secure.path} could not be locked to remove the old secure copy`);
    delete values[key];
    return { path: secure.path, values };
  }

  /**
   * Load a store's current contents ahead of a write. A missing file is a
   * legitimately empty store; a file that exists but cannot be read refuses
   * the write outright, overwriting it would destroy every secret it holds.
   */
  private readStoreForWrite(target: SecretStorePath): Record<string, string> {
    const result = target.secure
      ? this.readEncryptedStore(target.path)
      : this.readPlaintextStore(target.path);
    if (result.status === 'unreadable') {
      throw new SecretStoreUnreadableError(
        `Refusing to write to the secrets store at ${target.path}: the file exists but cannot be read (${result.reason}). Overwriting it would destroy its contents; restore or move the file first.`,
      );
    }
    // No prototype, so a key such as `__proto__` is stored as data instead of being dropped.
    return Object.assign(Object.create(null) as Record<string, string>, result.status === 'ok' ? result.secrets : {});
  }

  async list(): Promise<string[]> {
    const keys = new Set<string>();
    for (const path of this.getReadOrder()) {
      const values = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) keys.add(key);
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }

  async listDetailed(): Promise<SecretRecord[]> {
    const envKeys = new Set(Object.keys(process.env));
    const records: SecretRecord[] = [];

    for (const path of this.getReadOrder()) {
      const values = path.secure ? this.readEncryptedFile(path.path) : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) {
        const refSource = getSecretRefSource(values[key]!);
        records.push({
          key,
          source: path.source,
          scope: path.scope,
          secure: path.secure,
          path: path.path,
          overriddenByEnv: envKeys.has(key),
          ...(refSource ? { refSource } : {}),
          ...(this.#usable(path, key, values[key]) ? {} : { unconfirmed: true as const }),
        });
      }
    }

    // An environment variable is listed only when it can be a credential this
    // manager serves: a stored key it overrides, or a name a built-in provider
    // declares. The rest of the process environment is not a secret record.
    const storedKeys = new Set(records.map((record) => record.key));
    for (const key of envKeys) {
      if (!storedKeys.has(key) && !DECLARED_PROVIDER_ENV_NAMES.has(key)) continue;
      records.push({
        key,
        source: 'env',
        scope: 'env',
        secure: false,
        overriddenByEnv: false,
      });
    }

    return records.sort((a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source));
  }

  async inspect(): Promise<SecretStorageReview> {
    const policy = this.getPolicy();
    const records = await this.listDetailed();
    const storedRecords = records.filter((record) => record.source !== 'env');
    const storeStates = this.getAllCandidateStores().map((store) => ({
      store,
      result: store.secure ? this.readEncryptedStore(store.path) : this.readPlaintextStore(store.path),
    }));
    const locations = storeStates.map(({ store, result }) => ({
      source: store.source,
      path: store.path,
      exists: existsSync(store.path),
      readable: result.status === 'ok',
    }));
    const warnings: string[] = [];
    for (const { store, result } of storeStates) {
      if (result.status === 'unreadable') {
        warnings.push(`store at ${store.path} exists but cannot be read (${result.reason})`);
      }
    }
    const unconfirmed = storedRecords.filter((record) => record.unconfirmed);
    if (unconfirmed.length) {
      warnings.push(`${unconfirmed.length} key(s) in this project's store are not used until confirmed with "Use a secret from this project's store" (Permissions and safety, Secrets): ${unconfirmed.map((record) => record.key).join(', ')}`);
    }
    if (policy === 'preferred_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext fallback secrets are present');
    }
    if (policy === 'require_secure') {
      // The policy leaves plaintext stores out of every read, so their key names are read here
      // (values discarded): a store the policy ignores is still reported when it holds keys.
      const ignored = storeStates.flatMap(({ store, result }) => !store.secure && result.status === 'ok'
        ? Object.keys(result.secrets).map((key) => `${key} (${store.path})`) : []);
      if (ignored.length > 0 || storedRecords.some((record) => !record.secure)) {
        warnings.push(`plaintext secrets exist but are ignored by current policy${ignored.length > 0 ? `: ${ignored.join(', ')}` : ''}`);
      }
    }

    return {
      policy,
      secureAvailable: true,
      storedKeys: new Set(storedRecords.map((record) => record.key)).size,
      envBackedKeys: new Set(records.filter((record) => record.source === 'env').map((record) => record.key)).size,
      secureKeys: new Set(storedRecords.filter((record) => record.secure).map((record) => record.key)).size,
      plaintextKeys: new Set(storedRecords.filter((record) => !record.secure).map((record) => record.key)).size,
      warnings,
      locations,
      records,
    };
  }

  /**
   * REVOKE. Removes the credential everywhere it can be reached.
   *
   * For a daemon-needed key the caller's `scope` is deliberately DISCARDED and
   * every tier is swept, because a revoke narrowed to one tier reports success
   * while leaving a live copy behind, a credential the operator believes is
   * gone and is not.
   */
  async delete(key: string, options: SecretDeleteOptions = {}): Promise<void> {
    const act = options.press?.act;
    if (act) { await this.#writeActs.run(act, () => this.deleteWithReceipt(key, options)); return; }
    await this.deleteWithReceipt(key, options);
  }

  /** As `delete`, answering which stores held the key; an empty answer means none did and nothing changed. */
  async deleteWithReceipt(key: string, options: SecretDeleteOptions = {}): Promise<readonly SecretDeletion[]> {
    const scopeFilter = resolveSecretDeleteScope(key, options.scope);
    const stores = this.getAllCandidateStores().filter((store) => {
      if (scopeFilter && store.scope !== scopeFilter) return false;
      if (options.medium && (options.medium === 'secure') !== store.secure) return false;
      return existsSync(store.path) && this.storeContainsKey(store, key);
    });
    if (stores.length === 0) return [];
    return await this.withCredentialMutation(key, () => this.withStoreMutations(stores.map(store => store.path), () => this.deleteOwned(key, stores)));
  }

  /**
   * Whether a candidate store holds `key`. A store that exists but cannot be
   * read is never "does not hold it": the delete refuses, naming the file,
   * because the key may still be there. Re-read under ownership before
   * changing any selected file, so unrelated writes survive.
   */
  private storeContainsKey(store: SecretStorePath, key: string): boolean {
    const result = store.secure ? this.readEncryptedStore(store.path) : this.readPlaintextStore(store.path);
    if (result.status === 'unreadable') {
      throw new SecretStoreUnreadableError(
        `Secret ${key} was not deleted: the secrets store at ${store.path} exists but cannot be read (${result.reason}), so the key may still be there; nothing was changed. Restore the file or make it readable, then delete again.`,
      );
    }
    return result.status === 'ok' && Object.hasOwn(result.secrets, key);
  }

  private deleteOwned(key: string, stores: readonly SecretStorePath[]): readonly SecretDeletion[] {
    let removed = false;
    const deletions: SecretDeletion[] = [];
    try {
      for (const store of stores) {
        const current = store.secure
          ? this.readEncryptedFile(store.path)
          : this.readPlaintextFile(store.path);
        if (!current || !Object.hasOwn(current, key)) continue;
        const values = Object.assign(Object.create(null) as Record<string, string>, current);
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete values[key];
        if (store.secure) this.writeEncryptedFile(store.path, values);
        else this.writePlaintextFile(store.path, values);
        logger.debug('SecretsManager: deleted secret', { key, source: store.source });
        removed = true;
        deletions.push({ scope: store.scope, medium: store.secure ? 'secure' : 'plaintext', source: store.source });
      }
    } finally {
      // A later store failing must not leave listeners holding a credential an earlier store already lost.
      if (removed) this.notifyChanged(key);
    }
    return deletions;
  }

  private deleteFromScopeOwned(key: string, stores: readonly SecretStorePath[]): void {
    let removed = false;
    try {
      for (const store of stores) {
        const current = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
        if (!current || !Object.hasOwn(current, key)) continue;
        const values = Object.assign(Object.create(null) as Record<string, string>, current);
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete values[key];
        if (store.secure) this.writeEncryptedFile(store.path, values);
        else this.writePlaintextFile(store.path, values);
        logger.debug('SecretsManager: removed one tier copy', { key, source: store.source });
        removed = true;
      }
    } finally {
      if (removed) this.notifyChanged(key);
    }
  }

  private getPolicy(): SecretStorageMode {
    return this.options.policy ?? loadConfiguredSecretPolicy(this.options.configManager);
  }

  private getReadOrder(): SecretStorePath[] {
    return secretReadOrder(this.layout, this.getPolicy() !== 'require_secure');
  }

  private getAllCandidateStores(): SecretStorePath[] {
    return allSecretStores(this.layout);
  }

  private resolveWriteTarget(scope: SecretScope, medium: SecretStorageMedium): SecretStorePath {
    return secretWriteTarget(this.layout, scope, medium);
  }

  private getDefaultWriteMedium(policy: SecretStorageMode): SecretStorageMedium {
    return policy === 'plaintext_allowed' ? 'plaintext' : 'secure';
  }

  /**
   * Read an encrypted store with three distinct outcomes: `ok` (decrypted),
   * `missing` (no file, a legitimately empty store), and `unreadable` (a file
   * exists but cannot be decrypted or parsed). Unreadable is never collapsed
   * into empty: writes to an unreadable store are refused so its contents are
   * never destroyed.
   */
  private readEncryptedStore(filePath: string): SecureStoreReadResult {
    const observed = this.#statStore(filePath);
    if (observed.status !== 'present') return observed;
    const cached = this.#cachedStore(filePath, observed.identity);
    if (cached) return { status: 'ok', secrets: cached };
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable', reason: summarizeError(err) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unreadable', reason: 'store file is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    const envelope = parsed as Partial<EncryptedStoreEnvelope>;
    if (typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }

    if (envelope.version !== SECRETS_STORE_FORMAT_VERSION) {
      return {
        status: 'unreadable',
        reason: `store format version ${typeof envelope.version === 'number' ? envelope.version : '(not a number)'} is not supported by this platform version`,
      };
    }

    try {
      const readKey = this.getReadEncryptionKey();
      if (readKey === null) {
        return {
          status: 'unreadable',
          reason: `the keyfile at ${this.keyFilePath} is missing; restore it next to the store, a new key was not created`,
        };
      }
      const secrets = JSON.parse(decrypt(envelope as EncryptedStoreEnvelope, readKey)) as Record<string, string>;
      return { status: 'ok', secrets: this.#keepStore(filePath, observed.identity, secrets) };
    } catch (err) {
      return {
        status: 'unreadable',
        reason: `cannot decrypt with the current keyfile (${summarizeError(err)})`,
      };
    }
  }

  /**
   * Lookup-flavored read: returns the secrets when readable, null otherwise.
   * An unreadable store logs one honest error per file per process; it is
   * never mistaken for an empty store on the write path (see set/delete).
   */
  private readEncryptedFile(filePath: string): Readonly<Record<string, string>> | null {
    const result = this.readEncryptedStore(filePath);
    if (result.status === 'ok') return result.secrets;
    if (result.status === 'unreadable') this.reportUnreadableStore(filePath, result.reason);
    return null;
  }

  private reportUnreadableStore(filePath: string, reason: string): void {
    if (this.reportedUnreadableStores.has(filePath)) return;
    this.reportedUnreadableStores.add(filePath);
    logger.error('SecretsManager: store exists but cannot be read; its secrets are unavailable and the file will not be overwritten', {
      path: filePath,
      reason: this.options.diagnosticMode === 'structural' ? 'secret store could not be read' : reason,
    });
  }

  private writeEncryptedFile(filePath: string, secrets: Record<string, string>): void {
    const key = this.getEncryptionKey();
    // Never encrypt with a cached key the keyfile no longer backs, the
    // resulting store would be unreadable by every other process (and by this
    // one after restart). A missing keyfile is restored from the cached key.
    assertCachedKeyIsCurrent(this.keyFilePath, key);
    const store = encrypt(JSON.stringify(secrets), key);
    // The 0700 directory mode is this store's own; the helper only creates the
    // directory when it is missing, so establishing it here keeps the mode.
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(filePath, store, { mode: 0o600, durable: true });
    this.#noteOwnWrite(filePath);
  }

  private readPlaintextStore(filePath: string): PlaintextStoreReadResult {
    const observed = this.#statStore(filePath);
    if (observed.status !== 'present') return observed;
    const cached = this.#cachedStore(filePath, observed.identity);
    if (cached) return { status: 'ok', secrets: cached };
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable', reason: summarizeError(err) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unreadable', reason: 'store file is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    if ('version' in parsed && 'secrets' in parsed) {
      const secrets = (parsed as PlaintextStore).secrets;
      return secrets && typeof secrets === 'object'
        ? { status: 'ok', secrets: this.#keepStore(filePath, observed.identity, secrets) }
        : { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    return { status: 'ok', secrets: this.#keepStore(filePath, observed.identity, parsed as Record<string, string>) };
  }

  private readPlaintextFile(filePath: string): Readonly<Record<string, string>> | null {
    const result = this.readPlaintextStore(filePath);
    if (result.status === 'ok') return result.secrets;
    if (result.status === 'unreadable') this.reportUnreadableStore(filePath, result.reason);
    return null;
  }

  private writePlaintextFile(filePath: string, secrets: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const payload: PlaintextStore = { version: 1, secrets };
    writeJsonFileAtomic(filePath, payload, { mode: 0o600, durable: true });
    this.#noteOwnWrite(filePath);
  }
}

function storeIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
