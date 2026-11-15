/** Transport data only. Source text does not confer execution or verification authority. */
import { array, boolean, literal, number, strictObject, string, union, type z } from 'zod/v4';

/**
 * The one size rule for submitted work: the goal and criteria together, in
 * UTF-8. Every ledger read returns a work whole, with its attempt report and
 * evidence, inside a 1 MiB page; a quarter of that keeps the largest accepted
 * work readable, so work that is accepted can always be shown.
 */
export const NATIVE_WORK_SUBMISSION_MAX_TEXT_BYTES = 262_144;

const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Validate non-whitespace without trimming, normalization, deduplication, or reordering.
const text = string().min(1).max(20_000).regex(/\S/, 'Must contain non-whitespace text');
const criteria = array(text).min(1).max(100);
const encoder = new TextEncoder();
const textBytes = (value: { readonly goal: string; readonly criteria: readonly string[] }): number =>
  value.criteria.reduce((total, criterion) => total + encoder.encode(criterion).byteLength, encoder.encode(value.goal).byteLength);

/** The authenticated host owns project, actor, source, session, work, and attempt selection. */
export const nativeWorkSubmissionRequestSchema = strictObject({
  requestId: id, inputId: id, expectedRevision: revision, goal: text, criteria,
}).refine(value => textBytes(value) <= NATIVE_WORK_SUBMISSION_MAX_TEXT_BYTES,
  `The goal and criteria together must be at most ${NATIVE_WORK_SUBMISSION_MAX_TEXT_BYTES / 1024} KiB; shorten them or split the work`);

export const nativeWorkSubmissionLookupRequestSchema = strictObject({ requestId: id });

/** Immutable submit-event projection. This is not an engine execution receipt. */
export const nativeWorkSubmissionReceiptSchema = strictObject({
  projectId: id, requestId: id, inputId: id, ledgerRevision: revision, workId: id, attemptId: id,
  expectedRevision: strictObject({ work: revision, criteria: revision, attempt: revision }),
  source: union([
    strictObject({ version: literal(1), sourceId: id, sourceRevision: id, sessionId: id }),
    strictObject({ version: literal(3), sourceId: string().regex(/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/), sourceRevision: string().regex(/^[a-f0-9]{64}$/), sessionId: id }),
    strictObject({ version: literal(4), sourceId: string().regex(/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/), sourceRevision: string().regex(/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/), sessionId: id }),
  ]),
  goal: text, criteria,
});

export const nativeWorkSubmissionResultSchema = strictObject({
  kind: literal('submitted'), replayed: boolean(), receipt: nativeWorkSubmissionReceiptSchema,
});

export const nativeWorkSubmissionLookupResultSchema = union([
  strictObject({ kind: literal('found'), receipt: nativeWorkSubmissionReceiptSchema }),
  strictObject({ kind: literal('not-found') }),
]);

export type NativeWorkSubmissionRequest = z.infer<typeof nativeWorkSubmissionRequestSchema>;
export type NativeWorkSubmissionLookupRequest = z.infer<typeof nativeWorkSubmissionLookupRequestSchema>;
export type NativeWorkSubmissionReceipt = z.infer<typeof nativeWorkSubmissionReceiptSchema>;
export type NativeWorkSubmissionResult = z.infer<typeof nativeWorkSubmissionResultSchema>;
export type NativeWorkSubmissionLookupResult = z.infer<typeof nativeWorkSubmissionLookupResultSchema>;
