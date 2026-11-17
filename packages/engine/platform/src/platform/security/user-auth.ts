import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { confirmFileDurable, writeFileAtomic } from '../utils/atomic-json-store.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { ProcessLockBusyError, withProcessLockSync } from '../utils/process-lock.js';
import { SettingsAuthorityUnavailableError } from './settings-authority.js';

export interface AuthUser {
  username: string;
  passwordHash: string;
  roles?: string[] | undefined;
}

export interface AuthSession {
  readonly id: string;
  token: string;
  username: string;
  expiresAt: number;
}

/** The accounts and signed-in sessions of a manager, copied so later changes do not alter it. */
export interface UserAuthState {
  readonly users: readonly AuthUser[];
  readonly sessions: readonly AuthSession[];
  /** Whether the last user-store write had failed, and whether settings changes were held back. Absent in a state made by an older build. */
  readonly faults?: { readonly persist: boolean; readonly settings: boolean } | undefined;
}

declare const settingsSessionAuthorityBrand: unique symbol;
/** Opaque same-session precondition. Contains no credential or fingerprint. */
export interface SettingsSessionAuthority {
  readonly kind: 'session';
  readonly roles: readonly string[];
  readonly [settingsSessionAuthorityBrand]: true;
}
interface SettingsSessionAuthorityRecord {
  readonly token: string;
  readonly session: AuthSession;
  readonly user: AuthUser;
  readonly username: string;
  readonly passwordHash: string;
  readonly roles: readonly string[];
  readonly expiresAt: number;
}

interface UserAuthConfig {
  sessionTtlMs?: number | undefined;
  maxSessions?: number | undefined;
  /** Maximum number of per-account lock state entries. Excess entries are evicted by staleness. Default: 10000. */
  maxAccountLocks?: number | undefined;
  users?: AuthUser[] | undefined;
  bootstrapFilePath: string;
  bootstrapCredentialPath: string;
  /** Scrypt cost params for hashing new passwords. Existing hashes carry their own params. Default: N=131072, r=8, p=1. */
  scryptParams?: ScryptParams | undefined;
  /** Injectable clock for testing. Defaults to Date.now. */
  nowFn?: (() => number) | undefined;
}

/**
 * How long a sign-in lasts without use: the one value, published by the
 * control plane as `sessionTtlMs`. Each use moves the end this far ahead
 * (at most once a minute), so a sign-in in use does not end mid-work.
 */
export const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A session's end moves forward on use at most this often. */
const SESSION_EXTEND_STEP_MS = 60_000;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_ACCOUNT_LOCKS = 10_000;
/** The shortest quiet period after which a failure count starts again. */
const MIN_LOCK_QUIET_MS = 60_000;
const SCRYPT_KEY_LENGTH = 64;

/** New hashes use the OWASP 128 MiB scrypt configuration. */
const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 131072, r: 8, p: 1 };
/** Two-part hashes predate stored parameters and always used this cost. */
const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * Scrypt cost parameters. N must be a power of 2. Increasing N multiplies
 * memory usage by 128*N*r bytes and CPU time proportionally.
 * New hashes default to N=131072, r=8, p=1; older stored costs remain verifiable.
 */
export interface ScryptParams {
  /** CPU/memory cost factor, must be a power of 2. Default: 131072. */
  readonly N: number;
  /** Block size. Default: 8. */
  readonly r: number;
  /** Parallelization factor. Default: 1. */
  readonly p: number;
}

/**
 * Per-account login failure state for escalating lockout.
 * Independent of IP-based throttling.
 */
interface AccountLockState {
  failures: number;
  lockedUntil: number;
  /** When the last counted failure happened; with `lockedUntil` it decides when the count starts again. */
  lastFailureAt: number;
}

/** The lock a failure count reaches: 6-9 failures 30 s, 10-19 five minutes, 20 or more 30 minutes. */
function lockDurationMs(failures: number): number {
  if (failures >= 20) return 30 * 60_000;
  if (failures >= 10) return 5 * 60_000;
  if (failures >= 6) return 30_000;
  return 0;
}

/**
 * Result of authenticate(), includes lock state so callers can
 * return Retry-After without leaking whether the username exists.
 *
 * The union is strict: `.user` is ONLY present (and non-undefined) on the
 * `ok:true` branch, so TypeScript catches any caller that forgets to check `.ok`
 * before accessing the user. `.usedBootstrapCredential` is set on the `ok:true`
 * branch so callers can decide whether to retire the bootstrap credential file.
 */
export type AuthenticateResult =
  | { readonly ok: true; readonly user: AuthUser; readonly usedBootstrapCredential: boolean; readonly lockedUntilMs?: undefined; readonly busy?: undefined }
  | {
    readonly ok: false; readonly user?: undefined; readonly usedBootstrapCredential?: undefined; readonly lockedUntilMs?: number;
    /** The sign-in queue was full, so the password was not checked; the caller answers "try again shortly". */
    readonly busy?: true;
    /**
     * The username and password tried are exactly the bootstrap credential
     * file's, and the user store no longer accepts them: the file fell behind
     * (edited by hand, or left from an earlier store). Only someone who read
     * that private file can trigger this, so the caller may say so.
     */
    readonly staleBootstrapCredential?: true;
  };

/**
 * Sign-ins waiting for the password check. The check is memory-hard (about
 * 128 MiB and 0.2 s each), so attempts run one at a time off the event loop and
 * a burst beyond this many is refused at once instead of queueing work.
 */
