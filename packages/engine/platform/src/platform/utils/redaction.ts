import { declaredFieldKind, FieldKindReader, withheldFieldKind, type FieldKind } from './field-kind-reading.js';
import { isClassicOperation } from '../runtime/decision-policy.js';
import { assertRedactionCurrent, ProfileDistinctiveReader, type ProfileRedactionRole } from './redaction-reading.js';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput, captureOwnedJson, retainOwnedJson, judgmentInputProblem, snapshotJudgmentEvidence } from '../gate/judgment-input.js';
import { captureStructuredCredentialReferenceConfigValue } from '../config/structured-credential-config.js';
import { exportCredentialSpans } from './batteries/export-credential-spans.js';

const profileRoles = new ProfileDistinctiveReader();

/**
 * Issuer-reserved credential formats: GitHub, GitLab, Slack and AWS reserve
 * these prefixes for their credentials, so a token in one of these shapes is a
 * credential by the issuer's own definition. Masked everywhere, the owner's
 * own disk included.
 */
const ISSUER_CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(ghp_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(gho_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(glpat-[A-Za-z0-9_-]{20,})/g, replacement: '[REDACTED_GITLAB_TOKEN]' },
  { pattern: /\b(xoxb-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(xoxp-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_AWS_KEY]' },
];

/**
 * Whether text contains a canonical issuer-reserved credential format.
 *
 * A synchronous containment predicate for callers that refuse a write rather
 * than redact it. Unlike redactIssuerCredentials, this does not consult owner
 * profile values or account identity. Ambiguous candidate shapes are not
 * issuer formats and no judgment request or remembered reading is consulted.
 */
export function containsIssuerCredential(text: string): boolean {
  // String.search does not consume a global pattern's lastIndex, so repeated
  // calls and interleaved redaction cannot change the answer.
  return ISSUER_CREDENTIAL_PATTERNS.some(({ pattern }) => text.search(pattern) !== -1);
}

/**
 * Shapes that a credential often has but that ordinary text also has: an
 * `sk-` token of 20 or more characters, a `key-` token of 16 or more, and the
 * word after `Bearer`. `key-rotation-policy-for-tenants` and "the bearer of bad
 * news" fit them too. They only FIND candidate spans; whether a span is kept
 * is decided from its characters alone ({@link isReadableCredentialCandidate}),
 * and no span is sent anywhere to be judged. The Bearer shape matches the
 * token alone, so a marker replaces the token and keeps the word `Bearer`.
 */
const CREDENTIAL_CANDIDATE_SHAPES: ReadonlyArray<{ pattern: RegExp; marker: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, marker: '[REDACTED_API_KEY]' },
  { pattern: /\bkey-[A-Za-z0-9_-]{16,}/g, marker: '[REDACTED_API_KEY]' },
  { pattern: /(?<=Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, marker: '[REDACTED_TOKEN]' },
];

/** A span of text in a credential candidate shape, and the marker that replaces it when masked. */
export interface CredentialCandidate {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly marker: string;
}

/**
 * The spans of `text` in a credential candidate shape, in text order, with
 * overlaps removed (the earlier span wins, and at the same start the longer).
 */
export function findCredentialCandidates(text: string): CredentialCandidate[] {
  const found: CredentialCandidate[] = [];
  for (const { pattern, marker } of CREDENTIAL_CANDIDATE_SHAPES) {
    for (const match of text.matchAll(pattern)) {
      if (match[0].length === 0) continue;
      found.push({ start: match.index, end: match.index + match[0].length, value: match[0], marker });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: CredentialCandidate[] = [];
  for (const candidate of found) {
    const last = spans[spans.length - 1];
    if (last === undefined || candidate.start >= last.end) spans.push(candidate);
  }
  return spans;
}

/** Words a placeholder is made of; an all-caps value built from them grants nothing. */
const PLACEHOLDER_WORD = /(?:^|_)(?:YOUR|MY|THE|API|ACCESS|AUTH|BEARER|TOKEN|KEY|SECRET|PASSWORD|HERE|PLACEHOLDER|REPLACE|ME|EXAMPLE|DUMMY|FAKE|TEST|CHANGE|INSERT|XXX+)(?=_|$)/;

/** A plain word: letters only, at most one leading capital, with a vowel. */
function isPlainWord(part: string): boolean {
  return /^[A-Za-z]?[a-z]{0,19}$/.test(part) && part.length > 0 && /[aeiouy]/i.test(part);
}

/**
 * Whether a candidate span is provably not a credential, from its characters
 * alone. A span this cannot clear is masked: a masked word in a log is the
 * only cost, and the value never leaves the machine to be judged.
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
 * Mask every credential candidate span ({@link findCredentialCandidates})
 * that {@link isReadableCredentialCandidate} cannot clear. One local pass: no
 * request, no state kept between calls.
 */
export function maskCredentialCandidates(text: string): string {
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
 * Identity: the running account's home directory and user name.
 *
 * This is ANONYMISATION, not secret-hiding, and it only earns its keep on text
 * that is about to leave the machine, a session export the owner hands to
 * someone, a telemetry payload. Applied to a file that lives on their own disk
 * it destroys information they need (which directory the work happened in) in
 * order to hide their username from themselves, and the substitution cannot
 * be undone.
 *
 * Kept apart from the credential patterns because the two answer different
 * questions and therefore have different correct call sites. See
 * `redactIssuerCredentials` below.
 *
 * The values are the account's own, read from the operating system and
 * supplied through {@link registerAccountIdentityRedaction}, and matched
 * exactly. They are not guessed from path layout: a `/home/<segment>` pattern
 * takes whatever follows `/home/` for a user name, which is wrong for every
 * path under `/home` that is not this account's home and misses a home that
 * lives anywhere else.
 */
export interface AccountIdentity {
  /** The account's home directory, e.g. `/home/alice`, `/Users/alice`, `C:\\Users\\alice`. */
  readonly homeDirectory: string;
  /** The account's login name, e.g. `alice`. */
  readonly userName: string;
}

/** Supplies the running account's identity. */
export type AccountIdentityReader = () => AccountIdentity;

// A value-free incarnation: even replacing a reader with itself or clearing an
// already empty registration retires prior asynchronous redaction proofs.
let redactionSourceIncarnation: object = Object.freeze({});
let profileGenerationReader: (() => unknown) | undefined;
let profileReadCapture: (() => { readonly assertCurrent: () => void }) | undefined;
let profileRegistration: object = Object.freeze({});
let identityRegistration: object = Object.freeze({});

/** Capture registration ownership and retain the supplied profile read lifetime. */
export function captureRedactionSource(): { readonly assertCurrent: () => void } {
  const incarnation = redactionSourceIncarnation;
  const readGeneration = profileGenerationReader;
  const captureRead = profileReadCapture;
  const readValues = profileValueReader;
  const readIdentity = accountIdentityReader;
  const unavailable = (): never => { throw new Error('Redaction source is no longer current'); };
  let generation: unknown;
  let read: { readonly assertCurrent: () => void } | undefined;
  let values: string, identity: string;
  try {
    generation = readGeneration?.(); read = captureRead?.();
    values = JSON.stringify(captureOwnedJson(readValues?.() ?? null));
    identity = JSON.stringify(captureOwnedJson(readIdentity?.() ?? null));
  } catch { return unavailable(); }
  const assertCurrent = (): void => {
    if (redactionSourceIncarnation !== incarnation || profileGenerationReader !== readGeneration || profileReadCapture !== captureRead
      || profileValueReader !== readValues || accountIdentityReader !== readIdentity) return unavailable();
    let current: unknown;
    try {
      current = readGeneration?.(); assertRedactionCurrent(() => read?.assertCurrent());
      if (JSON.stringify(captureOwnedJson(readValues?.() ?? null)) !== values
        || JSON.stringify(captureOwnedJson(readIdentity?.() ?? null)) !== identity) return unavailable();
    } catch { return unavailable(); }
    if (current !== generation || redactionSourceIncarnation !== incarnation || profileGenerationReader !== readGeneration || profileReadCapture !== captureRead) return unavailable();
  };
  assertCurrent();
  return Object.freeze({ assertCurrent });
}

let accountIdentityReader: AccountIdentityReader | null = null;
let identityPatternCacheKey: string | null = null;
let identityPatterns: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [];

/**
 * Register (or clear, with `null`) the reader that supplies the running
 * account's home directory and user name. The returned disposer clears only
 * its own still-current registration and is safe to call repeatedly.
 *
 * A registered reader rather than an `os` import, for the same reason as
 * {@link registerProfileRedactionValues}: this module runs in browser, worker
 * and mobile bundles that have no operating-system account. With nothing
 * registered, text keeps its paths and names.
 */
export function registerAccountIdentityRedaction(reader: AccountIdentityReader | null): () => void {
  const registration = Object.freeze({});
  identityRegistration = registration;
  redactionSourceIncarnation = Object.freeze({});
  accountIdentityReader = reader;
  identityPatternCacheKey = null;
  identityPatterns = [];
  return () => {
    if (identityRegistration !== registration) return;
    registerAccountIdentityRedaction(null);
  };
}

/**
 * Where a path or name ends: at anything that cannot continue a path segment
 * or a login name. A dot ends it only when no name character follows, so the
 * full stop after `/home/alice.` ends the path and `/home/alice.old` is
 * another directory.
 */
const NAME_END = '(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])';
const NAME_START = '(?<![\\p{L}\\p{N}_.-])';

/**
 * The home directory with its last segment replaced (`/home/[REDACTED]`), so
 * a redacted path still reads as a path, then the user name on its own.
 */
function currentIdentityPatterns(): ReadonlyArray<{ pattern: RegExp; replacement: string }> {
  if (accountIdentityReader === null) return [];
  const { homeDirectory, userName } = accountIdentityReader();
  const home = homeDirectory.replace(/[\\/]+$/, '');
  const name = userName.trim();
  const cacheKey = JSON.stringify([home, name]);
  if (cacheKey !== identityPatternCacheKey) {
    identityPatternCacheKey = cacheKey;
    const separator = Math.max(home.lastIndexOf('/'), home.lastIndexOf('\\'));
    const patterns: Array<{ pattern: RegExp; replacement: string }> = [];
    if (separator >= 0 && separator < home.length - 1) {
      patterns.push({
        pattern: new RegExp(`${escapeRegExp(home)}${NAME_END}`, 'gu'),
        replacement: `${home.slice(0, separator + 1).replace(/\$/g, '$$$$')}[REDACTED]`,
      });
    }
    if (name.length > 0) {
      patterns.push({ pattern: new RegExp(`${NAME_START}${escapeRegExp(name)}${NAME_END}`, 'gu'), replacement: '[REDACTED]' });
    }
    identityPatterns = patterns;
  }
  return identityPatterns;
}

// ---------------------------------------------------------------------------
// Owner-profile containment (docs/owner-profile.md §11.3)
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Local registered values; only safe role descriptors enter semantic readings. */
export interface ProfileRedactionValues {
  /** Closed-tier values, withheld unless their declared safe role settles as non-identifying. */
  readonly guarded: readonly string[];
  /** Values stay local. Only declared field/section roles may enter a reading. */
  readonly guardedFields?: readonly (ProfileRedactionRole & { readonly value: string })[];
  /**
   * Third-party personal data (`People`). Redacted regardless of length or
   * shape, because §10 is absolute. Matched on word boundaries so a two-letter
   * name cannot blank the middle of unrelated words.
   */
  readonly absolute: readonly string[];
}

/** Supplies the closed-tier values present in the loaded profile, if any. */
export type ProfileRedactionValueReader = () => ProfileRedactionValues;

let profileValueReader: ProfileRedactionValueReader | null = null;
let profilePatternCacheKey: string | null = null;
let profilePatterns: readonly RegExp[] = [];

/**
 * Register (or clear, with `null`) the reader that supplies the loaded
 * profile's closed-tier values. The returned disposer clears only its own
 * still-current registration and never restores an older owner.
 *
 * A registered reader rather than an import: `redaction.ts` must stay usable
 * where no profile exists, a browser bundle, a surface with no daemon, a test
 * that never built a store. With nothing registered this module behaves exactly
 * as it did before the profile existed.
 */
export function registerProfileRedactionValues(
  reader: ProfileRedactionValueReader | null,
  /** Trusted host load-generation identity; no profile value is exposed by the capture. */
  generationReader?: () => unknown,
  /** Capture once, then assert this lease across load and write intent, including same-content changes. */
  captureRead?: () => { readonly assertCurrent: () => void },
): () => void {
  const registration = Object.freeze({});
  profileRegistration = registration;
  redactionSourceIncarnation = Object.freeze({});
  profileGenerationReader = reader === null ? undefined : generationReader;
  profileReadCapture = reader === null ? undefined : captureRead;
  profileValueReader = reader;
  profilePatternCacheKey = null;
  profilePatterns = [];
  return () => {
    if (profileRegistration !== registration) return;
    registerProfileRedactionValues(null);
  };
}

/** Prepare safe role readings without disclosing any registered local value. */
export async function prepareProfileRedactionRoles(options: JudgmentReadingOptions = {}): Promise<void> {
  if (isClassicOperation()) { options.signal?.throwIfAborted(); options.assertCurrent?.(); return; }
  const source = captureRedactionSource();
  const signal = options.signal, ownerCurrent = options.assertCurrent;
  const assertCurrent = () => {
    if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent) throw new Error('Redaction operation is no longer current');
    source.assertCurrent(); assertRedactionCurrent(ownerCurrent);
  };
  assertCurrent();
  const roles = profileValueReader?.().guardedFields?.map(({ field, sourceKind }) => ({ field, sourceKind })) ?? [];
  await Promise.all(roles.map((role) => profileRoles.readAsync(role, source, { ...(signal ? { signal } : {}), assertCurrent })));
  assertCurrent();
}

/**
 * Compiled patterns for the current profile values.
 *
 * Recompiled only when the set of values actually changes, because this runs on
 * every at-rest write and every exported message, not once per process, the
 * profile is reloaded whenever the owner edits the file, so a
 * compile-once-at-startup cache would go stale the first time they did.
 */
function currentProfilePatterns(): readonly RegExp[] {
  if (profileValueReader === null) return [];
  const { guarded, absolute, guardedFields = [] } = profileValueReader();
  const source = captureRedactionSource();
  const rolesByValue = new Map<string, { occurrences: number; roles: ProfileRedactionRole[] }>();
  for (const value of guarded) {
    const key = value.trim().toLowerCase();
    const group = rolesByValue.get(key) ?? { occurrences: 0, roles: [] };
    group.occurrences++;
    rolesByValue.set(key, group);
  }
  for (const { value, field, sourceKind } of guardedFields) rolesByValue.get(value.trim().toLowerCase())?.roles.push({ field, sourceKind });
  const ordinary = new Set([...rolesByValue].filter(([, group]) => group.roles.length === group.occurrences
    && group.roles.every((role) => profileRoles.read(role, source) === false)).map(([key]) => key));
  const guardedValues = guarded.map((value) => value.trim()).filter((value) => value.length > 0 && !ordinary.has(value.toLowerCase()));
  // Third-party data is unconditional; only empty values are dropped.
  const absoluteValues = absolute.map((value) => value.trim()).filter((value) => value.length > 0);
  const cacheKey = JSON.stringify([guardedValues, absoluteValues]);
  if (cacheKey !== profilePatternCacheKey) {
    profilePatternCacheKey = cacheKey;
    // Longest first, so a value contained inside another is not left as a
    // half-redacted fragment of the longer one.
    const sortByLength = (a: { value: string }, b: { value: string }): number =>
      b.value.length - a.value.length;
    profilePatterns = [
      ...guardedValues.map((value) => ({ value, boundary: true })),
      ...absoluteValues.map((value) => ({ value, boundary: true })),
    ]
      .sort(sortByLength)
      .map(({ value, boundary }) => (boundary ? boundedPattern(value) : new RegExp(escapeRegExp(value), 'gi')));
  }
  source.assertCurrent();
  return profilePatterns;
}

/**
 * A pattern that only matches the value as a whole token.
 *
 * `- Al` as a bare substring pattern would blank the "Al" out of "Also" and
 * "Already". The lookarounds are on letters and digits only, so a value that
 * starts or ends with punctuation still matches where it should.
 */
function boundedPattern(value: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'giu');
}

function applyPatterns(
  text: string,
  patterns: ReadonlyArray<{ pattern: RegExp; replacement: string }>,
): string {
  let result = text;
  // Profile values first: they are whole values, and replacing them before the
  // generic patterns means an address containing a home path is redacted as a
  // profile value rather than left as a partially-rewritten address.
  for (const pattern of currentProfilePatterns()) {
    result = result.replace(pattern, '[REDACTED_PROFILE]');
  }
  // Iterating the INJECTED list rather than a module constant: that is this
  // lane's narrowing, and hard-coding the egress list here would quietly ignore
  // whatever a caller passed.
  for (const { pattern, replacement } of patterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Credentials AND home-path anonymisation.
 *
 * For text that is LEAVING the machine, session exports, telemetry. Both
 * halves are wanted there: the reader is not the owner, so the owner's username
 * is not theirs to have.
 *
 * Local and deterministic ({@link redactDiagnosticText}): the same text gives
 * the same result on every call, and no model request is started. Callers that
 * want the semantic credential reading as well await
 * {@link redactSensitiveDataAsync}.
 */
export function redactSensitiveData(text: string): string {
  return redactDiagnosticText(text);
}

export interface RedactionOptions extends JudgmentReadingOptions {
  /** Literal values already known to the caller as secrets. They never enter a reading. */
  readonly secretValues?: readonly string[];
  readonly purpose?: 'redaction' | 'export';
}

export interface StructuredRedactionOptions extends RedactionOptions {
  /** Native schema paths; `*` matches an array element, never an object subtree.
   * Declarations retain structure, while every string still passes egress checks.
   * Existing secret and owner-profile roles cannot be weakened. */
  readonly declaredFields?: readonly {
    readonly path: readonly string[];
    readonly kind: 'secret' | 'owner_profile' | 'content' | 'other';
  }[];
}
type OutgoingSpan = CredentialCandidate & { readonly field?: string; readonly syntax: 'assignment-value' | 'candidate-token' };

function outgoingSpans(text: string): OutgoingSpan[] {
  const found: OutgoingSpan[] = findCredentialCandidates(text).map((candidate) => ({ ...candidate, syntax: 'candidate-token' }));
  // Egress withholds every namespace-shaped candidate before a reading. The
  // at-rest discovery minimum is not evidence that a shorter value is public.
  for (const match of text.matchAll(/\b(?:sk-|key-)[A-Za-z0-9_-]+/g)) {
    found.push({ start: match.index, end: match.index + match[0].length, value: match[0],
      marker: '[REDACTED_API_KEY]', syntax: 'candidate-token' });
  }
  // Grammar finds values, never decides whether their field is secret.
  const quoted = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
  const boundary = String.raw`(?=\s+["']?[A-Za-z_][A-Za-z0-9_.-]*["']?(?:\s*[:=]|\s+is\s+)|[ \t]*(?:[\n,;}]|$))`;
  // A complete quoted value owns its contents. An unquoted value ends before
  // the next field, so each independent role reaches the canonical reader.
  const value = new RegExp(String.raw`(${quoted}|["']|[^"'\n,;}][^\n,;}]*?${boundary})`, 'y');
  const assignments = /(?:^|[\s{[,;])["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*/g;
  const declarations = /(?:^|\s)([A-Za-z_][A-Za-z0-9_.-]*)\s+is\s+/g;
  const completeQuoted = new RegExp(`^(?:${quoted})$`);
  const headers: { readonly field: string; readonly start: number; readonly keyStart: number }[] = [];
  for (const grammar of [assignments, declarations]) {
    for (let match = grammar.exec(text); match !== null; match = grammar.exec(text)) {
      grammar.lastIndex = match.index + 1;
      const field = match[1];
      if (field !== undefined) headers.push({ field, start: match.index + match[0].length,
        keyStart: match.index + match[0].indexOf(field) });
    }
  }
  const keyStarts = new Set(headers.map((header) => header.keyStart));
  const values: { readonly field: string; readonly value: string; readonly start: number; readonly end: number }[] = [];
  for (const { field, start } of headers) {
    if (keyStarts.has(start)) continue; // The next field follows an empty value.
    value.lastIndex = start;
    const token = value.exec(text)?.[1];
    if (token !== undefined) values.push({ field, value: token, start, end: start + token.length });
  }
  values.sort((a, b) => a.start - b.start || b.end - a.end);
  const quotedOwners: typeof values = [];
  for (const entry of values) {
    if (completeQuoted.test(entry.value) && (quotedOwners.at(-1)?.end ?? -1) <= entry.start) quotedOwners.push(entry);
  }
  let quotedIndex = 0;
  for (const { field, value, start, end } of values) {
    while (quotedOwners[quotedIndex] !== undefined && quotedOwners[quotedIndex]!.end <= start) quotedIndex++;
    const owner = quotedOwners[quotedIndex];
    if (owner !== undefined && owner.start < start && start < owner.end) continue;
    if ((value.startsWith('"') || value.startsWith("'")) && !completeQuoted.test(value))
      throw new Error('Malformed quoted redaction source.');
    if (/^[A-Za-z]$/.test(field) && value.startsWith('\\')) continue; // Windows drive syntax is not a field declaration.
    const candidate = found.find((span) => span.start >= start && span.end <= end);
    const protectedMarker = value.match(/^\[REDACTED(?:_[A-Z]+)*\]$/)?.[0];
    found.push({ start, end, value, field, syntax: 'assignment-value', marker: protectedMarker ?? candidate?.marker ?? '[REDACTED]' });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end
    || (a.syntax === b.syntax ? 0 : a.syntax === 'assignment-value' ? -1 : 1));
  const spans: OutgoingSpan[] = [];
  for (const span of found) {
    const previous = spans.at(-1);
    if (previous === undefined || previous.end <= span.start) spans.push(span);
  }
  return spans;
}

function replaceSpans(text: string, spans: readonly { readonly start: number; readonly end: number; readonly replacement: string }[]): string {
  let result = '', offset = 0;
  for (const span of spans) { result += text.slice(offset, span.start) + span.replacement; offset = span.end; }
  return result + text.slice(offset);
}

function protectedFieldValue(value: unknown): string {
  if (typeof value !== 'string') return '[REDACTED]';
  const issuer = ISSUER_CREDENTIAL_PATTERNS.find(({ pattern }) => value.search(pattern) !== -1);
  const marker = issuer?.replacement ?? findCredentialCandidates(value)[0]?.marker ?? '[REDACTED]';
  return (value.match(/^Bearer\s+/i)?.[0] ?? '') + marker;
}

interface OperationFieldReadings {
  read(field: string): Promise<FieldKind | undefined>;
  assertCurrent(): void;
  dispose(): void;
}

/** Local declared roles stay bound to the complete redaction operation's lifetime. */
function operationFieldReadings(options: JudgmentReadingOptions): OperationFieldReadings {
  const callerCurrent = options.assertCurrent, signal = options.signal;
  const assertCurrent = () => {
    assertRedactionCurrent(callerCurrent);
    if (options.signal !== signal || options.assertCurrent !== callerCurrent || signal?.aborted) throw new Error('Field policy source is no longer current');
  };
  const reader = new FieldKindReader({ ...options, assertCurrent });
  return {
    assertCurrent,
    async read(field) { assertCurrent(); const kind = await reader.readAsync(field); assertCurrent(); return kind; },
    dispose() { reader.dispose(); },
  };
}

/**
 * Mask text that leaves the machine. Everything but a session export gets the
 * local masking pass alone (no model request). A session export also has its
 * candidate spans read, all of them in one request for the text: a span read
 * as not a credential keeps its value, an unsure one stays masked, and a failed
 * request leaves the local result.
 */
export async function redactSensitiveDataAsync(text: string, options: RedactionOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (options.purpose === 'export' && !isClassicOperation()) return redactExportText(text, options);
  // Synchronous: nothing can change between the start and the end, so the
  // caller's own check runs once, before the result is handed back.
  const result = redactClassicText(text, options.secretValues);
  options.assertCurrent?.();
  return result;
}

/**
 * Conservative local masking: issuer formats, registered profile values, the
 * caller's own secrets, candidate shapes and values of credential-named
 * assignments. Synchronous, so nothing it reads can change while it runs.
 * `anonymize` also replaces the account's home directory and user name, which
 * text leaving the machine wants and text kept on it does not.
 */
function redactClassicText(text: string, secrets: readonly string[] = [], anonymize = true): string {
  const protectedText = maskKnownValues(text, secrets, anonymize);
  const result = replaceSpans(protectedText, localSpans(protectedText, 0).map(span => ({ ...span, replacement: span.marker })));
  return judgmentInputProblem(result) === undefined ? result : '[REDACTED]';
}

/** Issuer formats, identity (when `anonymize`), registered profile values and the caller's secrets. */
function maskKnownValues(text: string, secrets: readonly string[], anonymize: boolean): string {
  let protectedText = applyPatterns(text, anonymize ? [...ISSUER_CREDENTIAL_PATTERNS, ...currentIdentityPatterns()] : ISSUER_CREDENTIAL_PATTERNS);
  const profile = profileValueReader?.();
  const values = [...secrets, ...(profile?.guarded ?? []), ...(profile?.absolute ?? []), ...(profile?.guardedFields?.map(field => field.value) ?? [])];
  for (const secret of values.filter(value => value.length > 0).sort((a, b) => b.length - a.length))
    protectedText = protectedText.split(secret).join('[REDACTED]');
  return protectedText;
}

/** Most serialized characters one span reading carries; a larger text is read in several requests. */
const EXPORT_SPAN_REQUEST_CHARS = 120_000;

/**
 * The session-export pass: the local masking, with its candidate tokens read
 * together. Cost: 0 requests for a text with no candidate token, otherwise one
 * (more only when the lines around the spans exceed one request's budget).
 */
async function redactExportText(text: string, options: RedactionOptions): Promise<string> {
  if (text.length === 0) return text;
  const signal = options.signal;
  const reading = { ...(signal ? { signal } : {}), ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}) };
  // Profile roles decide which registered profile values the local pass masks.
  try { await prepareProfileRedactionRoles(reading); }
  catch (error) { if (signal?.aborted) throw error; }
  let known = '', spans: OutgoingSpan[] = [], local = '';
  try {
    known = maskKnownValues(text, options.secretValues ?? [], true);
    spans = localSpans(known, 0);
    local = replaceSpans(known, spans.map(span => ({ ...span, replacement: span.marker })));
    if (judgmentInputProblem(local) !== undefined) local = '[REDACTED]';
  } catch { return '[REDACTED]'; }
  // A credential-named value is masked as a fact; only candidate tokens are a judgment.
  const askable = spans.flatMap((span, index) => span.field === undefined && span.syntax === 'candidate-token' ? [index] : []);
  if (askable.length === 0 || local === '[REDACTED]') { assertRedactionCurrent(options.assertCurrent); return local; }
  const items = askable.map(index => exportSpanItem(known, spans, index));
  const released = new Set<number>();
  try {
    const owner = captureJudgmentPort(exportCredentialSpans.name, reading);
    for (const batch of exportSpanBatches(items)) {
      const result = await exportCredentialSpans.count(owner.port, batch.map(entry => entry.item), { signal: owner.signal, site: exportCredentialSpans.name });
      owner.assertCurrent();
      for (const [position, reading] of result.readings.entries()) {
        const entry = batch[position];
        if (entry !== undefined && reading.outcome === 'act' && reading.verdict === 'no') released.add(entry.span);
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return local;
  }
  const result = replaceSpans(known, spans.map((span, index) => {
    if (!released.has(index)) return { ...span, replacement: span.marker };
    // A released value still may not carry literal credential or card syntax.
    try { snapshotJudgmentEvidence(span.value); return { ...span, replacement: span.value }; }
    catch { return { ...span, replacement: span.marker }; }
  }));
  assertRedactionCurrent(options.assertCurrent);
  return judgmentInputProblem(result) === undefined ? result : local;
}

type ExportSpanPart = { kind: 'text'; text: string } | { kind: 'span'; reference: string; syntax: 'assignment-value' | 'candidate-token' };

/** One span's question: its line with every span withheld, and which span is asked about. */
function exportSpanItem(text: string, spans: readonly OutgoingSpan[], target: number): { span: number; item: { parts: ExportSpanPart[]; target: string } } {
  const span = spans[target]!;
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const newline = text.indexOf('\n', span.end);
  const lineEnd = newline === -1 ? text.length : newline;
  const parts: ExportSpanPart[] = [];
  let offset = lineStart, reference = 0, targetReference = '';
  for (const [index, other] of spans.entries()) {
    if (other.start < lineStart || other.end > lineEnd) continue;
    parts.push({ kind: 'text', text: text.slice(offset, other.start) });
    const ref = `span-${++reference}`;
    if (index === target) targetReference = ref;
    parts.push({ kind: 'span', reference: ref, syntax: other.syntax });
    offset = other.end;
  }
  parts.push({ kind: 'text', text: text.slice(offset, lineEnd) });
  return { span: target, item: { parts: parts.filter(part => part.kind !== 'text' || part.text.length > 0), target: targetReference } };
}

function exportSpanBatches<T extends { readonly item: unknown }>(entries: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [], size = 0;
  for (const entry of entries) {
    const length = JSON.stringify(entry.item).length;
    if (batch.length > 0 && size + length > EXPORT_SPAN_REQUEST_CHARS) { batches.push(batch); batch = []; size = 0; }
    batch.push(entry); size += length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Spans the local pass masks: every candidate token, and the value of an
 * assignment whose field is credential-named. The value of an ordinary
 * assignment (`Auth failed: Bearer sk-...`) is kept, with the candidate tokens
 * inside it masked.
 */
function localSpans(text: string, offset: number, depth = 0): OutgoingSpan[] {
  return outgoingSpans(text).flatMap((span): OutgoingSpan[] => {
    const shifted = { ...span, start: span.start + offset, end: span.end + offset };
    if (span.field === undefined || withheldFieldKind(span.field) === 'secret'
      || judgmentInputProblem({ [span.field]: span.value }) !== undefined) return [shifted];
    return depth < 4 ? localSpans(span.value, shifted.start, depth + 1) : [shifted];
  });
}

/**
 * The one local masking pass for a message that is shown or stored: the same
 * text gives the same result every time, no model request is made, and the
 * message stays readable with credential material masked. `anonymize: false`
 * keeps paths and the user name, for records that stay on the owner's machine.
 * A failure to mask yields `[REDACTED]`.
 */
export function redactDiagnosticText(text: string, options: { readonly anonymize?: boolean } = {}): string {
  if (text.length === 0) return text;
  try { return redactClassicText(text, [], options.anonymize !== false); } catch { return '[REDACTED]'; }
}

/**
 * Mask a structured value by value class. Numbers, booleans and null are kept;
 * text is masked by {@link redactClassicText}; a field whose name declares
 * credential material (or that the input screen names a credential field) is
 * withheld whole, and an owner-profile field becomes `[REDACTED_PROFILE]`.
 * Errors become their name and masked message. Accessors are never invoked.
 * Never asks a model.
 *
 * `strictNames` is for telemetry and other egress, which carries no
 * conversation text: text under a free-text field name (`prompt`, `response`,
 * `content`, ...) becomes `[REDACTED_TEXT]` and anything but a number or
 * boolean under a name with no declared role becomes `[REDACTED]`;
 * identifiers, models, statuses and counts under their declared names keep
 * their values.
 */
function maskStructuredValue(value: unknown, secrets: readonly string[], anonymize: boolean, strictNames = false): unknown {
  const seen = new WeakSet<object>();
  const text = (entry: string) => entry.length === 0 ? entry : redactClassicText(entry, secrets, anonymize);
  const field = (key: string, descriptor: PropertyDescriptor): unknown => {
    if (!('value' in descriptor)) return '[REDACTED]';
    const child: unknown = descriptor.value;
    const kind = declaredFieldKind(key);
    if (kind === 'owner_profile') return '[REDACTED_PROFILE]';
    if (kind === 'secret') return child === null || child === undefined || typeof child === 'boolean' || child === '' ? child : protectedFieldValue(child);
    if (strictNames) {
      if (kind === 'content' && typeof child === 'string' && child.length > 0) return '[REDACTED_TEXT]';
      if (kind === undefined && child !== null && child !== undefined && typeof child !== 'number' && typeof child !== 'boolean') return '[REDACTED]';
    }
    // The input screen's own credential and card field rules, for a name this table does not declare.
    if (typeof child === 'string' && child.length > 0 && judgmentInputProblem({ [key]: child }) !== undefined) return '[REDACTED]';
    return visit(child);
  };
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return text(entry);
    if (typeof entry === 'bigint') return entry.toString();
    if (typeof entry === 'function' || typeof entry === 'symbol') return undefined;
    if (entry === null || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return '[Circular]';
    seen.add(entry);
    try {
      if (entry instanceof Error) return text(`${entry.name}: ${entry.message}`);
      if (entry instanceof Date) return Number.isNaN(entry.getTime()) ? 'Invalid Date' : entry.toISOString();
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      if (Array.isArray(entry)) {
        const items: unknown[] = [];
        for (let index = 0; index < entry.length; index++) {
          const descriptor = descriptors[String(index)];
          items.push(descriptor === undefined ? undefined : !('value' in descriptor) ? '[REDACTED]' : visit(descriptor.value));
        }
        return items;
      }
      const result: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        // A name that itself carries credential material is written masked, and
        // its value withheld; masked names that collide keep separate slots.
        const safeKey = text(key);
        let outputKey = safeKey, suffix = 1;
        while (Object.hasOwn(result, outputKey)) outputKey = `${safeKey} [${suffix++}]`;
        Object.defineProperty(result, outputKey, { value: safeKey === key ? field(key, descriptor) : '[REDACTED]',
          enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { seen.delete(entry); }
  };
  return visit(value);
}

/**
 * {@link maskStructuredValue} for a record kept on this machine (the activity
 * log): text keeps its paths and the user name.
 */
export function redactDiagnosticValue(value: unknown): unknown {
  try { return maskStructuredValue(value, [], false); } catch { return '[REDACTED]'; }
}

function redactClassicStructure(value: unknown, options: StructuredRedactionOptions): unknown {
  options.signal?.throwIfAborted();
  const result = maskStructuredValue(captureOwnedJson(value), options.secretValues ?? [], true);
  options.assertCurrent?.();
  return result;
}

/**
 * Profile values and issuer-reserved credential formats only, leaving paths
 * and candidate-shaped spans intact.
 *
 * For text that STAYS on the owner's machine, the at-rest journal, whose file
 * lives inside the very directory the identity patterns would rewrite. There
 * is no one to anonymise them from in their own files, and `/home/[REDACTED]/…`
 * makes a journal entry unusable for the debugging it exists for. The
 * candidate spans ({@link findCredentialCandidates}) are masked by the at-rest
 * writer on its reading of each one.
 */
export function redactIssuerCredentials(text: string): string {
  return applyPatterns(text, ISSUER_CREDENTIAL_PATTERNS);
}

/**
 * Local, deterministic structured masking for telemetry and other egress (see
 * {@link maskStructuredValue}): identifiers, models, statuses and counts keep
 * their values; conversation text under a free-text field name is withheld.
 */
export function redactStructuredData(value: unknown): unknown {
  try { return maskStructuredValue(value, [], true, true); } catch { return '[REDACTED]'; }
}

/** Shared asynchronous egress recursion. Field values never enter field-role readings. */
export async function redactStructuredDataAsync(value: unknown, options: StructuredRedactionOptions = {}): Promise<unknown> {
  if (isClassicOperation()) return redactClassicStructure(value, options);
  const signal = options.signal, ownerCurrent = options.assertCurrent;
  let source: ReturnType<typeof captureRedactionSource>, snapshot: unknown, retainedValue: ReturnType<typeof retainOwnedJson>;
  const purpose = options.purpose, originalSecrets = options.secretValues;
  const secretSource = retainOwnedJson(originalSecrets ?? []), capturedSecrets = secretSource.snapshot;
  const originalFields = options.declaredFields;
  const declaredSource = retainOwnedJson(originalFields ?? []);
  const declarations = new Map<string, FieldKind>();
  const declaredSnapshot = declaredSource.snapshot;
  if (!Array.isArray(declaredSnapshot)) return '[REDACTED]';
  for (const declaration of declaredSnapshot) {
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)
      || !('path' in declaration) || !('kind' in declaration)) return '[REDACTED]';
    const { path, kind } = declaration;
    if (!Array.isArray(path) || path.length === 0 || !path.every(segment => typeof segment === 'string' && segment.length > 0)
      || (kind !== 'secret' && kind !== 'owner_profile' && kind !== 'content' && kind !== 'other')) return '[REDACTED]';
    const key = JSON.stringify(path.map(segment => segment === '*' ? null : segment));
    if (declarations.has(key)) return '[REDACTED]';
    declarations.set(key, kind);
  }
  const secretLiterals: string[] = [];
  if (!Array.isArray(capturedSecrets)) return '[REDACTED]';
  for (const secret of capturedSecrets) {
    if (typeof secret !== 'string') return '[REDACTED]';
    if (secret.length > 0) secretLiterals.push(secret);
  }
  secretLiterals.sort((a, b) => b.length - a.length);
  type ReferenceCapture = { readonly kind: 'held' } | { readonly kind: 'sentinel' }
    | { readonly kind: 'reference'; readonly value: ReturnType<typeof captureStructuredCredentialReferenceConfigValue> };
  const nativeReferences = new Map<string, { readonly path: readonly string[]; readonly capture: ReferenceCapture }>();
  try {
    source = captureRedactionSource(); retainedValue = retainOwnedJson(value); snapshot = retainedValue.snapshot;
    // Only native config and the support bundle's root config envelope carry
    // this declaration. An arbitrary extension suffix grants no exemption.
    for (const path of [['judgment.fallbacks'], ['judgment', 'fallbacks'], ['config', 'judgment.fallbacks'], ['config', 'judgment', 'fallbacks']]) {
      const raw = originalPath(path);
      if (raw.kind === 'missing') continue;
      let capture: ReferenceCapture = { kind: 'held' };
      if (raw.value === '<redacted>') capture = { kind: 'sentinel' };
      else try {
        const references = captureStructuredCredentialReferenceConfigValue('judgment.fallbacks', raw.value);
        capture = { kind: 'reference', value: references };
      } catch { /* Malformed declared values remain opaque throughout this operation. */ }
      nativeReferences.set(JSON.stringify(path), { path, capture });
    }
  } catch { return '[REDACTED]'; }
  const assertSource = () => {
    assertRedactionCurrent(ownerCurrent); source.assertCurrent();
    if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent
      || options.purpose !== purpose || options.secretValues !== originalSecrets || options.declaredFields !== originalFields)
      throw new Error('Structured redaction source is no longer current');
    secretSource.assertCurrent(); declaredSource.assertCurrent(); retainedValue.assertCurrent();
  };
  const assertCurrent = assertSource;
  const reading = { ...options, assertCurrent };
  const fields = operationFieldReadings(reading);
  const texts = new Map<string, string>();
  function protectKey(key: string): string {
    let protectedKey = applyPatterns(key, [...ISSUER_CREDENTIAL_PATTERNS, ...currentIdentityPatterns()]);
    for (const secret of secretLiterals) protectedKey = protectedKey.replaceAll(secret, '[REDACTED]');
    return protectedKey;
  }
  function originalPath(path: readonly string[]): { readonly kind: 'missing' } | { readonly kind: 'present'; readonly value: unknown } {
    let raw: unknown = value;
    for (const segment of path) {
      if (raw === null || typeof raw !== 'object') return { kind: 'missing' };
      const descriptor = Object.getOwnPropertyDescriptor(raw, segment);
      if (!descriptor?.enumerable || !('value' in descriptor)) return { kind: 'missing' };
      raw = descriptor.value;
    }
    return { kind: 'present', value: raw };
  }
  function protectReference(path: readonly string[]): unknown {
    // The retained parser capture includes original fields structural JSON
    // omits, and the source guard revalidates it at every reading boundary.
    const capture = nativeReferences.get(JSON.stringify(path))?.capture;
    if (capture === undefined || capture.kind === 'held') return '[REDACTED]';
    if (capture.kind === 'sentinel') return '<redacted>';
    for (const reference of capture.value) for (const text of [reference.endpoint, reference.model, reference.keySource, reference.keyName]) {
      if (protectKey(text) !== text || judgmentInputProblem(text) !== undefined) return '[REDACTED]';
    }
    return capture.value;
  }
  type FieldReading = { readonly kind: 'reference'; readonly safeKey: string; readonly value: unknown }
    | { readonly kind: 'semantic'; readonly safeKey: string; readonly fieldKind: FieldKind | undefined };
  async function visit(entry: unknown, path: readonly string[] = [], schemaPath: readonly (string | null)[] = []): Promise<unknown> {
    assertCurrent();
    if (typeof entry === 'string') {
      // A fixed credential-reference sentinel, never a raw secret value.
      if (entry === '<redacted>') return entry;
      const cached = texts.get(entry);
      if (cached !== undefined) return cached;
      // Only an export reads its candidate spans; every other value gets the local pass alone.
      const result = purpose === 'export'
        ? await redactExportText(entry, { ...reading, secretValues: secretLiterals })
        : redactClassicText(entry, secretLiterals);
      if (texts.size >= 256) {
        const oldest = texts.keys().next();
        if (!oldest.done) texts.delete(oldest.value);
      }
      texts.set(entry, result);
      return result;
    }
    if (Array.isArray(entry)) {
      const output: unknown[] = [];
      for (const [index, child] of entry.entries()) output.push(await visit(child, [...path, String(index)], [...schemaPath, null]));
      return output;
    }
    if (entry !== null && typeof entry === 'object') {
      const output: Record<string, unknown> = {};
      const entries = Object.entries(Object.getOwnPropertyDescriptors(entry));
      for (let offset = 0; offset < entries.length; offset += 4) {
        const batch = entries.slice(offset, offset + 4);
        // Drain the bounded group even when one source is retired while awaiting.
        const readings = await Promise.allSettled(batch.map(async ([key]): Promise<FieldReading> => {
          let safeKey = protectKey(key);
          const childPath = [...path, key];
          if (nativeReferences.has(JSON.stringify(childPath))) return { kind: 'reference', safeKey,
            value: safeKey === key ? protectReference(childPath) : '[REDACTED]' };
          // Property names are source text too. An assignment-shaped name must
          // pass the same withheld-span readings before it can become a field
          // role question or an output key. Reuse only this operation's owned
          // complete-text reading, including its source/contract restrictions.
          if (safeKey === key && outgoingSpans(key).length > 0) {
            const protectedKey = await visit(key);
            if (typeof protectedKey !== 'string') throw new Error('Protected field name is unavailable');
            safeKey = protectedKey;
          }
          let fieldKind = safeKey === key ? await fields.read(key) : undefined;
          if (safeKey === key && fieldKind !== 'secret' && fieldKind !== 'owner_profile')
            fieldKind = declarations.get(JSON.stringify([...schemaPath, key])) ?? fieldKind;
          return { kind: 'semantic', safeKey, fieldKind };
        }));
        assertCurrent();
        for (const [index, [key, descriptor]] of batch.entries()) {
          const result = readings[index];
          if (result === undefined || result.status === 'rejected') throw new Error('Field reading source is no longer current');
          const reading = result.value, { safeKey } = reading;
          const child: unknown = descriptor.value;
          let outputKey = safeKey, suffix = 1;
          while (Object.hasOwn(output, outputKey)) outputKey = `${safeKey} [${suffix++}]`;
          Object.defineProperty(output, outputKey, { value: reading.kind === 'reference' ? reading.value
            : child === '<redacted>' ? child : reading.fieldKind === undefined ? '[REDACTED]'
              : reading.fieldKind === 'secret' ? protectedFieldValue(child)
                : reading.fieldKind === 'owner_profile' ? '[REDACTED_PROFILE]' : await visit(child, [...path, key], [...schemaPath, key]), enumerable: true });
        }
      }
      return output;
    }
    return entry;
  }
  try {
    const names: string[] = [];
    function collect(entry: unknown, path: readonly string[] = []): void {
      if (Array.isArray(entry)) { for (const [index, child] of entry.entries()) collect(child, [...path, String(index)]); }
      else if (entry !== null && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) {
        const childPath = [...path, key];
        if (nativeReferences.has(JSON.stringify(childPath))) continue;
        // Candidate values embedded in a name stay local until visit protects
        // them. Keep those names out of the initial input validation.
        if (protectKey(key) === key && outgoingSpans(key).length === 0) names.push(key);
        collect(child, childPath);
      }
    }
    collect(snapshot); assertJudgmentInput({ fields: names }); assertCurrent();
    const result = await visit(snapshot); assertCurrent(); fields.assertCurrent(); return result;
  }
  catch { return '[REDACTED]'; }
  finally { fields.dispose(); }
}

/** Whether a telemetry attribute's whole value is withheld (credential or owner-profile field name). */
export function isSensitiveTelemetryKey(key: string): boolean {
  return withheldFieldKind(key) !== undefined;
}
