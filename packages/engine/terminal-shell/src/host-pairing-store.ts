import { lstatSync, mkdirSync, readFileSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BoundedJsonFile, type BoundedJsonFileIO, type BoundedJsonFileTransaction } from '@goodvibes/engine/platform/platform/state/durable-file-io';
export const HOST_PAIRING_MAX_RECORDS = 32;
export const HOST_PAIRING_MAX_BYTES = 256 * 1024;
export interface HostPairingAttempt {
  readonly attemptId: string;
  readonly name: string;
  readonly startedAt: number;
}
export interface HostPairingSecret {
  readonly token: string;
  readonly tokenId: string;
  readonly name: string;
  readonly createdAt: number;
}

let overflowUid: number | null | undefined;
/** The kernel's overflow uid (`/proc/sys/kernel/overflowuid`), read once; null where there is none to read. */
function kernelOverflowUid(): number | null {
  if (overflowUid !== undefined) return overflowUid;
  try {
    const value = Number(readFileSync('/proc/sys/kernel/overflowuid', 'utf8').trim());
    overflowUid = Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    overflowUid = null;
  }
  return overflowUid;
}

/**
 * Whether a directory above a home may hold that home's credential store: a
 * real directory (no symlink) owned by this user, by root, or by the kernel's
 * overflow uid, and not writable by group or others unless the sticky bit is set.
 *
 * The overflow uid is how a directory owned by a user unmapped in this user
 * namespace looks (real root's `/`, `/tmp` and `/home` in a rootless container
 * or under `unshare -r`). No process in this namespace can act as that owner:
 * nobody here can chmod, rename or replace it, exactly as for root outside a
 * namespace. What stays refused: a directory owned by any other user, a
 * symlink, and a directory writable by group or others without the sticky bit
 * (anyone could swap the entry under it). The store's own directories and
 * files are checked apart, and must be owned by this user with no group or
 * other access.
 */
export function isTrustedAncestorDirectory(stat: Stats, uid: number | undefined = typeof process.geteuid === 'function' ? process.geteuid() : undefined): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const owner = stat.uid === uid || stat.uid === 0 || (kernelOverflowUid() !== null && stat.uid === kernelOverflowUid());
  if (!owner) return false;
  return (stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0;
}

/** Why the store refused, so a caller can say what to fix instead of one constant sentence. */
export type HostPairingUnavailableCause =
  | 'invalid-origin'
  | 'home-not-absolute'
  | 'ancestor-unsafe'
  | 'directory-not-private'
  | 'file-not-private'
  | 'invalid-content'
  | 'file-too-large'
  | 'store-full'
  | 'io-error';
export interface HostPairingUnavailable<Reason extends string = string> {
  readonly status: 'unavailable';
  readonly cause: HostPairingUnavailableCause;
  /** The product's sentence, then what is wrong, where, and what to do. */
  readonly reason: `${Reason}${string}`;
  readonly path?: string | undefined;
  readonly expected?: string | undefined;
}
export type HostPairing<Reason extends string = string> =
  | {
      readonly status: 'missing';
    }
  | ({
      readonly status: 'paired';
    } & HostPairingSecret)
  | ({
      readonly status: 'unknown';
    } & HostPairingAttempt)
  | HostPairingUnavailable<Reason>;
export type BeginHostPairingResult<Reason extends string = string, Cancel extends boolean = true> =
  | {
      readonly status: 'begun' | 'conflict' | (Cancel extends true ? 'cancelled' : never);
    }
  | HostPairingUnavailable<Reason>;
export type CompleteHostPairingResult<Reason extends string = string> =
  | {
      readonly status: 'paired' | 'conflict';
    }
  | HostPairingUnavailable<Reason>;
export type ClearHostPairingAttemptResult<Reason extends string = string> =
  | {
      readonly status: 'cleared' | 'conflict';
    }
  | HostPairingUnavailable<Reason>;
export type RemoveHostPairingResult<Reason extends string = string> =
  | {
      readonly status: 'removed' | 'conflict';
    }
  | HostPairingUnavailable<Reason>;
