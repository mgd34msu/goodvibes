/**
 * download-verified.ts, atomic, checksum-verified download of one managed
 * voice-runtime component (engine archive or model file).
 *
 * The body streams to a partial file beside the destination while a running
 * sha256 is kept, so memory stays at one network chunk whatever the file size
 * and progress moves as bytes land. A pinned size + sha256 gate decides the
 * rename: a byte-count or checksum mismatch keeps NOTHING at the final path, so
 * a corrupted or tampered download can never be handed to the speech engine.
 *
 * A network failure keeps the partial file and the next attempt asks the
 * server for the rest with `Range`; a server that ignores the range sends the
 * whole file and the partial is started over. The deadline is an idle one: a
 * transfer fails when no byte arrives for `idleTimeoutMs`, never because a
 * slow link took long.
 */
import { createHash, type Hash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface VerifiedDownloadSpec {
  readonly url: string;
  /**
   * Further origins serving the SAME bytes, tried in order when `url` fails.
   * Every origin is held to the same pinned size and sha256, so a mirror can
   * improve availability but never change what is installed.
   */
  readonly fallbackUrls?: readonly string[] | undefined;
  /** Expected byte count (pinned). */
  readonly bytes: number;
  /** Expected lowercase hex sha256 (pinned). */
  readonly sha256: string;
}

export type VerifiedDownloadPhase = 'skip' | 'download' | 'verify' | 'done';

export interface VerifiedDownloadOptions {
  readonly spec: VerifiedDownloadSpec;
  readonly destPath: string;
  readonly fetchImpl?: typeof fetch | undefined;
  /** An idle deadline: a transfer fails after this long with no bytes received. Default 60 s. */
  readonly timeoutMs?: number | undefined;
  /** Stops the download; the partial file is kept for the next attempt. */
  readonly signal?: AbortSignal | undefined;
  /** Progress callback (best-effort). `bytesDone` counts bytes on disk for this component. */
  readonly onProgress?: ((phase: VerifiedDownloadPhase, message?: string, bytesDone?: number) => void) | undefined;
}

export type VerifiedDownloadResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number; readonly skipped: boolean }
  | { readonly ok: false; readonly reason: 'download-failed' | 'checksum-mismatch' | 'size-mismatch'; readonly error: string };

/** No byte for this long ends a transfer. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** A progress event at most once per this many bytes. */
const PROGRESS_STEP_BYTES = 1024 * 1024;
/** Resumes in a row, within one attempt on one origin, while each one makes progress. */
const MAX_RESUMES = 5;
const HASH_READ_CHUNK = 1024 * 1024;

function checksumPin(value: string): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

/** Hash an existing file in bounded chunks (memory stays at one chunk). */
function hashFileSync(path: string, hash: Hash = createHash('sha256')): Hash {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { closeSync(fd); }
  return hash;
}

/** Hash an existing file without holding the event loop for its whole length. */
async function hashFile(path: string, hash: Hash = createHash('sha256')): Promise<Hash> {
  for await (const chunk of createReadStream(path, { highWaterMark: HASH_READ_CHUNK })) hash.update(chunk as Buffer);
  return hash;
}

/** True when an existing file already matches the pinned size + checksum. */
export function fileMatches(path: string, spec: VerifiedDownloadSpec): boolean {
  try {
    const expected = checksumPin(spec.sha256);
    if (expected === undefined) return false;
    if (!existsSync(path)) return false;
    if (statSync(path).size !== spec.bytes) return false;
    return hashFileSync(path).digest('hex') === expected;
  } catch {
    return false;
  }
}

async function fileMatchesAsync(path: string, spec: VerifiedDownloadSpec, expected: string): Promise<boolean> {
  try {
    if (!existsSync(path) || statSync(path).size !== spec.bytes) return false;
    return (await hashFile(path)).digest('hex') === expected;
  } catch {
    return false;
  }
}

