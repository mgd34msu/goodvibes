import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import {
  WEBUI_READER_LIMITS as LIMITS,
  type DaemonRefusalItem, type DaemonRefusalValue,
  type ResolvedCommandRank, type ResolvedDaemonRefusal, type WebuiReadResult,
} from './webui-types.js';

class Hold extends Error {
  constructor(readonly reason: 'budget' | 'unsupported-input') { super('WebUI reading held.'); }
}
const unsupported = (): never => { throw new Hold('unsupported-input'); };
const budget = (): never => { throw new Hold('budget'); };

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unsupported();
  if (Object.keys(value).some((key) => !keys.includes(key))) return unsupported();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) return unsupported();
  if (value.length > limit) return budget();
  return value;
}
function member<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) return unsupported();
  return value as T;
}

export function snapshotWebuiCode(input: unknown): { readonly code: string; readonly tag: string } {
  const source = object(snapshotJudgmentInput(input), ['code', 'tag']);
  return { code: text(source['code'], 8192), tag: text(source['tag'], 128, true) };
}

/** Screen every complete name before narrowing; credential values are not in this input contract. */
export function snapshotWebuiCredentialNames(input: unknown): { readonly providerId: string; readonly keys: readonly string[] } {
  const source = object(snapshotJudgmentInput(input), ['providerId', 'keys']);
  const names = source['keys'];
  if (!Array.isArray(names) || names.length < 1 || names.length > 64) return unsupported();
  const keys = names.map(name => text(name, 256));
  if (new Set(keys).size !== keys.length) return unsupported();
  return { providerId: text(source['providerId'], 128), keys };
}

/** Screen the whole original subject before the cap; never clip, redact, or normalize it. */
export function snapshotWebuiMailSubject(input: unknown): { readonly subject: string } {
  const source = object(snapshotJudgmentInput(input), ['subject']);
  return { subject: text(source['subject'], 4096, true) };
}

export function snapshotWebuiDaemonRefusal(input: unknown): ResolvedDaemonRefusal {
  // Inspect the COMPLETE source before caps, projection, any hash, or port use.
  const source = object(snapshotJudgmentInput(input), ['methodId', 'status', 'code', 'category', 'message']);
  const methodId = text(source['methodId'], 256);
  const message = text(source['message'], LIMITS.errorBytes, true);
  if (new TextEncoder().encode(message).byteLength > LIMITS.errorBytes) return budget();
  const status = source['status'];
  if (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || (status !== 0 && (status < 100 || status > 599)))) return unsupported();
  const code = source['code'] === undefined ? undefined : text(source['code'], 128, true);
  const category = source['category'] === undefined ? undefined : member(source['category'], ['network', 'authentication'] as const);
  return { methodId, message, ...(status === undefined ? {} : { status: status as number }),
    ...(code === undefined ? {} : { code }), ...(category === undefined ? {} : { category }) };
}

const REFUSAL_CODES: Readonly<Record<string, DaemonRefusalItem>> = {
  SESSION_NOT_FOUND: 'session_not_found', SESSION_CLOSED: 'session_closed',
  SESSION_ACTIVE: 'session_active', SESSION_NOT_LOCAL: 'session_not_local', METHOD_NOT_FOUND: 'method_unknown',
};
// Exact existing wire categories, not substring guesses or HTTP 412/501 inference.
const OTHER_CODES = new Set([
  'NO_ACTIVE_TURN', 'CONFLICT', 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'PERMISSION_DENIED',
  'NETWORK_UNREACHABLE', 'TIMEOUT', 'CANCELLED', 'NOT_INVOKABLE',
  'CALENDAR_NOT_CONFIGURED', 'CALENDAR_CREDENTIALS_MISSING', 'CALENDAR_AUTH_FAILED',
  'EMAIL_NOT_CONFIGURED', 'EMAIL_CREDENTIALS_MISSING', 'EMAIL_AUTH_FAILED',
  'IMAP_NOT_CONFIGURED', 'SMTP_NOT_CONFIGURED', 'IMAP_AUTH_FAILED', 'SMTP_AUTH_FAILED',
  'step-up-required', 'step-up-verifier-unavailable',
]);
const emptyRefusal = (): Record<DaemonRefusalItem, boolean> => ({
  session_not_found: false, session_closed: false, session_active: false, session_not_local: false, method_unknown: false,
});
function structuredRefusal(source: ResolvedDaemonRefusal): DaemonRefusalValue | undefined {
  const item = source.code !== undefined && Object.hasOwn(REFUSAL_CODES, source.code) ? REFUSAL_CODES[source.code] : undefined;
  if (item !== undefined) return { ...emptyRefusal(), [item]: item !== 'method_unknown' || source.status === 404 };
  if (OTHER_CODES.has(source.code ?? '') || source.status === 0 || source.status === 401 || source.category !== undefined) return emptyRefusal();
  return undefined;
}

