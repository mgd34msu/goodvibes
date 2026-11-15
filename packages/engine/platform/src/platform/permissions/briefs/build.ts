import type { PermissionPromptRequest } from '../prompt.js';
import { riskDescriptorFor } from '../../runtime/permissions/risk-model.js';
import { explainPermissionRiskFamily } from '../../runtime/permissions/risk-language.js';
import type { PermissionApprovalBrief } from './types.js';
import type { PermissionRequestAnalysis } from '../types.js';
import { permissionSubject } from '../subject.js';

/** The request's subject as one string, one value per line (see permissionSubject for the parts). */
export function getDisplayArg(tool: string, args: Record<string, unknown>): string {
  return permissionSubject(tool, args).values.join('\n');
}

/** The request's own analysis, or the one every approval card shows when a request arrives without one. */
export function fallbackAnalysis(request: PermissionPromptRequest): PermissionRequestAnalysis {
  if (request.analysis) return request.analysis;
  const subject = permissionSubject(request.tool, request.args);
  return {
    classification: request.category,
    riskLevel: request.category === 'read' ? 'low' : request.category === 'write' ? 'medium' : 'high',
    summary: `Review ${request.tool} request`,
    reasons: ['Inspect the target and intent before approving this action.'],
    target: subject.values.join('\n'),
    targetKind: subject.kind,
  };
}

function titleForRisk(decisionModeLabel: string): string {
  const TITLES: Partial<Record<string, string>> = {
    delegation: 'Agent Delegation Approval',
    'shell-read': 'Shell Execution Approval',
    'shell-execution': 'Shell Execution Approval',
    'network-egress': 'Network Access Approval',
    'external-access': 'Network Access Approval',
    'config-mutation': 'Configuration Mutation Approval',
    'mcp-escalation': 'MCP Trust Escalation Approval',
  };
  const mapped = TITLES[decisionModeLabel]!;
  if (mapped) return mapped;
  const headline = decisionModeLabel.replace(/-/g, ' ');
  return headline.replace(/\b\w/g, (char) => char.toUpperCase()) + ' Approval';
}

function decisionModeLabelForRisk(family: string): string {
  switch (family) {
    case 'shell-read':
    case 'shell-mutation':
    case 'shell-destructive':
      return 'shell-execution';
    case 'network-egress':
      return 'external-access';
    default:
      return family;
  }
}

function checklistForDecision(family: string, decisionModeLabel: string): string {
  switch (decisionModeLabel) {
    case 'shell-execution':
      return explainPermissionRiskFamily('shell-mutation');
    case 'external-access':
      return explainPermissionRiskFamily('network-egress');
    default:
      return explainPermissionRiskFamily(family as Parameters<typeof explainPermissionRiskFamily>[0]);
  }
}

export function buildPermissionApprovalBrief(request: PermissionPromptRequest): PermissionApprovalBrief {
  const risk = riskDescriptorFor(fallbackAnalysis(request));
  const decisionModeLabel = decisionModeLabelForRisk(risk.family);
  const subject = permissionSubject(request.tool, request.args);
  return {
    title: titleForRisk(decisionModeLabel),
    subjectLabel: subject.label,
    subjectKind: subject.kind,
    subjectValues: subject.values,
    decisionModeLabel,
    checklist: checklistForDecision(risk.family, decisionModeLabel),
    risk,
  };
}
