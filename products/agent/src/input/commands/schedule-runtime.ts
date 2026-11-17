import type { CommandRegistry } from '../command-registry.ts';
import { buildReminderSchedulePreview, parseReminderScheduleArgs } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { createReminderSchedule, resolveReminderConnectedHostConnection } from '../../agent/reminder-schedule.ts';
import {
  formatReminderScheduleFailure,
  formatReminderSchedulePreview,
  formatReminderScheduleSuccess,
} from '../../agent/reminder-schedule-format.ts';
import { AgentRoutineRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { resolveAgentConnectedHostConnection } from '../../agent/routine-schedule-promotion.ts';
import { parseRoutineSchedulePromotionArgs } from '../../agent/routine-schedule-args.ts';
import {
  formatRoutineScheduleCorrelation,
  formatRoutineScheduleReceipt,
  formatRoutineScheduleReceipts,
} from '../../agent/routine-schedule-format.ts';
import {
  fetchLiveSchedules,
  reconcileRoutineScheduleReceipts,
  RoutineScheduleReceiptStore,
} from '../../agent/routine-schedule-receipts.ts';
import { latestRunPerJob, listAutomationRunsSince } from '../../agent/automation-runs-source.ts';
import { buildScheduleEditPreview, parseScheduleEditArgs } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { editConnectedSchedule, enrichScheduleEditPreviewFromConnectedHost } from '../../agent/schedule-edit.ts';
import {
  formatScheduleEditFailure,
  formatScheduleEditPreview,
  formatScheduleEditSuccess,
} from '../../agent/schedule-edit-format.ts';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { executeConfirmedOperatorAction } from './operator-actions-runtime.ts';
import { runRoutineSchedulePromotion } from './routines-runtime.ts';
import { commandRefusal } from './confirmation.ts';

function formatNextRun(nextRunAt?: number): string {
  return nextRunAt ? new Date(nextRunAt).toLocaleString() : 'n/a';
}

/** Runs fetch window used to annotate /schedule list with each schedule's latest outcome. */
const RECENT_RUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * /schedule list's data source: the connected host's live schedules
 * (automation.schedules.list) annotated with each schedule's latest run
 * outcome (automation.runs.list), so a missed or failed run shows up as an
 * honest outcome line instead of silence. Never reads the agent's local
 * automation manager (local execution is disabled by design).
 */
async function printScheduleList(ctx: CommandContext): Promise<void> {
  const shellPaths = requireShellPaths(ctx);
  const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
  const fetched = await fetchLiveSchedules(connection);
  if (!fetched.ok) {
    throw commandRefusal(`Could not reach the connected host for schedules: ${fetched.error ?? 'unknown error'}`);
  }
  if (fetched.schedules.length === 0) {
    ctx.print(
      'No connected-host schedules.\n'
      + 'Local add/run/enable/disable/remove are blocked. Use /schedule remind --at <time> --message <text> --yes for reminders or /schedule promote-routine <routine> --cron <expr> --yes for explicit connected schedules.'
    );
    return;
  }

  const runsSince = await listAutomationRunsSince(connection, Date.now() - RECENT_RUN_WINDOW_MS);
  const latestByJob = latestRunPerJob(runsSince.runs);

  const lines = ['Connected-host schedules', ''];
  // An empty run list from a host that did not answer is not "nothing failed".
  if (runsSince.unavailable) lines.push(`  Could not check recent run outcomes (failed or missed runs are not shown): ${runsSince.unavailable}`, '');
  for (const schedule of fetched.schedules) {
    const status = schedule.enabled === false ? '○ paused  ' : '● enabled ';
    const next = formatNextRun(schedule.nextRunAt);
    const last = schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : 'never';
    // The whole id: the host matches schedule ids exactly, so a cut id cannot drive the verbs below.
    lines.push(`  ${schedule.id}  ${status} runs ${schedule.runCount ?? 0}  next ${next}  last ${last}`);
    const cadence = schedule.scheduleKind
      ? `${schedule.scheduleKind} ${schedule.scheduleValue ?? ''}${schedule.timezone ? ` [${schedule.timezone}]` : ''}`.trim()
      : 'n/a';
    lines.push(`    name ${schedule.name}  schedule ${cadence}`);

    const latestRun = latestByJob.get(schedule.id);
    if (latestRun && (latestRun.status === 'missed' || latestRun.status === 'failed')) {
      const when = latestRun.endedAt ? new Date(latestRun.endedAt).toLocaleString() : 'unknown time';
      lines.push(`    outcome ${latestRun.status}, last attempt ${when}`);
    }
  }
  ctx.print(lines.join('\n'));
}

function printReadOnlyScheduleBoundary(print: (text: string) => void, requestedAction: string): void {
  print([
    'GoodVibes Agent local schedule commands are read-only in this runtime.',
    `  requested ${requestedAction}`,
    '  policy no hidden local Agent automation jobs or immediate automation runs',
    '  use /schedule list',
    '  connected run route /automation schedule run <schedule-id> --yes',
    '  schedule route use /schedule promote-routine <routine> --cron <expr> --yes to create a connected schedule explicitly',
  ].join('\n'));
}

async function promoteRoutineSchedule(args: readonly string[], ctx: CommandContext): Promise<void> {
  const parsed = parseRoutineSchedulePromotionArgs(args);
  if (parsed.errors.length > 0) {
    ctx.print([
      'Usage: /schedule promote-routine <routine-id> (--cron <expr>|--every <interval>|--at <iso-time>) [--timezone <tz>] [--name <schedule-name>] [--provider <id>] [--model <model>] [--delivery-channel <channel[:route][ | label]>|--delivery-route <route[ | label]>|--delivery-webhook <url>] [--disabled] --yes',
      ...parsed.errors.map((error) => `  ${error}`),
    ].join('\n'));
    return;
  }
  const shellPaths = requireShellPaths(ctx);
  const routine = AgentRoutineRegistry.fromShellPaths(shellPaths).get(parsed.routineId ?? '');
  if (!routine) {
    throw commandRefusal(`Unknown Agent routine ${parsed.routineId ?? ''}`);
  }
  await runRoutineSchedulePromotion(ctx, routine, parsed);
}

async function createReminder(args: readonly string[], ctx: CommandContext): Promise<void> {
  const parsed = parseReminderScheduleArgs(args);
  if (parsed.errors.length > 0) {
    ctx.print([
      'Usage: /schedule remind (--cron <expr>|--every <interval>|--at <iso-time>) (--message <text>|<text...>) [--timezone <tz>] [--name <schedule-name>] [--provider <id>] [--model <model>] [--delivery-channel <channel[:route][ | label]>|--delivery-route <route[ | label]>|--delivery-webhook <url>] [--disabled] --yes',
      ...parsed.errors.map((error) => `  ${error}`),
    ].join('\n'));
    return;
  }
  const preview = buildReminderSchedulePreview(parsed);
  if (!parsed.yes) {
    ctx.print(formatReminderSchedulePreview(preview));
    return;
  }
  const shellPaths = requireShellPaths(ctx);
  const connection = resolveReminderConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
  const result = await createReminderSchedule(connection, preview);
  ctx.print(result.ok ? formatReminderScheduleSuccess(result) : formatReminderScheduleFailure(result));
}

async function editSchedule(args: readonly string[], ctx: CommandContext): Promise<void> {
  const parsed = parseScheduleEditArgs(args, {
    defaultRequestProvenance: `/schedule edit ${args[0] ?? ''}`.trim(),
  });
  if (parsed.errors.length > 0) {
    ctx.print([
      'Usage: /schedule edit <schedule-id> [--cron <expr>|--every <interval>|--at <iso-time>] [--timezone <tz>] [--stagger-ms <ms>] [--name <text>] [--prompt <text>|--task <text> --success-criteria <text>] [--revision <rev> --yes]',
      ...parsed.errors.map((error) => `  ${error}`),
    ].join('\n'));
    return;
  }
  let preview = buildScheduleEditPreview(parsed);
  if (!parsed.yes) {
    try {
      const shellPaths = requireShellPaths(ctx);
      const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
      preview = await enrichScheduleEditPreviewFromConnectedHost(connection, preview);
    } catch {
      // A basic preview is still safer than blocking confirmation on local path services.
    }
    ctx.print(formatScheduleEditPreview(preview));
    return;
  }
  const shellPaths = requireShellPaths(ctx);
  const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
  const result = await editConnectedSchedule(connection, preview);
  ctx.print(result.ok ? formatScheduleEditSuccess(result) : formatScheduleEditFailure(result));
}

export function registerScheduleRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'schedule',
    effect: 'connected-host-state',
    // Its words are fields (kind, value, prompt), so an unclosed quote is refused, not shifted.
    strictArgs: true,
    aliases: ['sched'],
    description: 'Inspect schedules, create confirmed reminders, and explicitly promote Agent-local routines to connected schedules',
    usage: 'list | edit <id> --cron <expr> --yes | remind --at <iso> --message <text> --yes | receipts | reconcile | receipt <id> | promote-routine <routine-id> --cron <expr> --yes',
    argsHint: 'list | edit <id> --cron <expr> --yes | remind --at <iso> --message <text> --yes | receipts | reconcile | receipt <id> | promote-routine <routine-id> --cron <expr> --yes',
    async handler(args, ctx) {
      const sub = args[0];

      if (sub === 'remind' || sub === 'reminder') {
        await createReminder(args.slice(1), ctx);
        return;
      }

      if (sub === 'promote-routine' || sub === 'promote' || sub === 'create-routine-schedule') {
        await promoteRoutineSchedule(args.slice(1), ctx);
        return;
      }

      if (sub === 'receipts' || sub === 'history') {
        ctx.print(formatRoutineScheduleReceipts(RoutineScheduleReceiptStore.fromShellPaths(requireShellPaths(ctx)).snapshot()));
        return;
      }

      if (sub === 'reconcile' || sub === 'sync' || sub === 'status') {
        const shellPaths = requireShellPaths(ctx);
        const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
        const result = await reconcileRoutineScheduleReceipts(connection, RoutineScheduleReceiptStore.fromShellPaths(shellPaths).snapshot());
        ctx.print(formatRoutineScheduleCorrelation(result));
        return;
      }

      if (sub === 'receipt') {
        const id = args[1];
        if (!id) {
          throw commandRefusal('Usage: /schedule receipt <receipt-id>');
        }
        const receipt = RoutineScheduleReceiptStore.fromShellPaths(requireShellPaths(ctx)).get(id);
        ctx.print(receipt ? formatRoutineScheduleReceipt(receipt) : `Unknown routine schedule receipt ${id}`);
        return;
      }

      if (sub === 'edit' || sub === 'update' || sub === 'patch') {
        await editSchedule(args.slice(1), ctx);
        return;
      }

      if (sub === 'run' || sub === 'enable' || sub === 'disable' || sub === 'delete' || sub === 'remove') {
        const scheduleId = args[1] ?? '';
        if (!scheduleId) {
          throw commandRefusal(`Usage: /schedule ${sub} <schedule-id> --yes`);
        }
        const action = sub === 'run'
          ? 'automation.schedules.run'
          : sub === 'enable'
            ? 'automation.schedules.enable'
            : sub === 'disable'
              ? 'automation.schedules.disable'
              : 'automation.schedules.delete';
        await executeConfirmedOperatorAction(ctx, action, 'scheduleId', scheduleId, args.slice(2), `/schedule ${sub} <schedule-id> --yes`);
        return;
      }

      if (!sub || sub === 'list') {
        await printScheduleList(ctx);
        return;
      }

      if (sub === 'add') {
        printReadOnlyScheduleBoundary(ctx.print, `/schedule ${args.join(' ')}`.trim());
        return;
      }

      ctx.print(
        'Usage:\n'
        + '  /schedule list\n'
        + '  /schedule receipts\n'
        + '  /schedule reconcile\n'
        + '  /schedule receipt <receipt-id>\n'
        + '  /schedule run <schedule-id> --yes\n'
        + '  /schedule enable <schedule-id> --yes\n'
        + '  /schedule disable <schedule-id> --yes\n'
        + '  /schedule delete <schedule-id> --yes\n'
        + '  /schedule edit <schedule-id> [--cron <expr>|--every <interval>|--at <iso-time>] [--name <text>] [--prompt <text>|--task <text> --success-criteria <text>] --yes\n'
        + '  /schedule remind (--cron <expr>|--every <interval>|--at <iso-time>) (--message <text>|<text...>) [--delivery-channel <channel>|--delivery-route <route>|--delivery-webhook <url>] --yes\n'
        + '  /schedule promote-routine <routine-id> (--cron <expr>|--every <interval>|--at <iso-time>) [--delivery-channel <channel>|--delivery-route <route>|--delivery-webhook <url>] --yes\n'
        + '  Local schedule creation remains blocked; schedule lifecycle/edit actions are confirmed connected-host actions.'
      );
    },
  });
}
