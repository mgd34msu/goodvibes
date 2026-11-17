import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { assertSecurityReadSource } from '../security/read-source.js';
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
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher, type Stats } from 'fs';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { observeImportFile, assertImportFileCurrent, type ImportFileObservation, type PreparedImportTransitionFacts } from './prepared-import.js';
import type { PreparedConfigMutationReceipt } from './prepared-mutation.js';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import type { ConfigManager } from './manager.js';
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
import { getSecretRefSource, isSecretRefInput, normalizeSecretRef, resolveSecretRef, useSecretProviderHostConfig, type SecretProviderHostConfig } from './secret-refs.js';
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
declare const secretImportBrand: unique symbol;
declare const secretImportTransitionBrand: unique symbol;
export interface PreparedSecretImport { readonly [secretImportBrand]: true }
export interface PreparedSecretImportTransition { readonly [secretImportTransitionBrand]: true }
export type SecretImportEntry =
  | { readonly key: string; readonly value: string; readonly scope: SecretScope; readonly operation?: 'set' }
  | { readonly key: string; readonly scope: SecretScope; readonly operation: 'delete'; readonly value?: never };
export interface PreparedSecretImportFacts {
  readonly operation: 'import';
  readonly beforeGeneration: number;
  readonly items: readonly { readonly key: string; readonly scope: SecretScope; readonly configured: boolean }[];
  readonly destinations: readonly { readonly path: string; readonly operation: 'set'; readonly tier: SecretScope | 'keyfile' }[];
}
interface SecretImportRecord {
  readonly facts: PreparedSecretImportFacts;
  readonly policy: SecretStorageMode;
  readonly methods: readonly unknown[];
  readonly observations: { readonly path: string; observation: ImportFileObservation }[];
  readonly publications: readonly { readonly path: string; readonly payload: unknown; readonly keyfile: boolean }[];
  phase: 'prepared' | 'pending' | 'committing' | 'committed' | 'failed';
  transition?: PreparedSecretImportTransition;
  /** Set once the pending counts and generation were settled, so a second settle is a no-op. */
  settled?: boolean;
}
export interface SecretWriteOptions {
  /** Optional exact effect transaction; never grants permission by itself. */
  readonly effect?: ((transition: SecretWriteTransition) => SecretWriteEffectOwner) | undefined;
  /** Retained caller authority, checked again after queued store-lock acquisition. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
}

export interface SecretDeleteOptions {
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
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

/** The owner's password-manager host settings (`storage.secretProviders.*`); empty fields fall back to each provider's defaults. */
export function readSecretProviderHostConfig(configManager: Pick<ConfigManager, 'get'>): SecretProviderHostConfig {
  const read = (key: 'onePasswordCli' | 'bitwardenCli' | 'bitwardenAppDataDir' | 'bitwardenSessionEnv' | 'bwsCli' | 'bwsAccessTokenEnv' | 'bwsConfigFile' | 'bwsServerUrl'): string | undefined => {
    try {
      const value = configManager.get(`storage.secretProviders.${key}`);
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch { return undefined; }
  };
  return {
    onePassword: { cli: read('onePasswordCli') },
    bitwarden: { cli: read('bitwardenCli'), appDataDir: read('bitwardenAppDataDir'), sessionEnv: read('bitwardenSessionEnv') },
    bitwardenSecretsManager: { cli: read('bwsCli'), accessTokenEnv: read('bwsAccessTokenEnv'), configFile: read('bwsConfigFile'), serverUrl: read('bwsServerUrl') },
  };
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

/** An environment value only when `key` is really a variable, so names such as `__proto__` never read an inherited property. */
function ownEnvValue(key: string): string | undefined {
  return Object.hasOwn(process.env, key) ? process.env[key] : undefined;
}

export class SecretsManager {
  /** Restriction only, captured from this manager's actual native stores. */
  /**
   * A check that the stored credentials did not change while a status read ran:
   * integer compares of this owner's revision (its own writes, and another
   * process's writes seen by the store watch) and the storage policy.
   */
  captureReadSource(): () => void {
    assertSecurityReadSource(!this.pendingLocalMutations.size, 'secret store');
    this.#startWatching();
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

  private notifyChanged(key: string, privateImport = false): void {
    for (const listener of [...this.changeListeners]) {
      try { listener(key); } catch (error) {
        logger.warn('SecretsManager: change listener failed', { key,
          ...(privateImport ? { reason: 'listener-failed' } : { error: summarizeError(error) }) });
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
   */
  #watchers: FSWatcher[] | null = null;
  #startWatching(): void {
    if (this.#watchers) return;
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
    if (this.#foreignStoreWrites !== before) this.notifyCredentialInvalidation();
  }

  /** Value-free local owner state; no credential names, paths, bytes or hashes. */
  getCredentialMutationState(): Readonly<{ generation: number; pending: boolean }> {
    return Object.freeze({ generation: this.credentialMutationGeneration, pending: this.pendingLocalMutations.size > 0 });
  }

  /** Pre-effect and settlement notifications, including failed or no-op writes. */
  onDidInvalidateCredentials(listener: () => void): () => void {
    this.#startWatching();
    this.credentialInvalidationListeners.add(listener);
    return () => { this.credentialInvalidationListeners.delete(listener); };
  }

  private notifyCredentialInvalidation(): void {
    this.#credentialSnapshots.clear();
    this.#resolvedReferences.clear();
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
  private readonly preparedImports = new WeakMap<PreparedSecretImport, SecretImportRecord>();

  /**
   * A check that the stored credentials are still the ones read now: integer
   * compares of this owner's revision (its own writes, and another process's
   * writes seen by the store watch) and the storage policy. No disk access.
   */
  captureLocalCredentialReadset(): () => void {
    if (this.pendingLocalMutations.size) throw new Error('Credential owner is busy.');
    this.#startWatching();
    const revision = this.#revisionSource.revision(), policy = this.getPolicy();
    return () => {
      if (this.pendingLocalMutations.size || this.#revisionSource.revision() !== revision || this.getPolicy() !== policy) throw new Error('Credential source changed.');
    };
  }

  /** Stage complete private payloads; capture never creates a keyfile or repairs a store. */
  prepareImport(entries: readonly SecretImportEntry[]): PreparedSecretImport {
    try { return this.prepareImportOwned(entries); }
    catch { throw new Error('Secret import is unavailable.'); }
  }
  private prepareImportOwned(entries: readonly SecretImportEntry[]): PreparedSecretImport {
    const values = captureStrictJudgmentJson(entries), state = this.getCredentialMutationState(), policy = this.getPolicy();
    if (state.pending || !values.length || new Set(values.map(entry => entry.key)).size !== values.length
      || values.some(entry => typeof entry.key !== 'string' || !entry.key || (entry.operation !== undefined && entry.operation !== 'set' && entry.operation !== 'delete')
        || (entry.operation === 'delete' ? entry.value !== undefined : typeof entry.value !== 'string') || !['project', 'user', 'daemon'].includes(entry.scope))) throw new Error('Secret import is unavailable.');
    const medium = this.getDefaultWriteMedium(policy);
    const keyObservation = observeImportFile(this.keyFilePath);
    if (keyObservation.raw !== null && !/^[0-9a-f]{64}$/i.test(keyObservation.raw.trim())) throw new Error('Secret keyfile is unavailable.');
    const key = keyObservation.raw === null ? this.encKey ?? randomBytes(32) : Buffer.from(keyObservation.raw.trim(), 'hex');
    if (this.encKey && keyObservation.raw !== null && !this.encKey.equals(key)) throw new Error('Secret keyfile changed.');
    const observations = [{ path: this.keyFilePath, observation: keyObservation }];
    const targets = new Map<string, { readonly store: SecretStorePath; readonly values: Record<string, string>; encryptionKey: Buffer }>();
    const items = values.map(entry => ({ key: entry.key, value: entry.operation !== 'delete' && typeof entry.value === 'string' && shouldStoreAsLiteral(entry.value) ? encodeLiteralSecret(entry.value) : entry.value, operation: entry.operation ?? 'set', scope: resolveSecretWriteScope(entry.key, entry.scope) }));
    for (const entry of items) {
      const stores = entry.operation === 'delete' ? [this.resolveWriteTarget(entry.scope, 'secure'), this.resolveWriteTarget(entry.scope, 'plaintext')]
        : [this.resolveWriteTarget(entry.scope, medium)];
      for (const store of stores) {
      let target = targets.get(store.path);
      if (!target) {
        const observation = observeImportFile(store.path);
        const previousObservation = observations.find(entry => entry.path === store.path);
        if (previousObservation) assertImportFileCurrent(store.path, previousObservation.observation);
        else observations.push({ path: store.path, observation });
        if (entry.operation === 'delete' && observation.raw === null) continue;
        let existing: unknown = {};
        const encryptionKey = key;
        if (observation.raw !== null) {
          const parsed: unknown = JSON.parse(observation.raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Secret store is unavailable.');
          if (store.secure) {
            if (!('iv' in parsed) || typeof parsed.iv !== 'string' || !('tag' in parsed) || typeof parsed.tag !== 'string' || !('data' in parsed) || typeof parsed.data !== 'string') throw new Error('Secret store is unavailable.');
            if (!('version' in parsed) || parsed.version !== SECRETS_STORE_FORMAT_VERSION || keyObservation.raw === null) throw new Error('Secret store is unavailable.');
            const envelope: EncryptedStoreEnvelope = { iv: parsed.iv, tag: parsed.tag, data: parsed.data, version: SECRETS_STORE_FORMAT_VERSION };
            existing = JSON.parse(decrypt(envelope, key));
          } else existing = 'secrets' in parsed ? parsed.secrets : parsed;
        }
        if (!existing || typeof existing !== 'object' || Array.isArray(existing) || Object.values(existing).some(value => typeof value !== 'string')) throw new Error('Secret store is unavailable.');
        target = { store, values: { ...captureStrictJudgmentJson(existing) } as Record<string, string>, encryptionKey }; targets.set(store.path, target);
      }
      if (entry.operation === 'delete') delete target.values[entry.key];
      else {
        target.encryptionKey = key;
        Object.defineProperty(target.values, entry.key, { value: entry.value, enumerable: true, writable: true, configurable: true });
      }
      }
    }
    const needsKey = keyObservation.raw === null && [...targets.values()].some(target => target.store.secure && target.encryptionKey === key);
    const publications = [...(needsKey ? [{ path: this.keyFilePath, payload: `${key.toString('hex')}\n`, keyfile: true }] : []),
      ...[...targets.values()].map(target => {
        const payload = target.store.secure ? encrypt(JSON.stringify(target.values), target.encryptionKey) : { version: 1, secrets: target.values };
        return { path: target.store.path, payload, keyfile: false };
      })];
    const handle = Object.freeze({}) as PreparedSecretImport;
    const facts: PreparedSecretImportFacts = Object.freeze({ operation: 'import', beforeGeneration: state.generation,
      items: Object.freeze(items.map(({ key, scope, operation }) => Object.freeze({ key, scope, configured: operation === 'set' }))),
      destinations: Object.freeze(publications.map(publication => Object.freeze({ path: publication.path, operation: 'set' as const,
        tier: publication.keyfile ? 'keyfile' as const : targets.get(publication.path)!.store.scope }))) });
    this.preparedImports.set(handle, { facts, policy, observations, publications: captureStrictJudgmentJson(publications),
      methods: [this.getPolicy, this.resolveWriteTarget, this.getDefaultWriteMedium], phase: 'prepared' });
    this.assertPreparedImport(handle); return handle;
  }
  inspectPreparedImport(handle: PreparedSecretImport): PreparedSecretImportFacts {
    const record = this.preparedImports.get(handle); if (!record) throw new Error('Secret import is not authentic.'); return record.facts;
  }
  private assertImportRecord(record: SecretImportRecord, generation: number): void {
    if (this.credentialMutationGeneration !== generation || this.getPolicy() !== record.policy
      || [this.getPolicy, this.resolveWriteTarget, this.getDefaultWriteMedium].some((method, index) => method !== record.methods[index])) throw new Error('Secret import owner changed.');
    for (const observation of record.observations) assertImportFileCurrent(observation.path, observation.observation);
  }
  assertPreparedImport(handle: PreparedSecretImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'prepared' || this.pendingLocalMutations.size) throw new Error('Secret import is unavailable.');
    this.assertImportRecord(record, record.facts.beforeGeneration);
  }
  beginPreparedImport(handle: PreparedSecretImport): PreparedSecretImportTransition {
    this.assertPreparedImport(handle); const record = this.preparedImports.get(handle)!;
    const transition = Object.freeze({}) as PreparedSecretImportTransition; record.transition = transition; record.phase = 'pending';
    this.credentialMutationGeneration++;
    for (const item of record.facts.items) this.pendingLocalMutations.set(item.key, 1);
    this.notifyCredentialInvalidation();
    try { this.assertPreparedImportTransition(handle, transition); return transition; }
    catch {
      record.phase = 'failed'; this.credentialMutationGeneration++;
      for (const item of record.facts.items) {
        const remaining = (this.pendingLocalMutations.get(item.key) ?? 1) - 1;
        if (remaining) this.pendingLocalMutations.set(item.key, remaining); else this.pendingLocalMutations.delete(item.key);
      }
      this.notifyCredentialInvalidation(); throw new Error('Secret import owner changed.');
    }
  }
  inspectPreparedImportTransition(handle: PreparedSecretImport, transition: PreparedSecretImportTransition): PreparedImportTransitionFacts {
    this.assertPreparedImportTransition(handle, transition); const record = this.preparedImports.get(handle)!;
    return Object.freeze({ beforeGeneration: record.facts.beforeGeneration, afterGeneration: this.credentialMutationGeneration, phase: record.phase === 'committed' ? 'committed' : 'pending' });
  }
  assertPreparedImportTransition(handle: PreparedSecretImport, transition: PreparedSecretImportTransition): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.transition !== transition || !['pending', 'committing', 'committed'].includes(record.phase)) throw new Error('Secret import transition is not authentic.');
    const completed = record.phase === 'committed';
    if (completed ? this.pendingLocalMutations.size > 0 : this.pendingLocalMutations.size !== record.facts.items.length || record.facts.items.some(item => this.pendingLocalMutations.get(item.key) !== 1)) throw new Error('Secret import owner changed.');
    this.assertImportRecord(record, record.facts.beforeGeneration + (completed ? 2 : 1));
  }
  /** Acquire the real file namespace before a synchronous authenticated publication tail. */
  async withPreparedImport<T>(handle: PreparedSecretImport,
    operation: (finish: (assertCurrent: () => void) => PreparedConfigMutationReceipt) => T,
    assertCurrent: () => void = () => {}): Promise<T> {
    this.assertPreparedImport(handle);
    const record = this.preparedImports.get(handle)!;
    const current = () => { assertCurrent(); this.assertPreparedImport(handle); };
    return this.withStoreMutations(record.publications.map(publication => publication.path), () => {
      current(); let active = true; let spent = false;
      try { return operation(beforeEffect => {
        if (!active || spent) throw new Error('Secret import is spent.'); spent = true;
        beforeEffect(); const transition = this.beginPreparedImport(handle);
        return this.finishPreparedImportOwned(handle, transition, beforeEffect);
      }); } finally { active = false; }
    }, [], current);
  }

  async finishPreparedImport(handle: PreparedSecretImport, transition: PreparedSecretImportTransition, beforeEffect: () => void): Promise<PreparedConfigMutationReceipt> {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'pending' || record.transition !== transition) throw new Error('Secret import is spent.');
    record.phase = 'committing';
    const current = () => { beforeEffect(); this.assertPreparedImportTransition(handle, transition); };
    try {
      current();
      return await this.withStoreMutations(record.publications.map(publication => publication.path),
        () => this.finishPreparedImportOwned(handle, transition, beforeEffect), [], current);
    } catch {
      // Files were already published and settled: a later failure (for example
      // releasing the store lock) must not turn a committed import into 'unknown'.
      // The owned step advances the phase; read it through a function so the 'committing' assignment above does not narrow it.
      const phaseNow = (): SecretImportRecord['phase'] => record.phase;
      if (phaseNow() === 'committed') {
        return Object.freeze({ status: 'committed', completedPaths: Object.freeze(record.publications.map(publication => publication.path)) });
      }
      record.phase = 'failed'; this.settlePreparedImport(record);
      return Object.freeze({ status: 'unknown', completedPaths: Object.freeze([]),
        ...(record.publications[0] ? { uncertainPath: record.publications[0].path } : {}) });
    }
  }
  private settlePreparedImport(record: SecretImportRecord): void {
    if (record.settled) return;
    record.settled = true;
    this.credentialMutationGeneration++;
    for (const item of record.facts.items) {
      const remaining = (this.pendingLocalMutations.get(item.key) ?? 1) - 1;
      if (remaining) this.pendingLocalMutations.set(item.key, remaining); else this.pendingLocalMutations.delete(item.key);
    }
    this.notifyCredentialInvalidation();
    if (record.phase === 'committed') for (const item of record.facts.items) this.notifyChanged(item.key, true);
  }
  private finishPreparedImportOwned(handle: PreparedSecretImport, transition: PreparedSecretImportTransition, beforeEffect: () => void): PreparedConfigMutationReceipt {
    const record = this.preparedImports.get(handle);
    if (!record || !['pending', 'committing'].includes(record.phase) || record.transition !== transition) throw new Error('Secret import is spent.');
    record.phase = 'committing'; const completedPaths: string[] = []; let uncertainPath: string | undefined;
    const current = () => { beforeEffect(); this.assertPreparedImportTransition(handle, transition); };
    try {
      current();
      for (const publication of record.publications) {
        uncertainPath = publication.path; current();
        if (publication.keyfile) writeFileSync(publication.path, publication.payload as string, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        else writeJsonFileAtomic(publication.path, publication.payload, { mode: 0o600, cleanupStaleTemps: false, assertCurrent: current });
        this.#noteOwnWrite(publication.path);
        completedPaths.push(publication.path);
        record.observations.find(observation => observation.path === publication.path)!.observation = observeImportFile(publication.path);
      }
      record.phase = 'committed'; uncertainPath = undefined;
      const projectKeys = record.facts.items.filter(item => item.scope === 'project' && item.configured).map(item => item.key);
      for (const destination of record.facts.destinations) {
        if (destination.tier === 'project') this.#approveProjectWrite({ source: 'project-secure', path: destination.path, secure: true, scope: 'project' }, projectKeys);
      }
    } catch { record.phase = 'failed'; }
    finally { this.settlePreparedImport(record); }
    return Object.freeze({ status: record.phase === 'committed' ? 'committed' : completedPaths.length ? 'partial' : 'unknown',
      completedPaths: Object.freeze(completedPaths), ...(uncertainPath ? { uncertainPath } : {}) });
  }
  assertCompletedImport(handle: PreparedSecretImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'committed' || this.pendingLocalMutations.size) throw new Error('Secret import did not commit.');
    this.assertImportRecord(record, record.facts.beforeGeneration + 2);
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
            writeJsonFileAtomic(publication.path, publication.payload, { mode: 0o600, cleanupStaleTemps: false });
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

  applyPreparedScopedDeletion(handle: PreparedScopedSecretDeletion, assertCurrent: () => void): Promise<import('./prepared-mutation.js').PreparedConfigMutationReceipt> {
    return this.withPreparedScopedDeletion(handle, finish => finish(assertCurrent));
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
   * credential revision. Any set, delete, import or store change clears them.
   */
  readonly #resolvedReferences = new Map<string, string>();

  constructor(options: SecretsManagerOptions) {
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
    const configManager = this.options.configManager;
    // References resolved anywhere in this process run the password managers this owner's settings name.
    if (configManager) useSecretProviderHostConfig(() => readSecretProviderHostConfig(configManager));
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

  /** True unless `store` is this project's store and `key` in it was never confirmed. */
  #usable(store: SecretStorePath, key: string, report = false): boolean {
    if (store.scope !== 'project' || this.#approvals.isApproved(store.path, key)) return true;
    const id = `${store.path}\0${key}`;
    if (report && !this.#reportedUnconfirmed.has(id)) {
      this.#reportedUnconfirmed.add(id);
      logger.warn('SecretsManager: a key in this project\'s secret store is not used until you confirm it', {
        key, path: store.path, next: `/secrets trust ${key} --yes, or store it in your user store`,
      });
    }
    return false;
  }

  #approveProjectWrite(store: SecretStorePath, keys: readonly string[]): void {
    if (store.scope !== 'project' || keys.length === 0) return;
    try { this.#approvals.approve(store.path, keys); }
    catch (error) {
      logger.warn('SecretsManager: stored in the project store, but the confirmation could not be recorded; confirm it with /secrets trust', {
        keys, path: store.path, error: summarizeError(error),
      });
    }
  }

  /**
   * The user confirms `key` found in this project's secret store, so it is used
   * from now on. Returns the store files it was confirmed in; empty when this
   * project's store does not hold the key.
   */
  confirmProjectSecret(key: string): readonly string[] {
    const confirmed: string[] = [];
    for (const store of this.getAllCandidateStores()) {
      if (store.scope !== 'project') continue;
      const values = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
      if (!values || !Object.hasOwn(values, key)) continue;
      this.#approvals.approve(store.path, [key]);
      confirmed.push(store.path);
    }
    if (confirmed.length) {
      this.credentialMutationGeneration += 2;
      this.notifyCredentialInvalidation();
      this.notifyChanged(key);
    }
    return confirmed;
  }

  async get(key: string): Promise<string | null> {
    return this.getInternal(key, new Set([key]));
  }

  /** Atomic first creation for daemon-owned material, shared across process creators.
   * References and unreadable tiers cannot be treated as missing material.
   * This does not authorize replacing an existing key or changing its scope.
   */
  async getOrCreateDaemonSecret(key: string, create: () => string, assertCurrent?: () => void): Promise<string> {
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
      return value;
    }, paths.slice(1), guard);
  }

  /**
   * Synchronous credential-owner fence for a local literal only. This follows
   * the same local precedence as get(), but never follows references, launches
   * commands, or contacts a secret provider. Keep the value inside credential
   * ownership; it is not an identity or provenance snapshot.
   */
  resolveLocalSecretSync(key: string):
    | { readonly state: 'resolved'; readonly value: string }
    | { readonly state: 'absent' | 'unsupported' } {
    const capture = (value: unknown): ReturnType<SecretsManager['resolveLocalSecretSync']> => {
      if (typeof value !== 'string') return { state: 'unsupported' };
      const literal = decodeLiteralSecret(value);
      if (literal !== null) return { state: 'resolved', value: literal };
      return isSecretRefInput(value) ? { state: 'unsupported' } : { state: 'resolved', value };
    };
    const envValue = ownEnvValue(key);
    if (envValue !== undefined) return capture(envValue);
    if (this.pendingLocalMutations.has(key)) return { state: 'unsupported' };
    for (const path of this.getReadOrder()) {
      const result = path.secure ? this.readEncryptedStore(path.path) : this.readPlaintextStore(path.path);
      if (result.status === 'unreadable') return { state: 'unsupported' };
      if (result.status === 'ok' && Object.hasOwn(result.secrets, key) && this.#usable(path, key)) return capture(result.secrets[key]);
    }
    return { state: 'absent' };
  }

  /** Local alias-aware observation. Private credential bytes never become judgment facts. */
  resolveLocalCredentialSnapshot(key: string):
    | { readonly state: 'resolved'; readonly value: string; readonly revision: string }
    | { readonly state: 'absent'; readonly revision: string }
    | { readonly state: 'unsupported' } {
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
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current) || this.pendingLocalMutations.has(current) || ownEnvValue(current) !== undefined) return { state: 'unsupported' };
      seen.add(current);
      let value: string | undefined;
      for (const path of this.getReadOrder()) {
        const result = path.secure ? this.readEncryptedStore(path.path) : this.readPlaintextStore(path.path);
        if (result.status === 'unreadable') return { state: 'unsupported' };
        const found = result.status === 'ok' && Object.hasOwn(result.secrets, current) && this.#usable(path, current);
        chain.push([current, path.path, path.secure, found]);
        if (found) { value = result.secrets[current]; break; }
      }
      if (value === undefined) return depth === 0 ? { state: 'absent', revision: revision() } : { state: 'unsupported' };
      if (typeof value !== 'string') return { state: 'unsupported' };
      chain.push(value);
      const literal = decodeLiteralSecret(value);
      if (literal !== null) return { state: 'resolved', value: literal, revision: revision() };
      if (!isSecretRefInput(value)) return { state: 'resolved', value, revision: revision() };
      const ref = normalizeSecretRef(value);
      if (!ref || ref.source !== 'goodvibes') return { state: 'unsupported' };
      current = ref.id;
    }
    return { state: 'unsupported' };
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
  async getFromScope(key: string, scope: SecretScope): Promise<string | null> {
    for (const path of this.getAllCandidateStores()) {
      if (path.scope !== scope) continue;
      const secrets = path.secure ? this.readEncryptedFile(path.path) : this.readPlaintextFile(path.path);
      if (secrets !== null && Object.hasOwn(secrets, key)) return secrets[key] ?? null;
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
  async getWriteScopeEntry(key: string, scope: SecretScope): Promise<string | null> {
    for (const medium of ['secure', 'plaintext'] as const) {
      const target = this.resolveWriteTarget(scope, medium);
      const result = target.secure ? this.readEncryptedStore(target.path) : this.readPlaintextStore(target.path);
      if (result.status === 'unreadable') {
        throw new SecretStoreUnreadableError(`The secrets store at ${target.path} exists but cannot be read (${result.reason}).`);
      }
      if (result.status === 'ok' && Object.hasOwn(result.secrets, key)) return result.secrets[key] ?? null;
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
        if (!this.#usable(path, key, true)) continue;
        logger.debug('SecretsManager: resolved from store', { key, source: path.source });
        const value = secrets[key]!;
        if (value === undefined) return null;
        // A wrapped literal is the credential itself, never a pointer to follow.
        const literal = decodeLiteralSecret(value);
        if (literal !== null) return literal;
        return this.resolveMaybeReferencedValue(key, value, seen, path.scope === 'project');
      }
    }

    return null;
  }

  private async resolveMaybeReferencedValue(key: string, value: string, seen: Set<string>, fromProjectStore = false): Promise<string | null> {
    if (!isSecretRefInput(value)) return value;

    // A project store lives inside a directory that may have been cloned from
    // anywhere, so it is data, not a place to run commands or read files from.
    // Only references that stay inside GoodVibes follow; an env: reference
    // would let a checkout name any variable of the user's environment.
    const refSource = getSecretRefSource(value);
    if (fromProjectStore && refSource !== 'goodvibes') {
      logger.warn('SecretsManager: refused a secret reference found in a project store; move it to the user store (scope user) to use it', {
        key,
        refSource: refSource ?? 'unknown',
      });
      return null;
    }

    const commandBacked = refSource !== null && COMMAND_BACKED_SOURCES.has(refSource);
    const cacheKey = `${key}\0${value}`;
    const cached = commandBacked ? this.#resolvedReferences.get(cacheKey) : undefined;
    if (cached !== undefined) return cached;
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
      });
      logger.debug('SecretsManager: resolved secret reference', { key, refSource: resolved.source });
      if (commandBacked && resolved.value !== null && this.#revisionSource.revision() === revision) {
        if (this.#resolvedReferences.size >= 256) this.#resolvedReferences.clear();
        this.#resolvedReferences.set(cacheKey, resolved.value);
      }
      return resolved.value;
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

  async set(key: string, value: string, options: SecretWriteOptions = {}): Promise<void> {
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

  private writeStorePaths(scope: SecretScope, medium: SecretStorageMedium, policy: SecretStorageMode): string[] {
    const target = this.resolveWriteTarget(scope, medium);
    return [target.path, ...(target.secure && policy === 'preferred_secure'
      ? [this.resolveWriteTarget(scope, 'plaintext').path] : [])];
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
          releases.push(await acquireCrossProcessLock(`${path}.mutation.lock`, { strictOwnership: true, totalTimeoutMs: 10_000 }));
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

    try {
      effect?.beforeWrite();
      if (target.secure) {
        this.writeEncryptedFile(target.path, existing);
      } else {
        this.writePlaintextFile(target.path, existing);
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
          ...(this.#usable(path, key) ? {} : { unconfirmed: true as const }),
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
      warnings.push(`${unconfirmed.length} key(s) in this project's store are not used until confirmed with /secrets trust <KEY>: ${unconfirmed.map((record) => record.key).join(', ')}`);
    }
    if (policy === 'preferred_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext fallback secrets are present');
    }
    if (policy === 'require_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext secrets exist but are ignored by current policy');
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
    await this.deleteWithReceipt(key, options);
  }

  /** As `delete`, answering which stores held the key; an empty answer means none did and nothing changed. */
  async deleteWithReceipt(key: string, options: SecretDeleteOptions = {}): Promise<readonly SecretDeletion[]> {
    const daemonNeeded = isDaemonNeededSecretKey(key);
    const scopeFilter = daemonNeeded ? undefined : options.scope;
    const stores = this.getAllCandidateStores().filter((store) => {
      if (scopeFilter && store.scope !== scopeFilter) return false;
      if (options.medium && (options.medium === 'secure') !== store.secure) return false;
      return existsSync(store.path) && this.storeContainsKey(store, key);
    });
    if (stores.length === 0) return [];
    return await this.withCredentialMutation(key, () => this.withStoreMutations(stores.map(store => store.path), () => this.deleteOwned(key, stores)));
  }

  private storeContainsKey(store: SecretStorePath, key: string): boolean {
    // Preserve no-op deletion from unrelated/read-only tiers. Re-read under
    // ownership before changing any selected file, so unrelated writes survive.
    const values = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
    return values !== null && Object.hasOwn(values, key);
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
    writeJsonFileAtomic(filePath, store, { mode: 0o600 });
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
    writeJsonFileAtomic(filePath, payload, { mode: 0o600 });
    this.#noteOwnWrite(filePath);
  }
}

function storeIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
