import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, linkSync, realpathSync, renameSync, statSync, unlinkSync, type BigIntStats } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';

/**
 * What was done with an operator-token file that could not be read.
 *
 * A token store is a fleet's shared secret: every paired client authenticates
 * with the value in it. When the file was unreadable, truncated by a crash
 * mid-write, half-written, or overwritten with something that is not a token
 * record, the read fell through and MINTED A NEW TOKEN over the top of it.
 * That is a fleet-wide 401 with no record of what happened and no way back:
 * the bytes that every client was holding are gone, and nothing says so.
 *
 * So the unreadable file is moved aside first, under a `.unrecognized`
 * neighbour, and the event is reported. The rotation still happens, a daemon
 * with no readable token cannot serve, but it is now a stated one, with the
 * old file still on disk.
 */
export interface CompanionTokenQuarantine {
  /** The token store that could not be read. */
  readonly from: string;
  /** Where its bytes were moved. Empty when the move itself failed. */
  readonly to: string;
  /** Why it was not usable, in one line. */
  readonly reason: string;
}

export interface CompanionPairingResult {
  readonly token: string;
  readonly peerId: string;
  readonly createdAt: number;
  /**
   * Present only when an unreadable token store was moved aside to mint this
   * one. A caller that surfaces anything to an operator must surface this:
   * every paired client has to pair again.
   */
  readonly quarantined?: CompanionTokenQuarantine | undefined;
}

export interface CompanionConnectionInfo {
  readonly url: string;
  readonly token: string;
  readonly username: string;
  readonly version: string;
  readonly surface: string;
  /** Bootstrap password for companion authentication (omitted if not applicable). */
  readonly password?: string | undefined;
}

export interface CompanionTokenRecord {
  readonly token: string;
  readonly peerId: string;
  readonly createdAt: number;
}

export interface CompanionTokenOptions {
  readonly daemonHomeDir: string;
  readonly regenerate?: boolean | undefined;
  /**
   * Where a quarantine is recorded for the next surface that looks, the
   * daemon's own receipt store (platform/daemon/receipts.ts). Omitted ⇒ the
   * event is logged and returned but nothing carries it to a person.
   */
  readonly receipts?: { record(text: string): unknown } | undefined;
}

export interface PruneStaleOperatorTokensOptions {
  readonly daemonHomeDir: string;
  readonly candidatePaths?: readonly string[] | undefined;
}

export interface PruneStaleOperatorTokensResult {
  readonly canonicalPath: string;
  readonly prunedPaths: readonly string[];
  readonly failedPaths: readonly string[];
  readonly skippedPaths: readonly string[];
}

const TOKEN_PREFIX = 'gv_';

function generateTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

function generatePeerId(): string {
  return randomBytes(12).toString('hex');
}

/**
 * The operator token file of a daemon home: `<daemonHomeDir>/operator-tokens.json`.
 * The one statement of where the token lives; this module is its only writer.
 * Every reader takes the daemon home from `resolveGoodVibesDaemonHome` (which
 * honours `GOODVIBES_DAEMON_HOME`) and this function, never a hand-built path.
 */
export function operatorTokenPath(daemonHomeDir: string): string {
  return join(daemonHomeDir, 'operator-tokens.json');
}

function normalizeCompanionTokenOptions(
  first: CompanionTokenOptions | string,
  second?: CompanionTokenOptions,
): CompanionTokenOptions {
  if (typeof first === 'string') {
    if (!second) {
      throw new Error('getOrCreateCompanionToken(surface, options) requires options.daemonHomeDir');
    }
    return second;
  }
  return first;
}

/**
 * Load the stored companion token, or generate and persist a new one.
 * Token is always written to <daemonHomeDir>/operator-tokens.json at mode 0600.
 */
