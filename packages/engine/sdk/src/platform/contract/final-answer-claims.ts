import { hashState, type NoulQuestion, type YesNoReading } from '@goodvibes-jev/judgment';

export interface AnswerClaimScope {
  readonly start: number;
  readonly end: number;
  readonly textDigest: string;
}
export interface AnswerClaimReview extends AnswerClaimScope {
  readonly stateHash: string;
  readonly decisionId: string;
  readonly reading: Pick<YesNoReading, 'probability' | 'verdict' | 'outcome'>;
}

// Only original immutable host-issued scope objects retain this association.
// The string is already the candidate answer, not another copy or a global
// content-keyed cache. Saved/foreign JSON must verify its actual commitment.
const scopeOutputs = new WeakMap<object, string>();

/** Preserve the actual host-issued scope through its completed reading. Copying
 * visible offsets/digests cannot acquire this private current-input identity. */
export function recordAnswerClaimReview(scope: AnswerClaimScope, details: Omit<AnswerClaimReview, keyof AnswerClaimScope>): AnswerClaimReview {
  const output = scopeOutputs.get(scope);
  if (output === undefined) throw new Error('Answer claim review requires its original host scope');
  const review = Object.freeze({ start: scope.start, end: scope.end, textDigest: scope.textDigest,
    stateHash: details.stateHash, decisionId: details.decisionId, reading: Object.freeze({ ...details.reading }) });
  scopeOutputs.set(review, output); return review;
}

/** Bind the exact claim range in the logged question as well as the state. */
export function scopedClaimQuestion(question: NoulQuestion, scope: AnswerClaimScope, outputDigest: string): NoulQuestion {
  return { ...question, instructions: { review: question.instructions ?? null,
    claimScope: { start: scope.start, end: scope.end, textDigest: scope.textDigest, outputDigest } } };
}

/** Contiguous exact text, retaining whitespace and the context around claims. */
export function answerClaimScopes(output: string, start = 0, end = output.length, limit = 4_000): AnswerClaimScope[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > output.length
    || !Number.isInteger(limit) || limit < 1 || limit > 4_000) throw new RangeError('Answer claim scope requires a valid range and chunk limit');
  const scopes: AnswerClaimScope[] = [];
  let offset = start;
  do {
    let boundary = Math.min(end, offset + limit);
    if (boundary < end) {
      const paragraph = output.lastIndexOf('\n', boundary);
      if (paragraph > offset + limit / 2) boundary = paragraph + 1;
      else {
        const space = output.lastIndexOf(' ', boundary);
        if (space > offset + limit / 2) boundary = space + 1;
      }
    }
    const scope = Object.freeze({ start: offset, end: boundary, textDigest: hashState(output.slice(offset, boundary)) });
    scopeOutputs.set(scope, output); scopes.push(scope);
    offset = boundary;
  } while (offset < end);
  return scopes;
}

/** Neither an absent passage nor overlapping checks can qualify an answer. */
export function completeAnswerClaimCoverage(output: string, scopes: readonly AnswerClaimScope[]): boolean {
  let offset = 0;
  if (!scopes.length) return false;
  for (const scope of scopes) {
    const originalOutput = scope && scopeOutputs.get(scope);
    if (!scope || !Number.isInteger(scope.start) || !Number.isInteger(scope.end) || scope.start !== offset
      || scope.end < scope.start || scope.end > output.length || scope.end - scope.start > 4_001
      || (scope.end === scope.start && output.length !== 0)
      || (originalOutput !== undefined ? originalOutput !== output : scope.textDigest !== hashState(output.slice(scope.start, scope.end)))) return false;
    offset = scope.end;
  }
  return offset === output.length && (output.length !== 0 || scopes.length === 1);
}
