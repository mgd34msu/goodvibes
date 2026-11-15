/**
 * sha256sums, generate and verify a SHA256SUMS manifest over release assets.
 *
 * One record grammar, the coreutils text form `<64 lowercase hex>  <name>`,
 * where a name is one plain file name (`[A-Za-z0-9._+-]`, never `.` or `..`).
 * The generator writes only that form and the parser accepts only that form,
 * so what one writes the other reads. A missing asset is a hard failure, and
 * with an exact payload set a payload the manifest does not list fails too: a
 * release must never ship an unlisted or absent binary.
 */

export interface Sha256Entry {
  /** Name recorded in the manifest (the asset basename). */
  readonly name: string;
  /** Absolute or root-relative path to hash. */
  readonly path: string;
}

/** Reads a file's bytes; returns null when the file is absent or not a regular file. */
export type ReadBytes = (path: string) => Uint8Array | null;
/** Computes a lowercase hex sha256 of bytes. */
export type HashBytes = (bytes: Uint8Array) => string;

const RECORD = /^([0-9a-f]{64}) {2}([A-Za-z0-9._+-]+)$/;
const NAME = /^[A-Za-z0-9._+-]+$/;

/** Whether `name` can be a manifest record name: one plain file name. */
export function isManifestName(name: string): boolean {
  return NAME.test(name) && name !== '.' && name !== '..';
}

export interface Sha256SumsResult {
  readonly ok: boolean;
  /** Manifest text (only meaningful when ok). */
  readonly manifest: string;
  /** Entries whose file was missing. */
  readonly missing: readonly string[];
  /** Entry names that are not plain file names. */
  readonly invalid: readonly string[];
}

/**
 * Produce a SHA256SUMS manifest. Every entry must be a plain file name that
 * resolves to bytes; otherwise ok=false and the entry is listed.
 */
export function generateSha256Sums(entries: readonly Sha256Entry[], readBytes: ReadBytes, hashBytes: HashBytes): Sha256SumsResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const lines: string[] = [];
  for (const entry of entries) {
    if (!isManifestName(entry.name)) { invalid.push(entry.name); continue; }
    const bytes = readBytes(entry.path);
    if (bytes === null) { missing.push(entry.name); continue; }
    lines.push(`${hashBytes(bytes)}  ${entry.name}`);
  }
  if (entries.length === 0 || missing.length > 0 || invalid.length > 0) return { ok: false, manifest: '', missing, invalid };
  return { ok: true, manifest: `${lines.join('\n')}\n`, missing: [], invalid: [] };
}

export interface VerifyResult {
  readonly ok: boolean;
  /** Names whose recomputed hash differs from the manifest. */
  readonly mismatched: readonly string[];
  /** Names present in the manifest but absent on disk. */
  readonly missing: readonly string[];
  /** With an exact payload set: payloads the manifest does not list. */
  readonly unlisted: readonly string[];
  /** With an exact payload set: manifest names that are not among the payloads. */
  readonly unexpected: readonly string[];
}

/** Parse a manifest into name→hash pairs. Throws on any record outside the coreutils text form. */
export function parseSha256Manifest(manifest: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = manifest.endsWith('\n') ? manifest.slice(0, -1).split('\n') : manifest.split('\n');
  for (const [index, line] of lines.entries()) {
    const match = RECORD.exec(line);
    if (!match || !isManifestName(match[2]!)) throw new Error(`Malformed SHA256SUMS record on line ${index + 1}; expected "<64 lowercase hex>  <file name>"`);
    if (map.has(match[2]!)) throw new Error(`Duplicate SHA256SUMS asset: ${match[2]}`);
    map.set(match[2]!, match[1]!);
  }
  if (map.size === 0) throw new Error('SHA256SUMS manifest contains no assets');
  return map;
}

/**
 * Verify assets against a manifest by recomputing each hash. With `exact`, the
 * manifest must also list exactly those payload names: coverage is a name-set
 * comparison, so it costs no extra hashing.
 */
export function verifySha256Sums(manifest: string, readBytes: ReadBytes, hashBytes: HashBytes, exact?: readonly string[]): VerifyResult {
  const expected = parseSha256Manifest(manifest);
  const mismatched: string[] = [];
  const missing: string[] = [];
  for (const [name, hash] of expected) {
    const bytes = readBytes(name);
    if (bytes === null) { missing.push(name); continue; }
    if (hashBytes(bytes) !== hash) mismatched.push(name);
  }
  const payloads = new Set(exact ?? []);
  const unlisted = exact === undefined ? [] : [...payloads].filter(name => !expected.has(name)).sort();
  const unexpected = exact === undefined ? [] : [...expected.keys()].filter(name => !payloads.has(name)).sort();
  return {
    ok: mismatched.length === 0 && missing.length === 0 && unlisted.length === 0 && unexpected.length === 0,
    mismatched, missing, unlisted, unexpected,
  };
}
