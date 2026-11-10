import { hashState, type NoulQuestion, type YesNoReading } from '@goodvibes-jev/judgment';
import { types as nodeTypes } from 'node:util';

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
const apply = Reflect.apply, get = WeakMap.prototype.get, set = WeakMap.prototype.set, freeze = Object.freeze;
const descriptor = Object.getOwnPropertyDescriptor, prototype = Object.getPrototypeOf, isProxy = nodeTypes.isProxy;
const outputOwners = new WeakMap<AnswerClaimOutput, OutputOwner>(), scopeOutputs = new WeakMap<object, OutputOwner>();
const ownerOf = (value: AnswerClaimOutput | undefined) => value && apply(get, outputOwners, [value]) as OutputOwner | undefined;
const scopeOwner = (value: object) => apply(get, scopeOutputs, [value]) as OutputOwner | undefined;
function scopeData(value: AnswerClaimScope): AnswerClaimScope | undefined {
  if (!value || typeof value !== 'object' || isProxy(value) || ![null, Object.prototype].includes(prototype(value))) return undefined;
  const fields: Record<string, unknown> = {};
  for (const key of ['start', 'end', 'version', 'textDigest', 'outputDigest']) {
    const field = descriptor(value, key); if (!field) continue; if (!('value' in field)) return undefined; fields[key] = field.value;
  }
  if (typeof fields['start'] !== 'number' || typeof fields['end'] !== 'number') return undefined;
  if (fields['version'] === 2 && typeof fields['outputDigest'] === 'string' && !Object.hasOwn(fields, 'textDigest'))
    return { version: 2, start: fields['start'], end: fields['end'], outputDigest: fields['outputDigest'] };
  if (fields['version'] === undefined && typeof fields['textDigest'] === 'string' && !Object.hasOwn(fields, 'outputDigest'))
    return { start: fields['start'], end: fields['end'], textDigest: fields['textDigest'] };
  return undefined;
}

/** This existing complete-answer commitment is independently checked against
 * saved content receipts and exact logged questions. One per actual answer
 * owner, never one per passage or a global content-keyed cache. */
export function captureAnswerClaimOutput(output: string): AnswerClaimOutput {
  if (typeof output !== 'string') throw new TypeError('Answer claim output requires text');
  const digest = hashState(output), handle = freeze({ digest });
  apply(set, outputOwners, [handle, freeze({ output, digest })]); return handle;
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
  apply(set, scopeOutputs, [review, output]); return review;
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
 * actual completion owner supplies its existing whole-answer commitment. */
export function answerClaimScopes(output: string, start = 0, end = output.length, limit = 4_000, supplied?: AnswerClaimOutput): AnswerClaimScope[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > output.length
    || !Number.isInteger(limit) || limit < 1 || limit > 4_000) throw new RangeError('Answer claim scope requires a valid range and chunk limit');
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
    apply(set, scopeOutputs, [scope, owner]); scopes.push(scope); offset = boundary;
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
  if (!scopes.length) return false;
  for (const scope of scopes) {
    const original = scope && scopeOwner(scope);
    const data = scopeData(scope);
    if (!data || !Number.isInteger(data.start) || !Number.isInteger(data.end) || data.start !== offset
      || data.end < data.start || data.end > output.length || data.end - data.start > 4_001
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
