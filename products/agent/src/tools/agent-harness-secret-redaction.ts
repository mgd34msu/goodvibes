import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn/preview-text';

/**
 * One redaction table for every harness read model that shows published text to
 * a model. Bearer forms come first: the generic `authorization: <value>` rule
 * would otherwise consume the word "Bearer" and leave the token behind.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
  [/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 <redacted>'],
  [/secret:\/\/[^\s,'"}]+/gi, 'secret://<redacted>'],
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
];

/** The text with secret-shaped values replaced, whitespace untouched and no length cap. */
export function redactSecretText(raw: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), raw);
}

/** Redacted, whitespace-collapsed and capped at `limit` characters. */
export function redactedHarnessPreview(raw: string, limit: number): string {
  return previewHarnessText(redactSecretText(raw), limit);
}

/** Whether `redactedHarnessPreview` would cut this text short. */
export function harnessPreviewCuts(raw: string, limit: number): boolean {
  return redactSecretText(raw).replace(/\s+/g, ' ').trim().length > limit;
}