/**
 * Pure caller-side path before the interpretation endpoint. A structural result
 * has no probabilities or decision IDs; `undefined` means a reading is needed.
 */
export function readStructuredDaemonRefusal(input: ResolvedDaemonRefusal): WebuiReadResult<DaemonRefusalValue> | undefined {
  try {
    const value = structuredRefusal(snapshotWebuiDaemonRefusal(input));
    return value === undefined ? undefined : { status: 'ready', value, basis: 'structured' };
  } catch (error) {
    if (error instanceof JudgmentInputError) return { status: 'held', reason: error.problem === 'unsupported-input' ? 'unsupported-input' : 'unsafe-input' };
    if (error instanceof Hold) return { status: 'held', reason: error.reason };
    throw error;
  }
}

export function snapshotWebuiCommandRank(input: unknown): ResolvedCommandRank {
  const source = object(snapshotJudgmentInput(input), ['query', 'registryVersion', 'candidates']);
  const query = text(source['query'], LIMITS.queryChars);
  const registryVersion = text(source['registryVersion'], 256);
  const entries = source['candidates'];
  if (!Array.isArray(entries)) return unsupported();
  if (entries.length > LIMITS.candidateCount) return budget();
  if (Object.keys(entries).length !== entries.length || Array.from({ length: entries.length }, (_, index) => !Object.hasOwn(entries, index)).some(Boolean)) return unsupported();
  const candidates = entries.map((entry: unknown) => {
    const candidate = object(entry, ['title', 'group', 'keywords']);
    const title = text(candidate['title'], LIMITS.titleChars);
    const group = candidate['group'] === undefined ? undefined : text(candidate['group'], LIMITS.groupChars, true);
    const rawKeywords = candidate['keywords'];
    if (rawKeywords !== undefined && !Array.isArray(rawKeywords)) return unsupported();
    if (rawKeywords && rawKeywords.length > LIMITS.keywordCount) return budget();
    if (rawKeywords && (Object.keys(rawKeywords).length !== rawKeywords.length || Array.from({ length: rawKeywords.length }, (_, index) => !Object.hasOwn(rawKeywords, index)).some(Boolean))) return unsupported();
    const keywords = rawKeywords?.map((keyword: unknown) => text(keyword, LIMITS.keywordChars));
    return { title, ...(group === undefined ? {} : { group }), ...(keywords === undefined ? {} : { keywords }) };
  });
  return { query, registryVersion, candidates };
}

/** Canonical key names and descriptions only. Values are never part of this source. */
export function snapshotWebuiConfigKeys(input: unknown): { readonly keys: readonly { readonly key: string; readonly description: string }[] } {
  const source = object(snapshotJudgmentInput(input), ['keys']);
  const names = source['keys'];
  if (!Array.isArray(names) || names.length < 1 || names.length > 64) return unsupported();
  const keys = names.map(entry => { const item = object(entry, ['key', 'description']); return { key: text(item['key'], 256), description: text(item['description'], 8192, true) }; });
  if (new Set(keys.map(item => item.key)).size !== keys.length) return unsupported();
  return { keys };
}
