import type { PermissionRiskDescriptor } from '../../runtime/permissions/risk-model.js';
import type { PermissionAnalysisTargetKind } from '../types.js';

export interface PermissionApprovalBrief {
  readonly title: string;
  readonly subjectLabel: string;
  readonly subjectKind: PermissionAnalysisTargetKind;
  /** Every value of the request's subject, uncut (see permissions/subject.ts). */
  readonly subjectValues: readonly string[];
  readonly decisionModeLabel: string;
  readonly checklist: string;
  readonly risk: PermissionRiskDescriptor;
}