export type HostPairingIO = BoundedJsonFileIO;
class HostPairingRefusal extends Error {
  constructor(
    override readonly cause: HostPairingUnavailableCause,
    readonly detail: string,
    readonly path?: string | undefined,
    readonly expected?: string | undefined,
  ) {
    super(detail);
  }
}
export function createHostPairingStore<const Reason extends string>(policy: {
  readonly unavailableReason: Reason;
  readonly surfaceRoot: string;
  readonly directory: string;
  readonly filename: string;
  readonly strictOrigin: boolean;
}) {
  type StoredPairing = Exclude<
    HostPairing<Reason>,
    {
      status: 'missing' | 'unavailable';
    }
  >;
  interface PairingFile {
    readonly version: 1;
    readonly records: {
      readonly host: string;
      readonly pairing: StoredPairing;
    }[];
  }
  const errorCode = (error: unknown): string =>
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'unexpected error';
  const unavailable = (error: unknown): HostPairingUnavailable<Reason> => {
    const refusal = error instanceof HostPairingRefusal
      ? error
      // Only the error code: an underlying message is not shown, so nothing from it can leak.
      : new HostPairingRefusal('io-error', `It could not be read or written (${errorCode(error)}); check the disk and that no other GoodVibes process is stuck holding it, then try again.`);
    return {
      status: 'unavailable',
      cause: refusal.cause,
      reason: `${policy.unavailableReason} ${refusal.detail}`,
      ...(refusal.path ? { path: refusal.path } : {}),
      ...(refusal.expected ? { expected: refusal.expected } : {}),
    };
  };
  const invalidOrigin = (baseUrl: unknown): HostPairingRefusal =>
    new HostPairingRefusal('invalid-origin', `${JSON.stringify(String(baseUrl).slice(0, 200))} is not an exact http(s) origin; use scheme://host[:port] with no path, user, query or fragment.`, undefined, 'scheme://host[:port]');
  const invalidRecord = (): HostPairingRefusal => new HostPairingRefusal('invalid-content', 'A pairing record is not valid.');
  const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
  const ownKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  function refuse(refusal: HostPairingRefusal = invalidRecord()): never {
    throw refusal;
  }
  const mode = (stat: Stats): string => (stat.mode & 0o7777).toString(8).padStart(4, '0');
  const text = (value: unknown, maximum: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= maximum && /\S/u.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
  const identifier = (value: unknown, maximum: number): value is string => text(value, maximum) && !/\s/u.test(value);
  const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  /** Only an origin is accepted. Reject syntax that URL would silently normalize away. */
  function canonicalizePairingHost(baseUrl: string): string | null {
    if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || /[\s\\?#]/u.test(baseUrl)) return null;
    const match = /^https?:\/\/([^/]+)\/?$/iu.exec(baseUrl);
    if (!match || match[1]!.includes('@')) return null;
    try {
      const url = new URL(baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        return null;
      if (policy.strictOrigin) {
        // Permit case folding and the protocol's explicit default port only.
        // Refuse percent-encoded hosts, numeric IPv4 aliases and other authority
        // rewrites that could hide which exact origin the owner selected.
        const authority = match[1]!.toLowerCase();
        const defaultPort = url.protocol === 'https:' ? '443' : '80';
        if (authority !== url.host.toLowerCase() && authority !== `${url.host.toLowerCase()}:${defaultPort}`) return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }
  function hostPairingStorePath(homeDirectory: string): string {
    return join(resolve(homeDirectory), '.goodvibes', policy.surfaceRoot, policy.directory, policy.filename);
  }
  function copyAttempt(value: unknown): HostPairingAttempt {
    if (
      !ownKeys(value, ['attemptId', 'name', 'startedAt']) ||
      !identifier(value.attemptId, 256) ||
      !text(value.name, 256) ||
      !timestamp(value.startedAt)
    )
      refuse();
    return { attemptId: value.attemptId, name: value.name, startedAt: value.startedAt };
  }
  function copySecret(value: unknown): HostPairingSecret {
    if (
      !ownKeys(value, ['token', 'tokenId', 'name', 'createdAt']) ||
      !identifier(value.token, 4096) ||
      !identifier(value.tokenId, 256) ||
      !text(value.name, 256) ||
      !timestamp(value.createdAt)
    )
      refuse();
    return { token: value.token, tokenId: value.tokenId, name: value.name, createdAt: value.createdAt };
  }
  function validateFile(value: unknown): PairingFile {
    if (
      !ownKeys(value, ['version', 'records']) ||
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      value.records.length > HOST_PAIRING_MAX_RECORDS
    )
      refuse();
    const records: PairingFile['records'] = [];
    for (const record of value.records) {
      if (
        !ownKeys(record, ['host', 'pairing']) ||
        typeof record.host !== 'string' ||
        canonicalizePairingHost(record.host) !== record.host ||
        records.some((prior) => prior.host === record.host)
      )
        refuse();
      const pairing = record.pairing;
      if (ownKeys(pairing, ['status', 'attemptId', 'name', 'startedAt']) && pairing.status === 'unknown') {
        records.push({
          host: record.host,
          pairing: {
            status: 'unknown',
            ...copyAttempt({ attemptId: pairing.attemptId, name: pairing.name, startedAt: pairing.startedAt }),
          },
        });
      } else if (ownKeys(pairing, ['status', 'token', 'tokenId', 'name', 'createdAt']) && pairing.status === 'paired') {
        records.push({
          host: record.host,
          pairing: {
            status: 'paired',
            ...copySecret({ token: pairing.token, tokenId: pairing.tokenId, name: pairing.name, createdAt: pairing.createdAt }),
          },
        });
      } else refuse();
    }
    return { version: 1, records };
  }
  function owned(stat: Stats): boolean {
    return typeof process.geteuid === 'function' && stat.uid === process.geteuid();
  }
  function secureDirectory(path: string, stat: Stats, privateDirectory: boolean): void {
    if (!stat.isDirectory() || stat.isSymbolicLink())
      refuse(new HostPairingRefusal('directory-not-private', `${path} is not a real directory (a symlink or a file).`, path, 'a directory you own'));
    if (!owned(stat)) refuse(new HostPairingRefusal('directory-not-private', `${path} is owned by uid ${stat.uid}, not by you.`, path, 'a directory you own'));
    if (privateDirectory ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0)
      refuse(new HostPairingRefusal(
        'directory-not-private',
        privateDirectory ? `${path} has mode ${mode(stat)}; run chmod 700 ${path}.` : `${path} has mode ${mode(stat)}, writable by others; run chmod go-w ${path}.`,
        path,
        privateDirectory ? '0700' : 'not writable by group or others',
      ));
  }
  /** No symlink ancestry, including dangling links; never chmod/adopt an insecure existing directory. */
  function directories(homeDirectory: string, create: boolean): string {
    if (typeof homeDirectory !== 'string' || !isAbsolute(homeDirectory))
      refuse(new HostPairingRefusal('home-not-absolute', `The home directory ${JSON.stringify(String(homeDirectory))} is not an absolute path.`, undefined, 'an absolute path'));
    const home = resolve(homeDirectory);
    for (let ancestor = dirname(home); ; ancestor = dirname(ancestor)) {
      const stat = lstatSync(ancestor);
      if (!isTrustedAncestorDirectory(stat))
        refuse(new HostPairingRefusal(
          'ancestor-unsafe',
          `${ancestor}, above the home directory, is ${stat.isSymbolicLink() ? 'a symlink' : `owned by uid ${stat.uid} with mode ${mode(stat)}`}; use the home's real path, or make that directory owned by you or root and not writable by group or others (unless it is sticky, as /tmp is).`,
          ancestor,
          'a real directory owned by you, root or the namespace overflow user, not writable by group or others unless sticky',
        ));
      if (dirname(ancestor) === ancestor) break;
    }
    // The caller's home must already exist. Only this product's descendants are created.
    secureDirectory(home, lstatSync(home), false);
    const paths = [join(home, '.goodvibes'), join(home, '.goodvibes', policy.surfaceRoot), dirname(hostPairingStorePath(home))];
    for (const [index, path] of paths.entries()) {
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      try {
        secureDirectory(path, lstatSync(path), index === paths.length - 1);
      } catch (error) {
        if (!create && missing(error)) return hostPairingStorePath(home);
        throw error;
      }
    }
    return hostPairingStorePath(home);
  }
  /** Owner-only, single-link regular file; size and symlink rules are the bounded file's. */
  const secureFile = (path: string) => (stat: Stats): boolean => {
    if (!owned(stat)) refuse(new HostPairingRefusal('file-not-private', `${path} is owned by uid ${stat.uid}, not by you.`, path, 'a file you own'));
    if (stat.nlink !== 1)
      refuse(new HostPairingRefusal('file-not-private', `${path} has ${stat.nlink} hard links; copy it to a new file in its place.`, path, '1 link'));
    if ((stat.mode & 0o7777) !== 0o600) refuse(new HostPairingRefusal('file-not-private', `${path} has mode ${mode(stat)}; run chmod 600 ${path}.`, path, '0600'));
    return true;
  };
  const storeFile = (path: string, io: Partial<HostPairingIO>): BoundedJsonFile<PairingFile | null> => {
    const invalid = (): HostPairingRefusal =>
      new HostPairingRefusal('invalid-content', `${path} is not a valid pairing store (a symlink, not a regular file, or content this store does not accept); move it aside to start empty.`, path);
    return new BoundedJsonFile<PairingFile | null>(path, {
      maxBytes: HOST_PAIRING_MAX_BYTES, empty: () => null, invalid,
      parse: (value) => { try { return validateFile(value); } catch { throw invalid(); } },
      limit: () => new HostPairingRefusal('file-too-large', `${path} is over the ${HOST_PAIRING_MAX_BYTES}-byte limit; move it aside or forget a pairing you no longer use.`, path, `at most ${HOST_PAIRING_MAX_BYTES} bytes`),
      accept: secureFile(path), io,
    });
  };
  /**
   * One verified read. The writer made the file durable before it returned, so
   * a read only checks and parses it. Only a successful begin grants permission
   * to make a new mint request.
   */
  function readHostPairing(homeDirectory: string, baseUrl: string, overrides: Partial<HostPairingIO> = {}): HostPairing<Reason> {
    try {
      const host = canonicalizePairingHost(baseUrl);
      if (!host) return unavailable(invalidOrigin(baseUrl));
      const file = storeFile(directories(homeDirectory, false), overrides).peek();
      return file?.records.find((record) => record.host === host)?.pairing ?? { status: 'missing' };
    } catch (error) {
      return unavailable(error);
    }
  }
  async function locked<T>(home: string, io: Partial<HostPairingIO>, operation: (file: BoundedJsonFileTransaction<PairingFile | null>) => T): Promise<T> {
    const path = directories(home, true);
    // Reject a lock symlink/special file before entering the shared primitive.
    try {
      const stat = lstatSync(`${path}.lock`);
      if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat))
        refuse(new HostPairingRefusal('file-not-private', `${path}.lock is not a regular file you own; remove it.`, `${path}.lock`, 'a regular file you own'));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return storeFile(path, io).transact((file) => {
      directories(home, false);
      return operation(file);
    });
  }
  /** Durable when this returns; a durability failure escapes and the caller reports the store unavailable. */
  function publish(store: BoundedJsonFileTransaction<PairingFile | null>, file: PairingFile): void {
    if (file.records.length > HOST_PAIRING_MAX_RECORDS)
      refuse(new HostPairingRefusal('store-full', `The store already holds ${HOST_PAIRING_MAX_RECORDS} host pairings; forget one you no longer use, then pair again.`, undefined, `at most ${HOST_PAIRING_MAX_RECORDS} hosts`));
    store.write(file);
  }
  /** Persist uncertainty BEFORE POST. Existing attempts never authorize a second mint, even with the same ID. */
  async function beginHostPairing<Current extends (() => boolean) | undefined = undefined>(
    homeDirectory: string,
    baseUrl: string,
    attempt: HostPairingAttempt,
    overrides: Partial<HostPairingIO> = {},
    current?: Current | undefined,
  ): Promise<BeginHostPairingResult<Reason, Current extends undefined ? false : true>> {
    try {
      const host = canonicalizePairingHost(baseUrl);
      if (!host) return unavailable(invalidOrigin(baseUrl));
      const pending: StoredPairing = { status: 'unknown', ...copyAttempt(attempt) };
      const result = await locked(homeDirectory, overrides, (store) => {
        // Lock acquisition may wait. A known cancellation before publication
        // creates no attempt and must not require uncertain-outcome recovery.
        if (current && !current()) return { status: 'cancelled' as const };
        const file: PairingFile = store.read() ?? { version: 1, records: [] };
        if (file.records.some((record) => record.host === host)) return { status: 'conflict' as const };
        file.records.push({ host, pairing: pending });
        publish(store, file);
        return { status: 'begun' as const };
      });
      // A missing currentness callback cannot produce cancellation.
      return result as BeginHostPairingResult<Reason, Current extends undefined ? false : true>;
    } catch (error) {
      return unavailable(error);
    }
  }
  /**
   * CAS removal of one unresolved attempt, so the host can be paired again.
   * It removes only an `unknown` record carrying exactly this attempt id and
   * never a paired one. The caller must know no credential was minted: the
   * request was never sent, the host answered with a definitive rejection, or
   * the owner confirmed on the host that nothing was created.
   */
  async function clearHostPairingAttempt(
    homeDirectory: string,
    baseUrl: string,
    attemptId: string,
    overrides: Partial<HostPairingIO> = {},
  ): Promise<ClearHostPairingAttemptResult<Reason>> {
    try {
      const host = canonicalizePairingHost(baseUrl);
      if (!host) return unavailable(invalidOrigin(baseUrl));
      if (!identifier(attemptId, 256)) return { status: 'conflict' };
      return await locked(homeDirectory, overrides, (store) => {
        const file = store.read();
        const index = file?.records.findIndex((record) => record.host === host) ?? -1;
        const current = file?.records[index]?.pairing;
        if (!file || !current || current.status !== 'unknown' || current.attemptId !== attemptId) return { status: 'conflict' as const };
        file.records.splice(index, 1);
        publish(store, file);
        return { status: 'cleared' as const };
      });
    } catch (error) {
      return unavailable(error);
    }
  }
  /**
   * CAS removal of one saved credential, for a credential the host no longer
   * accepts or a terminal the owner unpairs. It removes only a `paired` record
   * carrying exactly this token id. The token itself stays valid on the host
   * until it is revoked there.
   */
  async function removeHostPairing(
    homeDirectory: string,
    baseUrl: string,
    tokenId: string,
    overrides: Partial<HostPairingIO> = {},
  ): Promise<RemoveHostPairingResult<Reason>> {
    try {
      const host = canonicalizePairingHost(baseUrl);
      if (!host) return unavailable(invalidOrigin(baseUrl));
      return await locked(homeDirectory, overrides, (store) => {
        const file = store.read();
        const index = file?.records.findIndex((record) => record.host === host) ?? -1;
        const current = file?.records[index]?.pairing;
        if (!file || !current || current.status !== 'paired' || current.tokenId !== tokenId) return { status: 'conflict' as const };
        file.records.splice(index, 1);
        publish(store, file);
        return { status: 'removed' as const };
      });
    } catch (error) {
      return unavailable(error);
    }
  }
  /** CAS completion; a saved credential is removed with removeHostPairing and an unresolved attempt with clearHostPairingAttempt. */
  async function completeHostPairing(
    homeDirectory: string,
    baseUrl: string,
    attemptId: string,
    secret: HostPairingSecret,
    overrides: Partial<HostPairingIO> = {},
  ): Promise<CompleteHostPairingResult<Reason>> {
    try {
      const host = canonicalizePairingHost(baseUrl);
      if (!host) return unavailable(invalidOrigin(baseUrl));
      if (!identifier(attemptId, 256)) return { status: 'conflict' };
      const paired: StoredPairing = { status: 'paired', ...copySecret(secret) };
      return await locked(homeDirectory, overrides, (store) => {
        const file = store.read();
        const index = file?.records.findIndex((record) => record.host === host) ?? -1;
        const current = file?.records[index]?.pairing;
        if (!file || !current || current.status !== 'unknown' || current.attemptId !== attemptId || current.name !== paired.name) {
          return { status: 'conflict' as const };
        }
        file.records[index] = { host, pairing: paired };
        publish(store, file);
        return { status: 'paired' as const };
      });
    } catch (error) {
      return unavailable(error);
    }
  }
  return { canonicalizePairingHost, hostPairingStorePath, readHostPairing, beginHostPairing, completeHostPairing, clearHostPairingAttempt, removeHostPairing };
}
