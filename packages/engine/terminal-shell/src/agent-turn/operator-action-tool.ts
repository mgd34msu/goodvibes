import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { captureStrictJudgmentJson } from '@goodvibes/engine/platform/platform/gate';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { assertSafeOperatorPathValue, ownerOnlyOperatorMethodIds } from './operator-contract-routes.js';
import { buildOperatorActionRequest, getOperatorActions, OPERATOR_ACTION_IDS } from './operator-actions.js';
import { scheduleNextRouteLines } from './schedule-next-routes.js';
import { runDaemonMethodNested } from './capability-tools.js';
import { confirmParameter, requestParameter } from './effect-admission.js';

/** The actions whose method the contract publishes as the owner's own act (answering an approval put to him). */
function ownerActionIds(): readonly string[] {
  const ownerOnly = new Set(ownerOnlyOperatorMethodIds());
  return OPERATOR_ACTION_IDS.filter((action) => ownerOnly.has(action));
}

/**
 * `agent_operator_action`: one allowlisted daemon action (a schedule run, paused or deleted; an automation run
 * cancelled; an approval cancelled). Each runs as a nested `capability_run` call naming the action's method, so it is
 * judged by that method's own declarations (a delete that cannot be undone is asked), the one gate a model's daemon
 * call goes through; this call only routes it and is classed a read, so the method's question is the only one.
 * Answering an approval or a question put to the owner is his own answer: refused here, with no question, whatever
 * approved the call.
 */
export function createAgentOperatorActionTool(
  _shellPaths: ShellPathService,
  _configManager: AgentConnectedHostConfigReader,
): Tool {
  const ownerActs = ownerActionIds();
  const routed = OPERATOR_ACTION_IDS.filter((action) => !ownerActs.includes(action));
  return {
    definition: {
      name: 'agent_operator_action',
      activity: { doing: 'Running', did: 'ran', object: 'an approved action', objects: 'approved actions' },
      description: 'Run one allowlisted operator action; it goes through the same permission gate as every other daemon call.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: Object.keys(getOperatorActions()).filter((action) => !ownerActs.includes(action)),
            description: 'Exact allowlisted public operator method id to execute. Answering an approval put to the owner is his own act, not an action here.',
          },
          targetId: {
            type: 'string',
            description: 'Generic target id.',
          },
          approvalId: {
            type: 'string',
            description: 'Approval id for approvals.cancel.',
          },
          jobId: {
            type: 'string',
            description: 'Automation job id.',
          },
          runId: {
            type: 'string',
            description: 'Automation run id for automation.runs.cancel or automation.runs.retry.',
          },
          scheduleId: {
            type: 'string',
            description: 'Schedule id for run, enable, disable, or delete.',
          },
          note: {
            type: 'string',
            description: 'Optional approval note for approval actions.',
          },
          remember: {
            type: 'boolean',
            description: 'Optional approval remember flag for approval actions only.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        required: ['action'],
        additionalProperties: false,
      },
      // This call reaches only the daemon, through the nested capability_run call that decides the action itself.
      sideEffects: ['state'],
      readModes: { field: 'action', values: routed },
      // Answering an approval put to the owner: refused to a model in every mode, never asked.
      ownerActs: { field: 'action', values: ownerActs },
    },
    execute: async (rawArgs, options) => {
      const parsed = buildOperatorActionRequest(captureStrictJudgmentJson(rawArgs));
      if (!parsed.ok) return { success: false, error: parsed.error };
      const descriptor = parsed.descriptor;
      if (ownerActs.includes(descriptor.action)) {
        return { success: false, error: `${descriptor.action} answers an approval that was put to the owner, which only he does; a call the model makes is refused whatever approved it. Nothing was sent. Tell the owner approval ${parsed.targetId} is waiting: he answers it in the approval prompt, in Waiting for you, or in the web UI.` };
      }
      try {
        assertSafeOperatorPathValue(parsed.targetId, descriptor.targetField);
        options?.signal?.throwIfAborted();
        if (!assertCurrentToolInvocation(rawArgs, options)) return { success: false, error: `${descriptor.action} was not sent: it runs only as an admitted tool call.` };
      } catch (error) {
        return { success: false, error: `Connected operator action was not sent (${error instanceof Error ? error.message : String(error)}).` };
      }
      // The action's method input: its target and, for an approval action, the note and remember flag.
      const answer = await runDaemonMethodNested(descriptor.action, { ...(parsed.body ?? {}), [descriptor.targetField]: parsed.targetId }, options);
      if (!answer.ok) return { success: false, error: answer.error };
      const scheduleId = descriptor.action.startsWith('automation.schedules.') ? parsed.targetId : '';
      return { success: true, output: [answer.text,
        ...(scheduleId ? scheduleNextRouteLines(scheduleId, { deleted: descriptor.action === 'automation.schedules.delete' }) : [])].join('\n') };
    },
  };
}

/**
 * `inProcess`: the daemon hosting this turn, which is then the connected host
 * (in-process-host.ts); absent in the Agent's own process. The action is sent by
 * the nested daemon-method runner, which holds the connection.
 */
export function registerAgentOperatorActionTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  _inProcess?: AgentInProcessHost,
): void {
  registry.register(createAgentOperatorActionTool(shellPaths, configManager));
}
