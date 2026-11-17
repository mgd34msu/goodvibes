/**
 * The local, pre-judgment privacy boundary. A hosted judgment is itself an
 * outward transmission, even when the eventual tool call would be refused.
 *
 * This does not decide what a command means or try to discover every secret.
 * It refuses declared credential/card fields of structured arguments, known
 * wire operations, card numbers, private key blocks, a URL carrying a literal
 * password (a URL password has no innocent reading) and, in free text (file
 * content, commands), a credential declaration whose value is a key- or
 * token-shaped literal. A shorter literal in a credential declaration is not
 * refused but masked in what the decision model is sent and what the decision
 * log keeps (`maskJudgmentStateCredentials`). Text that only names a
 * credential (an environment variable, a member expression, a placeholder) is
 * ordinary code; whether free text is sensitive in meaning is the gate's
 * `secrets` reading.
 *
 * Inspect the complete JSON tree and complete strings BEFORE any reading size
 * cap. A refusal names the field and the kind of material seen, never the
 * value, its length or a fingerprint. No secret store or environment is read.
 */
import { findCredentialScopeDeclaration, isDaemonNeededSecretKey } from '../config/credential-scope-registry.js';
import { isSecretBearingConfigKey, isSecretReferenceValue } from '../config/secret-bearing-config-keys.js';
import { CARD_FIELD_NAMES } from '../payments/card-material.js';
import { findCardNumbersInContext } from '../security/card-shapes.js';
import { readCredentialEnvName } from '../tools/exec/credential-env.js';
import type { EntryType, JsonValue } from '@goodvibes-jev/judgment';
import { credentialReferenceText, declaredValueSpan, evidenceCredentialMarker, inlineDeclarations, literalDeclarationValue, secretLiteral } from './inline-declarations.js';

export type JudgmentInputProblem = 'credential-material' | 'card-material' | 'unsupported-input';

/** Where the material was found and what it looked like; never the value. */
export interface JudgmentInputFinding {
  readonly problem: JudgmentInputProblem;
  readonly field?: string | undefined;
  readonly seen?: string | undefined;
}

const NEXT: Readonly<Record<JudgmentInputProblem, string>> = {
  'credential-material': 'Credentials are not sent to the decision model. Refer to the credential by an environment variable or a stored secret reference (goodvibes://secrets/...), or store it through the secure credential setup.',
  'card-material': 'Card details are entered through the local terminal or web UI secure card setup; use the stored card id in tool calls.',
  'unsupported-input': 'Pass plain JSON data without accessors or cycles.',
};
const SEEN: Readonly<Record<JudgmentInputProblem, string>> = {
  'credential-material': 'credential material',
  'card-material': 'payment card material',
  'unsupported-input': 'data that is not plain JSON',
};

function refusalText(finding: JudgmentInputFinding): string {
  const seen = finding.seen ?? SEEN[finding.problem];
  const where = finding.field !== undefined && finding.field.length > 0 ? `\`${finding.field.slice(0, 80)}\` holds ${seen}` : `the arguments hold ${seen}`;
  return `Refused before judgment: ${where}. ${NEXT[finding.problem]}`;
}

/** A value-free refusal, including when a reading is called without a manager. */
export class JudgmentInputError extends Error {
  readonly problem: JudgmentInputProblem;
  readonly field: string | undefined;
  constructor(problem: JudgmentInputProblem | JudgmentInputFinding) {
    const finding = typeof problem === 'string' ? { problem } : problem;
    super(refusalText(finding));
    this.name = 'JudgmentInputError';
    this.problem = finding.problem;
    this.field = finding.field;
  }
}

