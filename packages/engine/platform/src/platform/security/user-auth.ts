import type { AuthorityRecordFile } from '../cluster/authority-record-file.js';
import { noteRefusedFromGroup } from '../cluster/refused-from-group.js';
import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { confirmFileDurable, writeFileAtomic } from '../utils/atomic-json-store.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { ProcessLockBusyError, withProcessLockSync } from '../utils/process-lock.js';
import { SettingsAuthorityUnavailableError } from './settings-authority.js';
import { reservedPrincipalForm } from '../pairing/principal-ids.js';
import { noteListChanged } from '../runtime/list-changes.js';

export interface AuthUser {
  username: string;
  passwordHash: string;
  roles?: string[] | undefined;
  /**
   * The operator scopes this user holds when it was given a narrower list than
   * its role's default set (`*` is the whole set). Absent: the role's set.
   */
  scopes?: string[] | undefined;
  /**
   * The password is the one generated at first start and written to the
   * bootstrap credential file. It signs in only while that file still holds
   * it: deleting or clearing the file withdraws it. Setting a password drops
   * this mark.
   */
  bootstrap?: true | undefined;
  /**
   * This account is the owner: written once, on the account made at first start, and carried forward at an upgrade
   * from the account that is the owner today (the first in the store, the one rule before this mark). Never inferred
   * from the store's order again; the owner is never deleted or narrowed, and no other user is made the owner.
   */
  owner?: true | undefined;
}

export interface AuthSession {
  readonly id: string;
  token: string;
  username: string;
  expiresAt: number;
  /** Signed in with the bootstrap credential: the session ends when that file no longer names its user. */
  viaBootstrapCredential?: true | undefined;
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
  /**
   * The authority record (cluster/authority-record-file.ts). A user added,
   * changed or deleted here is written to it, and a user the record holds
   * replaces the local copy of that name: a user added on one machine of a
   * group signs in on every machine, and a password changed or a user deleted
   * on any machine ends that user's sessions on all of them. Users the record
   * has never named stay this machine's own.
   */
  authority?: AuthorityRecordFile | undefined;
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

/**
 * Failed network sign-ins for one username from every source. The per-source
 * lock never stops a guesser who changes source; past many failures in an hour
 * this slows the SOURCES that failed for the username, never the username for
 * everyone: a source with no failure of its own (the owner signing in from
 * another address) is never held by what other sources did.
 */
interface UsernameFailureWindow {
  failures: number;
  windowStart: number;
  slowedUntil: number;
  /** The sources that failed for this username in the window (bounded: a source past the bound is held by its own lock only). */
  readonly sources: Set<string>;
}

/** Sources one username's window remembers. */
const USERNAME_FAILURE_SOURCES = 4_096;

const USERNAME_FAILURE_WINDOW_MS = 60 * 60_000;
const USERNAME_FAILURE_THRESHOLD = 50;
const USERNAME_SLOWDOWN_MS = 30_000;

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
    /**
     * The password matched a generated bootstrap password whose credential
     * file was deleted or cleared, which withdraws it. Only someone who knew
     * that password can trigger this, so the caller may say so.
     */
    readonly withdrawnBootstrapCredential?: true;
    /**
     * The password was right for the account as it was when the check began,
     * but the password was changed or the account deleted while it ran: the
     * newer password decides, so this sign-in is refused. Only someone who
     * knew the old password can trigger this.
     */
    readonly passwordChangedDuringSignIn?: true;
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
  /** The scope list the user stores, when narrower than its role's default set. */
  readonly scopes?: readonly string[] | undefined;
}

/** The public view of a stored user: never the password hash. */
function userRecord(user: AuthUser): AuthUserRecord {
  return {
    username: user.username,
    roles: Object.freeze([...(user.roles ?? [])]),
    ...(user.scopes !== undefined ? { scopes: Object.freeze([...user.scopes]) } : {}),
  };
}

function normalizeScopeList(scopes: readonly string[]): string[] {
  const list = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (list.length === 0) throw new Error('A scope list names at least one operator scope; to give the role\'s full set, clear the list instead.');
  return list;
}

function isScopeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((scope) => typeof scope === 'string' && scope.length > 0);
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

