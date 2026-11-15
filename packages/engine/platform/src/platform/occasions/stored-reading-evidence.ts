/**
 * Gift history as model input: the one place machine-owned occasion records go
 * to a model (the gift interview's opening questions). The loader already
 * validated every record field by field; this screens the content that is sent
 * (credential and card material are refused) and drops the storage clock.
 */
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { GiftRecord } from './types.js';

export function storedGiftEvidence(history: readonly GiftRecord[]): readonly Omit<GiftRecord, 'recordedAt'>[] {
  return history.map(({ recordedAt: _clock, ...evidence }) => snapshotJudgmentInput(evidence) as Omit<GiftRecord, 'recordedAt'>);
}