// Explicit wire fields: OAuth token responses, HTTP authentication headers,
// user-auth credentials and provider credentials. Not a suffix/name heuristic.
const CREDENTIAL_FIELDS = new Set([
  'password', 'apiKey', 'api_key', 'clientSecret', 'client_secret',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'id_token',
  'privateKey', 'private_key', 'api-key', 'access-token', 'client-secret', 'private-key',
]);
const CREDENTIAL_FIELDS_CASE_FOLDED = new Set([...CREDENTIAL_FIELDS].map(field => field.toLowerCase()));
const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
// CardMaterial/CardFieldName and the HTML payment autofill field names.
const CARD_FIELDS = new Set([
  'pan', 'cvv', 'cvc', 'cardNumber', 'cardExpiry', 'cardholderName',
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name',
]);
const CARD_CREATE = 'payments.cards.create';
/** Carries the owner's typed card security code in `code`. */
const SECURITY_CODE = 'payments.purchase.securityCode';
const CREDENTIAL_SET = 'credentials.set';
const OPERATION_FIELDS = ['method', 'operation', 'tool', 'name'] as const;

/** Structural capture only. Callers must separately privacy-screen every semantic field.
 * Internal protocol adapters use this to separate validated identity from raw content.
 * A host may add structural rejections (e.g. Node proxies), never transform or exempt data.
 */
interface RetainedJsonSlot {
  readonly key: string | symbol;
  readonly value: unknown;
  readonly writable: boolean | undefined;
  readonly enumerable: boolean | undefined;
  readonly configurable: boolean | undefined;
}
interface RetainedJsonObject {
  readonly value: object;
  readonly prototype: unknown;
  readonly slots: readonly RetainedJsonSlot[];
}
export interface RetainedOwnedJson {
  readonly snapshot: unknown;
  readonly assertCurrent: () => void;
}

const ownJsonKeys = Reflect.ownKeys;
const ownJsonDescriptor = Object.getOwnPropertyDescriptor;
const jsonPrototype = Object.getPrototypeOf;
const sameJsonSlot = Object.is;

// Only snapshots created by this traversal receive the reuse proof. A frozen
// caller object can still contain mutable descendants and never inherits it.
const capturedJsonRoots = new WeakSet<object>();
const capturedRootHas = WeakSet.prototype.has, capturedRootAdd = WeakSet.prototype.add;
const applyCapturedRoot = Reflect.apply;
function rememberCapturedRoot(snapshot: unknown): unknown {
  if (snapshot && typeof snapshot === 'object') applyCapturedRoot(capturedRootAdd, capturedJsonRoots, [snapshot]);
  return snapshot;
}
const isFrozenJson = Object.isFrozen;
/** True only when every node is a frozen data object; such a tree cannot change after capture. */
export function isDeepFrozenJson(value: unknown): boolean {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === 'function') return false;
    if (entry === null || typeof entry !== 'object' || seen.has(entry)) continue;
    seen.add(entry);
    if (!isFrozenJson(entry)) return false;
    for (const key of ownJsonKeys(entry)) {
      const descriptor = ownJsonDescriptor(entry, key);
      if (!descriptor || !('value' in descriptor)) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}
export function captureOwnedJson(value: unknown, rejectObject?: (value: object) => boolean): unknown {
  // A caller-supplied rejection predicate must always inspect the actual input.
  // Nested snapshots still traverse normally, preserving aggregate size limits.
  if (rejectObject === undefined && value && typeof value === 'object'
    && applyCapturedRoot(capturedRootHas, capturedJsonRoots, [value])) return value;
  return rememberCapturedRoot(captureOwnedJsonInternal(value, rejectObject));
}

