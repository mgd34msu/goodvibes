/**
 * at-rest-persistence.ts, the redaction + retention policy layer for the two
 * raw-content on-disk writers: the per-agent transcript journal
 * (agents/session.ts, `<agentId>.jsonl`) and the local execution ledger
 * (runtime/telemetry/exporters/local-ledger.ts, spans + `<file>.ledger.jsonl`).
 *
 * Both historically appended raw serialized records, a prompt, a tool stdout,
 * an event payload, straight to disk, so an API key or bearer token that
 * flowed through a turn was persisted in the clear. The redaction helper
 * (utils/redaction.ts) existed but was wired only to the telemetry query egress,
 * so nothing masked the at-rest copy.
 *
 * This module supplies:
 *   - redactAtRestLine: mask profile values and issuer-reserved credential
 *     formats (redactIssuerCredentials), and every candidate span (an `sk-` or
 *     `key-` token, the word after `Bearer`) that its characters do not prove
 *     harmless (isReadableCredentialCandidate), in a serialized JSON line
 *     before it is appended. Decided in code: no span is sent anywhere.
 *     The markers replace only the matched secret substrings with
 *     JSON-safe `[REDACTED_*]` markers, so the line stays valid JSON and its
 *     non-secret content stays readable, a redacted record never pretends the
 *     content was not there, it shows the marker.
 *
 *     Credentials ONLY, deliberately. utils/redaction.ts also carries
 *     home-path anonymisation, and the egress helper (redactSensitiveData)
 *     applies both, correctly, because a session export goes to someone who
 *     is not the owner. These files do not go anywhere: they sit on the
 *     owner's disk, inside the very directory those patterns rewrite.
 *     Anonymising the owner from themselves turned `/home/owner/Projects/x`
 *     into `/home/[REDACTED]/Projects/x` at write time and irreversibly, which
 *     costs the journal the one detail that makes a stale entry worth reading
 *     and protects nobody.
 *   - enforceFileRetention: an age + total-size cap over a set of append-only
 *     files, deleting oldest-first. A production caller invokes it at a natural
 *     lifecycle point (the checkpoint-gc lesson: retention that is defined but
 *     never called reclaims nothing).
 *   - resolveAtRestPolicy: read the honest-default config keys (redaction on by
 *     default; retention generous but bounded) into a resolved policy.
 */
import { lstatSync, unlinkSync, readdirSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findCredentialCandidates, redactIssuerCredentials } from '../utils/redaction.js';
import { captureExistingDirectory } from '../utils/atomic-json-store.js';

