/**
 * target-ref.ts, what was reviewed is what runs.
 *
 * An effect that a person or an agent reviewed first (a restore, a kill, a
 * settings import, a credential removal, a resend) names its target by a
 * {@link TargetRef} taken when it was shown: a stable id (never an ordinal, a
 * row index, a title or "current"), what the id lives in, a digest of the
 * facts that were shown, and the redacted text of each fact. The executor
 * builds the same reference from the target as it is now and compares; when
 * anything differs it refuses with `TARGET_CHANGED`, naming each change and
 * the call that shows the target again. In-process owners keep using the
 * revision contract (utils/revision.ts); this is the form that crosses a
 * process or a person.
 *
 * Browser-safe: no `node:` import, so the web UI keys its review marks with
 * the same digest.
 */
import { RefusalError, refusal, type TargetChange } from '@goodvibes/engine/errors';
import { base64Url, sha256Base64Url, sha256Bytes } from './sha256.js';

function canonical(value: unknown, seen: Set<object>, inArray: boolean): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      // As JSON.stringify: left out of an object, null in an array.
      return inArray ? 'null' : undefined;
    default:
      break;
  }
  const object = value as { toJSON?: () => unknown };
  if (typeof object.toJSON === 'function') return canonical(object.toJSON(), seen, inArray);
  if (seen.has(object)) throw new TypeError('canonicalJson: the value refers to itself');
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((entry: unknown) => canonical(entry, seen, true) ?? 'null').join(',')}]`;
    }
    const record = object as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = canonical(record[key], seen, false);
      if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * Key-order-independent JSON: object keys sorted at every depth, arrays in
 * their order, `undefined` left out of objects as JSON.stringify leaves it.
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` give the same string.
 */
export function canonicalJson(value: unknown): string {
  return canonical(value, new Set(), false) ?? 'null';
}

/** Unpadded base64url SHA-256 of {@link canonicalJson}: 43 characters. */
export function contentDigest(value: unknown): string {
  return sha256Base64Url(canonicalJson(value));
}

/** The exact target an effect acts on, as it was when it was shown. */
export interface TargetRef<K extends string = string> {
  /** What sort of thing: 'checkpoint', 'hunk', 'rewind', 'session', 'settings-row', 'notification-destination', ... */
  readonly kind: K;
  /** A stable id: never an ordinal, a row index, a title or "current". */
  readonly id: string;
  /** What the id lives in (a daemon target id, a workspace root, a session id), or null. */
  readonly scope: string | null;
  /** {@link contentDigest} of the facts. The facts may hold secrets; only the digest is kept. */
  readonly digest: string;
  /** Per fact, the display text the person saw (already redacted). */
  readonly shown: Readonly<Record<string, string>>;
}

/**
 * Take a reference to a target. `facts` are everything that, if different,
 * makes it another target; `shown` is what the person is shown for each fact
 * (redacted where the fact is secret). A fact with no `shown` entry still
 * moves the digest and is reported as changed by its name.
 */
export function targetRef<K extends string>(
  kind: K,
  id: string,
  facts: Readonly<Record<string, unknown>>,
  shown: Readonly<Record<string, string>>,
  scope: string | null = null,
): TargetRef<K> {
  // Each fact is digested on its own, so a change can be named later without keeping the fact.
  const perFact: Record<string, string> = {};
  for (const key of Object.keys(facts)) perFact[key] = contentDigest(facts[key]);
  return Object.freeze({
    kind,
    id,
    scope,
    digest: contentDigest(perFact),
    shown: Object.freeze({ ...shown }),
    [factDigests]: Object.freeze(perFact),
  }) as TargetRef<K>;
}

/** The per-fact digests a reference was built from; not part of the wire shape (a symbol key never serialises). */
const factDigests: unique symbol = Symbol('targetRef.factDigests');

function digestsOf(ref: TargetRef): Readonly<Record<string, string>> | undefined {
  return (ref as TargetRef & { readonly [factDigests]?: Readonly<Record<string, string>> })[factDigests];
}

