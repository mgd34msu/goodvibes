import type { JsonValue } from '@goodvibes/judgment';
import { buildGlobMatcher } from '../utils/glob-to-regex.js';
import type { ContractView } from './types.js';

/**
 * Registered host reads of the original owner's recorded work; never caller
 * prose. The value returned is the host record: it serves comparisons, source
 * accounting and the saved archive. A prompt takes {@link ownerEvidenceForModel}.
 */
export type OwnerEvidenceReader = (contract: ContractView, citationText: string) => JsonValue | undefined;

/** Session save bookkeeping is not a change to the observed source work. */
export function ownerEvidenceIdentity(evidence: JsonValue | undefined): JsonValue | undefined {
  return evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'sources')) : evidence;
}

/** Most owner reads one prompt lists when no declared files narrow them. */
export const OWNER_READS_MODEL_LIMIT = 60;

const OWNER_READS_MEANING = 'Earlier reads by the contract owner, matched line by line to the contract input: they show what was read, not review approval, tests or acceptance.';

/**
 * The owner's earlier reads as a model is shown them: the reads of the given
 * declared files (the unit's `files` patterns) plus any read whose cited lines
 * are quoted, and one sentence of meaning. With no declared files, the first
 * {@link OWNER_READS_MODEL_LIMIT} reads. Call ids, journal paths and sizes
 * stay in the host record: a model cannot use them, and the sizes change on
 * every session save.
 */
export function ownerEvidenceForModel(evidence: JsonValue | undefined, files?: readonly string[]): JsonValue | undefined {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !Array.isArray(evidence['sourceReads'])) return evidence;
  const patterns = (files ?? []).map(pattern => ({ path: pattern.replace(/\/$/, ''), match: buildGlobMatcher(pattern) }));
  const declared = (path: string): boolean => patterns.some(pattern => pattern.path === '.' ? !path.includes('/')
    : path === pattern.path || path.startsWith(pattern.path + '/') || pattern.match(path));
  const all = evidence['sourceReads'];
  const quoted = (read: JsonValue): boolean => read !== null && typeof read === 'object' && !Array.isArray(read) && typeof read['returnedContent'] === 'string';
  const scoped = patterns.length === 0 ? all : all.filter(read => quoted(read)
    || (read !== null && typeof read === 'object' && !Array.isArray(read) && typeof read['path'] === 'string' && declared(read['path'])));
  // Quoted reads are the ones a citation asked for; they are never the ones cut.
  const shown = scoped.length <= OWNER_READS_MODEL_LIMIT ? scoped
    : [...scoped.filter(quoted), ...scoped.filter(read => !quoted(read))].slice(0, OWNER_READS_MODEL_LIMIT);
  const validation = evidence['hostValidation'];
  const omitted = all.length - shown.length;
  const view: Record<string, JsonValue> = { kind: evidence['kind'] ?? 'original-owner-read-observations' };
  if (evidence['inputTree'] !== undefined) view['inputTree'] = evidence['inputTree'];
  if (validation && typeof validation === 'object' && !Array.isArray(validation)) {
    view['hostValidation'] = { operation: validation['operation'] ?? 'verify-recorded-owner-reads', success: validation['success'] ?? true,
      qualifiedFiles: validation['qualifiedFiles'] ?? all.length, returnedLines: validation['returnedLines'] ?? 0 };
  }
  view['sourceReads'] = shown;
  if (omitted > 0) {
    view['omittedFiles'] = omitted;
    view['omittedMeaning'] = patterns.length > 0
      ? 'The owner also read this many files outside this unit\'s declared files; they are not listed.'
      : 'The owner read this many more files than are listed; read a file yourself when you need it.';
  }
  view['meaning'] = OWNER_READS_MEANING;
  return view;
}
