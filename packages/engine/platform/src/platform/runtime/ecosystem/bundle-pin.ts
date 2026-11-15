/**
 * bundle-pin.ts
 *
 * SHA-256-pinned bundle distribution. A bundle is fetched from a source
 * (file / URL / git) and its bytes are verified against an EXPECTED SHA-256 pin
 * BEFORE the bundle is ever activated. The refusal is hard and structural:
 *
 *   - a source with no pin           → refused (cannot be represented as trusted)
 *   - a source whose bytes mismatch  → refused (no "install anyway" path)
 *
 * This is the postinstall-checksum lesson made load-bearing: verification is not
 * an advisory step a caller can skip; `fetchAndVerifyBundle` throws before it
 * returns bytes unless the pin matches. All three source kinds resolve to the
 * SAME byte space, so one pin convention (hex SHA-256 of the fetched bytes)
 * governs every source, no split hash spaces.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';

/** A pinned bundle source. `sha256` is REQUIRED, an unpinned source is invalid. */
export interface PinnedBundleSource {
  readonly kind: 'file' | 'url' | 'git';
  /** File path, URL, or git remote (for `git`, combined with `ref`). */
  readonly location: string;
  /** Expected hex SHA-256 of the fetched bytes. Lowercase, 64 hex chars. */
  readonly sha256: string;
  /** Git ref (tag/commit/branch) to archive. Required for `kind: 'git'`. */
  readonly ref?: string | undefined;
}

/** Injectable IO so the fetch path is testable without the network or git. */
export interface BundleFetchDeps {
  /** Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Produce deterministic archive bytes for a git source. Defaults to
   * `git archive --format=tar <ref> --remote=<location>`. Injected in tests.
   */
  readonly gitArchive?: ((location: string, ref: string) => Uint8Array) | undefined;
  /** Largest bundle read from a file or URL source, in bytes. Defaults to {@link MAX_BUNDLE_BYTES}. */
  readonly maxBytes?: number | undefined;
  /** Time allowed for a whole URL fetch, in milliseconds. Defaults to {@link BUNDLE_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/** Largest bundle a file or URL source may supply; bytes are counted before they are hashed. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** Time allowed for a URL source's whole fetch. */
export const BUNDLE_FETCH_TIMEOUT_MS = 60_000;

const MAX_REDIRECTS = 5;

/** Result of comparing fetched bytes to an expected pin. */
export type PinVerification =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly reason: string; readonly expected: string; readonly actual?: string | undefined };

const HEX64 = /^[0-9a-f]{64}$/;

/** Hex SHA-256 of a byte buffer. */
export function computeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verify fetched bytes against an expected pin. A missing/malformed pin is a
 * failure in its own right, the absence of a pin is never "acceptable".
 */
export function verifyBundleBytes(bytes: Uint8Array, expectedSha256: string): PinVerification {
  const expected = (expectedSha256 ?? '').toLowerCase();
  if (!HEX64.test(expected)) {
    return { ok: false, reason: 'missing or malformed SHA-256 pin (need 64 lowercase hex chars)', expected };
  }
  const actual = computeSha256(bytes);
  if (actual !== expected) {
    return { ok: false, reason: 'SHA-256 pin mismatch', expected, actual };
  }
  return { ok: true, sha256: actual };
}

/** Raised when a bundle is refused because its pin is missing or mismatched. */
export class BundlePinRefusal extends Error {
  constructor(
    readonly source: PinnedBundleSource,
    readonly verification: Extract<PinVerification, { ok: false }>,
  ) {
    super(
      `Refused to activate bundle from ${source.kind} source '${source.location}': ${verification.reason}` +
        (verification.actual ? ` (expected ${verification.expected}, got ${verification.actual})` : ''),
    );
    this.name = 'BundlePinRefusal';
  }
}

/** A host a URL source may not name: this machine, a private network or a link-local (metadata) address. */
function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (family === 6) {
    return host === '::' || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('::ffff:');
  }
  return false;
}

/**
 * Refuse a source whose location or ref would be read by the fetching program as
 * something other than a plain address. The pin is checked only after the fetch,
 * so the fetch itself must not be steerable by remote-supplied index content:
 * a git location or ref that starts with `-` would be taken as an option, a
 * `transport::address` remote runs a helper program, and a URL source must be
 * https to a host that is not this machine or an internal network.
 */