type PasswordVerification = { readonly params: ScryptParams } | undefined;
type ParsedPasswordHash = { readonly salt: Buffer; readonly expected: Buffer; readonly params: ScryptParams };
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
  return timingSafeEqual(actual, parsed.expected) ? { params: parsed.params } : undefined;
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
  // salt:N:r:p:hash
  const parts = passwordHash.split(':');
  if (parts.length !== 5) return undefined;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || N < 1 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return undefined;
  const saltEncoded = parts[0]!;
  const hashEncoded = parts[4]!;
  if (!saltEncoded || !hashEncoded) return undefined;
  return { salt: Buffer.from(saltEncoded, 'base64'), expected: Buffer.from(hashEncoded, 'base64'), params: { N, r, p } };
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
      && (user.scopes === undefined || isScopeList(user.scopes))
      && (user.owner === undefined || user.owner === true)
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
  return a.passwordHash === b.passwordHash && JSON.stringify(a.roles ?? []) === JSON.stringify(b.roles ?? [])
    && JSON.stringify(a.scopes ?? null) === JSON.stringify(b.scopes ?? null) && (a.owner === true) === (b.owner === true);
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
      bootstrap: true,
      // The account made at first start is the owner, recorded (ownerUsername).
      owner: true,
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
      || (user.roles !== undefined && (!Array.isArray(user.roles) || user.roles.some(role => typeof role !== 'string')))
      || (user.scopes !== undefined && !isScopeList(user.scopes))) {
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
  /** Network sign-in failures per username across all addresses (see UsernameFailureWindow). */
  private usernameFailures = new Map<string, UsernameFailureWindow>();
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
  readonly #authority: AuthorityRecordFile | undefined;
  readonly #publishing = new Set<Promise<void>>();

  /** Resolves once every user change has been written to the authority record (a command line exits after it). */
  async settled(): Promise<void> {
    while (this.#publishing.size > 0) await Promise.allSettled([...this.#publishing]);
  }

  constructor(config: UserAuthConfig) {
    this.#authority = config.authority;
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
    this.#recordOwnerOnce();
    this.users = this.#overlay(this.users);
    this.#authority?.onChange(() => this.#applyRecord());
  }

  /**
   * The users in force: this machine's file, with every user the authority
   * record names taken from the record (its live incarnation, or removed when
   * every incarnation was deleted).
   */
  #overlay(local: Map<string, AuthUser>): Map<string, AuthUser> {
    const view = this.#authority?.view();
    if (!view) return local;
    const next = new Map(local);
    const named = new Set(view.list('user').map((entry) => entry.public.username));
    // Owner decision D2: a name held by separate accounts made on different
    // machines is never overwritten here; this machine keeps its own account
    // (authority.status and cluster status report the difference).
    const conflicted = new Set(view.userConflicts().map((conflict) => conflict.username.toLowerCase()));
    for (const username of named) {
      if (conflicted.has(username.toLowerCase()) && local.has(username)) continue;
      const current = next.get(username);
      // The owner of this machine is never removed or narrowed from elsewhere: his account here stays his, and it
      // takes from the record only a new password (the mark is this machine's fact, never the record's).
      const owner = current?.owner === true;
      // His password stays in step across his machines only as his own recorded act (#ownerInStep, gate-review-6 G2):
      // nothing of his account here is taken from an entry of his name.
      if (owner) continue;
      const live = view.user(username);
      if (!live) { next.delete(username); continue; }
      const hash = live.private?.passwordHash;
      if (!hash) continue;
      const roles = owner ? [...(current?.roles ?? [])] : [...live.public.roles];
      const scopes = owner ? current?.scopes : live.public.scopes === null ? undefined : [...live.public.scopes];
      if (current && current.passwordHash === hash && JSON.stringify(current.roles ?? []) === JSON.stringify(roles)
        && JSON.stringify(current.scopes) === JSON.stringify(scopes)) continue;
      next.set(username, { username, passwordHash: hash, roles, ...(scopes !== undefined ? { scopes } : {}), ...(owner ? { owner: true as const } : {}) });
    }
    return this.#ownerInStep(view, next);
  }

  /**
   * The owner is the same person on each of his machines, so his password stays in step across the group: the latest
   * password the owner himself set on any of them (a record version that records his own act there, `passwordByOwner`,
   * the highest revision) is his password here too, whatever his account is named or numbered on each machine (each
   * makes its own at its first start). Nothing else changes his password from the group: a version of his account that
   * does not record his act is refused, logged and shown in the Machine group tab (gate-review-6 G2). The owner mark
   * itself is never taken from the record.
   */
  #ownerInStep(view: NonNullable<ReturnType<AuthorityRecordFile['view']>>, users: Map<string, AuthUser>): Map<string, AuthUser> {
    const owner = [...users.values()].find((user) => user.owner === true);
    if (!owner) return users;
    const self = this.#authority?.nodeId;
    // A machine writes only its own entry for its owner (`owner-<its record id>`), and only on his act there: a version
    // of it written by any other machine, or one that does not record his act, is refused.
    let latest: { readonly rev: number; readonly at: number; readonly origin: string; readonly hash: string } | undefined;
    let ownValid = false;
    let ownBroken = false;
    for (const entry of view.list('user')) {
      if (view.isRevoked(`user:${entry.id}`)) continue;
      const hash = entry.private?.passwordHash;
      if (!hash) continue;
      const ownersEntry = entry.id.startsWith('owner-');
      const writtenByItsMachine = ownersEntry && entry.id === `owner-${entry.origin}`;
      if (ownersEntry && writtenByItsMachine && entry.private?.passwordByOwner === true) {
        if (entry.origin === self) ownValid = true;
        const later = !latest || entry.rev > latest.rev || (entry.rev === latest.rev && (entry.at > latest.at || (entry.at === latest.at && entry.origin > latest.origin)));
        if (later) latest = { rev: entry.rev, at: entry.at, origin: entry.origin, hash };
        continue;
      }
      if (entry.id === `owner-${self}`) ownBroken = true;
      if ((ownersEntry || entry.public.username === owner.username) && entry.origin !== self && hash !== owner.passwordHash) {
        const what = `a new password for your account ${owner.username}`;
        if (noteRefusedFromGroup(`user:${entry.id}@${entry.rev}`, { what, origin: entry.origin, at: this.nowFn() })) {
          logger.warn('A new password for the owner\'s account arrived from another machine of the group without his own act there; refused, his password here is unchanged', { username: owner.username, from: entry.origin });
        }
      }
    }
    // This machine's own entry was written over from elsewhere: it is written again from his account here (a later
    // revision than the one that replaced it), and nothing from the group changes his password until it is.
    // None yet (an account kept from before this record, at this machine's own upgrade, or before its first sign-in
    // published one): his account here is recorded once, as it is on this machine.
    if (ownBroken || !ownValid) {
      // Never the first-run generated password: it is no act of his (his first sign-in sets his own, and publishes it).
      if (!this.#ownerRepublishing && this.#authority !== undefined && owner.bootstrap === undefined) {
        this.#ownerRepublishing = true;
        queueMicrotask(() => { this.#ownerRepublishing = false; this.#publish(owner.username, 'upsert', false); });
      }
      return users;
    }
    if (!latest || latest.origin === self || latest.hash === owner.passwordHash) return users;
    return new Map(users).set(owner.username, { ...owner, passwordHash: latest.hash });
  }

  #ownerRepublishing = false;

  /**
   * The owner, recorded once (`AuthUser.owner`). A store made before the mark existed has none: the account that is the
   * owner today (the first the store holds, the rule until now) is marked, once, and written, so from then on no
   * reordering, renaming or deleting of other users makes anyone else the owner.
   */
  #recordOwnerOnce(): void {
    const users = [...this.users.values()];
    if (users.some((user) => user.owner === true)) return;
    const first = users[0];
    if (!first) return;
    const marked: AuthUser = { ...first, owner: true };
    try {
      this.persist(new Map(this.users).set(first.username, marked));
      logger.info('The owner account is now recorded in the user store', { username: first.username });
    } catch (error) {
      // Kept in memory for this run; written at the next user change.
      this.users = new Map(this.users).set(first.username, marked);
      logger.warn('The owner account could not be recorded in the user store; it holds for this run', { username: first.username, error: String(error) });
    }
  }

  /** The record changed (here, in another process, or on another machine): take it in, ending sessions it made stale. */
  #applyRecord(): void {
    const next = this.#overlay(this.users);
    const changed = [...new Set([...this.users.keys(), ...next.keys()])]
      .filter((username) => !sameUser(this.users.get(username), next.get(username)));
    if (changed.length === 0) return;
    const ended = changed.filter((username) => this.users.get(username)?.passwordHash !== next.get(username)?.passwordHash);
    const previous = this.users;
    this.users = next;
    this.#revision++;
    for (const username of ended) this.revokeSessionsForUser(username);
    this.#noticeAdminWithdrawn(previous, next);
  }

  readonly #adminWithdrawnListeners = new Set<(username: string) => void>();

  /**
   * Be told when a user stops holding full admin authority: deleted, the admin
   * role gone, or a scope list without `*` (a change made here, or on another
   * machine of the group). What only an admin receives (web pushes of approvals
   * and owner questions) is withdrawn on it. Returns the unsubscribe.
   */
  onAdminWithdrawn(listener: (username: string) => void): () => void {
    this.#adminWithdrawnListeners.add(listener);
    return () => { this.#adminWithdrawnListeners.delete(listener); };
  }

  #noticeAdminWithdrawn(before: ReadonlyMap<string, AuthUser>, after: ReadonlyMap<string, AuthUser>): void {
    const holdsAdmin = (user: AuthUser | undefined): boolean =>
      user?.roles?.includes('admin') === true && (user.scopes === undefined || user.scopes.includes('*'));
    for (const [username, user] of before) {
      if (!holdsAdmin(user) || holdsAdmin(after.get(username))) continue;
      for (const listener of [...this.#adminWithdrawnListeners]) {
        try { listener(username); } catch (error) {
          logger.warn('A listener for a user that lost admin authority failed', { username, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  /** Write a user change to the authority record; logged on failure, the change stands here. */
  #publish(username: string, change: 'upsert' | 'delete', narrows: boolean): void {
    const authority = this.#authority;
    if (!authority) return;
    const user = this.users.get(username);
    // The owner's account: each machine keeps one entry of its own for him (`owner-<this machine's record id>`), which
    // carries his own password changes made here to his other machines (#ownerInStep); never conflicts with them.
    if (user?.owner === true && change === 'upsert') {
      // The first-run generated password is never his act: nothing goes to the group until he sets his own.
      if (user.bootstrap === true) return;
      const id = `owner-${authority.nodeId}`;
      const work = authority.write((view) => {
        const live = view.list('user').find((entry) => entry.id === id && !view.isRevoked(`user:${id}`));
        const privatePart = { passwordHash: user.passwordHash, passwordByOwner: true as const };
        if (live) {
          return { kind: 'update', key: `user:${id}`, value: null, narrowsOrWidens: false,
            patch: { username, roles: [...(user.roles ?? [])], scopes: null }, privatePart };
        }
        return { kind: 'issue', value: null, entries: [{ kind: 'user', id, audience: { nodeId: authority.nodeId },
          public: { username, roles: [...(user.roles ?? [])], scopes: null, epoch: 1, createdAt: this.nowFn() }, private: privatePart }] };
      }).then(() => undefined, (error: unknown) => logger.warn('A change of the owner\'s password could not be written to the authority record; it holds on this machine only until it is', { error: String(error) }));
      this.#publishing.add(work);
      void work.finally(() => this.#publishing.delete(work));
      return;
    }
    const work = authority.write((view) => {
      // A name held by separate accounts on different machines: a change here
      // must not land on another machine's account. It stays on this machine.
      if (view.userConflicts().some((conflict) => conflict.username.toLowerCase() === username.toLowerCase())) {
        logger.warn('This user exists as separate accounts made on different machines of the group; the change stays on this machine', { username });
        return { kind: 'none', value: null };
      }
      const live = view.user(username);
      if (change === 'delete') {
        return live ? { kind: 'revoke', key: `user:${live.id}`, by: 'owner', reason: 'user deleted', value: null } : { kind: 'none', value: null };
      }
      if (!user) return { kind: 'none', value: null };
      const scopes = user.scopes === undefined ? null : [...user.scopes];
      // The owner's own account changes here only by his own act on this machine: his first sign-in setting his
      // password, his sign-in (a stronger hash of the same password), or a rotation the owner's rule ran on his press or
      // his yes (local_auth.users.password.rotate is the owner's own act; deleting or narrowing him is refused). That is
      // recorded with the password, so his other machines take it as his (#overlay); no other version is taken there.
      const privatePart = { passwordHash: user.passwordHash, ...(user.owner === true ? { passwordByOwner: true as const } : {}) };
      if (live) {
        return { kind: 'update', key: `user:${live.id}`, value: null, narrowsOrWidens: narrows,
          patch: { roles: [...(user.roles ?? [])], scopes, epoch: live.public.epoch + (narrows ? 1 : 0) },
          privatePart };
      }
      return { kind: 'issue', value: null, entries: [{ kind: 'user', id: `u-${randomUUID()}`,
        public: { username, roles: [...(user.roles ?? [])], scopes, epoch: 1, createdAt: this.nowFn() },
        private: privatePart }] };
    }).then(() => undefined, (error: unknown) => logger.warn('A user change could not be written to the authority record; it holds on this machine only until it is', { username, error: String(error) }));
    this.#publishing.add(work);
    void work.finally(() => this.#publishing.delete(work));
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
    const next = this.#overlay(new Map(onDisk.map(user => [user.username, user])));
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
   * one at a time, and a lock counts per username and source (`clientAddress`:
   * the caller's sign-in source, every loopback address being one), so a
   * stranger repeating the owner's username locks out only their own source.
   * Past 50 failures for a username in an hour, each source that failed for it
   * waits 30 seconds after the last failure, so changing source does not buy
   * unlimited guesses; a source that did not fail is never held. A burst beyond
   * {@link MAX_WAITING_SIGN_INS} is answered `busy` without a password check.
   */
  authenticateSignIn(username: string, password: string, clientAddress: string): Promise<AuthenticateResult> {
    if (this.#signInsWaiting >= MAX_WAITING_SIGN_INS) return Promise.resolve({ ok: false, busy: true });
    this.#signInsWaiting++;
    const run = this.#signInQueue.then(async (): Promise<AuthenticateResult> => {
      const attempt = this.beginAttempt(username, clientAddress);
      if ('result' in attempt) return attempt.result;
      const verified = await verifyPasswordAsync(password, attempt.hashToCheck);
      // The password was checked against the hash read before the wait. A
      // password changed (here, by the CLI, or on another machine of the group)
      // or a user deleted meanwhile is the newer fact: the hash is the user's
      // password revision, and a moved one refuses this sign-in.
      if (attempt.user && verified && this.#passwordMoved(username, attempt.user.passwordHash)) {
        return { ok: false, passwordChangedDuringSignIn: true };
      }
      const settled = this.settleAttempt(attempt, verified);
      if ('ok' in settled) return this.explainFailure(settled, username, password);
      let user = settled.user;
      if (settled.upgrade) {
        try { user = this.saveUpgradedHash(username, user, await hashPasswordAsync(password, settled.upgrade)); }
        catch (error) { logger.warn('Password hash upgrade could not be computed; the login continues', { username, error: String(error) }); }
        // The stronger hash took a second wait: a password changed or a user deleted meanwhile refuses this sign-in, as above.
        if (user === settled.user && this.#passwordMoved(username, settled.user.passwordHash)) {
          return { ok: false, passwordChangedDuringSignIn: true };
        }
      }
      return this.completeAttempt(attempt, password, user);
    });
    this.#signInQueue = run.then(() => undefined, () => undefined).finally(() => { this.#signInsWaiting--; });
    return run;
  }

  /** Whether `username`'s password hash is no longer `heldHash`, after taking in another writer's change. One stat. */
  #passwordMoved(username: string, heldHash: string): boolean {
    this.refreshFromDisk();
    return this.users.get(username)?.passwordHash !== heldHash;
  }

  private lockKey(username: string, clientAddress: string | undefined): string {
    return clientAddress === undefined ? username : `${username}\u0000${clientAddress}`;
  }

  private beginAttempt(username: string, clientAddress: string | undefined):
    | { readonly result: AuthenticateResult }
    | { readonly username: string; readonly lockKey: string; readonly network: boolean; readonly source: string | undefined; readonly now: number; readonly user: AuthUser | undefined; readonly hashToCheck: string } {
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
    const network = clientAddress !== undefined;
    const slowed = network ? this.usernameFailures.get(username) : undefined;
    // Only a source that itself failed for this username is slowed: never the username for everyone.
    if (slowed && slowed.slowedUntil > now && slowed.sources.has(clientAddress!)) {
      return { result: { ok: false, lockedUntilMs: slowed.slowedUntil } };
    }

    const user = this.users.get(username);
    // Unknown accounts still perform the configured scrypt work instead of
    // bypassing password derivation.
    const target = this.scryptParams;
    const hashToCheck = user?.passwordHash ?? `Z29vZHZpYmVzLWR1bW15:${target.N}:${target.r}:${target.p}:${Buffer.alloc(SCRYPT_KEY_LENGTH).toString('base64')}`;
    return { username, lockKey, network, source: clientAddress, now, user, hashToCheck };
  }

  /** A failed check records the failure and answers; a passed one says whether the stored hash needs a stronger cost. */
  private settleAttempt(
    attempt: { readonly username: string; readonly lockKey: string; readonly network: boolean; readonly source: string | undefined; readonly now: number; readonly user: AuthUser | undefined },
    verified: PasswordVerification,
  ): AuthenticateResult | { readonly user: AuthUser; readonly upgrade: ScryptParams | null } {
    const { lockKey, now, user } = attempt;
    if (!verified || !user) {
      this._recordLoginFailure(lockKey, now);
      const newLock = this.accountLocks.get(lockKey);
      const slowedUntil = attempt.network ? this.recordUsernameFailure(attempt.username, now, attempt.source) : 0;
      const lockedUntilMs = Math.max(newLock && newLock.lockedUntil > now ? newLock.lockedUntil : 0, slowedUntil > now ? slowedUntil : 0);
      return lockedUntilMs > 0 ? { ok: false, lockedUntilMs } : { ok: false };
    }
    const target = this.scryptParams;
    if (!(verified.params.N < target.N || verified.params.r < target.r || verified.params.p < target.p)) return { user, upgrade: null };
    // Never downgrade a stronger stored dimension during an automatic upgrade.
    return { user, upgrade: { N: Math.max(target.N, verified.params.N), r: Math.max(target.r, verified.params.r), p: Math.max(target.p, verified.params.p) } };
  }

  /**
   * The user with the stronger hash when it was saved, otherwise the user as
   * read. The hash goes onto the record as it is now, so roles and scopes
   * changed while the hash was computed are kept.
   */
  private saveUpgradedHash(username: string, stored: AuthUser, passwordHash: string): AuthUser {
    const current = this.users.get(username);
    if (current === undefined) return stored;
    const updated = { ...current, passwordHash };
    // The login itself is already verified; a failed upgrade write only keeps the old hash.
    // A password another writer changed while the scrypt check ran is theirs: the upgrade is dropped, never written over it.
    try {
      if (this.persist(new Map(this.users).set(username, updated), { username, passwordHash: stored.passwordHash })) {
        // The same password under a stronger hash: no session ends anywhere.
        if (this.#authority?.view()?.user(username)) this.#publish(username, 'upsert', false);
        return updated;
      }
    }
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

  private completeAttempt(
    attempt: { readonly username: string; readonly lockKey: string; readonly network: boolean; readonly source: string | undefined; readonly now: number },
    password: string,
    user: AuthUser,
  ): AuthenticateResult {
    // Whether this login used the bootstrap credential (the password is already confirmed correct).
    const bootstrapCred = readBootstrapCredentialFile(this.bootstrapCredentialPath);
    const usedBootstrapCredential = bootstrapCred !== null
      && bootstrapCred.username === attempt.username
      && bootstrapCred.password === password;
    // A generated password lives only as long as the file that holds it.
    if (user.bootstrap === true && !usedBootstrapCredential) {
      this._recordLoginFailure(attempt.lockKey, attempt.now);
      if (attempt.network) this.recordUsernameFailure(attempt.username, attempt.now, attempt.source);
      return { ok: false, withdrawnBootstrapCredential: true };
    }
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
   * Count one failed network sign-in for the username from `source`; answers until when THAT source's sign-ins for it
   * wait (0 when they do not). Another source is never held by it.
   */
  private recordUsernameFailure(username: string, now: number, source: string | undefined): number {
    let window = this.usernameFailures.get(username);
    if (!window || now - window.windowStart >= USERNAME_FAILURE_WINDOW_MS) {
      if (!window && this.usernameFailures.size >= this.maxAccountLocks) {
        // The oldest window goes first; usernames nobody signs in with fill the map, not the owner's.
        const oldest = this.usernameFailures.keys().next();
        if (!oldest.done) this.usernameFailures.delete(oldest.value);
      }
      this.usernameFailures.delete(username);
      window = { failures: 0, windowStart: now, slowedUntil: 0, sources: new Set<string>() };
      this.usernameFailures.set(username, window);
    }
    window.failures++;
    if (source !== undefined && (window.sources.has(source) || window.sources.size < USERNAME_FAILURE_SOURCES)) window.sources.add(source);
    if (window.failures >= USERNAME_FAILURE_THRESHOLD) window.slowedUntil = now + USERNAME_SLOWDOWN_MS;
    return source !== undefined && window.sources.has(source) ? window.slowedUntil : 0;
  }

  /** Every lock and failure count of `username`, from every source: its password changed (see rotatePassword). */
  #forgetSignInFailures(username: string): void {
    this.usernameFailures.delete(username);
    for (const key of [...this.accountLocks.keys()]) {
      if (key === username || key.startsWith(`${username}\u0000`)) this.accountLocks.delete(key);
    }
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
    return user ? userRecord(user) : null;
  }

  /**
   * `viaBootstrapCredential`: the sign-in used the bootstrap credential, so the
   * session ends once that file no longer names the user.
   */
  createSession(username: string, options: { readonly viaBootstrapCredential?: boolean | undefined } = {}): AuthSession {
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
      ...(options.viaBootstrapCredential === true ? { viaBootstrapCredential: true as const } : {}),
    };
    this.sessions.set(token, session);
    this.#revision++;
    noteListChanged({ list: 'safety', change: 'created' });
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
    if (session.viaBootstrapCredential === true && this.bootstrapCredentialUsername(now) !== session.username) {
      // The bootstrap file was deleted or cleared: what it let in ends with it.
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
    if (this.sessions.delete(tokenOrId)) { this.#revision++; noteListChanged({ list: 'safety', change: 'deleted' }); return true; }
    for (const [sessionToken, session] of this.sessions) {
      if (session.id === tokenOrId) {
        this.sessions.delete(sessionToken);
        this.#revision++;
        noteListChanged({ list: 'safety', change: 'deleted' });
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
      noteListChanged({ list: 'safety', change: 'deleted' });
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

  /**
   * The owner among the users: the one account the store records as the owner (`AuthUser.owner`, written on the
   * account made at first start, or carried forward at an upgrade), never the first in the store's order. Null when
   * no account, or more than one, carries the mark (a store edited by hand): then nobody signs in as the owner. Read
   * from memory; no I/O.
   */
  ownerUsername(): string | null {
    let found: string | null = null;
    for (const user of this.users.values()) {
      if (user.owner !== true) continue;
      if (found !== null) return null;
      found = user.username;
    }
    return found;
  }

  listUsers(): AuthUserRecord[] {
    return [...this.users.values()]
      .map(userRecord)
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

  /**
   * `scopes`: the operator scopes the user holds, narrower than its role's
   * default set; absent, the role's set applies.
   */
  addUser(username: string, password: string, roles: readonly string[] = ['admin'], scopes?: readonly string[]): AuthUserRecord {
    const normalized = username.trim();
    if (!normalized) throw new Error('Username is required.');
    const reserved = reservedPrincipalForm(normalized);
    if (reserved !== undefined) {
      throw new Error(`Username ${normalized} has the reserved form ${reserved}, which another kind of credential signs in as; choose another name.`);
    }
    if (this.users.has(normalized)) throw new Error(`User already exists: ${normalized}`);
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
    const user: AuthUser = {
      username: normalized,
      passwordHash: hashPassword(password, this.scryptParams),
      roles: [...new Set(roles.filter(Boolean))],
      ...(scopes !== undefined ? { scopes: normalizeScopeList(scopes) } : {}),
    };
    this.persist(new Map(this.users).set(normalized, user));
    this.#publish(normalized, 'upsert', true);
    noteListChanged({ list: 'safety', change: 'created', id: normalized });
    return userRecord(user);
  }

  /**
   * Give a user a narrower scope list, or (`null`) return it to its role's
   * default set. Takes effect on the user's next request: the grant is read
   * from the user record when a credential is authenticated.
   */
  setUserScopes(username: string, scopes: readonly string[] | null): AuthUserRecord {
    const normalized = username.trim();
    const existing = this.users.get(normalized);
    if (!existing) throw new Error(`Unknown local auth user: ${normalized}`);
    if (existing.owner === true && scopes !== null && !scopes.includes('*')) {
      throw new Error(`Cannot narrow ${normalized}: it is the owner's account, and the owner holds every scope. Nothing was changed.`);
    }
    const { scopes: _previous, ...rest } = existing;
    const next: AuthUser = scopes === null ? rest : { ...rest, scopes: normalizeScopeList(scopes) };
    const previous = this.users;
    this.persist(new Map(this.users).set(normalized, next));
    this.#publish(normalized, 'upsert', true);
    this.#noticeAdminWithdrawn(previous, this.users);
    noteListChanged({ list: 'safety', change: 'changed', id: normalized });
    return userRecord(next);
  }

  deleteUser(username: string): boolean {
    const normalized = username.trim();
    const existing = this.users.get(normalized);
    if (!existing) return false;
    if (this.users.size <= 1) {
      throw new Error('Cannot delete the last local auth user.');
    }
    // The owner is the one recorded owner: removing him would leave the daemon with none (and no other user becomes him).
    if (existing.owner === true) {
      throw new Error(`Cannot delete ${normalized}: it is the owner's account, and the daemon has one owner. Nothing was deleted.`);
    }
    // No session without the admin role can pass the admin check, so the last admin is protected too.
    const isAdmin = (user: AuthUser): boolean => user.roles?.includes('admin') === true;
    if (isAdmin(existing) && ![...this.users.values()].some(user => user.username !== normalized && isAdmin(user))) {
      throw new Error(`Cannot delete ${normalized}: it is the last local auth user with the admin role. Give another user the admin role first.`);
    }
    const previous = this.users;
    const next = new Map(this.users);
    next.delete(normalized);
    this.persist(next);
    this.#publish(normalized, 'delete', true);
    // A user deleted with no session open is told too (onRevoked): what was kept for him (the projects the owner gave
    // him) goes with him.
    if (this.revokeSessionsForUser(normalized) === 0) {
      for (const listener of [...this.#revocationListeners]) {
        try { listener([normalized]); }
        catch (error) { logger.warn('Local auth revocation listener failed', { error: String(error) }); }
      }
    }
    this.#noticeAdminWithdrawn(previous, this.users);
    noteListChanged({ list: 'safety', change: 'deleted', id: normalized });
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
    // A chosen password is the user's own: no longer tied to the bootstrap file.
    const { bootstrap: _generated, ...rest } = existing;
    this.persist(new Map(this.users).set(normalized, {
      ...rest,
      passwordHash: hashPassword(nextPassword, this.scryptParams),
    }));
    this.#publish(normalized, 'upsert', true);
    this.revokeSessionsForUser(normalized);
    // A new password starts the count again: whoever failed with the old one guessed at a password that no longer signs
    // in, so no source stays held for it (the owner's own way back in after a flood: security/user-auth.ts sign-in locks).
    this.#forgetSignInFailures(normalized);
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
      users: [...this.users.values()].map(user => ({ ...user, ...(user.roles ? { roles: [...user.roles] } : {}), ...(user.scopes ? { scopes: [...user.scopes] } : {}) })),
      sessions: [...this.sessions.values()].map(session => ({ ...session })),
      faults: { persist: this.persistFaulted, settings: this.settingsFaulted },
    };
  }

  /**
   * Replace the live accounts and sessions with a snapshot. Memory only: the caller owns the user
   * file and has already put it back, so this does not write it.
   */
  restoreState(state: UserAuthState): void {
    this.users = new Map(state.users.map(user => [user.username, { ...user, ...(user.roles ? { roles: [...user.roles] } : {}), ...(user.scopes ? { scopes: [...user.scopes] } : {}) }]));
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
    this.bootstrapCredentialSeen = null;
    noteListChanged({ list: 'safety', change: 'deleted' });
    return true;
  }

  /**
   * Delete the bootstrap credential file only when nothing signs in with it
   * any more: the user it names is gone or has a password of its own. A file
   * still holding a live generated password is the owner's only copy of it and
   * is kept, whoever else signs in. Returns whether a file was deleted.
   */
  retireStaleBootstrapCredential(): boolean {
    const credential = readBootstrapCredentialFile(this.bootstrapCredentialPath);
    if (credential === null) return false;
    const named = this.users.get(credential.username);
    if (named?.bootstrap === true) return false;
    // A store written by 3.3.1 or earlier has no bootstrap mark. While the file
    // still holds that user's password it is the generated one, and the owner's
    // only copy: mark it once and keep the file. One password check, only for
    // a store that predates the mark.
    if (named && named.bootstrap === undefined && this.persistUsers && verifyPassword(credential.password, named.passwordHash)) {
      try {
        if (this.persist(new Map(this.users).set(named.username, { ...named, bootstrap: true }), { username: named.username, passwordHash: named.passwordHash })) return false;
      } catch (error) {
        logger.warn('The generated password could not be marked in the user store; the bootstrap credential file is kept', { username: named.username, error: String(error) });
        return false;
      }
    }
    return this.clearBootstrapCredentialFile();
  }

  /** The bootstrap file's last reading: the user it names (null: no usable file), read at most once a second. */
  private bootstrapCredentialSeen: { readonly at: number; readonly username: string | null } | null = null;

  private bootstrapCredentialUsername(now: number): string | null {
    const seen = this.bootstrapCredentialSeen;
    if (seen !== null && now - seen.at < DISK_CHECK_INTERVAL_MS) return seen.username;
    const username = readBootstrapCredentialFile(this.bootstrapCredentialPath)?.username ?? null;
    this.bootstrapCredentialSeen = { at: now, username };
    return username;
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
    // A write that holds only while the password is unchanged is refused once any writer moved it:
    // this process (a rotation or an authority-record change taken in meanwhile) as well as another one on disk.
    if (onlyIfHash && this.users.get(onlyIfHash.username)?.passwordHash !== onlyIfHash.passwordHash) return false;
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