const MAX_WAITING_SIGN_INS = 8;

interface AuthUserStore {
  readonly version: 1;
  readonly users: AuthUser[];
}

export interface AuthUserRecord {
  readonly username: string;
  readonly roles: readonly string[];
}

export interface AuthSessionRecord {
  readonly id: string;
  readonly username: string;
  readonly expiresAt: number;
}

export interface LocalAuthSnapshot {
  readonly userStorePath: string;
  readonly bootstrapCredentialPath: string;
  readonly persisted: boolean;
  readonly bootstrapCredentialPresent: boolean;
  readonly userCount: number;
  readonly sessionCount: number;
  readonly users: readonly AuthUserRecord[];
  readonly sessions: readonly AuthSessionRecord[];
}

function toBase64(value: Buffer): string {
  return value.toString('base64');
}

/**
 * Hash format: base64(salt):N:r:p:base64(derived)
 * The cost parameters are stored in the hash so old hashes can be verified
 * even after the default params change.
 */
function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS, salt?: Buffer): string {
  const actualSalt = salt ?? randomBytes(16);
  const derived = scryptSync(password, actualSalt, SCRYPT_KEY_LENGTH, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
  return `${toBase64(actualSalt)}:${params.N}:${params.r}:${params.p}:${toBase64(derived)}`;
}

/**
 * Generate a cryptographically random one-time password.
 * Called once on first boot when no users are configured.
 */
function generateInitialPassword(): string {
  return randomBytes(16).toString('hex');
}

type PasswordVerification = { readonly params: ScryptParams; readonly legacy: boolean } | undefined;
type ParsedPasswordHash = { readonly salt: Buffer; readonly expected: Buffer; readonly params: ScryptParams; readonly legacy: boolean };
function deriveSync(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, SCRYPT_KEY_LENGTH, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
}
/** The same derivation on the libuv thread pool, so the event loop keeps serving while it runs. */
const deriveAsync = (password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, SCRYPT_KEY_LENGTH, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
    (error, derived) => { if (error) reject(error); else resolve(derived); });
});

function compareDerived(parsed: ParsedPasswordHash, actual: Buffer): PasswordVerification {
  if (actual.length !== parsed.expected.length) return undefined;
  return timingSafeEqual(actual, parsed.expected) ? { params: parsed.params, legacy: parsed.legacy } : undefined;
}

function verifyPassword(password: string, passwordHash: string): PasswordVerification {
  const parsed = parsePasswordHash(passwordHash);
  if (!parsed) return undefined;
  try { return compareDerived(parsed, deriveSync(password, parsed.salt, parsed.params)); }
  catch { return undefined; }
}

async function verifyPasswordAsync(password: string, passwordHash: string): Promise<PasswordVerification> {
  const parsed = parsePasswordHash(passwordHash);
  if (!parsed) return undefined;
  try { return compareDerived(parsed, await deriveAsync(password, parsed.salt, parsed.params)); }
  catch { return undefined; }
}

async function hashPasswordAsync(password: string, params: ScryptParams): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveAsync(password, salt, params);
  return `${toBase64(salt)}:${params.N}:${params.r}:${params.p}:${toBase64(derived)}`;
}

function parsePasswordHash(passwordHash: string): ParsedPasswordHash | undefined {
  const parts = passwordHash.split(':');
  // Legacy format: salt:hash (2 parts), uses the original fixed cost for backward compatibility.
  // New format: salt:N:r:p:hash (5 parts)
  let saltEncoded: string;
  let hashEncoded: string;
  let params: ScryptParams;

  if (parts.length === 2) {
    // Legacy hash: its historical cost must not follow new defaults.
    [saltEncoded, hashEncoded] = parts as [string, string];
    params = LEGACY_SCRYPT_PARAMS;
  } else if (parts.length === 5) {
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || N < 1 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return undefined;
    saltEncoded = parts[0]!;
    hashEncoded = parts[4]!;
    params = { N, r, p };
  } else {
    return undefined;
  }

  if (!saltEncoded || !hashEncoded) return undefined;
  return { salt: Buffer.from(saltEncoded, 'base64'), expected: Buffer.from(hashEncoded, 'base64'), params, legacy: parts.length === 2 };
}

function readBootstrapUsers(filePath: string, observedRecovery?: () => void, freshAbsence = false): AuthUser[] | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthUserStore>;
    try { validateSettingsUserStore(parsed); } catch { observedRecovery?.(); }
    if (parsed.version !== 1 || !Array.isArray(parsed.users)) { observedRecovery?.(); return null; }
    const users = parsed.users.filter((user): user is AuthUser =>
      Boolean(user)
      && typeof user.username === 'string'
      && typeof user.passwordHash === 'string'
      && (user.roles === undefined || Array.isArray(user.roles))
    );
    if (users.length === 0 || users.length !== parsed.users.length) observedRecovery?.();
    return users.length > 0 ? users : null;
  } catch (error) {
    if (!freshAbsence || (error as NodeJS.ErrnoException).code !== 'ENOENT') observedRecovery?.();
    return null;
  }
}

/**
 * Write secret file content atomically at 0600 (owner read/write only), through
 * the shared exclusive-staging writer: a pre-planted symlink or a concurrent
 * writer at a fixed `<file>.tmp` can neither redirect nor tear the write.
 */
