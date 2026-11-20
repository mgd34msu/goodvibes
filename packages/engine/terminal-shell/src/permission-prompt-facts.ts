import { getPermissionCategoryLabel } from './permission-category-label.js';
import type { PermissionCategory, PermissionPromptRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import { approvalQuestion, buildPermissionApprovalBrief, getDisplayArg } from '@goodvibes-jev/engine/platform/platform/permissions';
/** Common request facts; each permission UI retains its actual choices and approval interaction. */
export class PermissionPromptFacts {
  static getDisplayArg(tool: string, args: Record<string, unknown>): string {
    return getDisplayArg(tool, args);
  }
  static getCategoryLabel(category: PermissionCategory): { label: string; color: string } {
    return getPermissionCategoryLabel(category);
  }
  static getPromptTitle(request: PermissionPromptRequest): string {
    return approvalQuestion(request);
  }
  static getSubjectLabel(request: PermissionPromptRequest): string {
    return buildPermissionApprovalBrief(request).subjectLabel;
  }
}
