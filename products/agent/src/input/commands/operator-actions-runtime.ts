import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import {
  buildOperatorActionRequest,
  formatOperatorActionFailure,
  formatOperatorActionPreview,
  formatOperatorActionSuccess,
  postOperatorAction,
  type OperatorActionId,
} from '../../agent/operator-actions.ts';
import { resolveAgentConnectedHostConnection } from '../../agent/routine-schedule-promotion.ts';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal, stripYesFlag } from './confirmation.ts';

interface OperatorActionOptionParse {
  readonly note?: string;
  readonly remember?: boolean;
  readonly errors: readonly string[];
}

function parseOperatorActionOptions(args: readonly string[]): OperatorActionOptionParse {
  const errors: string[] = [];
  let note: string | undefined;
  let remember: boolean | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--note') {
      const value = args[index + 1];
      if (!value) {
        errors.push('--note requires text');
        continue;
      }
      note = value;
      index += 1;
      continue;
    }
    if (token === '--remember') {
      remember = true;
      continue;
    }
    if (token === '--no-remember') {
      remember = false;
      continue;
    }
    errors.push(`Unknown option ${token}`);
  }
  return { note, remember, errors };
}

export async function executeConfirmedOperatorAction(
  ctx: CommandContext,
  action: OperatorActionId,
  targetField: 'approvalId' | 'jobId' | 'runId' | 'scheduleId',
  targetId: string,
  rawArgs: readonly string[],
  usage: string,
): Promise<void> {
  const parsed = stripYesFlag(rawArgs);
  const options = parseOperatorActionOptions(parsed.rest);
  if (options.errors.length > 0) {
    ctx.print([`Usage: ${usage}`, ...options.errors.map((error) => `  ${error}`)].join('\n'));
    return;
  }
  const request = buildOperatorActionRequest({
    action,
    [targetField]: targetId,
    note: options.note,
    remember: options.remember,
  });
  if (!request.ok) {
    throw commandRefusal(request.error, undefined, 'USAGE');
  }
  const requestSummary = `/${action} ${targetId}`;
  if (!parsed.yes) throw commandRefusal(formatOperatorActionPreview(request, requestSummary), `Usage: ${usage}`, 'CONFIRMATION_REQUIRED');
  const shellPaths = requireShellPaths(ctx);
  const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
  const result = await postOperatorAction(connection, request);
  if (!result.ok) throw commandRefusal(formatOperatorActionFailure(result), undefined, 'COMMAND_FAILED');
  ctx.print(formatOperatorActionSuccess(connection.baseUrl, result));
}

function approvalActionFromSubcommand(sub: string): OperatorActionId | null {
  if (sub === 'approve') return 'approvals.approve';
  if (sub === 'deny') return 'approvals.deny';
  if (sub === 'cancel') return 'approvals.cancel';
  return null;
}

function automationActionFromParts(scope: string, verb: string): {
  readonly action: OperatorActionId;
  readonly targetField: 'jobId' | 'runId' | 'scheduleId';
} | null {
  if ((scope === 'job' || scope === 'jobs') && verb === 'run') return { action: 'automation.jobs.run', targetField: 'jobId' };
  // automation.jobs.pause/resume retired (redundant with
  // disable/enable), the user-facing "pause"/"resume" verb is unchanged,
  // it now maps onto the canonical disable/enable wire actions.
  if ((scope === 'job' || scope === 'jobs') && verb === 'pause') return { action: 'automation.jobs.disable', targetField: 'jobId' };
  if ((scope === 'job' || scope === 'jobs') && verb === 'resume') return { action: 'automation.jobs.enable', targetField: 'jobId' };
  if ((scope === 'run' || scope === 'runs') && verb === 'cancel') return { action: 'automation.runs.cancel', targetField: 'runId' };
  if ((scope === 'run' || scope === 'runs') && verb === 'retry') return { action: 'automation.runs.retry', targetField: 'runId' };
  if ((scope === 'schedule' || scope === 'schedules') && verb === 'run') return { action: 'automation.schedules.run', targetField: 'scheduleId' };
  if ((scope === 'schedule' || scope === 'schedules') && verb === 'enable') return { action: 'automation.schedules.enable', targetField: 'scheduleId' };
  if ((scope === 'schedule' || scope === 'schedules') && verb === 'disable') return { action: 'automation.schedules.disable', targetField: 'scheduleId' };
  if ((scope === 'schedule' || scope === 'schedules') && (verb === 'delete' || verb === 'remove')) return { action: 'automation.schedules.delete', targetField: 'scheduleId' };
  return null;
}

export async function handleApprovalOperatorAction(args: readonly string[], ctx: CommandContext): Promise<boolean> {
  const sub = (args[0] ?? '').toLowerCase();
  const action = approvalActionFromSubcommand(sub);
  if (!action) return false;
  const approvalId = args[1] ?? '';
  const usage = `/approval ${sub} <approval-id> [--note <text>] [--remember|--no-remember] --yes`;
  if (!approvalId) {
    throw commandRefusal(`Usage: ${usage}`);
  }
  await executeConfirmedOperatorAction(ctx, action, 'approvalId', approvalId, args.slice(2), usage);
  return true;
}

export function registerOperatorActionRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'automation',
    aliases: ['auto'],
    description: 'Run confirmed connected-host automation actions from the Agent TUI',
    hidden: true,
    usage: 'job <run|pause|resume> <job-id> --yes | run <cancel|retry> <run-id> --yes | schedule <run|enable|disable|delete> <schedule-id> --yes',
    argsHint: 'job run <id> --yes | run cancel <id> --yes | schedule disable <id> --yes',
    async handler(args, ctx) {
      const scope = (args[0] ?? '').toLowerCase();
      const verb = (args[1] ?? '').toLowerCase();
      const targetId = args[2] ?? '';
      const mapping = automationActionFromParts(scope, verb);
      const usage = '/automation job <run|pause|resume> <job-id> --yes | /automation run <cancel|retry> <run-id> --yes | /automation schedule <run|enable|disable|delete> <schedule-id> --yes';
      if (!mapping || !targetId) {
        throw commandRefusal(`Usage: ${usage}`);
      }
      await executeConfirmedOperatorAction(ctx, mapping.action, mapping.targetField, targetId, args.slice(3), usage);
    },
  });
}