function atomicWriteSecretFile(filePath: string, content: string): void {
  writeFileAtomic(filePath, content, { mode: 0o600, durable: true });
}

function writeBootstrapUsers(filePath: string, users: AuthUser[]): void {
  // auth-user store contains scrypt password hashes, must be 0600.
  const payload: AuthUserStore = { version: 1, users };
  atomicWriteSecretFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeBootstrapCredentialFile(filePath: string, username: string, password: string): void {
  atomicWriteSecretFile(
    filePath,
    [
      'GoodVibes bootstrap auth',
      `username=${username}`,
      `password=${password}`,
      'purpose=Use these credentials only for local daemon/http listener /login routes when those surfaces are enabled.',
      'note=Normal platform host usage does not require these credentials.',
    ].join('\n') + '\n',
  );
}

function sameUser(a: AuthUser | undefined, b: AuthUser | undefined): boolean {
  if (!a || !b) return a === b;
  return a.passwordHash === b.passwordHash && JSON.stringify(a.roles ?? []) === JSON.stringify(b.roles ?? []);
}

/**
 * A user this process did not change takes the other writer's version (including its
 * deletion); one this process changed keeps this process's version. `base` is what the
 * file held when this process last read or wrote it.
 */
function mergeUserStores(base: ReadonlyMap<string, AuthUser>, theirs: ReadonlyMap<string, AuthUser>, ours: ReadonlyMap<string, AuthUser>): Map<string, AuthUser> {
  const merged = new Map<string, AuthUser>();
  for (const username of new Set([...base.keys(), ...theirs.keys(), ...ours.keys()])) {
    const user = sameUser(base.get(username), ours.get(username)) ? theirs.get(username) : ours.get(username);
    if (user) merged.set(username, user);
  }
  return merged;
}

/** Session checks look at the user file at most this often. */
const DISK_CHECK_INTERVAL_MS = 1_000;
/** How long a user-store write waits for another process's write to finish. */
const USER_STORE_LOCK_WAIT_MS = 1_000;

function loadOrBootstrapUsers(filePath: string, credentialPath: string, observedRecovery?: () => void, freshAbsence = false, params = DEFAULT_SCRYPT_PARAMS): AuthUser[] {
  const existing = readBootstrapUsers(filePath, observedRecovery, freshAbsence);
  if (existing) return existing;

  // An unreadable or unparseable store still holds the previous users and hashes;
  // keep those bytes aside so the regenerated admin never silently destroys them.
  if (existsSync(filePath)) {
    const aside = `${filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(filePath, aside);
      logger.warn('User auth store could not be read; it was kept aside and a new admin was generated', { path: filePath, keptAt: aside });
    } catch (error) {
      throw new Error(`The local auth user store ${filePath} could not be read and could not be moved aside (${error instanceof Error ? error.message : String(error)}); `
        + 'refusing to overwrite it. Repair or remove the file, then restart.', { cause: error });
    }
  }

  const initialPassword = generateInitialPassword();
  const username = 'admin';
  const users: AuthUser[] = [
    {
      username,
      passwordHash: hashPassword(initialPassword, params),
      roles: ['admin'],
    },
  ];
  writeBootstrapUsers(filePath, users);
  writeBootstrapCredentialFile(credentialPath, username, initialPassword);
  return users;
}

interface BootstrapCredentialRecord {
  readonly username: string;
  readonly password: string;
}

function readBootstrapCredentialFile(filePath: string): BootstrapCredentialRecord | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    let username: string | undefined;
    let password: string | undefined;
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('username=')) username = line.slice('username='.length);
      else if (line.startsWith('password=')) password = line.slice('password='.length);
    }
    if (!username || !password) return null;
    return { username, password };
  } catch {
    return null;
  }
}

/** Strict observation only: legacy bootstrap/recovery retains its own behavior. */
function inspectSettingsUserStore(filePath: string): boolean {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const parsed = JSON.parse(raw) as Partial<AuthUserStore> | null;
  validateSettingsUserStore(parsed);
  confirmFileDurable(filePath);
  return true;
}

function validateSettingsUserStore(parsed: Partial<AuthUserStore> | null): void {
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users) || parsed.users.length === 0) {
    throw new SettingsAuthorityUnavailableError();
  }
  const names = new Set<string>();
  for (const user of parsed.users) {
    if (!user || typeof user.username !== 'string' || !user.username || names.has(user.username)
      || typeof user.passwordHash !== 'string' || !user.passwordHash
      || (user.roles !== undefined && (!Array.isArray(user.roles) || user.roles.some(role => typeof role !== 'string')))) {
      throw new SettingsAuthorityUnavailableError();
    }
    names.add(user.username);
  }
}

export class UserAuthManager {
  private users = new Map<string, AuthUser>();
  /** The store could not be verified at startup; held until restart. */
  private settingsFaulted = false;
  /** The last user-store write failed, so disk may differ from memory; cleared by the next successful write. */
  private persistFaulted = false;
  private readonly settingsAuthorities = new WeakMap<SettingsSessionAuthority, SettingsSessionAuthorityRecord>();
  private sessions = new Map<string, AuthSession>();
  /** Whether the stale bootstrap credential file was already reported in this process. */
  private staleBootstrapNoted = false;
  /** Failure counters for lockout, keyed by username (in-process checks) or username and client address (sign-ins). */
  private accountLocks = new Map<string, AccountLockState>();
  private sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxAccountLocks: number;
  private readonly userStorePath: string;
  private readonly bootstrapCredentialPath: string;
  private readonly persistUsers: boolean;
  /** The users the file held when this process last read or wrote it, and that file's identity then. */
  private storedUsers = new Map<string, AuthUser>();
  private storedIdentity: string | undefined;
  private lastDiskCheck = 0;
  private readonly scryptParams: ScryptParams;
  /** Injectable clock, defaults to Date.now for production. */
  private readonly nowFn: () => number;
  /**
   * Moves when users, sessions or the two fault holds change, including a user
   * file another process rewrote that this owner took in. A session reaching
   * its expiry time moves it only when the session is removed.
   */
  #revision = 0;
  readonly #revisionSource = revisionSource('local auth', () => this.#revision);
  readonly #revocationListeners = new Set<(principalIds: readonly string[]) => void>();

  constructor(config: UserAuthConfig) {
    if (!config.bootstrapFilePath) throw new Error('UserAuthManager requires an explicit bootstrapFilePath.');
    if (!config.bootstrapCredentialPath) throw new Error('UserAuthManager requires an explicit bootstrapCredentialPath.');
    this.sessionTtlMs = config.sessionTtlMs ?? OPERATOR_SESSION_TTL_MS;
    this.maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxAccountLocks = config.maxAccountLocks ?? DEFAULT_MAX_ACCOUNT_LOCKS;
    this.userStorePath = config.bootstrapFilePath;
    this.bootstrapCredentialPath = config.bootstrapCredentialPath;
    this.persistUsers = config.users === undefined;
    this.scryptParams = config.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
    this.nowFn = config.nowFn ?? (() => Date.now());
    let freshAbsence = false;
    if (this.persistUsers) {
      try { freshAbsence = !inspectSettingsUserStore(this.userStorePath); }
      catch { this.settingsFaulted = true; }
    }
    const seedUsers = config.users ?? loadOrBootstrapUsers(this.userStorePath, this.bootstrapCredentialPath,
      () => { this.settingsFaulted = true; }, freshAbsence, this.scryptParams);

    for (const user of seedUsers) {
      this.users.set(user.username, user);
    }

    // No password is derived at start: a bootstrap file that fell behind the
    // store is explained at the failed sign-in that runs into it.
    if (this.persistUsers) this.rememberStore(this.users.values());
  }

  /** Local accounts and their sessions as a revision source. */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  private rememberStore(users: Iterable<AuthUser>): void {
    this.storedUsers = new Map([...users].map(user => [user.username, user]));
    try { this.storedIdentity = fileObservationIdentity(this.userStorePath); } catch { this.storedIdentity = undefined; }
  }

  /** Sessions of users another writer removed or gave a new password, compared with what this process holds. */
  private foreignlyChangedUsers(next: ReadonlyMap<string, AuthUser>): string[] {
    return [...this.users].filter(([username, user]) => next.get(username)?.passwordHash !== user.passwordHash).map(([username]) => username);
  }

  /**
   * Pick up changes another process (the CLI) made to the user file since this one last
   * looked, so a deleted user or a rotated password takes effect here without a restart.
   */
  private refreshFromDisk(throttled = false): void {
    if (!this.persistUsers) return;
    if (throttled) {
      const now = this.nowFn();
      if (now - this.lastDiskCheck < DISK_CHECK_INTERVAL_MS) return;
      this.lastDiskCheck = now;
    }
    let identity: string;
    try { identity = fileObservationIdentity(this.userStorePath); } catch { return; }
    if (identity === this.storedIdentity) return;
    const onDisk = readBootstrapUsers(this.userStorePath);
    if (!onDisk) return;
    const next = new Map(onDisk.map(user => [user.username, user]));
    for (const username of this.foreignlyChangedUsers(next)) this.revokeSessionsForUser(username);
    this.users = next;
    this.#revision++;
    this.rememberStore(onDisk);
  }

  /** Run `write` holding the user store's writer lock, which the kernel releases if this process dies. */
  private withUserStoreLock<T>(write: () => T): T {
    try {
      return withProcessLockSync(`${this.userStorePath}.writer.sqlite`, write, { waitMs: USER_STORE_LOCK_WAIT_MS });
    } catch (error) {
      if (error instanceof ProcessLockBusyError) {
        throw new Error('The local auth user store is being changed by another process. Nothing was saved; try again.', { cause: error });
      }
      throw error;
    }
  }

  static hashPassword(password: string, params?: ScryptParams): string {
    return hashPassword(password, params ?? DEFAULT_SCRYPT_PARAMS);
  }

  /**
   * Authenticate username/password with per-account lockout, synchronously.
   * For in-process checks; a sign-in that arrives over the network uses
   * {@link authenticateSignIn}, which keeps the event loop free.
   * - Does NOT leak whether a username exists (same generic error path for unknown users).
   * - Records failures with escalating backoff, per username or, when
   *   `clientAddress` is given, per username and address.
   * - Returns lockedUntilMs when the account is temporarily locked.
   * - Returns usedBootstrapCredential=true when the matched credential originated from
   *   the bootstrap credential file, so callers can defer retirement until a non-bootstrap
   *   login succeeds.
   */
  authenticate(username: string, password: string, clientAddress?: string): AuthenticateResult {
    const attempt = this.beginAttempt(username, clientAddress);
    if ('result' in attempt) return attempt.result;
    const settled = this.settleAttempt(attempt, verifyPassword(password, attempt.hashToCheck));
    if ('ok' in settled) return this.explainFailure(settled, username, password);
    const user = settled.upgrade ? this.saveUpgradedHash(username, settled.user, hashPassword(password, settled.upgrade)) : settled.user;
    return this.completeAttempt(attempt, password, user);
  }

  #signInQueue: Promise<unknown> = Promise.resolve();
  #signInsWaiting = 0;

  /**
   * A sign-in from the network: the password check runs on the thread pool,
   * one at a time, and a lock counts per username and client address, so a
   * stranger repeating the owner's username locks out only their own address.
   * A burst beyond {@link MAX_WAITING_SIGN_INS} is answered `busy` without a
   * password check.
   */
  authenticateSignIn(username: string, password: string, clientAddress: string): Promise<AuthenticateResult> {
    if (this.#signInsWaiting >= MAX_WAITING_SIGN_INS) return Promise.resolve({ ok: false, busy: true });
    this.#signInsWaiting++;
    const run = this.#signInQueue.then(async (): Promise<AuthenticateResult> => {
      const attempt = this.beginAttempt(username, clientAddress);
      if ('result' in attempt) return attempt.result;
      const settled = this.settleAttempt(attempt, await verifyPasswordAsync(password, attempt.hashToCheck));
      if ('ok' in settled) return this.explainFailure(settled, username, password);
      let user = settled.user;
      if (settled.upgrade) {
        try { user = this.saveUpgradedHash(username, user, await hashPasswordAsync(password, settled.upgrade)); }
        catch (error) { logger.warn('Password hash upgrade could not be computed; the login continues', { username, error: String(error) }); }
      }
      return this.completeAttempt(attempt, password, user);
    });
    this.#signInQueue = run.then(() => undefined, () => undefined).finally(() => { this.#signInsWaiting--; });
    return run;
  }

  private lockKey(username: string, clientAddress: string | undefined): string {
    return clientAddress === undefined ? username : `${username}\u0000${clientAddress}`;
  }

  private beginAttempt(username: string, clientAddress: string | undefined):
    | { readonly result: AuthenticateResult }
    | { readonly username: string; readonly lockKey: string; readonly now: number; readonly user: AuthUser | undefined; readonly hashToCheck: string } {
    const now = this.nowFn();
    this.refreshFromDisk();
    const lockKey = this.lockKey(username, clientAddress);
    const lockState = this.accountLocks.get(lockKey);

    // Check the lock before touching the user store; avoids a user-existence side-channel.
    // An attempt during a lock is not a failure of this account: it counts
    // toward the address's sign-in limit only, so it cannot extend the lock.
    if (lockState && lockState.lockedUntil > now) {
      return { result: { ok: false, lockedUntilMs: lockState.lockedUntil } };
    }

    const user = this.users.get(username);
    // Unknown accounts still perform the configured scrypt work instead of
    // bypassing password derivation. Legacy hashes retain their stored cost.
    const target = this.scryptParams;
    const hashToCheck = user?.passwordHash ?? `Z29vZHZpYmVzLWR1bW15:${target.N}:${target.r}:${target.p}:${Buffer.alloc(SCRYPT_KEY_LENGTH).toString('base64')}`;
    return { username, lockKey, now, user, hashToCheck };
  }

  /** A failed check records the failure and answers; a passed one says whether the stored hash needs a stronger cost. */
  private settleAttempt(
    attempt: { readonly lockKey: string; readonly now: number; readonly user: AuthUser | undefined },
    verified: PasswordVerification,
  ): AuthenticateResult | { readonly user: AuthUser; readonly upgrade: ScryptParams | null } {
    const { lockKey, now, user } = attempt;
    if (!verified || !user) {
      this._recordLoginFailure(lockKey, now);
      const newLock = this.accountLocks.get(lockKey);
      const lockedUntilMs = newLock && newLock.lockedUntil > now ? newLock.lockedUntil : undefined;
      return lockedUntilMs !== undefined ? { ok: false, lockedUntilMs } : { ok: false };
    }
    const target = this.scryptParams;
    if (!(verified.legacy || verified.params.N < target.N || verified.params.r < target.r || verified.params.p < target.p)) return { user, upgrade: null };
    // Never downgrade a stronger stored dimension during an automatic upgrade.
    return { user, upgrade: { N: Math.max(target.N, verified.params.N), r: Math.max(target.r, verified.params.r), p: Math.max(target.p, verified.params.p) } };
  }

  /** The user with the stronger hash when it was saved, otherwise the user as read. */
  private saveUpgradedHash(username: string, stored: AuthUser, passwordHash: string): AuthUser {
    const updated = { ...stored, passwordHash };
    // The login itself is already verified; a failed upgrade write only keeps the old hash.
    // A password another writer changed while the scrypt check ran is theirs: the upgrade is dropped, never written over it.
    try { if (this.persist(new Map(this.users).set(username, updated), { username, passwordHash: stored.passwordHash })) return updated; }
    catch (error) { logger.warn('Password hash upgrade could not be saved; the login continues', { username, error: String(error) }); }
    return stored;
  }

  /**
   * A sign-in that failed with exactly the username and password the bootstrap
   * credential file holds: the file fell behind the user store (edited by hand,
   * or left from an earlier store). Said here, where the failure is and the
   * password check is already paid for, instead of deriving a password at every
   * start to find out: the result carries it for the sign-in answer, and the
   * log says it once per process. Costs one small file read per failed sign-in.
   */
  private explainFailure(failed: AuthenticateResult, username: string, password: string): AuthenticateResult {
    if (!this.persistUsers || failed.ok || failed.busy) return failed;
    const credential = readBootstrapCredentialFile(this.bootstrapCredentialPath);
    if (!credential || credential.username !== username || credential.password !== password) return failed;
    if (!this.staleBootstrapNoted) {
      this.staleBootstrapNoted = true;
      logger.warn('The bootstrap credential file does not match the user store, so its password does not sign in', {
        credentialPath: this.bootstrapCredentialPath,
        userStorePath: this.userStorePath,
        username,
        hint: 'Edits to the bootstrap file do not change a password. Set one with goodvibes auth rotate-password <username>, or delete both files to generate a new admin.',
      });
    }
    return { ...failed, staleBootstrapCredential: true };
  }

  private completeAttempt(attempt: { readonly username: string; readonly lockKey: string }, password: string, user: AuthUser): AuthenticateResult {
    // Whether this login used the bootstrap credential (the password is already confirmed correct).
    const bootstrapCred = readBootstrapCredentialFile(this.bootstrapCredentialPath);
    const usedBootstrapCredential = bootstrapCred !== null
      && bootstrapCred.username === attempt.username
      && bootstrapCred.password === password;
    this.accountLocks.delete(attempt.lockKey);
    return { ok: true, user, usedBootstrapCredential };
  }

  /**
   * Record a login failure for one lock key (a username, or a username and client
   * address) and apply escalating backoff.
   *
   * Thresholds are anchored ABOVE the per-IP login budget (default 5/min) so
   * the first account lock cannot fire before the IP limiter has already
   * throttled further attempts. This preserves the 401-then-429-by-IP contract
   * for in-budget attempts.
   *
   *   1-5 failures:   no lock (IP budget exhaustion fires at attempt 6+)
   *   6-9 failures:   30-second lock
   *   10-19 failures: 5-minute lock
   *   20+ failures:   30-minute lock
   *
   * Attempts made while locked are not counted here (see beginAttempt). The
   * count starts again once the last failure, or the end of the lock it
   * caused, is a quiet period behind: the lock's own length, and at least a
   * minute. So nobody can keep an account locked by one guess per lock.
   */
  private _recordLoginFailure(lockKey: string, now: number): void {
    const existing = this.accountLocks.get(lockKey);
    if (!existing) {
      // New entry, evict if at cap before inserting.
      this._evictAccountLockIfNeeded(now);
    }
    const state = existing ?? { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    const quietSince = Math.max(state.lastFailureAt, state.lockedUntil);
    if (existing && now - quietSince >= Math.max(lockDurationMs(state.failures), MIN_LOCK_QUIET_MS)) state.failures = 0;
    state.failures++;
    state.lastFailureAt = now;
    const lockMs = lockDurationMs(state.failures);
    state.lockedUntil = lockMs > 0 ? now + lockMs : 0;
    this.accountLocks.set(lockKey, state);
  }

  /**
   * Evict account lock entries when the map is at capacity.
   * Prefers entries with expired locks + no recent failures (stale entries).
   * Falls back to the entry with the oldest/soonest-expired lock.
   * Preserves no-username-enumeration: eviction policy is time-based, not
   * user-existence-based.
   */
  private _evictAccountLockIfNeeded(now: number): void {
    if (this.accountLocks.size < this.maxAccountLocks) return;
    // First sweep: remove all fully stale entries (lock expired AND low failure count).
    for (const [key, state] of this.accountLocks.entries()) {
      if (state.lockedUntil <= now && state.failures < 6) {
        this.accountLocks.delete(key);
        if (this.accountLocks.size < this.maxAccountLocks) return;
      }
    }
    // Second sweep: remove the entry with the smallest lockedUntil (most expired).
    let oldestKey: string | undefined;
    let oldestUntil = Infinity;
    for (const [key, state] of this.accountLocks.entries()) {
      if (state.lockedUntil < oldestUntil) {
        oldestUntil = state.lockedUntil;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.accountLocks.delete(oldestKey);
    }
  }

  /**
   * Expose account lock state for testing.
   * Returns a defensive copy so callers cannot mutate internal state.
   * Use the injected nowFn (via UserAuthManager constructor) to advance time in tests.
   */
  getAccountLockState(username: string, clientAddress?: string): { failures: number; lockedUntil: number } | undefined {
    const state = this.accountLocks.get(this.lockKey(username, clientAddress));
    if (!state) return undefined;
    return { failures: state.failures, lockedUntil: state.lockedUntil };
  }

  getUser(username: string): AuthUserRecord | null {
    const user = this.users.get(username);
    if (!user) return null;
    return {
      username: user.username,
      roles: Object.freeze([...(user.roles ?? [])]),
    };
  }

  createSession(username: string): AuthSession {
    this.pruneExpiredSessions();
    if (this.sessions.size >= this.maxSessions) {
      // Evict the session with the earliest expiry to make room.
      let oldestToken: string | undefined;
      let oldestExpiry = Infinity;
      for (const [token, session] of this.sessions.entries()) {
        if (session.expiresAt < oldestExpiry) {
          oldestExpiry = session.expiresAt;
          oldestToken = token;
        }
      }
      if (oldestToken !== undefined) {
        this.sessions.delete(oldestToken);
      }
    }
    const token = randomBytes(32).toString('hex');
    const session: AuthSession = {
      id: `auth-session-${randomUUID()}`,
      token,
      username,
      expiresAt: this.nowFn() + this.sessionTtlMs,
    };
    this.sessions.set(token, session);
    this.#revision++;
    return session;
  }

  /** A live session, its end moved ahead by this use (at most once a minute; no write, no revision move). */
  validateSession(token: string): AuthSession | null {
    this.refreshFromDisk(true);
    const session = this.sessions.get(token);
    if (!session) return null;
    const now = this.nowFn();
    if (now > session.expiresAt) {
      this.sessions.delete(token);
      this.#revision++;
      return null;
    }
    const extended = now + this.sessionTtlMs;
    if (extended - session.expiresAt >= SESSION_EXTEND_STEP_MS) session.expiresAt = extended;
    return session;
  }

  /** Capture the exact in-memory session and current user, never username alone. */
  captureSettingsAuthority(token: string): SettingsSessionAuthority | null {
    if (this.settingsFaulted || this.persistFaulted) return null;
    const session = this.sessions.get(token);
    if (!session || session.token !== token || !Number.isFinite(session.expiresAt) || this.nowFn() >= session.expiresAt) return null;
    const user = this.users.get(session.username);
    if (!user || user.username !== session.username || (user.roles !== undefined
      && (!Array.isArray(user.roles) || user.roles.some(role => typeof role !== 'string')))) return null;
    const roles = Object.freeze([...(user.roles ?? [])]);
    const handle = Object.freeze({ kind: 'session' as const, roles }) as SettingsSessionAuthority;
    this.settingsAuthorities.set(handle, { token, session, user, username: user.username,
      passwordHash: user.passwordHash, roles, expiresAt: session.expiresAt });
    return handle;
  }

  /** Synchronous final check after every reentrant preparation callback. */
  assertSettingsAuthorityCurrent(authority: SettingsSessionAuthority): void {
    const expected = this.settingsAuthorities.get(authority);
    if (!expected || this.settingsFaulted || this.persistFaulted) throw new SettingsAuthorityUnavailableError();
    const session = this.sessions.get(expected.token);
    const user = this.users.get(expected.username);
    const roles = user?.roles ?? [];
    // The session's end may have moved ahead by use since the capture; it must still be ahead now.
    if (session !== expected.session || user !== expected.user
      || session.token !== expected.token || session.username !== expected.username
      || this.nowFn() >= session.expiresAt
      || user.username !== expected.username || user.passwordHash !== expected.passwordHash
      || roles.length !== expected.roles.length || roles.some((role, index) => role !== expected.roles[index])) {
      throw new SettingsAuthorityUnavailableError();
    }
  }

  revokeSession(tokenOrId: string): boolean {
    if (this.sessions.delete(tokenOrId)) { this.#revision++; return true; }
    for (const [sessionToken, session] of this.sessions) {
      if (session.id === tokenOrId) {
        this.sessions.delete(sessionToken);
        this.#revision++;
        return true;
      }
    }
    return false;
  }

  revokeSessionsForUser(username: string): number {
    let removed = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (session.username === username) {
        this.sessions.delete(token);
        removed++;
      }
    }
    if (removed > 0) {
      this.#revision++;
      for (const listener of [...this.#revocationListeners]) {
        try { listener([username]); }
        catch (error) { logger.warn('Local auth revocation listener failed', { error: String(error) }); }
      }
    }
    return removed;
  }

  /**
   * Told the usernames whose every login session just ended (the user was
   * deleted, its password changed here or in another process, or all its
   * sessions were revoked). One revoked session of a user that keeps others
   * moves the revision only. Returns the unsubscribe.
   */
  onRevoked(listener: (principalIds: readonly string[]) => void): () => void {
    this.#revocationListeners.add(listener);
    return () => { this.#revocationListeners.delete(listener); };
  }

  listUsers(): AuthUserRecord[] {
    return [...this.users.values()]
      .map((user) => ({
        username: user.username,
        roles: Object.freeze([...(user.roles ?? [])]),
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  listSessions(): AuthSessionRecord[] {
    this.pruneExpiredSessions();
    return [...this.sessions.values()]
      .map((session) => ({
        id: session.id,
        username: session.username,
        expiresAt: session.expiresAt,
      }))
      .sort((a, b) => a.username.localeCompare(b.username) || a.expiresAt - b.expiresAt);
  }

  addUser(username: string, password: string, roles: readonly string[] = ['admin']): AuthUserRecord {
    const normalized = username.trim();
    if (!normalized) throw new Error('Username is required.');
    if (this.users.has(normalized)) throw new Error(`User already exists: ${normalized}`);
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
    const user: AuthUser = {
      username: normalized,
      passwordHash: hashPassword(password, this.scryptParams),
      roles: [...new Set(roles.filter(Boolean))],
    };
    this.persist(new Map(this.users).set(normalized, user));
    return { username: user.username, roles: Object.freeze([...(user.roles ?? [])]) };
  }

  deleteUser(username: string): boolean {
    const normalized = username.trim();
    const existing = this.users.get(normalized);
    if (!existing) return false;
    if (this.users.size <= 1) {
      throw new Error('Cannot delete the last local auth user.');
    }
    // No session without the admin role can pass the admin check, so the last admin is protected too.
    const isAdmin = (user: AuthUser): boolean => user.roles?.includes('admin') === true;
    if (isAdmin(existing) && ![...this.users.values()].some(user => user.username !== normalized && isAdmin(user))) {
      throw new Error(`Cannot delete ${normalized}: it is the last local auth user with the admin role. Give another user the admin role first.`);
    }
    const next = new Map(this.users);
    next.delete(normalized);
    this.persist(next);
    this.revokeSessionsForUser(normalized);
    return true;
  }

  /**
   * Set a user's password. When the bootstrap credential file names this user,
   * it is deleted: the generated one-time password is retired the moment the
   * owner sets their own, and the chosen password is never written in clear.
   */
  rotatePassword(username: string, nextPassword: string): void {
    const normalized = username.trim();
    const existing = this.users.get(normalized);
    if (!existing) throw new Error(`Unknown local auth user: ${normalized}`);
    if (!nextPassword || nextPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    this.persist(new Map(this.users).set(normalized, {
      ...existing,
      passwordHash: hashPassword(nextPassword, this.scryptParams),
    }));
    this.revokeSessionsForUser(normalized);
    if (readBootstrapCredentialFile(this.bootstrapCredentialPath)?.username === normalized) {
      // The file now holds a password that no longer signs in; failing to delete it exposes nothing that works.
      try { rmSync(this.bootstrapCredentialPath, { force: true }); }
      catch (error) {
        logger.warn('The bootstrap credential file could not be deleted after the password change; it holds the old password, which no longer signs in', {
          credentialPath: this.bootstrapCredentialPath, error: String(error),
        });
      }
    }
  }

  /** A copy of the accounts (with their password hashes) and sessions, for putting them back with {@link restoreState}. */
  snapshotState(): UserAuthState {
    return {
      users: [...this.users.values()].map(user => ({ ...user, ...(user.roles ? { roles: [...user.roles] } : {}) })),
      sessions: [...this.sessions.values()].map(session => ({ ...session })),
      faults: { persist: this.persistFaulted, settings: this.settingsFaulted },
    };
  }

  /**
   * Replace the live accounts and sessions with a snapshot. Memory only: the caller owns the user
   * file and has already put it back, so this does not write it.
   */
  restoreState(state: UserAuthState): void {
    this.users = new Map(state.users.map(user => [user.username, { ...user, ...(user.roles ? { roles: [...user.roles] } : {}) }]));
    this.sessions = new Map(state.sessions.map(session => [session.token, { ...session }]));
    // A write that failed after the snapshot left disk and memory disagreeing; with the file put back they agree again.
    if (state.faults) {
      this.persistFaulted = state.faults.persist;
      this.settingsFaulted = state.faults.settings;
    }
    if (this.persistUsers) this.rememberStore(this.users.values());
    this.#revision++;
  }

  inspect(): LocalAuthSnapshot {
    this.pruneExpiredSessions();
    return Object.freeze({
      userStorePath: this.userStorePath,
      bootstrapCredentialPath: this.bootstrapCredentialPath,
      persisted: this.persistUsers,
      bootstrapCredentialPresent: existsSync(this.bootstrapCredentialPath),
      userCount: this.users.size,
      sessionCount: this.sessions.size,
      users: Object.freeze(this.listUsers()),
      sessions: Object.freeze(this.listSessions()),
    });
  }

  clearBootstrapCredentialFile(): boolean {
    if (!existsSync(this.bootstrapCredentialPath)) return false;
    rmSync(this.bootstrapCredentialPath, { force: true });
    return true;
  }

  getBootstrapCredentialPath(): string {
    return this.bootstrapCredentialPath;
  }

  private pruneExpiredSessions(): void {
    const now = this.nowFn();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
        this.#revision++;
      }
    }
  }

  /**
   * Write the candidate users, then make them live; a failed write changes nothing in memory.
   * The writer lock and the merge keep another process's change (the CLI adding or deleting
   * a user while this one upgrades a hash) from being written over; they cost one lock and,
   * only when the file changed, one read, on a user write (rare), never on a sign-in check.
   */
  private persist(next: Map<string, AuthUser>, onlyIfHash?: { readonly username: string; readonly passwordHash: string }): boolean {
    if (this.persistUsers) {
      let written: Map<string, AuthUser> | null;
      try {
        written = this.withUserStoreLock(() => {
          // Another process may have changed the file since this one read it: its changes to
          // users this call does not touch are kept rather than written over.
          let identity: string | undefined;
          try { identity = fileObservationIdentity(this.userStorePath); } catch { identity = undefined; }
          const onDisk = identity !== undefined && identity !== this.storedIdentity ? readBootstrapUsers(this.userStorePath) : null;
          if (onlyIfHash && onDisk && onDisk.find(user => user.username === onlyIfHash.username)?.passwordHash !== onlyIfHash.passwordHash) return null;
          const merged = onDisk ? mergeUserStores(this.storedUsers, new Map(onDisk.map(user => [user.username, user])), next) : next;
          writeBootstrapUsers(this.userStorePath, [...merged.values()]);
          this.rememberStore(merged.values());
          // What the other writer changed ends this process's sessions for those users; what this call changed is the caller's to revoke.
          for (const username of this.foreignlyChangedUsers(merged)) if (!sameUser(merged.get(username), next.get(username))) this.revokeSessionsForUser(username);
          return merged;
        });
      } catch (error) { this.persistFaulted = true; this.#revision++; throw error; }
      if (written === null) return false;
      next = written;
      this.persistFaulted = false;
    }
    this.users = next;
    this.#revision++;
    return true;
  }
}
