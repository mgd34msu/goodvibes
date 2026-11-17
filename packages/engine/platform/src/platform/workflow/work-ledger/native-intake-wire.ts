/** Browser-safe conversation data. Capture and admission never grant execution authority. */
import { nativeConversationContinuationRefSchema, nativeConversationContinuationSchema } from './native-continuation-context.js';
import { nativeClassicConversationAdmissionSchema } from './native-intake-policy.js';
import { nativeSelectedDiffSelector, nativeSelectedDiffSelectorSchema, nativeSelectedDiffContextSchema } from './native-diff-context.js';
import { array, enum as enumSchema, literal, number, strictObject, string, union, type z } from 'zod/v4';

const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Count UTF-16 units and preserve the exact submitted string.
const text = string().min(1).max(20_000, 'Must contain at most 20000 UTF-16 code units')
  .regex(/\S/, 'Must contain non-whitespace text');
export const nativeConversationIntakeUnsupportedSourceSchema = strictObject({ kind: enumSchema(['image', 'file', 'context']), label: id });
export const nativeConversationIntakeCaptureRequestSchema = strictObject({
  requestId: id, inputId: id, text, continuation: strictObject({ sessionId: id, selectedDiff: nativeSelectedDiffSelectorSchema.optional() }).optional(), unsupportedSources: array(nativeConversationIntakeUnsupportedSourceSchema).max(100),
});
export const nativeConversationIntakeLookupRequestSchema = strictObject({ inputId: id });
export const nativeConversationIntakeTransitionRequestSchema = strictObject({ inputId: id, sourceRevision: id });
export const nativeConversationIntakeSourceRefSchema = strictObject({ version: literal(1), inputId: id, sourceId: id, sourceRevision: id, sessionId: id,
  classic: nativeClassicConversationAdmissionSchema.optional(), continuation: nativeConversationContinuationRefSchema.optional() });
const spanSchema = strictObject({ partId: literal('input'), start: revision, end: revision });
/** Immutable admission-event projection, not an execution receipt or client-supplied proof. */
export const nativeConversationIntakeWorkReceiptSchema = strictObject({
  projectId: id, requestId: id, inputId: id, ledgerRevision: revision, workId: id, attemptId: id,
  expectedRevision: strictObject({ work: revision, criteria: revision, attempt: revision }),
  source: strictObject({ version: literal(2), sourceId: id, sourceRevision: id, sessionId: id,
    offsetEncoding: literal('utf16'), proposalRevision: id, spans: array(spanSchema).min(1).max(100),
    continuation: nativeConversationContinuationSchema.optional(),
    admissionDecisionId: id, judgmentDecisionIds: array(id).min(1).max(128) }),
  goal: text, criteria: array(text).min(1).max(100),
}).refine(value => {
  const boundary = (offset: number): boolean => offset <= value.goal.length && !(offset > 0 && offset < value.goal.length
    && /[\uD800-\uDBFF]/.test(value.goal[offset - 1]!) && /[\uDC00-\uDFFF]/.test(value.goal[offset]!));
  return value.source.spans.length === value.criteria.length && value.source.spans.every((span, index) =>
    span.start >= (value.source.spans[index - 1]?.end ?? 0) && span.start < span.end && boundary(span.start) && boundary(span.end) && value.goal.slice(span.start, span.end) === value.criteria[index]);
}, 'Criteria must preserve exact source spans and UTF-16 boundaries');
const common = { projectId: id, requestId: id, sourceRef: nativeConversationIntakeSourceRefSchema };
export const nativeConversationIntakeResultSchema = union([
  strictObject({ kind: literal('captured'), ...common }),
  strictObject({ kind: literal('processing'), ...common, stage: enumSchema(['routing', 'extracting', 'checking', 'deciding', 'waiting']), recovery: enumSchema(['pending', 'required']) }),
  strictObject({ kind: literal('turn'), ...common, route: enumSchema(['converse', 'answer']), text, continuation: nativeConversationContinuationSchema.optional() }),
  strictObject({ kind: literal('blocked'), ...common, reason: enumSchema(['unsupported-source', 'missing-context']), recovery: literal('required'),
    /** Resuming a blocked input changes nothing; the only way forward is to cancel it and capture a new input. */
    next: literal('cancel-and-resubmit').optional() }),
  strictObject({ kind: literal('refused'), ...common, reason: enumSchema(['semantic', 'exhausted']) }),
  strictObject({ kind: literal('cancelled'), ...common }),
  strictObject({ kind: literal('work'), ...common, receipt: nativeConversationIntakeWorkReceiptSchema }),
]).refine(value => value.kind !== 'work' || (value.receipt.projectId === value.projectId && value.receipt.requestId === value.requestId
  && value.receipt.inputId === value.sourceRef.inputId && value.receipt.source.sourceId === value.sourceRef.sourceId
  && value.receipt.source.sourceRevision === value.sourceRef.sourceRevision && value.receipt.source.sessionId === value.sourceRef.sessionId), 'Receipt source identity mismatch')
  .refine(value => !value.sourceRef.classic || value.kind === 'cancelled' || value.kind === 'turn' && value.route === 'converse',
    'Admission without a decision model must describe an ordinary conversation or its cancellation')
  .refine(value => {
    const continuation = value.kind === 'turn' ? value.continuation : value.kind === 'work' ? value.receipt.source.continuation : value.sourceRef.continuation;
    return JSON.stringify(continuation ? { ...(continuation.version === 2 ? { version: 2 as const } : {}), sessionId: continuation.sessionId, revision: continuation.revision, ...(continuation.selectedDiff ? { selectedDiff: 'unifiedDiff' in continuation.selectedDiff ? nativeSelectedDiffSelector(nativeSelectedDiffContextSchema.parse(continuation.selectedDiff)) : continuation.selectedDiff } : {}) } : null) === JSON.stringify(value.sourceRef.continuation ?? null);
  }, 'Continuation source binding mismatch');
