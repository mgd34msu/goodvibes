import { lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BoundedJsonFile, confirmFileDurable, type BoundedJsonFileIO, type BoundedJsonFileTransaction } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
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
export interface HostPairingUnavailable<Reason extends string = string> {
  readonly status: 'unavailable';
  readonly reason: Reason;
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
export type HostPairingIO = BoundedJsonFileIO;
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
  const unavailable = (): HostPairingUnavailable<Reason> => ({ status: 'unavailable', reason: policy.unavailableReason });
  const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
  const ownKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  function refuse(): never {
    throw new Error(policy.unavailableReason);
  }
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
  function secureDirectory(stat: Stats, privateDirectory: boolean): void {
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !owned(stat) ||
      (privateDirectory ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0)
    )
      refuse();
  }
  /** No symlink ancestry, including dangling links; never chmod/adopt an insecure existing directory. */
  function directories(homeDirectory: string, create: boolean): string {
    if (typeof homeDirectory !== 'string' || !isAbsolute(homeDirectory)) refuse();
    const home = resolve(homeDirectory);
    for (let ancestor = dirname(home); ; ancestor = dirname(ancestor)) {
      const stat = lstatSync(ancestor);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (!owned(stat) && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
      )
        refuse();
      if (dirname(ancestor) === ancestor) break;
    }
    // The caller's home must already exist. Only this product's descendants are created.
    secureDirectory(lstatSync(home), false);
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
        secureDirectory(lstatSync(path), index === paths.length - 1);
      } catch (error) {
        if (!create && missing(error)) return hostPairingStorePath(home);
        throw error;
      }
    }
    return hostPairingStorePath(home);
  }
  /** Owner-only, single-link regular file; size and symlink rules are the bounded file's. */
  const secureFile = (stat: Stats): boolean =>
    stat.isFile() && !stat.isSymbolicLink() && owned(stat) && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600;
  const unavailableError = (): Error => new Error(policy.unavailableReason);
  const storeFile = (path: string, io: Partial<HostPairingIO>): BoundedJsonFile<PairingFile | null> =>
    new BoundedJsonFile<PairingFile | null>(path, {
      maxBytes: HOST_PAIRING_MAX_BYTES, parse: validateFile, empty: () => null,
      invalid: unavailableError, limit: unavailableError, accept: secureFile, io,
    });
  /** Snapshot only: only a successful begin grants permission to make a new mint request. */
  function readHostPairing(homeDirectory: string, baseUrl: string, overrides: Partial<HostPairingIO> = {}): HostPairing<Reason> {
    try {
      const host = canonicalizePairingHost(baseUrl);
      if (!host) return unavailable();
      const path = directories(homeDirectory, false);
      const store = storeFile(path, overrides);
      const file = store.peek();
      if (!file) return { status: 'missing' };
      // A file a crashed process published may not be durable yet: make it so
      // before anything acts on it, without removing or rewriting it.
      (overrides.confirmFileDurable ?? confirmFileDurable)(store.path);
      return file.records.find((record) => record.host === host)?.pairing ?? { status: 'missing' };
    } catch {
      return unavailable();
    }
  }
  async function locked<T>(home: string, io: Partial<HostPairingIO>, operation: (file: BoundedJsonFileTransaction<PairingFile | null>) => T): Promise<T> {
    const path = directories(home, true);
    // Reject a lock symlink/special file before entering the shared primitive.
    try {
      const stat = lstatSync(`${path}.lock`);
      if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat)) refuse();
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
    if (file.records.length > HOST_PAIRING_MAX_RECORDS) refuse();
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
      if (!host) return unavailable();
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
    } catch {
      return unavailable();
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
      if (!host || !identifier(attemptId, 256)) return unavailable();
      return await locked(homeDirectory, overrides, (store) => {
        const file = store.read();
        const index = file?.records.findIndex((record) => record.host === host) ?? -1;
        const current = file?.records[index]?.pairing;
        if (!file || !current || current.status !== 'unknown' || current.attemptId !== attemptId) return { status: 'conflict' as const };
        file.records.splice(index, 1);
        publish(store, file);
        return { status: 'cleared' as const };
      });
    } catch {
      return unavailable();
    }
  }
  /** CAS completion only; rotation and revocation are not exposed, and clearing is limited to an unresolved attempt. */
  async function completeHostPairing(
    homeDirectory: string,
    baseUrl: string,
    attemptId: string,
    secret: HostPairingSecret,
    overrides: Partial<HostPairingIO> = {},
  ): Promise<CompleteHostPairingResult<Reason>> {
    try {
      const host = canonicalizePairingHost(baseUrl);
      if (!host || !identifier(attemptId, 256)) return unavailable();
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
    } catch {
      return unavailable();
    }
  }
  return { canonicalizePairingHost, hostPairingStorePath, readHostPairing, beginHostPairing, completeHostPairing, clearHostPairingAttempt };
}
