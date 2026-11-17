// Background/subagent tool-call permission owner.
//
// A background agent's tool calls run through the one tool-batch executor
// (core/orchestrator-tool-runtime.ts), so they get the same admission, hooks,
// budget and events as the main session's calls. This module only picks the
// permission owner that executor consults: the session's own manager, under
// the SAME permission mode as the foreground turn loop.
import type { PermissionManager } from '../permissions/manager.js';
import type { PermissionAttribution } from '../permissions/prompt.js';
import type { PermissionCheckResult } from '../permissions/types.js';
import type { ToolExecutionDeps } from '../core/orchestrator-tool-runtime.js';
import type { AgentRecord } from '../tools/agent/index.js';

/** The narrow slice of PermissionManager the background gate consults. */
export type BackgroundPermissionManager = Pick<
  PermissionManager,
  'checkDetailed' | 'check' | 'getBackgroundAgentsMode' | 'passesBoundary'
> & Partial<Pick<PermissionManager, 'prepareAutonomousOwner' | 'admitAutonomous' | 'autonomousPreparation' | 'projectAutonomousChoices' | 'releaseAutonomousChoices' | 'retireAutonomousSource' | 'getMode' | 'captureExecutionMode'>>;

const UNGATED_RESULT: PermissionCheckResult = {
  approved: true,
  persisted: false,
  sourceLayer: 'config_policy',
  reasonCode: 'config_allow',
  analysis: { classification: 'generic', riskLevel: 'low', summary: 'No permission manager is wired for this run', reasons: [] },
};

/**
 * The permission owner for one background agent's calls, in the shape the
 * tool-batch executor takes. A manager with the autonomous admission owner is
 * used as is (every shipped product). A manager without it is asked per call
 * with the agent named as the asker. No manager leaves the run ungated, which
 * only an isolated embedding wires.
 */
export function backgroundToolCallOwner(
  manager: BackgroundPermissionManager | undefined,
  record: Pick<AgentRecord, 'id'> & { readonly template?: AgentRecord['template'] | undefined },
): ToolExecutionDeps['permissionManager'] {
  if (!manager) {
    return { check: async () => true, checkDetailed: async () => UNGATED_RESULT };
  }
  const optional = {
    ...(manager.prepareAutonomousOwner ? { prepareAutonomousOwner: manager.prepareAutonomousOwner.bind(manager) } : {}),
    ...(manager.projectAutonomousChoices ? { projectAutonomousChoices: manager.projectAutonomousChoices.bind(manager) } : {}),
    ...(manager.getMode ? { getMode: manager.getMode.bind(manager) } : {}),
    ...(manager.captureExecutionMode ? { captureExecutionMode: manager.captureExecutionMode.bind(manager) } : {}),
    ...(manager.retireAutonomousSource ? { retireAutonomousSource: manager.retireAutonomousSource.bind(manager) } : {}),
    ...(manager.releaseAutonomousChoices ? { releaseAutonomousChoices: manager.releaseAutonomousChoices.bind(manager) } : {}),
  };
  if (manager.admitAutonomous && manager.autonomousPreparation) {
    return {
      check: manager.check.bind(manager),
      checkDetailed: manager.checkDetailed.bind(manager),
      admitAutonomous: manager.admitAutonomous.bind(manager),
      autonomousPreparation: manager.autonomousPreparation.bind(manager),
      ...optional,
    };
  }
  const attribution: PermissionAttribution = {
    kind: 'background-agent',
    agentId: record.id,
    ...(record.template ? { template: record.template } : {}),
  };
  return {
    check: (toolName, args, _attribution, options) => manager.check(toolName, args, attribution, options),
    checkDetailed: (toolName, args, _attribution, options) => manager.checkDetailed(toolName, args, attribution, options),
    ...optional,
  };
}
