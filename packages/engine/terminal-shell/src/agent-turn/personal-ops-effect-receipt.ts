import { randomUUID } from 'node:crypto';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import { asRecordOfDecidedCall, RECORD_NOT_SAVED } from './record-of-decided-call.js';

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
export interface PersonalOpsReceiptWritten {
  /** The saved receipt's artifact id; null when none was saved. */
  readonly id: string | null;
  /**
   * Why the record was not saved, in words to say after the act's own result (the act already ran): a rule that
   * refuses saves, or plan mode. Absent when it was saved, or when there was nowhere to save it.
   */
  readonly notSaved?: string | undefined;
}

export async function writePersonalOpsEffectReceipt(store: ArtifactStore | undefined, receipt: PersonalOpsEffectReceipt): Promise<PersonalOpsReceiptWritten> {
  if (!store) return { id: null };
  const recordedAt = new Date().toISOString();
  try {
    // The receipt is the record of the act it follows, written inside that act's tool call: part of the act the owner's
    // gate decided, never a question of its own (record-of-decided-call.ts).
    const descriptor = await asRecordOfDecidedCall(() => store.create({
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
    }));
    return { id: descriptor.id };
  } catch (error) {
    // The effect already happened and its result stands; a receipt that could not be saved is only missing from the lane.
    // One a rule or plan mode refused is said after the act's result, truthfully.
    const message = error instanceof Error ? error.message : String(error);
    const at = message.indexOf(RECORD_NOT_SAVED);
    return at < 0 ? { id: null } : { id: null, notSaved: message.slice(at).replace(/\.+$/, '') };
  }
}
