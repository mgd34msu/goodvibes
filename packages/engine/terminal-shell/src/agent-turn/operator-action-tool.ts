import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { redactSensitiveDataAsync } from '@goodvibes-jev/engine/platform/platform/utils';
import { isDeepStrictEqual } from 'node:util';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { assertOperatorEffect } from './operator-connection-owner.js';
import { assertSafeOperatorPathValue, findOperatorContractMethod } from './operator-contract-routes.js';
import { createOperatorInputProjector, operatorExecutionConnection, operatorExecutionWireInput, operatorExecutionRequestPolicy, operatorMethodIsOutward } from './operator-input-projector.js';
import {
  buildOperatorActionRequest,
  formatOperatorActionFailure,
  formatOperatorActionSuccess,
  getOperatorActions,
  postOperatorAction,
  renderOperatorActionPath,
} from './operator-actions.js';
import { confirmParameter, requestParameter } from './effect-admission.js';

export function createAgentOperatorActionTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_operator_action',
      activity: { doing: 'Running', did: 'ran', object: 'an approved action', objects: 'approved actions' },
      description: 'Run one allowlisted operator action under current recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: Object.keys(getOperatorActions()),
            description: 'Exact allowlisted public operator method id to execute.',
          },
          targetId: {
            type: 'string',
            description: 'Generic target id.',
          },
          approvalId: {
            type: 'string',
            description: 'Approval id for approvals.approve, approvals.deny, or approvals.cancel.',
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
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, options) => {
      // Set once the host's answer to the request has been received or the request has failed in flight.
      let posted: { readonly methodId: string; readonly ok: boolean } | undefined;
      try {
        const parsed = buildOperatorActionRequest(captureStrictJudgmentJson(rawArgs));
        if (!parsed.ok) return { success: false, error: parsed.error };
        const descriptor = parsed.descriptor;
        assertSafeOperatorPathValue(parsed.targetId, descriptor.targetField);
        const request = captureStrictJudgmentJson(parsed);
        const method = findOperatorContractMethod(request.descriptor.action);
        const methodSnapshot = captureStrictJudgmentJson(method);
        const assertInvocation = () => {
          assertOperatorEffect(rawArgs, options, operatorMethodIsOutward(request.descriptor.action));
          if (getOperatorActions()[request.descriptor.action] !== descriptor
            || !isDeepStrictEqual(captureStrictJudgmentJson(descriptor), request.descriptor)
            || findOperatorContractMethod(request.descriptor.action) !== method
            || !isDeepStrictEqual(captureStrictJudgmentJson(method), methodSnapshot)) throw new Error('Connected operator action changed.');
        };
        assertInvocation();
        const connection = operatorExecutionConnection(rawArgs, options, shellPaths, configManager, 'action');
        if (!connection) throw new Error('Connected operator effects require a registered source projection.');
        const assertCurrent = () => { assertInvocation(); connection.assertCurrent(); };
        if (!connection.token) return { success: false, error: `auth_required: ${connection.unavailable?.reason ?? 'no connected-host operator token found'}.` };
        const wireBody = operatorExecutionWireInput(request.body ?? {}, rawArgs, options, shellPaths, configManager, 'action');
        const wireRequest = { ...request, body: request.body === null && !Object.keys(wireBody).length ? null : wireBody };
        const requestPolicy = operatorExecutionRequestPolicy(rawArgs, options, shellPaths, configManager, 'action');
        if (!requestPolicy) throw new Error('Connected operator source policy is unavailable.');
        await requestPolicy.screen({ toolName: 'agent_operator_action', methodId: request.descriptor.action,
          endpoint: `${connection.baseUrl}${renderOperatorActionPath(request.descriptor, request.targetId)}`, payload: wireBody }, { signal: options?.signal, assertCurrent });
        const result = await postOperatorAction(connection, wireRequest, { signal: options?.signal, assertCurrent });
        posted = { methodId: result.methodId, ok: result.ok };
        // The client says whether the host may have acted; a refusal or an unsent call ('no') is reported as such below.
        if (!result.ok && result.applied === 'unknown') {
          return { success: false, error: [
            `outcome_unknown: ${result.methodId} was sent, but no answer showed whether the host applied it (${result.error}).`,
            'The daemon may have applied it. Read the current state with a list or status method before retrying, and do not repeat the call blindly.',
          ].join(' ') };
        }
        assertCurrent();
        const output = await redactSensitiveDataAsync(result.ok ? formatOperatorActionSuccess(connection.baseUrl, result)
          : formatOperatorActionFailure(result), { signal: options?.signal, assertCurrent, secretValues: [connection.token] });
        assertCurrent();
        if (!result.ok) return { success: false, error: output };
        if (output === '[REDACTED]') return { success: false, error: 'Connected operator receipt could not be projected safely.' };
        return { success: true, output };
      } catch (error) {
        if (posted?.ok) {
          // The host accepted it; only the report back failed. No receipt is claimed.
          return { success: false, error: `outcome_unknown: ${posted.methodId} was accepted by the host, but the result could not be reported (${error instanceof Error ? error.message : String(error)}). Read the current state with a list or status method before retrying.` };
        }
        return { success: false, error: `Connected operator action was not sent (${error instanceof Error ? error.message : String(error)}). It requires current recorded effect admission and an unchanged connection.` };
      }
    },
  };
}

/**
 * `inProcess`: the daemon hosting this turn, which is then the connected host
 * (in-process-host.ts); absent in the Agent's own process.
 */
export function registerAgentOperatorActionTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost,
): void {
  registry.register(createAgentOperatorActionTool(shellPaths, configManager), { inputProjection: createOperatorInputProjector(shellPaths, configManager, 'action', inProcess) });
}