/** One result per path, bound to both the actual file revision and expected pin. */
const verificationCache = new Map<string, { revision: string; expectedBytes: number; expectedSha256: string; matched: boolean }>();
function verificationFileRevision(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error('Verification source is not a file');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Like {@link fileMatches} but cached by file revision and expected pin: repeated status
 * polls do not re-read and re-hash a 63MB model on every call.
 * A changed file or expected pin is re-verified with the full hash;
 * provisioning decisions (download skip/replace) always use the full hash.
 */
export function fileMatchesCached(path: string, spec: VerifiedDownloadSpec): boolean {
  const expectedSha256 = checksumPin(spec.sha256);
  if (expectedSha256 === undefined) return false;
  const expectedBytes = spec.bytes;
  let revision: string;
  try {
    revision = verificationFileRevision(path);
  } catch {
    verificationCache.delete(path);
    return false;
  }
  const cached = verificationCache.get(path);
  if (cached && cached.revision === revision && cached.expectedBytes === expectedBytes && cached.expectedSha256 === expectedSha256) return cached.matched;
  const matched = fileMatches(path, { url: spec.url, bytes: expectedBytes, sha256: expectedSha256 });
  try { if (verificationFileRevision(path) !== revision) { verificationCache.delete(path); return false; } }
  catch { verificationCache.delete(path); return false; }
  if (verificationCache.size >= 128) verificationCache.clear();
  verificationCache.set(path, { revision, expectedBytes, expectedSha256, matched });
  return matched;
}

/**
 * Where a component's bytes collect until they verify. One fixed name per
 * destination, so the next attempt finds and resumes it.
 */
export function partialDownloadPath(destPath: string): string {
  return `${destPath}.download`;
}

function removeQuietly(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); }
  catch (error) { logger.warn('verified download partial cleanup failed', { path, error: summarizeError(error) }); }
}

function partialSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

type Failure = Extract<VerifiedDownloadResult, { ok: false }>;
/** A failed transfer, and whether bytes were added before it failed (so a resume is worth trying). */
type TransferFailure = Failure & { readonly progressed: boolean };

/**
 * Download a component to `destPath` atomically, verifying size + sha256.
 * Skips (returns skipped:true) when the file already matches. Never leaves a
 * partial or unverified file at `destPath`.
 */
