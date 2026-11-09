// Background/subagent tool-call permission gate.
//
// Extracted from orchestrator-runner.ts so the runner stays focused on the
// turn loop. This module owns the single rule: a background agent's tool calls
// are brokered through the SAME session permission mode as the foreground turn
// loop.
import type { PermissionManager } from '../permissions/manager.js';
import type { PermissionAttribution } from '../permissions/prompt.js';
import { buildToolDenial, buildDenialErrorMessage } from '../permissions/denial.js';
import type { ToolDenial } from '../types/tools.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { assertPermissionActive, awaitPermission } from '../permissions/cancellation.js';

/** The narrow slice of PermissionManager the background gate consults. */
export type BackgroundPermissionManager = Pick<
  PermissionManager,
  'checkDetailed' | 'check' | 'getBackgroundAgentsMode' | 'passesBoundary'
> & Partial<Pick<PermissionManager, 'prepareAutonomousOwner' | 'admitAutonomous' | 'autonomousPreparation' | 'projectAutonomousChoices' | 'releaseAutonomousChoices' | 'getMode' | 'captureExecutionMode'>>;

export type BackgroundPermissionOutcome =
  | { readonly approved: true; readonly modifiedArgs?: Record<string, unknown> | undefined }
  | { readonly approved: false; readonly error: string; readonly denial: ToolDenial };

/**
 * Background calls use the same owner/Jev/YOLO mode as foreground calls.
 * The retired backgroundAgents override cannot create a second execution policy.
 * An absent manager preserves isolated embedding contexts.
 */
export async function gateBackgroundToolCall(
  context: { readonly permissionManager?: BackgroundPermissionManager | undefined },
  /**
   * `template` is OPTIONAL here, unlike on AgentRecord.
   *
   * The body has always treated it as optional, it emits the attribution's
   * `template` only when the record carries a truthy one, because
   * PermissionAttribution.template is itself optional. Requiring it came from
   * `Pick<AgentRecord, 'id' | 'template'>`, not from anything this function
   * does, and it made every caller that has an id and no archetype invent one.
   * Widening, so the real caller in orchestrator-runner.ts (which passes a full
   * AgentRecord) is unaffected.
   */
  record: Pick<AgentRecord, 'id'> & { readonly template?: AgentRecord['template'] | undefined },
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BackgroundPermissionOutcome> {
  assertPermissionActive(signal);
  const manager = context.permissionManager;
  if (!manager) return { approved: true };
  const attribution: PermissionAttribution = {
    kind: 'background-agent',
    agentId: record.id,
    ...(record.template ? { template: record.template } : {}),
  };
  const result = await awaitPermission(() => manager.checkDetailed(toolName, args, attribution, { signal }), signal);
  if (result.approved) {
    return result.modifiedArgs ? { approved: true, modifiedArgs: result.modifiedArgs } : { approved: true };
  }
  const source = { reasonCode: result.reasonCode, sourceLayer: result.sourceLayer, userReason: result.userReason, detail: result.detail };
  return {
    approved: false,
    error: buildDenialErrorMessage(toolName, source),
    denial: buildToolDenial(source),
  };
}
