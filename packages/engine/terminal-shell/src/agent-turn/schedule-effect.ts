import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertProjectionExecution, type ToolInputProjector, type ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { getProcessUntrustedContentLedger as getSessionUntrustedContentLedger } from '@goodvibes-jev/engine/platform/platform/security';
import type { ConnectedHostConfigReader as AgentConnectedHostConfigReader } from './connected-host-client.js';
import { captureOperatorConnection } from './operator-connection-owner.js';
import { captureOperatorAutomationTarget } from './operator-automation-target.js';
import { executeOperatorMethodWithReceipt } from './operator-method-receipt.js';
import { scheduleNextRouteLines } from './schedule-next-routes.js';
import { agentArtifactEffectGuard, captureAgentExportPath } from './artifact-effect.js';
import type { AgentInProcessHost } from './in-process-host.js';

let nextScheduleCall = 0;
const captures = new WeakMap<object, { readonly shellPaths: ShellPathService; readonly configManager: AgentConnectedHostConfigReader;
  readonly inProcess: AgentInProcessHost | undefined;
  readonly connection: ReturnType<typeof captureOperatorConnection>;
  readonly selectedTarget?: { readonly id: string; readonly revision: string } | undefined }>();

/**
 * Resolve selected sources before any repair or model admission. The host is
 * the Agent's connected host; in a turn the daemon hosts for the Agent it is
 * that daemon, reached in process (`inProcess`) with the credentials the Agent presents to it.
 */
export function createScheduleInputProjector(shellPaths: ShellPathService, configManager: AgentConnectedHostConfigReader,
  inProcess?: AgentInProcessHost): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    const directory = shellPaths.workingDirectory;
    const workspace = captureAgentExportPath(directory, directory);
    const ledger = getSessionUntrustedContentLedger(), revisionOf = ledger.getPublicationRevision;
    const ledgerRevision = revisionOf.call(ledger);
    const connection = captureOperatorConnection(shellPaths, configManager, () => {
      request.signal?.throwIfAborted();
      if (shellPaths.workingDirectory !== directory) throw new ToolInputProjectionError('stale');
      if (getSessionUntrustedContentLedger() !== ledger || ledger.getPublicationRevision !== revisionOf
        || revisionOf.call(ledger) !== ledgerRevision) throw new ToolInputProjectionError('stale');
      workspace.assertCurrent();
    }, inProcess);
    const assertCurrent = () => { request.assertCurrent(); connection.assertCurrent(); };
    assertCurrent();
    let selectedTarget: { readonly id: string; readonly revision: string } | undefined;
    if (request.name === 'agent_schedule_edit') {
      const id = [request.args.scheduleId, request.args.jobId].find(value => typeof value === 'string' && value.trim());
      if (typeof id !== 'string') throw new ToolInputProjectionError('held');
      const targetId = id.trim();
      const native = await captureOperatorAutomationTarget('automation.jobs.update', { jobId: targetId }, connection,
        { signal: request.signal, assertCurrent });
      assertCurrent();
      const revision = native.wireFields.expectedMutationRevision;
      if (typeof revision !== 'string' || !revision) throw new ToolInputProjectionError('held');
      selectedTarget = Object.freeze({ id: targetId, revision });
    }
    const context = Object.freeze({});
    captures.set(context, { shellPaths, configManager, inProcess, connection, selectedTarget });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      async release() { captures.delete(context); } };
  } };
}

/** A connection/workspace restriction accompanies each newly admitted operator child. */
export function captureScheduleEffect(rawArgs: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, configManager: AgentConnectedHostConfigReader, registry: ToolRegistry, inProcess?: AgentInProcessHost) {
  const assertEffect = agentArtifactEffectGuard(rawArgs, options);
  assertEffect();
  const context = options?.inputProjectionContext, capture = context && captures.get(context);
  if (!context || !capture || capture.shellPaths !== shellPaths || capture.configManager !== configManager
    || capture.inProcess !== inProcess) throw new ToolInputProjectionError('held');
  const assertSource = () => {
    assertProjectionExecution(context, rawArgs); capture.connection.assertCurrent();
  };
  const assertCurrent = () => { assertEffect(); assertSource(); };
  assertCurrent();
  let sent = false;
  return {
    assertCurrent,
    /** True once the request was handed to the transport: from then on a failure cannot say it was not applied. */
    get sent() { return sent; },
    async invoke(methodId: string, input: Record<string, unknown>): Promise<Awaited<ReturnType<Tool['execute']>>> {
      let payload = input;
      if (methodId === 'automation.jobs.update') {
        const target = capture.selectedTarget;
        if (!target || target.id !== input.jobId) throw new ToolInputProjectionError('held');
        // The revision read when the edit was admitted; the host refuses the update if the job moved since.
        payload = { ...input, expectedMutationRevision: target.revision };
      }
      assertCurrent();
      sent = true;
      // Once the host has answered, its answer is the outcome: no fence runs after it.
      const receipt = await executeOperatorMethodWithReceipt(registry, `schedule-operator-${++nextScheduleCall}`, methodId,
        payload, options, { ...(options?.signal ? { signal: options.signal } : {}), assertCurrent: assertSource });
      if (!receipt.result.success && methodId === 'automation.jobs.update' && /AUTOMATION_JOB_STALE|"status": 409\b/.test(receipt.result.error ?? '')) {
        return { success: false, error: `The schedule changed since it was read, so the host refused the edit and nothing was changed. Read it again with schedule action:"list" scheduleId:"${String(input.jobId)}" and repeat the edit if it still applies.` };
      }
      // The host answered 2xx, so the change happened; only its answer could not be handed over.
      if (receipt.kind === 'held' && receipt.result.success) {
        return { success: true, output: [`${methodId} was applied on the connected host, but its answer could not be read, so the schedule id is not known here. List the schedules to see it; do not repeat the call.`, receipt.result.output ?? ''].filter(Boolean).join('\n') };
      }
      if (receipt.kind === 'received') {
        const body = receipt.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('id' in body) || typeof body.id !== 'string'
          || !body.id.trim() || (methodId === 'automation.jobs.update' && body.id !== input.jobId)) {
          return { success: false, error: 'The native schedule effect returned no matching schedule receipt.', output: receipt.result.output };
        }
      }
      return receipt.result;
    },
  };
}

/** Redacted child output is used only for presentation, never as effect authority. */
export function formatScheduleOperatorResult(result: Awaited<ReturnType<Tool['execute']>>, heading: string): Awaited<ReturnType<Tool['execute']>> {
  if (!result.success || !result.output) return result;
  let displayId = '(unknown)';
  try {
    const receipt: unknown = JSON.parse(result.output);
    if (receipt && typeof receipt === 'object' && !Array.isArray(receipt) && 'body' in receipt) {
      const body = receipt.body;
      if (body && typeof body === 'object' && !Array.isArray(body) && 'id' in body && typeof body.id === 'string') displayId = body.id;
    }
  } catch { /* The redacted receipt remains available as display text. */ }
  return { success: true, output: [heading, ...scheduleNextRouteLines(displayId), result.output].join('\n') };
}