export async function downloadVerifiedFile(options: VerifiedDownloadOptions): Promise<VerifiedDownloadResult> {
  const { spec: declared, destPath } = options;
  const spec = { url: declared.url, bytes: declared.bytes, sha256: declared.sha256 };
  const expected = checksumPin(spec.sha256);
  if (expected === undefined) return { ok: false, reason: 'checksum-mismatch', error: 'missing or malformed SHA-256 pin' };
  if (await fileMatchesAsync(destPath, spec, expected)) {
    options.onProgress?.('skip', `${destPath} already present and verified`, spec.bytes);
    return { ok: true, path: destPath, bytes: spec.bytes, skipped: true };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const idleTimeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const partPath = partialDownloadPath(destPath);
  mkdirSync(dirname(destPath), { recursive: true });
  // A partial larger than the pin cannot be the start of this file.
  if (partialSize(partPath) > spec.bytes) removeQuietly(partPath);

  const origins = [declared.url, ...(declared.fallbackUrls ?? [])];
  const failures: Failure[] = [];
  for (const [index, origin] of origins.entries()) {
    const outcome = await fromOrigin(origin);
    if (outcome.ok) return outcome;
    failures.push(outcome);
    if (options.signal?.aborted) break;
    if (index < origins.length - 1) {
      logger.warn('verified download origin failed, trying the next', { url: origin, reason: outcome.reason, error: outcome.error });
    }
  }
  // The first origin's failure is the one reported (its reason is the one a
  // caller branches on); the mirrors' failures are appended so none is hidden.
  const [first, ...mirrors] = failures;
  if (!first) return { ok: false, reason: 'download-failed', error: 'no download origin declared' };
  return mirrors.length === 0 ? first : { ...first, error: `${first.error}; fallback origins also failed: ${mirrors.map((m) => m.error).join('; ')}` };

  async function fromOrigin(url: string): Promise<VerifiedDownloadResult> {
    for (let resumes = 0; ; resumes++) {
      const outcome = await transfer(url);
      if (outcome.ok) return outcome;
      if (!outcome.progressed || outcome.reason !== 'download-failed' || resumes >= MAX_RESUMES || options.signal?.aborted) {
        return { ok: false, reason: outcome.reason, error: outcome.error };
      }
      options.onProgress?.('download', `connection lost after ${partialSize(partPath)} bytes; resuming`, partialSize(partPath));
    }
  }

  async function transfer(url: string): Promise<Extract<VerifiedDownloadResult, { ok: true }> | TransferFailure> {
    const have = partialSize(partPath);
    const idle = new AbortController();
    const signal = options.signal ? AbortSignal.any([idle.signal, options.signal]) : idle.signal;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new DOMException(`no data received for ${Math.round(idleTimeoutMs / 1000)} s`, 'TimeoutError')), idleTimeoutMs);
    };
    let added = 0;
    let fd: number | undefined;
    try {
      touch();
      options.onProgress?.('download', have > 0 ? `resuming ${url} at byte ${have}` : `fetching ${url}`, have);
      const response = await doFetch(url, { signal, ...(have > 0 ? { headers: { Range: `bytes=${have}-` } } : {}) });
      let offset = 0;
      if (have > 0 && response.status === 206 && contentRangeStart(response.headers.get('content-range')) === have) {
        offset = have;
      } else if (response.status === 416 && have > 0) {
        // The server will not serve from there; the partial is not trusted.
        removeQuietly(partPath);
        return { ok: false, reason: 'download-failed', error: `HTTP 416 resuming ${url}; the partial download was discarded`, progressed: true };
      } else if (!response.ok || response.status === 206) {
        return { ok: false, reason: 'download-failed', error: `HTTP ${response.status} for ${url}`, progressed: false };
      }
      if (!response.body) return { ok: false, reason: 'download-failed', error: `no response body from ${url}`, progressed: false };
      const announced = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(announced) && offset + announced !== spec.bytes) {
        if (offset > 0) removeQuietly(partPath);
        return { ok: false, reason: 'size-mismatch', error: `expected ${spec.bytes} bytes, the server announced ${offset + announced} (wrong asset)`, progressed: false };
      }
      // A resumed transfer hashes what is already on disk first, so the
      // running hash covers the whole file.
      const hash = offset > 0 ? await hashFile(partPath) : createHash('sha256');
      fd = openSync(partPath, offset > 0 ? 'a' : 'w');
      let done = offset;
      let reported = done;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        touch();
        if (done + chunk.byteLength > spec.bytes) {
          closeSync(fd); fd = undefined;
          removeQuietly(partPath);
          return { ok: false, reason: 'size-mismatch', error: `expected ${spec.bytes} bytes, got more (wrong asset)`, progressed: false };
        }
        writeSync(fd, chunk);
        hash.update(chunk);
        done += chunk.byteLength;
        added += chunk.byteLength;
        if (done - reported >= PROGRESS_STEP_BYTES) {
          reported = done;
          options.onProgress?.('download', undefined, done);
        }
      }
      closeSync(fd); fd = undefined;
      clearTimeout(idleTimer);
      if (done !== spec.bytes) {
        // The server ended the body cleanly short of the pin: a different file.
        // A dropped connection throws instead and keeps its bytes for a resume.
        removeQuietly(partPath);
        return { ok: false, reason: 'size-mismatch', error: `expected ${spec.bytes} bytes, got ${done} (truncated or wrong asset)`, progressed: false };
      }
      options.onProgress?.('verify', 'verifying checksum', done);
      const actual = hash.digest('hex');
      if (actual !== expected) {
        // Checksum mismatch: refuse and keep NOTHING.
        removeQuietly(partPath);
        return { ok: false, reason: 'checksum-mismatch', error: `sha256 mismatch: expected ${spec.sha256}, got ${actual}`, progressed: false };
      }
      renameSync(partPath, destPath);
      options.onProgress?.('done', `installed ${destPath}`, done);
      return { ok: true, path: destPath, bytes: done, skipped: false };
    } catch (error) {
      // The bytes received so far stay for the next attempt.
      return { ok: false, reason: 'download-failed', error: summarizeError(signal.aborted ? signal.reason ?? error : error), progressed: added > 0 };
    } finally {
      clearTimeout(idleTimer);
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Already closed. */ } }
    }
  }
}

/** The first byte position of a `Content-Range: bytes <start>-<end>/<total>` header. */
function contentRangeStart(value: string | null): number | undefined {
  const match = value ? /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(value.trim()) : null;
  return match ? Number(match[1]) : undefined;
}