export const nativeConversationIntakeLookupResultSchema = union([
  nativeConversationIntakeResultSchema, strictObject({ kind: literal('not-found') }),
]);

export type NativeConversationIntakeUnsupportedSource = z.infer<typeof nativeConversationIntakeUnsupportedSourceSchema>;
export type NativeConversationIntakeCaptureRequest = z.infer<typeof nativeConversationIntakeCaptureRequestSchema>;
export type NativeConversationIntakeLookupRequest = z.infer<typeof nativeConversationIntakeLookupRequestSchema>;
export type NativeConversationIntakeTransitionRequest = z.infer<typeof nativeConversationIntakeTransitionRequestSchema>;
export type NativeConversationIntakeSourceRef = z.infer<typeof nativeConversationIntakeSourceRefSchema>;
export type NativeConversationIntakeWorkReceipt = z.infer<typeof nativeConversationIntakeWorkReceiptSchema>;
export type NativeConversationIntakeResult = z.infer<typeof nativeConversationIntakeResultSchema>;
export type NativeConversationIntakeLookupResult = z.infer<typeof nativeConversationIntakeLookupResultSchema>;

/** Source bytes stay fixed while the authenticated host may attach one terminal
 * Admission without a decision model. A later response cannot remove or rewrite that admission.
 * Both references must already have passed the wire schema.
 */
export function sameNativeConversationSource(previous: NativeConversationIntakeSourceRef,
  next: NativeConversationIntakeSourceRef, kind: NativeConversationIntakeResult['kind']): boolean {
  const identity = (value: NativeConversationIntakeSourceRef) => {
    const result = { ...value }; delete result.classic; return JSON.stringify(result);
  };
  if (identity(previous) !== identity(next)) return false;
  if (previous.classic) return JSON.stringify(previous.classic) === JSON.stringify(next.classic);
  return !next.classic || kind === 'turn';
}
