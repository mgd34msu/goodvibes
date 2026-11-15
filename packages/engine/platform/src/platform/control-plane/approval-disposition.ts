import type { PermissionPromptDecision } from '../permissions/prompt.js';

/** Recorded provenance; never inferred from a legacy boolean or free text. */
export const SHARED_APPROVAL_DISPOSITIONS = [
  'approved', 'denied', 'amended', 'cancelled', 'expired', 'remembered',
] as const;
export type SharedApprovalDisposition = typeof SHARED_APPROVAL_DISPOSITIONS[number];
export type ExplicitApprovalDisposition = Extract<SharedApprovalDisposition, 'approved' | 'denied' | 'amended'>;

/** The persisted record is richer than the unchanged ordinary prompt result. */
export interface SharedApprovalDecision extends PermissionPromptDecision {
  readonly disposition?: SharedApprovalDisposition | undefined;
}

/** How a finished approval ended, as the record's status names it. */
export type FinishedApprovalStatus = 'approved' | 'denied' | 'cancelled' | 'expired';

/** Refuse malformed or contradictory resolution input before changing a record. */
export function assertExplicitApprovalDisposition(
  approved: unknown,
  disposition: unknown,
): asserts disposition is ExplicitApprovalDisposition | undefined {
  if (typeof approved !== 'boolean'
    || (disposition !== undefined && (approved
      ? disposition !== 'approved'
      : disposition !== 'denied' && disposition !== 'amended'))) {
    throw Object.assign(new Error('Approval disposition must match the explicit approval decision.'), {
      code: 'INVALID_ARGUMENT', status: 400,
    });
  }
}

export function isSharedApprovalDisposition(value: unknown): value is SharedApprovalDisposition {
  return typeof value === 'string' && (SHARED_APPROVAL_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * The one rule from a finished approval's disposition to its status and
 * verdict. A stored finished record keeps only the disposition (plus the
 * verdict for `remembered`, the one disposition that can go either way), so
 * the three can never disagree on disk.
 */
export function finishedApprovalOutcome(
  disposition: SharedApprovalDisposition,
  rememberedApproved?: boolean,
): { readonly status: FinishedApprovalStatus; readonly approved: boolean } | null {
  switch (disposition) {
    case 'approved': return { status: 'approved', approved: true };
    case 'denied':
    case 'amended': return { status: 'denied', approved: false };
    case 'cancelled': return { status: 'cancelled', approved: false };
    case 'expired': return { status: 'expired', approved: false };
    case 'remembered':
      if (typeof rememberedApproved !== 'boolean') return null;
      return rememberedApproved ? { status: 'approved', approved: true } : { status: 'denied', approved: false };
  }
}

/** Keep the exact legacy awaited shape: provenance is read from the record. */
export function ordinaryApprovalDecision(record: SharedApprovalDecision): PermissionPromptDecision {
  const { disposition: _disposition, ...decision } = record;
  return decision;
}
