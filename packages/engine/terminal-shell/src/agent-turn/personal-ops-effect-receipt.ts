import { randomUUID } from 'node:crypto';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';

/** The artifact purpose a Personal Ops effect receipt is saved under; the lanes list artifacts by it. */
export const PERSONAL_OPS_EFFECT_RECEIPT_PURPOSE = 'personal-ops-effect-receipt';

export type PersonalOpsEffectReceiptLane = 'inbox' | 'calendar' | 'reminders';
/** `unknown`: the request reached the provider and its outcome could not be confirmed. */
export const PERSONAL_OPS_EFFECT_RECEIPT_STATUSES = ['succeeded', 'failed', 'unknown'] as const;
export type PersonalOpsEffectReceiptStatus = typeof PERSONAL_OPS_EFFECT_RECEIPT_STATUSES[number];

export interface PersonalOpsEffectReceipt {
  readonly laneId: PersonalOpsEffectReceiptLane;
  /** The tool call that performed the effect, e.g. `google mail.send`. */
  readonly sourceTool: string;
  readonly operation: string;
  readonly providerId: string;
  readonly status: PersonalOpsEffectReceiptStatus;
  /** The provider's id for what the effect made or changed, when it returned one. */
  readonly subjectId?: string | undefined;
  /** What the user sees in the result; never the message body or event description. */
  readonly summary: string;
  readonly failureReason?: string | undefined;
}

/**
 * Records one provider effect the Agent performed (a sent mail, a created event,
 * a scheduled reminder) as a small artifact the Personal Ops lanes list. The
 * status is a typed field, so reading it needs no model. Called after the
 * effect, so a failed write never changes the effect's own result; the caller
 * reports the effect as it happened either way.
 */
export async function writePersonalOpsEffectReceipt(store: ArtifactStore | undefined, receipt: PersonalOpsEffectReceipt): Promise<string | null> {
  if (!store) return null;
  const recordedAt = new Date().toISOString();
  try {
    const descriptor = await store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: `personal-ops-${receipt.laneId}-${receipt.operation.replace(/[^a-zA-Z0-9._-]+/g, '-')}-${randomUUID()}.json`,
      text: `${JSON.stringify({ version: 1, recordedAt, ...receipt }, null, 2)}\n`,
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: PERSONAL_OPS_EFFECT_RECEIPT_PURPOSE,
        laneId: receipt.laneId,
        operation: receipt.operation,
        receiptStatus: receipt.status,
        providerId: receipt.providerId,
        sourceTool: receipt.sourceTool,
        ...(receipt.subjectId ? { subjectId: receipt.subjectId } : {}),
        ...(receipt.failureReason ? { failureReason: receipt.failureReason } : {}),
        createdAt: recordedAt,
      },
    });
    return descriptor.id;
  } catch {
    // The effect already happened and its result stands; a receipt that could not be saved is only missing from the lane.
    return null;
  }
}
