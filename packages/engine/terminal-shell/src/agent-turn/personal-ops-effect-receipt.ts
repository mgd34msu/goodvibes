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
   * refuses saves, plan mode, a save refused or failed. Absent when it was saved, or when there was nowhere to save it.
   */
  readonly notSaved?: string | undefined;
}

/**
 * Why a receipt's save did not happen, in plain words for "Its record was not saved: …": the owner's own rule ("a rule
 * of yours refuses saves (<its description>)"), his No, or the failure's own words without the wrappers a save's path
 * adds ("The artifact was not saved:", "Save an artifact was not done:") or a leading code (`outcome_unknown:`).
 */
function whyNotSaved(message: string): string {
  const rule = /a rule of yours refuses it(?: \(([^)]*)\))?/.exec(message);
  if (rule) return `a rule of yours refuses saves${rule[1] ? ` (${rule[1]})` : ''}`;
  let words = message.replace(/^The artifact was not saved:\s*/i, '').replace(/^Error:\s*/, '').replace(/^[A-Za-z ]+ was not done:\s*/, '').replace(/^[a-z]+(?:_[a-z]+)+:\s*/, '');
  words = words.replace(/\.+$/, '').trim();
  return words || 'the save did not happen';
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
    // Whatever kept it unsaved (a rule or plan mode that refuses saves, a save asked and refused, a store that failed) is
    // said after the act's result, truthfully: the act is reported done, its record not saved.
    const message = (error instanceof Error ? error.message : String(error)).trim();
    const at = message.indexOf(RECORD_NOT_SAVED);
    return { id: null, notSaved: at >= 0 ? message.slice(at).replace(/\.+$/, '') : `${RECORD_NOT_SAVED}: ${whyNotSaved(message)}` };
  }
}