export function assertSafeBundleSource(source: PinnedBundleSource): void {
  const location = source.location;
  if (source.kind === 'git') {
    if (location.startsWith('-')) throw new Error(`git source '${location}' is refused: a remote may not start with '-'`);
    if (/^[A-Za-z0-9+.-]*::/.test(location)) throw new Error(`git source '${location}' is refused: transport helper remotes (name::address) are not allowed`);
    const ref = source.ref ?? '';
    if (ref.startsWith('-')) throw new Error(`git source '${location}' is refused: ref '${ref}' may not start with '-'`);
    if (/[\u0000-\u001f\u007f\s]/.test(location) || /[\u0000-\u001f\u007f\s]/.test(ref)) {
      throw new Error(`git source '${location}' is refused: the remote and ref may not contain whitespace or control characters`);
    }
  }
  if (source.kind === 'url') {
    let url: URL;
    try { url = new URL(location); } catch { throw new Error(`URL source '${location}' is not a valid URL`); }
    if (url.protocol !== 'https:') throw new Error(`URL source '${location}' is refused: only https URLs are allowed`);
    if (isInternalHost(url.hostname)) throw new Error(`URL source '${location}' is refused: it names this machine or an internal network address`);
  }
}

/** Collect a response body, refusing as soon as it exceeds the cap. */
async function readCapped(res: Response, maxBytes: number, location: string): Promise<Uint8Array> {
  const tooLarge = (): Error => new Error(`URL source '${location}' is larger than the ${maxBytes}-byte limit; it was not read further`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fetchUrlBytes(source: PinnedBundleSource, deps: BundleFetchDeps): Promise<Uint8Array> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_BUNDLE_BYTES;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? BUNDLE_FETCH_TIMEOUT_MS);
  let target = source.location;
  // Redirects are followed by hand so every hop passes the same address check.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(target, { signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error(`URL source '${source.location}' returned HTTP ${res.status} with no Location`);
      target = new URL(next, target).toString();
      assertSafeBundleSource({ ...source, location: target });
      continue;
    }
    if (!res.ok) throw new Error(`URL source '${source.location}' returned HTTP ${res.status}`);
    return readCapped(res, maxBytes, source.location);
  }
  throw new Error(`URL source '${source.location}' redirected more than ${MAX_REDIRECTS} times`);
}

function resolveBytes(source: PinnedBundleSource, deps: BundleFetchDeps): Uint8Array | Promise<Uint8Array> {
  assertSafeBundleSource(source);
  switch (source.kind) {
    case 'file': {
      const maxBytes = deps.maxBytes ?? MAX_BUNDLE_BYTES;
      const stat = statSync(source.location);
      if (!stat.isFile()) throw new Error(`file source '${source.location}' is not a regular file`);
      if (stat.size > maxBytes) throw new Error(`file source '${source.location}' is larger than the ${maxBytes}-byte limit`);
      return new Uint8Array(readFileSync(source.location));
    }
    case 'git': {
      const ref = source.ref;
      if (!ref) throw new Error(`git source '${source.location}' requires a 'ref' (tag/commit) to pin against`);
      const archive =
        deps.gitArchive ??
        ((location: string, gitRef: string): Uint8Array =>
          new Uint8Array(
            execFileSync('git', ['archive', '--format=tar', `--remote=${location}`, gitRef], {
              maxBuffer: 256 * 1024 * 1024,
              // Only plain transports; a remote cannot pick a helper program.
              env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file:git:ssh:https' },
            }),
          ));
      return archive(source.location, ref);
    }
    case 'url':
      return fetchUrlBytes(source, deps);
  }
}

/**
 * Fetch a pinned bundle and verify its pin BEFORE returning. Throws
 * `BundlePinRefusal` on any missing/mismatched pin, there is no path that
 * yields bytes for an unverified source.
 */
export async function fetchAndVerifyBundle(
  source: PinnedBundleSource,
  deps: BundleFetchDeps = {},
): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const bytes = await resolveBytes(source, deps);
  const verification = verifyBundleBytes(bytes, source.sha256);
  if (!verification.ok) {
    throw new BundlePinRefusal(source, verification);
  }
  return { bytes, sha256: verification.sha256 };
}
