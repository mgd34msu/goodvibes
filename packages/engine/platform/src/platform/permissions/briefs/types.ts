import type { PermissionRiskDescriptor } from '../../runtime/permissions/risk-model.js';
import type { PermissionAnalysisTargetKind } from '../types.js';

/**
 * The facts behind an approval card's Details. The ask's own words (its question,
 * consequence and choices) are permissions/ask-presentation.ts's.
 */
export interface PermissionApprovalBrief {
  readonly subjectLabel: string;
  readonly subjectKind: PermissionAnalysisTargetKind;
  /** Every value of the request's subject, uncut (see permissions/subject.ts). */
  readonly subjectValues: readonly string[];
  readonly decisionModeLabel: string;
  readonly checklist: string;
  readonly risk: PermissionRiskDescriptor;
}
