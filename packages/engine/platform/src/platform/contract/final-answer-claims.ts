import { hashState, type NoulQuestion, type YesNoReading } from '@goodvibes/judgment';

interface ClaimRange { readonly start: number; readonly end: number }
/** Compatibility-only saved passage binding. Fresh scopes use the complete
 * answer commitment already required by the independently recorded question. */
interface HistoricalAnswerClaimScope extends ClaimRange { readonly version?: undefined; readonly textDigest: string }
interface CurrentAnswerClaimScope extends ClaimRange { readonly version: 2; readonly outputDigest: string }
export type AnswerClaimScope = HistoricalAnswerClaimScope | CurrentAnswerClaimScope;
interface ClaimReviewDetails {
  readonly stateHash?: string;
  readonly decisionId: string;
  readonly reading: Pick<YesNoReading, 'probability' | 'verdict' | 'outcome'>;
}
export type AnswerClaimReview = AnswerClaimScope & ClaimReviewDetails;
/** Public handle contains no answer. Only this actual constructor's immutable
 * object can reuse its privately bound whole-output commitment. */
export interface AnswerClaimOutput { readonly digest: string }
interface OutputOwner { readonly output: string; readonly digest: string }
const freeze = Object.freeze;
const outputOwners = new WeakMap<AnswerClaimOutput, OutputOwner>(), scopeOutputs = new WeakMap<object, OutputOwner>();
const ownerOf = (value: AnswerClaimOutput | undefined) => value === undefined ? undefined : outputOwners.get(value);
const scopeOwner = (value: object) => scopeOutputs.get(value);

/**
 * Most passages one answer is read in. An answer longer than this many
 * 4,000-character passages is read in longer passages, so the scoped review of
 * one answer costs at most this many requests whatever its length.
 */
export const MAX_ANSWER_PASSAGES = 8;
const MIN_PASSAGE_LENGTH = 4_000;

/** The passage length for an answer of `length` characters. */
export function answerPassageLimit(length: number): number {
  return Math.max(MIN_PASSAGE_LENGTH, Math.ceil(length / MAX_ANSWER_PASSAGES));
}

/** A saved scope read back as data: its offsets and exactly one of the two digest forms. */
function scopeData(value: AnswerClaimScope): AnswerClaimScope | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const fields = value as { readonly [key in 'start' | 'end' | 'version' | 'textDigest' | 'outputDigest']?: unknown };
  const { start, end, version, textDigest, outputDigest } = fields;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  if (version === 2 && typeof outputDigest === 'string' && textDigest === undefined) return { version: 2, start, end, outputDigest };
  if (version === undefined && typeof textDigest === 'string' && outputDigest === undefined) return { start, end, textDigest };
  return undefined;
}

/** This existing complete-answer commitment is independently checked against
 * saved content receipts and exact logged questions. One per actual answer
 * owner, never one per passage or a global content-keyed cache. */
export function captureAnswerClaimOutput(output: string): AnswerClaimOutput {
  if (typeof output !== 'string') throw new TypeError('Answer claim output requires text');
  const digest = hashState(output), handle = freeze({ digest });
  outputOwners.set(handle, freeze({ output, digest })); return handle;
}
function originalOutput(output: string, supplied?: AnswerClaimOutput): OutputOwner {
  if (supplied === undefined) { const actual = captureAnswerClaimOutput(output); return ownerOf(actual)!; }
  const owner = ownerOf(supplied);
  if (!owner || owner.output !== output) throw new Error('Answer claim output requires its original host owner');
  return owner;
}

/** Preserve actual original scope identity, never a visible copied flag. */
export function recordAnswerClaimReview(scope: AnswerClaimScope, details: ClaimReviewDetails): AnswerClaimReview {
  const output = scopeOwner(scope);
  if (output === undefined) throw new Error('Answer claim review requires its original host scope');
  const review = freeze({ ...scope, ...(details.stateHash === undefined ? {} : { stateHash: details.stateHash }), decisionId: details.decisionId, reading: freeze({ ...details.reading }) });
  scopeOutputs.set(review, output); return review;
}

/** Bind exact offsets and complete original answer in the independently logged
 * question. Old saved questions retain their exact per-passage recipe. */
export function scopedClaimQuestion(question: NoulQuestion, scope: AnswerClaimScope, outputDigest: string): NoulQuestion {
  const captured = scopeData(scope); if (!captured) throw new Error('Invalid answer claim scope'); scope = captured;
  if (scope.version === 2) {
    if (scope.outputDigest !== outputDigest) throw new Error('Answer claim output binding changed');
    return { ...question, instructions: { review: question.instructions ?? null, claimScope: { version: 2, start: scope.start, end: scope.end, outputDigest } } };
  }
  return { ...question, instructions: { review: question.instructions ?? null,
    claimScope: { start: scope.start, end: scope.end, textDigest: scope.textDigest, outputDigest } } };
}

/** Contiguous exact text, retaining whitespace and surrounding context. The
 * actual completion owner supplies its existing whole-answer commitment. The
 * default passage length keeps a whole answer to `MAX_ANSWER_PASSAGES`. */
export function answerClaimScopes(output: string, start = 0, end = output.length, limit = answerPassageLimit(output.length), supplied?: AnswerClaimOutput): AnswerClaimScope[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > output.length
    || !Number.isInteger(limit) || limit < 1 || limit > answerPassageLimit(output.length)) throw new RangeError('Answer claim scope requires a valid range and chunk limit');
  const owner = originalOutput(output, supplied), scopes: AnswerClaimScope[] = [];
  let offset = start;
  do {
    let boundary = Math.min(end, offset + limit);
    if (boundary < end) {
      const paragraph = output.lastIndexOf('\n', boundary);
      if (paragraph > offset + limit / 2) boundary = paragraph + 1;
      else { const space = output.lastIndexOf(' ', boundary); if (space > offset + limit / 2) boundary = space + 1; }
    }
    const scope = freeze({ version: 2 as const, start: offset, end: boundary, outputDigest: owner.digest });
    scopeOutputs.set(scope, owner); scopes.push(scope); offset = boundary;
  } while (offset < end);
  return scopes;
}

/** Neither absent passages nor overlapping checks qualify an answer. A copied
 * handle cannot suppress hashing: foreign scope2 rows compare the actual whole
 * answer once unless an actual private output owner proves that exact string.
 * Coverage is data binding, not proof of a recorded reading or authorization. */
export function completeAnswerClaimCoverage(output: string, scopes: readonly AnswerClaimScope[], supplied?: AnswerClaimOutput): boolean {
  const actual = ownerOf(supplied); let expectedDigest = actual?.output === output ? actual.digest : undefined;
  let offset = 0;
  const longest = answerPassageLimit(output.length) + 1;
  if (!scopes.length) return false;
  for (const scope of scopes) {
    const original = scope && scopeOwner(scope);
    const data = scopeData(scope);
    if (!data || !Number.isInteger(data.start) || !Number.isInteger(data.end) || data.start !== offset
      || data.end < data.start || data.end > output.length || data.end - data.start > longest
      || (data.end === data.start && output.length !== 0)) return false;
    if (original !== undefined) {
      if (original.output !== output || data.version !== 2 || data.outputDigest !== original.digest) return false;
    } else if (data.version === 2) {
      expectedDigest ??= hashState(output);
      if (data.outputDigest !== expectedDigest) return false;
    } else if (data.textDigest !== hashState(output.slice(data.start, data.end))) return false;
    offset = data.end;
  }
  return offset === output.length && (output.length !== 0 || scopes.length === 1);
}