/** Resolved at-rest policy the journal + ledger writers consult. */
export interface AtRestPolicy {
  /** Redact secret/credential patterns in each record before it is written. */
  readonly redact: boolean;
  /** Retention caps enforced over the on-disk files. */
  readonly retention: {
    /** Delete files whose mtime is older than this many milliseconds. */
    readonly maxAgeMs: number;
    /** Delete oldest files until the set's total size is under this many bytes. */
    readonly maxTotalBytes: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/**
 * The honest defaults, used when no config is wired: redaction ON, retention
 * generous but bounded (30 days / 512 MB) so a long-lived daemon cannot grow
 * these files without limit while a normal debugging window stays intact.
 */
export const DEFAULT_AT_REST_POLICY: AtRestPolicy = {
  redact: true,
  retention: { maxAgeMs: 30 * DAY_MS, maxTotalBytes: 512 * MB },
};

/** Config keys backing the policy (see config/schema-domain-at-rest.ts). */
export const AT_REST_CONFIG_KEYS = {
  redactEnabled: 'atRest.redactionEnabled',
  maxAgeDays: 'atRest.retentionMaxAgeDays',
  maxTotalMb: 'atRest.retentionMaxTotalMb',
} as const;

/**
 * Build a resolved policy from a config getter (ConfigManager.get shape). A
 * missing/invalid value falls back to the honest default rather than throwing,
 * a config problem must never take the write path down.
 */
export function resolveAtRestPolicy(get?: (key: string) => unknown): AtRestPolicy {
  if (!get) return DEFAULT_AT_REST_POLICY;
  const read = (key: string): unknown => {
    try { return get(key); } catch { return undefined; }
  };
  const redactRaw = read(AT_REST_CONFIG_KEYS.redactEnabled);
  const ageDaysRaw = read(AT_REST_CONFIG_KEYS.maxAgeDays);
  const totalMbRaw = read(AT_REST_CONFIG_KEYS.maxTotalMb);
  const redact = typeof redactRaw === 'boolean' ? redactRaw : DEFAULT_AT_REST_POLICY.redact;
  const maxAgeMs = typeof ageDaysRaw === 'number' && ageDaysRaw > 0
    ? ageDaysRaw * DAY_MS
    : DEFAULT_AT_REST_POLICY.retention.maxAgeMs;
  const maxTotalBytes = typeof totalMbRaw === 'number' && totalMbRaw > 0
    ? totalMbRaw * MB
    : DEFAULT_AT_REST_POLICY.retention.maxTotalBytes;
  return { redact, retention: { maxAgeMs, maxTotalBytes } };
}

// ---------------------------------------------------------------------------
// Candidate spans: decided in code, never sent anywhere
// ---------------------------------------------------------------------------

/** Words a placeholder is made of; an all-caps value built from them grants nothing. */
const PLACEHOLDER_WORD = /(?:^|_)(?:YOUR|MY|THE|API|ACCESS|AUTH|BEARER|TOKEN|KEY|SECRET|PASSWORD|HERE|PLACEHOLDER|REPLACE|ME|EXAMPLE|DUMMY|FAKE|TEST|CHANGE|INSERT|XXX+)(?=_|$)/;

/** A plain word: letters only, at most one leading capital, with a vowel. */
function isPlainWord(part: string): boolean {
  return /^[A-Za-z]?[a-z]{0,19}$/.test(part) && part.length > 0 && /[aeiouy]/i.test(part);
}

/**
 * Whether a candidate span is provably not a credential, from its characters
 * alone. A span this cannot clear is masked: a masked word in the owner's own
 * log is the only cost, and the value never leaves the machine to be judged.
 *
 * Readable:
 *   - a plain word after "Bearer" in prose ("the bearer of bad news");
 *   - an all-caps placeholder such as YOUR_TOKEN_HERE;
 *   - filler made of one or two repeated characters (`sk-xxxxxxxx…`);
 *   - an `sk-`/`key-` name built from two or more plain words, with short
 *     numeric parts allowed (`key-rotation-policy-for-tenants`,
 *     `key-value-store-migration-2024`, `sk-spinner-double-bounce-animation`).
 * A random token has mixed case, digits inside words, or one long run, and
 * stays masked.
 */
export function isReadableCredentialCandidate(value: string): boolean {
  const prefixed = /^(sk|key)-/i.exec(value);
  const body = prefixed ? value.slice(prefixed[0].length) : value;
  if (body.length === 0) return false;
  const significant = body.replace(/[-_.]/g, '');
  if (significant.length > 0 && new Set(significant.toLowerCase()).size <= 2) return true;
  if (/^[A-Z][A-Z_]{1,39}$/.test(body) && PLACEHOLDER_WORD.test(body)) return true;
  if (!prefixed) {
    // The word after "Bearer": a hex-only run of 8 or more could be a token.
    return isPlainWord(body) && !(body.length >= 8 && /^[a-f]+$/i.test(body));
  }
  const parts = body.split(/[-_]/);
  let words = 0;
  for (const part of parts) {
    if (/^[0-9]{1,4}$/.test(part)) continue;
    if (!/^[a-z]{1,20}$/.test(part) || !isPlainWord(part)) return false;
    words += 1;
  }
  return words >= 2;
}

/**
 * Mask issuer-reserved formats and every credential candidate span that
 * {@link isReadableCredentialCandidate} cannot clear. Synchronous: one pass of
 * local patterns, no request, no state kept between lines. Throws when the
 * owner-profile redaction source is being replaced, so no line is written
 * against a profile that is changing.
 */
export function redactAtRestLine(line: string): string {
  let text: string;
  // A fixed error: an upstream rejection may carry the very text being protected.
  try { text = redactIssuerCredentials(line); } catch { throw new Error('At-rest redaction is unavailable while the owner profile is changing; the line was not written'); }
  const candidates = findCredentialCandidates(text);
  if (candidates.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const candidate of candidates) {
    if (isReadableCredentialCandidate(candidate.value)) continue;
    out += text.slice(cursor, candidate.start) + candidate.marker;
    cursor = candidate.end;
  }
  return out + text.slice(cursor);
}

/**
 * Writes each line masked, at once, in call order. A failed append throws to
 * the caller, so the caller knows that line is not on disk.
 */
export class AtRestLineWriter {
  /** The site name is accepted from existing callers; nothing is read per site. */
  constructor(_site?: string) {}

  write(line: string, append: (redacted: string) => void): void {
    append(redactAtRestLine(line));
  }

  /** Every line is on disk when write returns; kept so callers can await one point. */
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RetentionOutcome {
  readonly deletedFiles: readonly string[];
  readonly reclaimedBytes: number;
}

interface RetentionFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  removeOriginal(): void;
}
function sameRetentionFile(current: BigIntStats, original: BigIntStats): boolean {
  return current.isFile() && !current.isSymbolicLink() && current.nlink === 1n
    && current.dev === original.dev && current.ino === original.ino && current.mode === original.mode
    && current.uid === original.uid && current.gid === original.gid && current.size === original.size
    && current.mtimeNs === original.mtimeNs && current.ctimeNs === original.ctimeNs && current.birthtimeNs === original.birthtimeNs;
}

/**
 * Enforce the age + total-size caps over a set of append-only files, deleting
 * oldest-first. Missing files are skipped. Deletion failures are swallowed
 * (best-effort gc must never break the write path) but excluded from the
 * reclaimed total. Returns what was reclaimed for the caller to log.
 */
export function enforceFileRetention(files: readonly string[], policy: AtRestPolicy): RetentionOutcome {
  return enforceSelectedRetention(files, policy, new Map());
}

/** Directory enumeration can pass its actual original parent into deletion. */
function enforceSelectedRetention(files: readonly string[], policy: AtRestPolicy,
  parents: Map<string, ReturnType<typeof captureExistingDirectory>>): RetentionOutcome {
  const now = Date.now();
  const stats: RetentionFile[] = [];
  const selected = new Set<string>();
  const uid = process.geteuid?.();
  if (uid === undefined) return { deletedFiles: [], reclaimedBytes: 0 };
  for (const path of files) {
    try {
      const parentPath = dirname(path), parent = parents.get(parentPath) ?? captureExistingDirectory(parentPath);
      parents.set(parentPath, parent); parent.assertCurrent();
      const nativePath = join(parent.canonical, basename(path));
      if (selected.has(nativePath)) continue;
      const original = lstatSync(nativePath, { bigint: true }), size = Number(original.size);
      if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1n || original.uid !== BigInt(uid)
        || !Number.isSafeInteger(size) || size < 0) continue;
      parent.assertCurrent(); selected.add(nativePath);
      stats.push({ path, size, mtimeMs: Number(original.mtimeMs), removeOriginal() {
        parent.assertCurrent();
        if (!sameRetentionFile(lstatSync(nativePath, { bigint: true }), original)) throw new Error('Retention source changed');
        parent.assertCurrent(); unlinkSync(nativePath);
      } });
    } catch {
      // Missing, unsafe, foreign or unreadable leaves are not ours to remove.
    }
  }

  const deleted: string[] = [];
  let reclaimed = 0;
  const attempted = new Set<RetentionFile>();
  const remove = (entry: RetentionFile): boolean => {
    if (attempted.has(entry)) return false;
    attempted.add(entry);
    try {
      entry.removeOriginal();
      deleted.push(entry.path);
      reclaimed += entry.size;
      return true;
    } catch {
      // Best-effort: a file we cannot delete is left in place.
      return false;
    }
  };

  // Age cap: drop anything older than maxAgeMs.
  const survivors: RetentionFile[] = [];
  for (const entry of stats) {
    if (now - entry.mtimeMs > policy.retention.maxAgeMs && remove(entry)) continue;
    survivors.push(entry);
  }

  // Size cap: oldest-first until the surviving set is under the byte budget.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of survivors) {
    if (total <= policy.retention.maxTotalBytes) break;
    if (remove(entry)) total -= entry.size;
  }

  return { deletedFiles: deleted, reclaimedBytes: reclaimed };
}

/**
 * Enforce retention over every `*.jsonl` transcript-journal file in a directory
 * (the per-agent `<agentId>.jsonl` logs). A convenience wrapper over
 * enforceFileRetention that resolves the directory listing; a missing directory
 * is a no-op.
 */
export function enforceJournalDirectoryRetention(dir: string, policy: AtRestPolicy): RetentionOutcome {
  try {
    const parent = captureExistingDirectory(dir);
    parent.assertCurrent();
    const names = readdirSync(parent.canonical).filter((name) => name.endsWith('.jsonl'));
    parent.assertCurrent();
    return enforceSelectedRetention(names.map(name => join(parent.canonical, name)), policy,
      new Map([[parent.canonical, parent]]));
  } catch {
    return { deletedFiles: [], reclaimedBytes: 0 };
  }
}