export function getOrCreateCompanionToken(
  options: CompanionTokenOptions,
): CompanionPairingResult;
export function getOrCreateCompanionToken(
  surface: string,
  options: CompanionTokenOptions,
): CompanionPairingResult;
export function getOrCreateCompanionToken(
  first: CompanionTokenOptions | string,
  second?: CompanionTokenOptions,
): CompanionPairingResult {
  const options = normalizeCompanionTokenOptions(first, second);
  const tokenPath = operatorTokenPath(options.daemonHomeDir);

  let quarantined: CompanionTokenQuarantine | undefined;
  if (!options.regenerate && existsSync(tokenPath)) {
    const loaded = readTokenRecord(tokenPath);
    if (loaded.record) {
      return { token: loaded.record.token, peerId: loaded.record.peerId, createdAt: loaded.record.createdAt };
    }
    // A file another process removed between the check and the read is simply absent.
    if (loaded.reason !== ABSENT) {
      // Another process may have published a valid token since the read above; moving that
      // aside would rotate the token it just handed out. Judge the file as it is now.
      const current = readTokenRecord(tokenPath);
      if (current.record) {
        return { token: current.record.token, peerId: current.record.peerId, createdAt: current.record.createdAt };
      }
      if (current.reason !== ABSENT) quarantined = quarantineTokenStore(tokenPath, current.reason, options.receipts);
    }
  }

  const record: CompanionTokenRecord = {
    token: generateTokenValue(),
    peerId: generatePeerId(),
    createdAt: Date.now(),
  };

  // Publish a complete owner-only record before returning a usable token.
  // Publication failures must reach the caller instead of reporting success.
  if (!options.regenerate) {
    // Another process on this home (daemon and TUI) may be minting right now.
    // The loser adopts the winner's token instead of overwriting it with one
    // that no client was given.
    const winner = publishNewTokenRecord(tokenPath, record);
    if (winner) return { token: winner.token, peerId: winner.peerId, createdAt: winner.createdAt };
  } else {
    writeJsonFileAtomic(tokenPath, record, { mode: 0o600, trailingNewline: false });
  }

  return {
    token: record.token,
    peerId: record.peerId,
    createdAt: record.createdAt,
    ...(quarantined === undefined ? {} : { quarantined }),
  };
}

/**
 * Write the record complete to a private neighbour, then link it into place:
 * the link fails when the token file already exists, so a concurrent first mint
 * cannot be overwritten. Returns the record that is already there when this
 * call lost the race, otherwise null. A filesystem without hard links falls
 * back to the plain atomic replace.
 */
function publishNewTokenRecord(tokenPath: string, record: CompanionTokenRecord): CompanionTokenRecord | null {
  const staging = `${tokenPath}.new-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeJsonFileAtomic(staging, record, { mode: 0o600, trailingNewline: false });
  try {
    linkSync(staging, tokenPath);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const existing = readTokenRecord(tokenPath).record;
      if (existing) return existing;
      writeJsonFileAtomic(tokenPath, record, { mode: 0o600, trailingNewline: false });
      return null;
    }
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'EXDEV') {
      writeJsonFileAtomic(tokenPath, record, { mode: 0o600, trailingNewline: false });
      return null;
    }
    throw error;
  } finally {
    try { unlinkSync(staging); } catch { /* already gone */ }
  }
}

const ABSENT = 'absent';

/** Read the stored record, or say in one line why it is not usable. */
function readTokenRecord(tokenPath: string): { record: CompanionTokenRecord | null; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(tokenPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null, reason: ABSENT };
    // A transient fault (EMFILE, EACCES, EIO) says nothing about the content; moving the file
    // aside would rotate the token for every paired client over a read that may succeed next time.
    throw error;
  }
  if (!raw.trim()) {
    // The classic torn write: created or truncated, then the process died
    // before the content landed.
    return { record: null, reason: 'the file is empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, reason: 'the file is not valid JSON' };
  }
  const candidate = parsed as Partial<CompanionTokenRecord> | null;
  if (!candidate || typeof candidate !== 'object') return { record: null, reason: 'the file is not a token record' };
  if (typeof candidate.token !== 'string' || !candidate.token) return { record: null, reason: 'the record carries no token' };
  if (typeof candidate.peerId !== 'string' || !candidate.peerId) return { record: null, reason: 'the record carries no peer id' };
  return {
    record: {
      token: candidate.token,
      peerId: candidate.peerId,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    },
    reason: '',
  };
}

/** Move an unreadable token store aside, loudly. Never throws. */
function quarantineTokenStore(
  tokenPath: string,
  reason: string,
  receipts?: { record(text: string): unknown } | undefined,
): CompanionTokenQuarantine {
  let destination = '';
  try {
    destination = nextUnrecognizedPath(tokenPath);
    renameSync(tokenPath, destination);
  } catch (error) {
    destination = '';
    // Another process already moved it aside; nothing is about to be overwritten.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('The unreadable operator token store could not be moved aside; it is about to be overwritten', {
        path: tokenPath,
        reason,
        error: String(error),
      });
    }
  }
  logger.error('The operator token store was unreadable, a new token was issued and every paired client must pair again', {
    path: tokenPath,
    reason,
    ...(destination ? { movedTo: destination } : {}),
  });
  try {
    receipts?.record(
      `the operator token store was unreadable (${reason}), a new token was issued, so every paired client must pair again`
      + (destination ? `; the old file is at ${destination}` : ''),
    );
  } catch (error) {
    logger.error('The operator token quarantine could not be recorded as a receipt', {
      path: tokenPath,
      error: String(error),
    });
  }
  return { from: tokenPath, to: destination, reason };
}

/** `<path>.unrecognized`, or the first numbered neighbour that is free. */
function nextUnrecognizedPath(tokenPath: string): string {
  const base = `${tokenPath}.unrecognized`;
  if (!existsSync(base)) return base;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base}.${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}.${Date.now()}`;
}

