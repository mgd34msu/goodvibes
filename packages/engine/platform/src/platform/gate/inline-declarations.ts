/** Exact declaration syntax only, not an interpretation of the supplied text. */
const BOUNDARY = /[\s{[,;&?="']/;
const KEY_START = /[A-Za-z_]/;
const KEY_PART = /[A-Za-z0-9_.-]/;
const SPACE = /\s/;
const QUOTE = /["']/;
const TOKEN_END = /[\s,;}]/;
const SECRET_REFERENCE_PREFIX = 'goodvibes://secrets/';
const EVIDENCE_CREDENTIAL_MARKERS = [
  '[REDACTED]', '<redacted>', '[REDACTED_TOKEN]', '[REDACTED_API_KEY]',
  '[REDACTED_GITHUB_TOKEN]', '[REDACTED_GITLAB_TOKEN]', '[REDACTED_SLACK_TOKEN]',
  '[REDACTED_AWS_KEY]', '[REDACTED_PROFILE]', '[REDACTED_TEXT]',
] as const;

/** These public markers are safe only in observational evidence, never action input. */
export function evidenceCredentialMarker(value: unknown, evidence: boolean): boolean {
  return evidence && typeof value === 'string' && EVIDENCE_CREDENTIAL_MARKERS.some(marker => marker === value);
}

export interface InlineDeclaration {
  readonly key: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly lastReferenceSeparator: number;
}

/**
 * Visit every overlapping declaration, flags before fields in the caller.
 * Keys and whitespace are consumed once. A shared value token's end and last
 * reference separator are scanned once, even when it contains nested keys.
 * Never capture, copy or validate the full remaining suffix for each key.
 */
export function* inlineDeclarations(text: string, flags: boolean): Generator<InlineDeclaration> {
  let cursor = 0, tokenEnd = 0, lastReferenceSeparator = -1;
  while (cursor < text.length) {
    const start = cursor++;
    if (start > 0 && !BOUNDARY.test(text.charAt(start - 1))) continue;
    let keyStart = start;
    if (flags) {
      if (text.charAt(keyStart++) !== '-') continue;
      if (text.charAt(keyStart) === '-') keyStart++;
    }
    if (!KEY_START.test(text.charAt(keyStart))) continue;
    let keyEnd = keyStart + 1;
    while (KEY_PART.test(text.charAt(keyEnd))) keyEnd++;
    cursor = keyEnd;
    let after = keyEnd;
    if (!flags && QUOTE.test(text.charAt(after))) after++;
    const whitespaceStart = after;
    while (SPACE.test(text.charAt(after))) after++;
    const separated = after > whitespaceStart;
    const delimiter = after;
    if (flags) {
      if (text.charAt(after) === '=') after++;
      else if (!separated) continue;
    } else {
      if (text.charAt(after) !== ':' && text.charAt(after) !== '=') continue;
      after++;
    }
    while (SPACE.test(text.charAt(after))) after++;
    // The original flag grammar can use whitespace as its separator when
    // `--password =` has no value after '='. Then '=' itself is the value.
    if (flags && separated && text.charAt(delimiter) === '='
      && (after === text.length || TOKEN_END.test(text.charAt(after)))) after = delimiter;
    if (after === text.length || TOKEN_END.test(text.charAt(after))) continue;
    if (after >= tokenEnd) {
      tokenEnd = after; lastReferenceSeparator = -1;
      while (tokenEnd < text.length && !TOKEN_END.test(text.charAt(tokenEnd))) {
        const character = text.charAt(tokenEnd);
        if (character === '?' || character === '#') lastReferenceSeparator = tokenEnd;
        tokenEnd++;
      }
    }
    yield { key: text.slice(keyStart, keyEnd), valueStart: after, valueEnd: tokenEnd, lastReferenceSeparator };
  }
}

const VALUE_QUOTE = /["'`]/;
const AUTH_SCHEME = /^(?:bearer|basic|token|digest|bot|apikey)$/i;
const EXPANSION = /^\$[{(]?[A-Za-z_]|\$\{|\{\{|<%|#\{|^%[A-Za-z_]\w*%$/;
const PLACEHOLDER = /^(?:x+|\*+|\.{3}|-+|changeme|change[-_]?me|placeholder|example|redacted|secret|password|passwd|token|none|null|nil|undefined|todo|tbd|dummy|fake|test|sample|your[-_].*|<[^>]*>|\[[^\]]*\])$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Text that names where a credential comes from instead of holding one: a
 * shell or template expansion (`$TOKEN`, `${DB_PASSWORD}`, `{{ token }}`), a
 * member expression or call (`process.env.API_KEY`, `form.password.value`,
 * `getToken()`), or a placeholder word (`changeme`, `<your key>`).
 */
export function credentialReferenceText(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return true;
  if (EXPANSION.test(text) || PLACEHOLDER.test(text)) return true;
  const expression = text.replace(/\(.*\)[;,)]*$/, '').replace(/[;,)]+$/, '');
  const segments = expression.split(/\??\.|\[[^\]]*\]/).filter(segment => segment.length > 0);
  // A JWT also has dotted segments; a member path has short identifier ones.
  return segments.length > 0 && (segments.length > 1 || expression !== text) && !text.startsWith('eyJ')
    && segments.every(segment => IDENTIFIER.test(segment) && !secretLiteral(segment));
}

/**
 * A literal shaped like a real key or token: a JWT, or at least 16 visible
 * characters mixing letters and digits with ten or more distinct characters
 * (issuer tokens, hex and base64 keys, UUIDs). A short or plain word such as
 * a test password is not; whether text is sensitive in meaning is the gate's
 * own `secrets` reading.
 */
export function secretLiteral(value: string): boolean {
  if (value.length < 16 || !/^[\x21-\x7e]+$/.test(value)) return false;
  if (/^eyJ[\w-]+\.[\w-]+\./.test(value)) return true;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return new Set(value).size >= 10;
}

export interface DeclaredValueRule {
  /** A credential value counts only when it is a secret-shaped literal; a card value counts whenever it is literal. */
  readonly kind: 'credential' | 'card';
  /** Redaction markers are allowed in observational evidence only. */
  readonly evidence: boolean;
  /** An HTTP authentication header: the credential is the token after a scheme word. */
  readonly authHeader?: boolean;
}

/**
 * Where a declaration's literal value sits: its span in `text` (quotes left
 * out; for an authentication header, the token after the scheme word) and the
 * value. Null for a secret reference, an empty value, an expansion, a member
 * expression or a placeholder. A safe reference chain must not repeatedly scan
 * every remaining path suffix.
 */
export function declaredValueSpan(
  text: string,
  declaration: InlineDeclaration,
  rule: DeclaredValueRule,
): { readonly start: number; readonly end: number; readonly value: string } | null {
  let start = declaration.valueStart, end = declaration.valueEnd;
  if (VALUE_QUOTE.test(text.charAt(start))) start++;
  if (end > start && VALUE_QUOTE.test(text.charAt(end - 1))) end--;
  if (end > start + SECRET_REFERENCE_PREFIX.length && text.startsWith(SECRET_REFERENCE_PREFIX, start)
    && declaration.lastReferenceSeparator < start) return null;
  if (start >= end) return null;
  let value = text.slice(start, end);
  if (rule.kind === 'credential' && rule.evidence && EVIDENCE_CREDENTIAL_MARKERS.some(marker => marker === value)) return null;
  if (rule.authHeader && AUTH_SCHEME.test(value)) {
    let next = declaration.valueEnd;
    while (SPACE.test(text.charAt(next))) next++;
    let tokenEnd = next;
    while (tokenEnd < text.length && !TOKEN_END.test(text.charAt(tokenEnd))) tokenEnd++;
    start = next; end = tokenEnd;
    if (VALUE_QUOTE.test(text.charAt(start))) start++;
    if (end > start && VALUE_QUOTE.test(text.charAt(end - 1))) end--;
    if (start >= end) return null;
    value = text.slice(start, end);
  }
  if (credentialReferenceText(value)) return null;
  return { start, end, value };
}

/**
 * Whether a declaration's value is literal material of its kind: any literal
 * for a card value, a key- or token-shaped literal for a credential.
 */
export function literalDeclarationValue(text: string, declaration: InlineDeclaration, rule: DeclaredValueRule): boolean {
  const span = declaredValueSpan(text, declaration, rule);
  return span !== null && (rule.kind === 'card' || secretLiteral(span.value));
}