/**
 * What differs between the reference that was reviewed and the target as it
 * is now: [] when kind, id, scope and digest are the same. A gone target is
 * one change, `{ field: 'target', now: null }`. Otherwise each fact whose
 * value moved, by its shown text (or its name when it had none); when the
 * reviewed reference came over the wire without its per-fact digests, each
 * shown field whose text differs, or one `content` change when none does.
 */
export function compareTarget(reviewed: TargetRef, current: TargetRef | null): readonly TargetChange[] {
  if (current === null) return [{ field: 'target', was: `${reviewed.kind} ${reviewed.id}`, now: null }];
  const changes: TargetChange[] = [];
  if (current.kind !== reviewed.kind || current.id !== reviewed.id) {
    changes.push({ field: 'target', was: `${reviewed.kind} ${reviewed.id}`, now: `${current.kind} ${current.id}` });
  }
  if (current.scope !== reviewed.scope) {
    changes.push({ field: 'scope', was: reviewed.scope ?? 'none', now: current.scope ?? 'none' });
  }
  if (current.digest === reviewed.digest) return changes;
  const before = digestsOf(reviewed);
  const after = digestsOf(current);
  const reported = new Set<string>();
  if (before && after) {
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[field] === after[field]) continue;
      reported.add(field);
      changes.push({ field, was: reviewed.shown[field] ?? (field in before ? '(as shown)' : '(none)'), now: field in after ? current.shown[field] ?? '(changed)' : null });
    }
  } else {
    for (const field of new Set([...Object.keys(reviewed.shown), ...Object.keys(current.shown)])) {
      if (reviewed.shown[field] === current.shown[field]) continue;
      reported.add(field);
      changes.push({ field, was: reviewed.shown[field] ?? '(none)', now: current.shown[field] ?? null });
    }
  }
  if (reported.size === 0) changes.push({ field: 'content', was: '(as shown)', now: '(changed)' });
  return changes;
}

/** A reviewed target is not what it was when it was shown: nothing was done. */
export class TargetChangedError extends RefusalError {
  readonly changes: readonly TargetChange[];
  readonly reviewed: TargetRef;

  constructor(reviewed: TargetRef, changes: readonly TargetChange[], reviewAgain: string) {
    const listed = changes.map((change) => change.now === null
      ? `${change.field} ${change.was} is gone`
      : `${change.field} was ${change.was}, now ${change.now}`).join('; ');
    super(refusal({
      code: 'TARGET_CHANGED',
      state: 'nothing was done',
      reason: `${reviewed.kind} ${reviewed.id} changed since it was shown: ${listed}`,
      next: [reviewAgain],
      retryable: false,
      status: 409,
      changes,
    }), { category: 'bad_request', source: 'runtime' });
    this.name = 'TargetChangedError';
    this.changes = this.refusal.changes ?? changes;
    this.reviewed = reviewed;
  }
}

/**
 * Throws {@link TargetChangedError} when {@link compareTarget} is not empty.
 * `reviewAgain` is the exact call or command that shows the target again.
 */
export function assertTarget(reviewed: TargetRef, current: TargetRef | null, reviewAgain: string): void {
  const changes = compareTarget(reviewed, current);
  if (changes.length > 0) throw new TargetChangedError(reviewed, changes, reviewAgain);
}

/** A fresh identity for one incarnation of a record: 96 random bits, base64url (16 characters). */
export function newIncarnation(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/**
 * A key part that is injective: a value already matching `[a-z0-9]+` is kept
 * (upper-cased with `upper`, so `openai` is `OPENAI`); any other value is
 * sanitised (case folded, every other character `_`) and gets `_` plus 8 hex
 * characters of its digest, so two values that sanitise alike never share a
 * key and a kept value, which has no `_`, never equals a suffixed one.
 */
export function injectiveKeyPart(value: string, upper = false): string {
  if (/^[a-z0-9]+$/.test(value)) return upper ? value.toUpperCase() : value;
  const cased = upper ? value.toUpperCase() : value.toLowerCase();
  const sanitized = cased.replace(upper ? /[^A-Z0-9]/g : /[^a-z0-9]/g, '_');
  const hex = Array.from(sha256Bytes(value).subarray(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${sanitized}_${upper ? hex.toUpperCase() : hex}`;
}
