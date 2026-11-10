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
 *     `key-` token, the word after `Bearer`) that has not been read as
 *     something other than a credential by `engine.runtime.at-rest-credential`,
 *     in a serialized JSON line before it is appended.
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
import { isClassicOperation } from './decision-policy.js';
import { lstatSync, unlinkSync, readdirSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mapLimit } from '@goodvibes-jev/judgment';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { captureRedactionSource, containsIssuerCredential, findCredentialCandidates, redactIssuerCredentials, type CredentialCandidate } from '../utils/redaction.js';
import { logger } from '../utils/logger.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { atRestCredential } from './batteries/at-rest-credential.js';
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
  const redactRaw = get(AT_REST_CONFIG_KEYS.redactEnabled);
  const ageDaysRaw = get(AT_REST_CONFIG_KEYS.maxAgeDays);
  const totalMbRaw = get(AT_REST_CONFIG_KEYS.maxTotalMb);
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
// Candidate spans: `engine.runtime.at-rest-credential`
// ---------------------------------------------------------------------------

/** How much text on each side of a candidate span the reading sees. */
const CANDIDATE_CONTEXT_CHARS = 160;
/** How many span readings run at once; each span is its own request. */
const CANDIDATE_READ_CONCURRENCY = 4;
/** Immutable original and its current local profile/issuer projection. Never logged. */
interface AdmittedLine {
  readonly text: string;
  readonly redaction: ReturnType<typeof captureRedactionSource>;
  readonly readings: Map<string, SpanReading>;
  readonly pending: Map<string, PendingSpan>;
}
interface SpanReading {
  readonly clear: boolean;
  readonly redaction: ReturnType<typeof captureRedactionSource>;
  readonly authority: JudgmentPortCapture;
}
interface PendingSpan {
  readonly authority: JudgmentPortCapture;
  readonly promise: Promise<void>;
}

let readingGeneration = 0;
// Offsets are meaningful only inside this original admitted write. Its maps
// expire with that write; a later write receives no exemption or pending work.
const spanKey = (candidate: CredentialCandidate): string => `${candidate.start}:${candidate.end}`;
const unavailable = (): Error => new Error('At-rest credential reading is unavailable; unread spans remain masked');

/** Match issuer formats in strings/keys and nested JSON-string envelopes. */
function containsDecodedIssuer(value: unknown): boolean {
  let nodes = 0;
  let characters = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 64) throw unavailable();
    if (typeof entry === 'string') {
      characters += entry.length;
      if (characters > 1_000_000) throw unavailable();
      if (containsIssuerCredential(entry)) return true;
      const trimmed = entry.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let decoded: unknown;
        try { decoded = JSON.parse(entry) as unknown; } catch { return false; }
        return visit(decoded, depth + 1);
      }
      return false;
    }
    if (Array.isArray(entry)) return entry.some((child) => visit(child, depth + 1));
    if (entry && typeof entry === 'object') {
      return Object.entries(entry).some(([key, child]) => visit(key, depth + 1) || visit(child, depth + 1));
    }
    return false;
  };
  return visit(value, 0);
}

/**
 * Admit the COMPLETE original before extracting any candidate or context.
 * The ledger span writer also supplies JSONL batches. Inspect both the intact
 * input (including multiline material) and every complete decoded record.
 * This is the existing deterministic floor, not universal secret detection.
 * Refused sources still use the existing local issuer/candidate masking path;
 * this boundary does not change the persisted journal/ledger record schema.
 */
function admitLine(original: string): AdmittedLine | undefined {
  try {
    const redaction = captureRedactionSource();
    snapshotJudgmentInput(original);
    if (containsIssuerCredential(original)) return undefined;
    let records: unknown[];
    try { records = [JSON.parse(original) as unknown]; }
    catch {
      const lines = original.split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0) return undefined;
      records = lines.map((line) => JSON.parse(line) as unknown);
    }
    for (const record of records) {
      snapshotJudgmentInput(record);
      // JSON escaping must not conceal an issuer format from admission.
      if (containsDecodedIssuer(record)) return undefined;
    }
    const text = redactIssuerCredentials(original);
    redaction.assertCurrent();
    return Object.freeze({ text, redaction, readings: new Map<string, SpanReading>(), pending: new Map<string, PendingSpan>() });
  } catch {
    // Never retain or inspect an upstream rejection, which may carry source text.
    return undefined;
  }
}

