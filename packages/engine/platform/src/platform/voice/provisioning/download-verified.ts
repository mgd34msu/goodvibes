/**
 * download-verified.ts, atomic, checksum-verified download of one managed
 * voice-runtime component (engine archive or model file).
 *
 * Extends the atomic pattern (temp file in the same directory, then
 * rename) with a pinned size + sha256 gate: a byte-count or checksum mismatch
 * refuses the write and keeps NOTHING at the final path, so a corrupted or
 * tampered download can never be handed to the speech engine. Resumable by
 * re-run: an existing file whose checksum already matches is skipped.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface VerifiedDownloadSpec {
  readonly url: string;
  /** Expected byte count (pinned). */
  readonly bytes: number;
  /** Expected lowercase hex sha256 (pinned). */
  readonly sha256: string;
}

export interface VerifiedDownloadOptions {
  readonly spec: VerifiedDownloadSpec;
  readonly destPath: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** Progress callback (best-effort). */
  readonly onProgress?: ((phase: 'skip' | 'download' | 'verify' | 'done', message?: string) => void) | undefined;
}

export type VerifiedDownloadResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number; readonly skipped: boolean }
  | { readonly ok: false; readonly reason: 'download-failed' | 'checksum-mismatch' | 'size-mismatch'; readonly error: string };

/** External download pins require SHA-256; only actual pin comparisons call this. */
function sha256Hex(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

function checksumPin(value: string): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

/** True when an existing file already matches the pinned size + checksum. */
export function fileMatches(path: string, spec: VerifiedDownloadSpec): boolean {
  try {
    const expected = checksumPin(spec.sha256);
    if (expected === undefined) return false;
    if (!existsSync(path)) return false;
    if (statSync(path).size !== spec.bytes) return false;
    return sha256Hex(readFileSync(path)) === expected;
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
 * polls do not synchronously re-read and re-hash a 63MB model on every call.
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
 * Download a component to `destPath` atomically, verifying size + sha256.
 * Skips (returns skipped:true) when the file already matches, this is what
 * makes a re-run resumable. Never leaves a partial or unverified file in place.
 */
export async function downloadVerifiedFile(options: VerifiedDownloadOptions): Promise<VerifiedDownloadResult> {
  const { spec: declared, destPath } = options;
  const spec = { url: declared.url, bytes: declared.bytes, sha256: declared.sha256 };
  const expected = checksumPin(spec.sha256);
  if (expected === undefined) return { ok: false, reason: 'checksum-mismatch', error: 'missing or malformed SHA-256 pin' };
  if (fileMatches(destPath, spec)) {
    options.onProgress?.('skip', `${destPath} already present and verified`);
    return { ok: true, path: destPath, bytes: spec.bytes, skipped: true };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const dir = dirname(destPath);
  const tmpPath = join(dir, `.${randomBytes(8).toString('hex')}.part`);
  try {
    options.onProgress?.('download', `fetching ${spec.url}`);
    const response = await doFetch(spec.url, { signal: AbortSignal.timeout(options.timeoutMs ?? 600_000) });
    if (!response.ok) {
      return { ok: false, reason: 'download-failed', error: `HTTP ${response.status} for ${spec.url}` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== spec.bytes) {
      return { ok: false, reason: 'size-mismatch', error: `expected ${spec.bytes} bytes, got ${bytes.length} (truncated or wrong asset)` };
    }
    options.onProgress?.('verify', 'verifying checksum');
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      // Checksum mismatch: refuse and keep NOTHING.
      return { ok: false, reason: 'checksum-mismatch', error: `sha256 mismatch: expected ${spec.sha256}, got ${actual}` };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, bytes);
    if (statSync(tmpPath).size !== bytes.length) {
      unlinkSync(tmpPath);
      return { ok: false, reason: 'download-failed', error: 'temp write incomplete' };
    }
    renameSync(tmpPath, destPath);
    options.onProgress?.('done', `installed ${destPath}`);
    return { ok: true, path: destPath, bytes: bytes.length, skipped: false };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupError) {
      logger.warn('verified download partial cleanup failed', { tmpPath, error: summarizeError(cleanupError) });
    }
    return { ok: false, reason: 'download-failed', error: summarizeError(error) };
  }
}