/**
 * Regenerate the companion token, replacing any existing token.
 * Written to <daemonHomeDir>/operator-tokens.json at mode 0600.
 */
export function regenerateCompanionToken(
  options: CompanionTokenOptions,
): CompanionPairingResult {
  return getOrCreateCompanionToken({ ...options, regenerate: true });
}

/**
 * The token stored in `<daemonHomeDir>/operator-tokens.json`, read without
 * creating, moving or repairing anything. Null when the file is absent or
 * holds no usable record.
 */
export function readCompanionTokenValue(daemonHomeDir: string): string | null {
  return readTokenRecord(operatorTokenPath(daemonHomeDir)).record?.token ?? null;
}

/**
 * Replace the stored token with a new value. `commit` is told the new value
 * first; when it throws, the file is left exactly as it was. The record is then
 * written whole at mode 0600, keeping its peer id, and the new value returned.
 */
export function replaceCompanionToken(
  options: Pick<CompanionTokenOptions, 'daemonHomeDir'>,
  commit: (token: string) => void,
): CompanionPairingResult {
  const tokenPath = operatorTokenPath(options.daemonHomeDir);
  const previous = readTokenRecord(tokenPath).record;
  const record: CompanionTokenRecord = {
    token: generateTokenValue(),
    peerId: previous?.peerId ?? generatePeerId(),
    createdAt: Date.now(),
  };
  commit(record.token);
  writeJsonFileAtomic(tokenPath, record, { mode: 0o600, trailingNewline: false });
  return { token: record.token, peerId: record.peerId, createdAt: record.createdAt };
}

export function pruneStaleOperatorTokens(
  options: PruneStaleOperatorTokensOptions,
): PruneStaleOperatorTokensResult {
  const canonicalPath = resolve(operatorTokenPath(options.daemonHomeDir));
  const prunedPaths: string[] = [];
  const failedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const seen = new Set<string>();

  for (const candidate of options.candidatePaths ?? []) {
    if (!candidate || typeof candidate !== 'string') continue;
    const candidatePath = resolve(candidate);
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    if (candidatePath === canonicalPath) {
      skippedPaths.push(candidatePath);
      continue;
    }
    let candidateStat: BigIntStats;
    try { candidateStat = statSync(candidatePath, { bigint: true }); }
    catch (error) {
      // A missing candidate remains a noop. Other lookup failures cannot
      // establish identity, so retain it and report the failed cleanup.
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      (code === 'ENOENT' || code === 'ENOTDIR' ? skippedPaths : failedPaths).push(candidatePath);
      continue;
    }
    try {
      // Lexical paths do not establish ownership: a relocated daemon home or
      // workspace parent may be a directory symlink, and files may be hard
      // links. Never unlink the selected identity under another spelling.
      const canonicalStat = statSync(canonicalPath, { bigint: true });
      if (!canonicalStat.isFile() || !candidateStat.isFile()) {
        failedPaths.push(candidatePath);
        continue;
      }
      if (realpathSync(candidatePath) === realpathSync(canonicalPath)
        || (canonicalStat.ino !== 0n && candidateStat.dev === canonicalStat.dev && candidateStat.ino === canonicalStat.ino)) {
        skippedPaths.push(candidatePath);
        continue;
      }
      // Some filesystems cannot report an inode. Distinct resolved paths alone
      // cannot disprove a hard-link alias; uncertain identity fails closed.
      if (canonicalStat.ino === 0n || candidateStat.ino === 0n) {
        failedPaths.push(candidatePath);
        continue;
      }
      unlinkSync(candidatePath);
      prunedPaths.push(candidatePath);
    } catch {
      failedPaths.push(candidatePath);
    }
  }

  return {
    canonicalPath,
    prunedPaths,
    failedPaths,
    skippedPaths,
  };
}

/**
 * Build a CompanionConnectionInfo object from raw parameters.
 */
export function buildCompanionConnectionInfo(options: {
  daemonUrl: string;
  token: string;
  username?: string | undefined;
  password?: string | undefined;
  version?: string | undefined;
  surface?: string | undefined;
}): CompanionConnectionInfo {
  return {
    url: options.daemonUrl,
    token: options.token,
    username: options.username ?? 'admin',
    ...(options.password !== undefined ? { password: options.password } : {}),
    version: options.version ?? '0.0.0',
    surface: options.surface ?? 'daemon',
  };
}

/**
 * Encode a CompanionConnectionInfo as a JSON string suitable for QR encoding.
 */
export function encodeConnectionPayload(info: CompanionConnectionInfo): string {
  return JSON.stringify({
    url: info.url,
    token: info.token,
    username: info.username,
    ...(info.password !== undefined ? { password: info.password } : {}),
    version: info.version,
    surface: info.surface,
  });
}