/** Fence transport AND the installed decision recorder without retaining original text. */
function captureReadingAuthority(site: string, redactions: readonly ReturnType<typeof captureRedactionSource>[]): JudgmentPortCapture {
  const generation = readingGeneration;
  // Capture only value-free assertions, never AdmittedLine/source strings.
  const checks = redactions.map((source) => source.assertCurrent);
  return captureJudgmentPort(site, { assertCurrent: () => {
    if (generation !== readingGeneration) throw unavailable();
    for (const check of checks) check();
  } });
}

function remembered(line: AdmittedLine, candidate: CredentialCandidate, authority: JudgmentPortCapture): boolean | undefined {
  const key = spanKey(candidate);
  const reading = line.readings.get(key);
  if (!reading) return undefined;
  try {
    authority.assertCurrent();
    if (reading.authority.identity !== authority.identity) return undefined;
    line.redaction.assertCurrent();
    reading.redaction.assertCurrent();
    reading.authority.assertCurrent();
    authority.assertCurrent();
    return reading.clear;
  }
  catch { line.readings.delete(key); return undefined; }
}

function rememberSpan(line: AdmittedLine, key: string, clear: boolean, authority: JudgmentPortCapture): void {
  line.readings.set(key, { clear, authority, redaction: line.redaction });
}

function unreadCandidates(line: AdmittedLine, authority: JudgmentPortCapture): CredentialCandidate[] {
  return findCredentialCandidates(line.text).filter((candidate) => remembered(line, candidate, authority) === undefined);
}

function readSpan(candidate: CredentialCandidate, line: AdmittedLine, site: string, authority: JudgmentPortCapture): Promise<void> {
  const key = spanKey(candidate);
  const inFlight = line.pending.get(key);
  if (inFlight?.authority.identity === authority.identity) return inFlight.promise;
  const generation = readingGeneration;
  const assertCurrent = () => {
    authority.assertCurrent();
    line.redaction.assertCurrent();
    // Both strings are immutable, completely admitted inputs. The captured
    // redaction owner above retires profile/identity changes, including ABA.
    if (generation !== readingGeneration) throw unavailable();
    authority.assertCurrent();
  };
  const read = (async (): Promise<void> => {
    try {
      assertCurrent();
      const state = {
        span: candidate.value,
        context: line.text.slice(Math.max(0, candidate.start - CANDIDATE_CONTEXT_CHARS), candidate.end + CANDIDATE_CONTEXT_CHARS),
      };
      const run = await atRestCredential.run(authority.port, state, {
        site, signal: authority.signal, beforeAttempt: assertCurrent,
      });
      assertCurrent();
      // Critical's settled no already requires >=0.9 confidence; its legacy band never emits act.
      const clear = run.readings.credential.verdict === 'no';
      run.recordAction(clear ? 'keep' : 'mask');
      assertCurrent();
      rememberSpan(line, key, clear, authority);
    } catch { throw unavailable(); }
  })();
  const pending = { authority, promise: read };
  line.pending.set(key, pending);
  const release = () => { if (line.pending.get(key) === pending) line.pending.delete(key); };
  void read.then(release, release);
  return read;
}

async function readAdmittedLines(lines: readonly AdmittedLine[], site: string, authority: JudgmentPortCapture): Promise<void> {
  const work: Array<{ candidate: CredentialCandidate; line: AdmittedLine }> = [];
  const originals = new Set<AdmittedLine>();
  for (const line of lines) {
    if (originals.has(line)) continue;
    originals.add(line);
    for (const candidate of unreadCandidates(line, authority)) {
      work.push({ candidate, line });
    }
  }
  await mapLimit(work, CANDIDATE_READ_CONCURRENCY, ({ candidate, line }) => readSpan(candidate, line, site, authority));
}

/**
 * Protected or unsupported originals are never sent to the judgment port.
 * Admissible records retain the semantic reading; missing/failed ports reject
 * with a fixed error and leave unread spans masked. No source is truncated to
 * make it pass admission. Returns projections from this exact call; it never
 * primes a later write or retains possible credentials after the call ends.
 * This does not certify arbitrary unknown tokens safe.
 */
