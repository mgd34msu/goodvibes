import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { WEBUI_READER_LIMITS as LIMITS, type ResolvedCommandRank } from './webui-types.js';

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
