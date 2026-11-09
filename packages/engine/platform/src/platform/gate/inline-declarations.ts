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

/** Match exactly the existing quoted literal/reference/marker rules using spans.
 * A safe reference chain must not repeatedly scan every remaining path suffix.
 */
export function literalDeclarationValue(text: string, declaration: InlineDeclaration, allowEvidenceMarker: boolean): boolean {
  let start = declaration.valueStart, end = declaration.valueEnd;
  if (QUOTE.test(text.charAt(start))) start++;
  if (end > start && QUOTE.test(text.charAt(end - 1))) end--;
  if (start >= end) return false;
  if (end > start + SECRET_REFERENCE_PREFIX.length && text.startsWith(SECRET_REFERENCE_PREFIX, start)
    && declaration.lastReferenceSeparator < start) return false;
  if (allowEvidenceMarker && EVIDENCE_CREDENTIAL_MARKERS.some(marker => marker.length === end - start && text.startsWith(marker, start))) return false;
  return true;
}