export async function readAtRestCredentialSpans(lines: readonly string[], site: string): Promise<readonly string[]> {
  try {
    // Capture the complete array structurally. Its elements are independent
    // complete sources; each JSONL payload is admitted intact, never per window.
    let originals: readonly string[];
    try {
      const captured = captureOwnedJson(lines);
      if (!Array.isArray(captured) || captured.some((line) => typeof line !== 'string')) return Object.freeze([]);
      originals = captured as readonly string[];
    } catch { return Object.freeze([]); }
    // Classic keeps issuer and candidate masking without any semantic read.
    if (isClassicOperation()) return Object.freeze(originals.map(line => projectAtRestLine(line)));
    const owned = new Map<string, AdmittedLine | undefined>();
    const admitted = originals.map(original => {
      if (!owned.has(original)) owned.set(original, admitLine(original));
      return owned.get(original);
    });
    const readable = [...new Set(admitted.filter((line): line is AdmittedLine => line !== undefined))];
    let authority: JudgmentPortCapture | undefined;
    if (readable.some(line => findCredentialCandidates(line.text).length > 0)) {
      authority = captureReadingAuthority(site, readable.map(line => line.redaction));
      await readAdmittedLines(readable, site, authority);
    }
    return Object.freeze(originals.map((original, index) =>
      projectAtRestLine(original, admitted[index] ? authority : undefined, admitted[index])));
  } catch { throw unavailable(); }
}

/** Project using only the caller's captured authority; a queued line cannot borrow a new runtime. */
function projectAtRestLine(line: string, authority?: JudgmentPortCapture, source?: AdmittedLine): string {
  let text: string;
  try { text = redactIssuerCredentials(line); } catch { throw unavailable(); }
  const candidates = findCredentialCandidates(text);
  if (!candidates.length) return text;
  let currentAuthority = authority;
  try { source?.redaction.assertCurrent(); } catch { currentAuthority = undefined; }
  // With no live semantic authority every candidate stays masked. In
  // particular, crash capture and Classic never borrow a completed reading.
  const admitted = currentAuthority ? source ?? admitLine(line) : undefined;
  let out = '';
  let cursor = 0;
  for (const candidate of candidates) {
    if (admitted?.text === text && currentAuthority && remembered(admitted, candidate, currentAuthority) === true) continue;
    out += text.slice(cursor, candidate.start) + candidate.marker;
    cursor = candidate.end;
  }
  return out + text.slice(cursor);
}

/** Local issuer/profile protection plus candidate masking, retaining the JSONL schema. */
export function redactAtRestLine(line: string): string {
  return projectAtRestLine(line);
}

/** Retire all admitted reading generations; no completed cross-write cache exists. */
export function clearAtRestCredentialReadings(): void {
  readingGeneration += 1;
}

/** Ordered writer: capture source and reading authority when the line is queued. */
export class AtRestLineWriter {
  readonly #site: string;
  #tail: Promise<void> | null = null;

  constructor(site: string) { this.#site = site; }

  write(line: string, append: (redacted: string) => void): void {
    const admitted = isClassicOperation() ? undefined : admitLine(line);
    let authority: JudgmentPortCapture | undefined;
    if (admitted && findCredentialCandidates(admitted.text).length > 0) {
      try { authority = captureReadingAuthority(this.#site, [admitted.redaction]); } catch { /* Unavailable: keep unread spans masked. */ }
    }
    const needsReading = admitted !== undefined && authority !== undefined && unreadCandidates(admitted, authority).length > 0;
    if (this.#tail === null && !needsReading) {
      append(projectAtRestLine(line, authority, admitted));
      return;
    }
    const previous = this.#tail ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (needsReading && admitted && authority) await readAdmittedLines([admitted], this.#site, authority);
      })
      .catch(() => {
        // Value-free, nonrecursive failure: no error-display reading or borrowed error fields.
        try { logger.warn('[at-rest] credential span reading failed; unread spans are masked'); } catch { /* Diagnostics are best effort. */ }
      })
      .then(() => append(projectAtRestLine(line, authority, admitted)))
      .catch(() => {
        try { logger.warn('[at-rest] writing a queued line failed'); } catch { /* Diagnostics are best effort. */ }
      });
    this.#tail = next;
    void next.then(() => { if (this.#tail === next) this.#tail = null; });
  }

  async flush(): Promise<void> {
    while (this.#tail !== null) await this.#tail;
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
