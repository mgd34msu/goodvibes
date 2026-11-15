import { judge } from '../runtime/judge.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { ENTITY_ALIAS_SLOTS, entityAlias } from './batteries/entity-alias.js';
import { splitKnowledgePassages } from './passages.js';
import { KnowledgeExtractionJudgmentHoldError } from './extraction-policy.js';

/** Names nominated per entity; one request reads them all. */
export const MAX_ENTITY_ALIAS_CANDIDATES = ENTITY_ALIAS_SLOTS.length;
/** Passages that mention the entity, sent with its one request. */
export const MAX_ENTITY_ALIAS_EVIDENCE_BYTES = 2_048;
/** A nominated name longer than this is a phrase, not a name. */
export const MAX_ENTITY_ALIAS_NAME_CHARS = 64;
const PASSAGE_CHARS = 600;
const SITE = 'knowledge.ingest.entity-alias';

interface EntityIdentity {
  readonly kind: string;
  readonly title: string;
}
interface AliasEvidence {
  readonly title: string;
  readonly summary: string;
  readonly extractionSummary: string;
  readonly excerpt?: string | undefined;
  readonly sections: readonly string[];
}

/** The caller stopped wanting the aliases (aborted or its source moved); nothing is kept. */
export class KnowledgeEntityAliasHoldError extends Error {
  constructor() {
    super('Knowledge entity aliases are on hold: the ingest that asked for them was cancelled or its source changed.');
    this.name = 'KnowledgeEntityAliasHoldError';
  }
}

function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const ALIAS_WORDS = String.raw`(?:also\s+)?(?:called|known\s+as|named|nicknamed|abbreviated(?:\s+as)?|short\s+for|stands\s+for|or\s+simply)|aka|a\.k\.a\.`;

function clean(raw: string): string {
  const words = raw.replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/gu, '').replace(/\s+/g, ' ').split(' ');
  return words.slice(0, 4).join(' ');
}

/**
 * Names a passage states for the entity: `Title (X)`, `X (Title)`, `Title, also
 * called X`, `X, known as Title`, and the title's initials where they occur as a
 * word. Every candidate is a literal span of the evidence.
 */
function nominate(title: string, evidence: string): string[] {
  const t = escape(title);
  const found: string[] = [];
  const patterns = [
    new RegExp(`${t}\\s*\\(\\s*([^()\\n]{1,${MAX_ENTITY_ALIAS_NAME_CHARS}}?)\\s*\\)`, 'giu'),
    new RegExp(`([\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}._'’-]*)\\s*\\(\\s*${t}\\s*\\)`, 'giu'),
    new RegExp(`${t}[,]?\\s+(?:is\\s+)?(?:${ALIAS_WORDS})\\s+["“'‘]?([^"”'’,.;:()\\n]{1,${MAX_ENTITY_ALIAS_NAME_CHARS}})`, 'giu'),
    new RegExp(`["“'‘]?([^"”'’,.;:()\\n]{1,${MAX_ENTITY_ALIAS_NAME_CHARS}}?)["”'’]?[,]?\\s+(?:is\\s+)?(?:${ALIAS_WORDS})\\s+${t}\\b`, 'giu'),
  ];
  for (const pattern of patterns) for (const match of evidence.matchAll(pattern)) if (match[1]) found.push(clean(match[1]));
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const initials = words.map((word) => word[0]!.toUpperCase()).join('');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escape(initials)}(?![\\p{L}\\p{N}])`, 'u').test(evidence)) found.push(initials);
  }
  const seen = new Set([title.toLowerCase()]);
  const out: string[] = [];
  for (const candidate of found) {
    const key = candidate.toLowerCase();
    if (!candidate || candidate.length > MAX_ENTITY_ALIAS_NAME_CHARS || seen.has(key) || !evidence.includes(candidate)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length === MAX_ENTITY_ALIAS_CANDIDATES) break;
  }
  return out;
}

/**
 * Aliases for each structured entity a source names. Code nominates candidate
 * names from the passages that mention the entity; an entity with none makes
 * no request; otherwise one request reads all of its candidates, and each
 * confident yes that is a literal span of the passages is kept. An entity whose
 * reading does not settle (unsure, deadline, no decision model) keeps no
 * inferred alias; the other entities keep theirs and the ingest goes on.
 */
export async function readKnowledgeEntityAliases(
  entities: readonly EntityIdentity[],
  input: AliasEvidence,
  signal?: AbortSignal,
  retainGuard?: (assertCurrent: () => void) => void,
  ownerCurrent?: () => void,
): Promise<readonly (readonly string[])[]> {
  const current = () => {
    if (signal?.aborted) throw new KnowledgeEntityAliasHoldError();
    // The host's own extraction hold keeps its kind; any other owner failure is this hold, without its detail.
    try { ownerCurrent?.(); } catch (error) { if (error instanceof KnowledgeExtractionJudgmentHoldError) throw error; throw new KnowledgeEntityAliasHoldError(); }
  };
  current();
  if (entities.length === 0) return [];
  retainGuard?.(current);
  const passages = splitKnowledgePassages([[input.title, input.summary, input.extractionSummary, input.excerpt, ...input.sections]], PASSAGE_CHARS);
  const encoder = new TextEncoder();
  const requests = entities.map(({ kind, title }) => {
    const lower = title.toLowerCase();
    const chosen: string[] = [];
    let bytes = 0;
    for (const passage of passages) {
      if (!passage.text.toLowerCase().includes(lower)) continue;
      const size = encoder.encode(passage.text).byteLength;
      if (bytes + size > MAX_ENTITY_ALIAS_EVIDENCE_BYTES) continue;
      bytes += size;
      chosen.push(passage.text);
    }
    const evidence = chosen.join('\n');
    return { entity: { kind, title }, evidence, candidates: evidence ? nominate(title, evidence) : [] };
  });
  // Only the passages and names that leave are scanned.
  for (const request of requests) if (request.candidates.length) assertJudgmentInput(request);
  const aliases = await Promise.all(requests.map(async ({ entity, evidence, candidates }) => {
    current();
    if (!candidates.length) return [] as readonly string[];
    const slots = ENTITY_ALIAS_SLOTS.slice(0, candidates.length);
    const outcome = await judge({
      site: SITE, battery: entityAlias, only: slots,
      state: { entity, candidates, evidence },
      ...(signal ? { signal } : {}),
      settle: (readings) => slots.flatMap((slot, index) => {
        const reading = readings[slot];
        const candidate = candidates[index]!;
        return reading?.outcome === 'act' && reading.verdict === 'yes' && evidence.includes(candidate) ? [candidate] : [];
      }),
      fallback: () => [],
      describe: (kept) => kept.length ? `aliases: ${kept.length} of ${candidates.length}` : 'no alias',
    });
    return outcome.value;
  })).catch((error: unknown) => {
    // Only the caller's abort rejects `judge`; report it as this hold.
    if (signal?.aborted) throw new KnowledgeEntityAliasHoldError();
    throw error;
  });
  current();
  return aliases;
}