/** Retain original data slots while the canonical traversal detaches its snapshot. */
export function retainOwnedJson(value: unknown, rejectObject?: (value: object) => boolean): RetainedOwnedJson {
  const objects: RetainedJsonObject[] = [];
  // Our own snapshots and fully frozen data trees have immutable data slots
  // throughout. Still run caller restrictions and aggregate admission, but there
  // are no mutable slots to rewalk at every asynchronous reading boundary.
  const immutable = value !== null && typeof value === 'object'
    && (applyCapturedRoot(capturedRootHas, capturedJsonRoots, [value]) || isDeepFrozenJson(value));
  const snapshot = rememberCapturedRoot(captureOwnedJsonInternal(value, rejectObject, immutable ? undefined : objects));
  const assertCurrent = () => {
    try {
      for (const record of objects) {
        if (jsonPrototype(record.value) !== record.prototype) throw new Error();
        const keys = ownJsonKeys(record.value);
        if (keys.length !== record.slots.length) throw new Error();
        for (let index = 0; index < keys.length; index++) {
          const slot = record.slots[index];
          if (!slot || keys[index] !== slot.key) throw new Error();
          const descriptor = ownJsonDescriptor(record.value, slot.key);
          if (!descriptor || !('value' in descriptor) || !sameJsonSlot(descriptor.value, slot.value)
            || descriptor.writable !== slot.writable || descriptor.enumerable !== slot.enumerable
            || descriptor.configurable !== slot.configurable) throw new Error();
        }
      }
    } catch { throw new JudgmentInputError('unsupported-input'); }
  };
  assertCurrent();
  return Object.freeze({ snapshot, assertCurrent });
}

function captureOwnedJsonInternal(value: unknown, rejectObject?: (value: object) => boolean,
  retained?: RetainedJsonObject[], includeHidden = false): unknown {
  // Local tool data is not a hosted judgment request. Walk iteratively so large
  // files, batches and deeply nested JSON do not inherit transport/stack limits.
  const ancestors = new Set<object>();
  const observed = retained ? new WeakSet<object>() : undefined;
  const unsupported = (): never => { throw new JudgmentInputError('unsupported-input'); };
  type Work = { entry: unknown; parent: object; key: string } | { original: object; copy: object };
  const result = Object.create(null) as Record<string, unknown>;
  const pending: Work[] = [{ entry: value, parent: result, key: 'value' }];
  try {
    while (pending.length) {
      const work = pending.pop()!;
      if ('original' in work) {
        Object.freeze(work.copy);
        ancestors.delete(work.original);
        continue;
      }
      const { entry, parent, key } = work;
      const assign = (data: unknown) => Object.defineProperty(parent, key, { value: data, enumerable: true });
      if (entry === null || entry === undefined || typeof entry === 'boolean' || typeof entry === 'string') {
        assign(entry); continue;
      }
      if (typeof entry === 'number') {
        if (!Number.isFinite(entry)) return unsupported();
        assign(entry); continue;
      }
      if (typeof entry !== 'object' || ancestors.has(entry) || rejectObject?.(entry)) return unsupported();
      const array = Array.isArray(entry);
      const prototype: unknown = Object.getPrototypeOf(entry);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return unsupported();
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      if (Object.getOwnPropertySymbols(descriptors).length > 0 || (array && Object.hasOwn(descriptors, 'constructor'))) return unsupported();
      if (Object.values(descriptors).some((descriptor) => !('value' in descriptor) || typeof descriptor.value === 'function')) return unsupported();
      if (retained && observed && !observed.has(entry)) {
        observed.add(entry);
        const keys = ownJsonKeys(entry);
        if (keys.length !== ownJsonKeys(descriptors).length) return unsupported();
        retained.push({ value: entry, prototype, slots: keys.map(key => {
          const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
          if (!descriptor || !('value' in descriptor)) return unsupported();
          return { key, value: descriptor.value, writable: descriptor.writable,
            enumerable: descriptor.enumerable, configurable: descriptor.configurable };
        }) });
      }
      const length: unknown = array ? descriptors['length']?.value : 0;
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 0xffff_ffff) return unsupported();
      const copy: object = array ? new Array(length) : Object.create(null) as object;
      assign(copy);
      ancestors.add(entry);
      pending.push({ original: entry, copy });
      for (const [childKey, descriptor] of Object.entries(descriptors).reverse()) {
        if (array ? childKey === 'length' : !includeHidden && !descriptor.enumerable) continue;
        pending.push({ entry: descriptor.value, parent: copy, key: childKey });
      }
    }
    return result['value'];
  } catch { return unsupported(); }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function credentialKey(key: string): boolean {
  return isSecretBearingConfigKey(key) || findCredentialScopeDeclaration(key) !== null || isDaemonNeededSecretKey(key);
}

function declaredControl(selector: unknown): JudgmentInputProblem | undefined {
  if (typeof selector !== 'string') return undefined;
  // CSS attribute equality syntax, not a guess from a merchant's name/label.
  for (const match of selector.matchAll(/\[\s*(autocomplete|type|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/gi)) {
    const attribute = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (attribute === 'type' && value.toLowerCase() === 'password') return 'credential-material';
    if (attribute === 'name' && CARD_FIELDS.has(value)) return 'card-material';
    if (attribute === 'autocomplete' && value.split(/\s+/).some((token) => CARD_FIELDS.has(token))) return 'card-material';
  }
  return undefined;
}

function fieldDeclaration(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  const type: unknown = fields['type']?.value;
  if (typeof type !== 'string' || !['string', 'number', 'integer', 'boolean', 'null'].includes(type)) return false;
  return Object.entries(fields).every(([key, descriptor]) => descriptor.get === undefined && descriptor.set === undefined
    && ['type', 'description', 'title', 'format', 'readOnly', 'writeOnly', '$comment'].includes(key));
}

function protectedKey(key: string): JudgmentInputProblem | undefined {
  if (CARD_FIELDS.has(key)) return 'card-material';
  if (CREDENTIAL_FIELDS_CASE_FOLDED.has(key.toLowerCase()) || AUTH_HEADERS.has(key.toLowerCase()) || credentialKey(key)) return 'credential-material';
  return undefined;
}

function reference(value: unknown): boolean {
  return isSecretReferenceValue(value) && typeof value === 'string' && /^goodvibes:\/\/secrets\/[^\s?#]+$/.test(value.trim());
}

function safeReference(value: unknown, problem: JudgmentInputProblem | undefined, evidence: boolean): boolean {
  return reference(value) || (problem === 'credential-material' && evidenceCredentialMarker(value, evidence))
    || (typeof value === 'string' && credentialReferenceText(value));
}

const LITERAL_SEEN: Readonly<Record<JudgmentInputProblem, string>> = {
  'credential-material': 'a literal credential value',
  'card-material': 'a literal card value',
  'unsupported-input': 'data that is not plain JSON',
};
const TOKEN_SEEN = 'a literal value shaped like a key or token';

function found(problem: JudgmentInputProblem, field?: string, seen?: string): JudgmentInputFinding {
  return { problem, field, seen };
}

// Syntax screening is deterministic for an immutable string and these two
// modes. Repeated ownership checks must still validate the source, but need
// not rescan unchanged multi-megabyte task text at every nested boundary.
// This bounds retained cache memory only; all input is always inspected.
const clearInlineText = new Map<string, number>();
const MAX_INLINE_CACHE_CHARS = 4 * 1024 * 1024;
const MAX_INLINE_CACHE_ENTRIES = 2048;
let inlineCacheChars = 0;
function inlineProblem(text: string, cardOnly = false, evidence = false, field?: string): JudgmentInputFinding | undefined {
  const mode = 1 << ((cardOnly ? 1 : 0) + (evidence ? 2 : 0));
  const known = clearInlineText.get(text) ?? 0;
  if (known & mode) return undefined;
  const problem = inspectInlineProblem(text, cardOnly, evidence, field);
  // Never retain rejected credential/card material in the cache.
  if (problem === undefined && text.length <= MAX_INLINE_CACHE_CHARS) {
    if (known) clearInlineText.delete(text);
    else inlineCacheChars += text.length;
    clearInlineText.set(text, known | mode);
    while (inlineCacheChars > MAX_INLINE_CACHE_CHARS || clearInlineText.size > MAX_INLINE_CACHE_ENTRIES) {
      const oldest = clearInlineText.keys().next().value!;
      inlineCacheChars -= oldest.length; clearInlineText.delete(oldest);
    }
  }
  return problem;
}

/**
 * Read only syntax with a declared meaning: KEY=value / JSON key:value and
 * HTTP authentication headers. Refusing the entire call avoids pretending a
 * redacted shell program has the same effects as the original program.
 */
function inspectInlineProblem(text: string, cardOnly = false, evidence = false, field?: string): JudgmentInputFinding | undefined {
  if (findCardNumbersInContext(text, 1).length > 0) return found('card-material', field, 'a payment card number');
  if (!cardOnly && /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) return found('credential-material', field, 'a private key block');
  for (const flags of [true, false]) {
    for (const declaration of inlineDeclarations(text, flags)) {
      const problem = protectedKey(declaration.key);
      if (problem && (!cardOnly || problem === 'card-material')
        && literalDeclarationValue(text, declaration, {
          kind: problem === 'card-material' ? 'card' : 'credential',
          evidence: problem === 'credential-material' && evidence,
          authHeader: AUTH_HEADERS.has(declaration.key.toLowerCase()),
        })) return found(problem, declaration.key, problem === 'card-material' ? LITERAL_SEEN[problem] : TOKEN_SEEN);
    }
  }
  // Start once per contiguous scheme-character run, rather than restarting a
  // greedy scan at every letter of a long document. The prefix preserves the
  // original earliest letter-started candidate after digits or punctuation.
  // URL userinfo has a password by definition, unlike a word in prose.
  for (const match of text.matchAll(/(?<![A-Za-z0-9+.-])[0-9+.-]*([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+)/g)) {
    try {
      const url = new URL(match[1]!);
      const password = decodedUrlPart(url.password);
      if (!cardOnly && password.length > 0 && !credentialReferenceText(password)) {
        return found('credential-material', 'URL password', LITERAL_SEEN['credential-material']);
      }
      for (const [key, value] of url.searchParams) {
        const problem = protectedKey(key);
        if (problem && (!cardOnly || problem === 'card-material') && present(value) && !reference(value) && !credentialReferenceText(value)
          && (problem === 'card-material' || secretLiteral(value))) return found(problem, key, problem === 'card-material' ? LITERAL_SEEN[problem] : TOKEN_SEEN);
      }
    } catch { /* Not a URL; its meaning remains Jev's question. */ }
  }
  return undefined;
}

/** A URL part decoded, or as written when its `%` is not an escape. */
function decodedUrlPart(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

const MASKED_CREDENTIAL = '[credential]';
/** A shell environment variable name: the shape the exec tool's credential names (PGPASSWORD, GITHUB_TOKEN, DB_PASSWORD) take. */
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** A declared key whose value is masked: a credential field, or an environment variable the exec tool withholds as a credential. */
function maskedKey(key: string): boolean {
  return protectedKey(key) === 'credential-material' || (ENVIRONMENT_NAME.test(key) && readCredentialEnvName(key));
}

/** Free text with the literal value of each credential declaration masked; the same string when there is none. */
function maskCredentialText(text: string): string {
  const spans: { start: number; end: number }[] = [];
  for (const flags of [true, false]) {
    for (const declaration of inlineDeclarations(text, flags)) {
      if (!maskedKey(declaration.key)) continue;
      const span = declaredValueSpan(text, declaration, {
        kind: 'credential', evidence: false, authHeader: AUTH_HEADERS.has(declaration.key.toLowerCase()),
      });
      if (span !== null) spans.push({ start: span.start, end: span.end });
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = '', cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, span.start)) + MASKED_CREDENTIAL;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * A judgment state with the literal value of every credential declaration in
 * its text masked. The screen above refuses key- or token-shaped values of a
 * credential field and passes shorter ones (a real but short password in a
 * command), and a credential environment variable (PGPASSWORD=..., GITHUB_TOKEN=...)
 * passes whatever its value; the decision
 * model needs to know a credential is there, never its value, so the copy it
 * is sent, and the one the decision log keeps, carries a marker instead. One
 * scan of the state's strings per request; unchanged parts are returned as
 * they are.
 */
export function maskJudgmentStateCredentials(state: EntryType): EntryType {
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return maskCredentialText(value);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      const next = value.map(mask);
      return next.every((entry, index) => entry === value[index]) ? value : next;
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const masked = mask(entry);
      if (masked !== entry) changed = true;
      next[key] = masked;
    }
    return changed ? next : value;
  };
  return mask(state) as EntryType;
}

/**
 * Return the first fixed refusal kind. Schema field names and operation names
 * are inspected even in nested tool/params wrappers and JSON-encoded bodies.
 * Empty credential fields and goodvibes secret references carry no raw value.
 */
function snapshotProblem(value: unknown, toolName: string, cardOnly = false, evidence = false): JudgmentInputFinding | undefined {
  const unsupported = found('unsupported-input');
  const ancestors = new Set<object>();
  type Entry = { entry: unknown; suffixes: readonly string[]; parentKey: string | undefined; operation: string };
  type Work = Entry | { leave: object } | { field: string; child: unknown; parent: Entry };
  const named = inlineProblem(toolName, cardOnly);
  if (named) return named;
  const pending: Work[] = [{ entry: value, suffixes: [], parentKey: undefined, operation: toolName }];
  while (pending.length) {
    const work = pending.pop()!;
    if ('leave' in work) { ancestors.delete(work.leave); continue; }
    if ('field' in work) {
      const { field: key, child, parent: { suffixes, parentKey, operation } } = work;
        const keyProblem = inlineProblem(key, cardOnly, evidence, 'a property name');
        if (keyProblem) return keyProblem;
        const fullSuffixes = [...suffixes.map(suffix => `${suffix}.${key}`), key];
        const cardField = (parentKey === 'cardMaterial' && (CARD_FIELD_NAMES as readonly string[]).includes(key)) || (parentKey === 'card' && (key === 'number' || key === 'expiry'));
        let declared: JudgmentInputProblem | undefined = cardField ? 'card-material' : protectedKey(key);
        if (declared === undefined) {
          for (const suffix of fullSuffixes) {
            declared = protectedKey(suffix);
            if (declared !== undefined) break;
          }
        }
        if (declared && (!cardOnly || declared === 'card-material') && present(child) && !safeReference(child, declared, evidence) && !fieldDeclaration(child)) return found(declared, fullSuffixes[0] ?? key, LITERAL_SEEN[declared]);
        pending.push({ entry: child, suffixes: fullSuffixes, parentKey: key, operation });
      continue;
    }
    const { entry, suffixes, parentKey, operation } = work;
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let decoded: unknown;
        try { decoded = JSON.parse(entry); } catch { const problem = inlineProblem(entry, cardOnly, evidence, parentKey); if (problem) return problem; continue; }
        pending.push({ entry: decoded, suffixes, parentKey, operation });
        continue;
      }
      const problem = inlineProblem(entry, cardOnly, evidence, parentKey);
      if (problem) return problem;
      continue;
    }
    if (entry === null || entry === undefined || typeof entry === 'boolean') continue;
    if (typeof entry === 'number') {
      // A card number arrives as text; a JSON number is a count, an id or a
      // clock (a declared card field holding one is refused by its name).
      if (!Number.isFinite(entry)) return unsupported;
      continue;
    }
    if (typeof entry !== 'object' || ancestors.has(entry)) return unsupported;
    const array = Array.isArray(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return unsupported;
    ancestors.add(entry);
    pending.push({ leave: entry });
    {
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      // Array.map consults constructor[Symbol.species], and JSON hooks can run
      // even when non-enumerable. Plain JSON must not supply executable hooks.
      if (Object.getOwnPropertySymbols(descriptors).length > 0 || (array && Object.hasOwn(descriptors, 'constructor'))) return unsupported;
      if (Object.values(descriptors).some((descriptor) => !('value' in descriptor) || typeof descriptor.value === 'function')) return unsupported;
      // Array.map and JSON read array slots regardless of enumerability. Inspect
      // every own array value; only an array's structural length is omitted.
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(descriptors)
        .filter(([key, descriptor]) => array ? key !== 'length' : descriptor.enumerable)
        .map(([key, descriptor]) => [key, descriptor.value as unknown]));
      const selected = OPERATION_FIELDS.map((field) => fields[field]).find((field) => field === CARD_CREATE || field === SECURITY_CODE || field === CREDENTIAL_SET);
      const op = typeof selected === 'string' ? selected : operation;
      const cardField = CARD_FIELD_NAMES.find((field) => present(fields[field]) && !reference(fields[field]) && !fieldDeclaration(fields[field]));
      if (op === CARD_CREATE && cardField !== undefined) return found('card-material', cardField, `card fields of ${CARD_CREATE}`);
      if (op === SECURITY_CODE && present(fields['code'])) return found('card-material', 'code', 'a card security code');
      const typedValue = fields['value'] ?? fields['text'];
      const targetField = fields['field'];
      const typedKey = fields['value'] !== undefined ? 'value' : 'text';
      if (present(typedValue) && !reference(typedValue)) {
        if (typeof targetField === 'string' && (CARD_FIELD_NAMES as readonly string[]).includes(targetField)) return found('card-material', typedKey, `text typed into the card field ${targetField}`);
        const control = declaredControl(fields['selector']);
        if (control && (!cardOnly || control === 'card-material')) return found(control, typedKey, `text typed into a ${control === 'card-material' ? 'card' : 'password'} control`);
        if (!cardOnly && fields['type'] === 'password') return found('credential-material', typedKey, 'text typed into a password control');
        if (typeof fields['autocomplete'] === 'string' && fields['autocomplete'].split(/\s+/).some((token) => CARD_FIELDS.has(token))) return found('card-material', typedKey, 'text typed into a card control');
      }
      const namedKey = fields['key'] ?? fields['configKey'] ?? fields['secretKey'] ?? fields['name'];
      if (cardOnly && present(fields['value']) && !reference(fields['value']) && !fieldDeclaration(fields['value'])
        && typeof namedKey === 'string' && protectedKey(namedKey) === 'card-material') return found('card-material', namedKey, LITERAL_SEEN['card-material']);
      const namedProblem = op === CREDENTIAL_SET ? 'credential-material' : typeof namedKey === 'string' ? protectedKey(namedKey) : undefined;
      if (!cardOnly && present(fields['value']) && !safeReference(fields['value'], namedProblem, evidence) && !fieldDeclaration(fields['value']) && namedProblem) {
        return found('credential-material', typeof namedKey === 'string' ? namedKey : 'value', LITERAL_SEEN['credential-material']);
      }
      for (const [key, child] of Object.entries(fields).reverse()) pending.push({ field: key, child, parent: { entry, suffixes, parentKey, operation: op } });
    }
  }
  return undefined;
}

/** Native evidence inspection only: no credential exception, projection or admission is produced. */
export function judgmentInputCardProblem(value: unknown, toolName = ''): 'card-material' | 'unsupported-input' | undefined {
  try {
    const problem = snapshotProblem(captureOwnedJson(value), toolName, true)?.problem;
    return problem === 'card-material' || problem === 'unsupported-input' ? problem : undefined;
  } catch (error) {
    if (error instanceof JudgmentInputError) return 'unsupported-input';
    throw error;
  }
}

/** Immutable, fully inspected data for consumers that will project or serialize it. */
export function snapshotJudgmentInput(value: unknown, toolName = ''): unknown {
  const snapshot = captureOwnedJson(value);
  const problem = snapshotProblem(snapshot, toolName);
  if (problem) throw new JudgmentInputError(problem);
  return snapshot;
}

/** Complete observational evidence, including exact public credential redaction
 * tokens. This never admits an action: snapshotJudgmentInput remains the raw
 * invocation boundary. Card data, attached secrets and malformed input retain
 * the same refusal rules. No fields, suffixes or source bytes are omitted. */
export function snapshotJudgmentEvidence(value: unknown): unknown {
  const snapshot = rememberCapturedRoot(captureOwnedJsonInternal(value, undefined, undefined, true));
  const problem = snapshotProblem(snapshot, '', false, true);
  if (problem) throw new JudgmentInputError(problem);
  return snapshot;
}

/** Convert captured data using the JSON wire's undefined/array rules, without invoking hooks. */
function projectJson(value: unknown): JsonValue {
  const result: Record<string, JsonValue> = {};
  type Container = JsonValue[] | Record<string, JsonValue>;
  type Work = { entry: unknown; parent: Container; key: string } | { finish: Container };
  const pending: Work[] = [{ entry: value, parent: result, key: 'value' }];
  while (pending.length) {
    const work = pending.pop()!;
    if ('finish' in work) { Object.freeze(work.finish); continue; }
    const { entry, parent, key } = work;
    const assign = (child: JsonValue) => Object.defineProperty(parent, key, { value: child, enumerable: true });
    if (entry === undefined || entry === null) { assign(null); continue; }
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') { assign(entry); continue; }
    if (typeof entry !== 'object') throw new JudgmentInputError('unsupported-input');
    const array = Array.isArray(entry);
    const copy: Container = array ? new Array<JsonValue>(entry.length) : {};
    if (!array) Object.setPrototypeOf(copy, null);
    assign(copy);
    pending.push({ finish: copy });
    for (const [childKey, child] of Object.entries(entry).reverse()) {
      if (array) {
        const index = Number(childKey);
        // JSON serializes only indexed array slots. Preserve sparse length
        // without allocating entries for every absent slot.
        if (!Number.isInteger(index) || index < 0 || index >= entry.length || String(index) !== childKey) continue;
      } else if (child === undefined) continue;
      pending.push({ entry: child, parent: copy, key: childKey });
    }
  }
  const projected = result['value'];
  if (projected === undefined) throw new JudgmentInputError('unsupported-input');
  rememberCapturedRoot(projected);
  return projected;
}

function projectJsonRoot(value: unknown): JsonValue {
  if (value === undefined) throw new JudgmentInputError('unsupported-input');
  return projectJson(value);
}

/** Structurally owned JSON for protocol adapters whose semantic fields are inspected separately. */
export function captureJsonValue(value: unknown): JsonValue {
  return projectJsonRoot(captureOwnedJson(value));
}

function entryOf(value: JsonValue): EntryType {
  if (typeof value === 'number' || typeof value === 'boolean') throw new JudgmentInputError('unsupported-input');
  return value;
}

/** Structurally owned state, restricted to the System One entry vocabulary. */
export function captureJsonEntry(value: unknown): EntryType {
  return entryOf(captureJsonValue(value));
}

/** Privacy-inspected JSON with a type derived from the captured values. */
export function snapshotJudgmentJson(value: unknown, toolName = ''): JsonValue {
  return projectJsonRoot(snapshotJudgmentInput(value, toolName));
}

/** Privacy-inspected state, restricted to text, object, array or null. */
export function snapshotJudgmentEntry(value: unknown, toolName = ''): EntryType {
  return entryOf(snapshotJudgmentJson(value, toolName));
}

/** The refusal for this input (its kind, field and message), or undefined when it passes. */
export function judgmentInputRefusal(value: unknown, toolName = ''): JudgmentInputError | undefined {
  try { snapshotJudgmentInput(value, toolName); return undefined; }
  catch (error) {
    if (error instanceof JudgmentInputError) return error;
    throw error;
  }
}

/** Return a fixed refusal kind without exposing input or executing its accessors. */
export function judgmentInputProblem(value: unknown, toolName = ''): JudgmentInputProblem | undefined {
  return judgmentInputRefusal(value, toolName)?.problem;
}

/** Must run before accessing the port, not only before awaiting a request. */
export function assertJudgmentInput(value: unknown, toolName = ''): void {
  snapshotJudgmentInput(value, toolName);
}
