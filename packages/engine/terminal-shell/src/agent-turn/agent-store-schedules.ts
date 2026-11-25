/**
 * The acts that let a routine run by itself (capabilities/builtin/routines.ts:
 * switching it on or off, putting it on a schedule, the receipts of those
 * schedules and checking them against the schedules that exist), done by the
 * daemon on the routine store and its own schedules.
 */
import { CapabilityRefusal, type ActionValues } from '@goodvibes/engine/platform/platform/capabilities';
import { AgentRoutineRegistry, type AgentRoutineRecord } from './routine-registry.js';
import {
  buildRoutineSchedulePreview, formatRoutineScheduleCorrelation, formatRoutineScheduleFailure, formatRoutineScheduleReceipt, formatRoutineScheduleReceipts,
  formatRoutineScheduleSuccess, formatReceiptsOnOtherHosts, promoteRoutineToConnectedSchedule, reconcileRoutineScheduleReceipts, routinePromotionBlockers,
  RoutineScheduleReceiptStore, type ParsedRoutineSchedulePromotionArgs,
} from './routine-schedules.js';
import {
  parseChannelDeliveryTarget, parseLinkDeliveryTarget, parseRouteDeliveryTarget, parseWebhookDeliveryTarget, validateDeliveryTargets,
  type RoutineScheduleDeliveryTargetSpec,
} from './schedule-delivery-targets.js';
import { storeStep, type StoreAct, type StoreActContext } from './agent-store-common.js';

const routinesOf = (context: StoreActContext): AgentRoutineRegistry => AgentRoutineRegistry.fromShellPaths(context.shellPaths);
const receiptsOf = (context: StoreActContext): RoutineScheduleReceiptStore => RoutineScheduleReceiptStore.fromShellPaths(context.shellPaths);

function routineOrRefuse(context: StoreActContext, idOrName: string): AgentRoutineRecord {
  const routine = storeStep(() => routinesOf(context).get(idOrName));
  if (!routine) throw new CapabilityRefusal(`No routine ${idOrName}.`, 'Your routines are listed in Memory and knowledge and in Automation.', 'NOT_FOUND');
  return routine;
}

/** The schedule a promotion asks for, read from the values. */
function promotionOf(values: ActionValues): ParsedRoutineSchedulePromotionArgs {
  const errors: string[] = [];
  const deliveryTargets: RoutineScheduleDeliveryTargetSpec[] = [];
  const add = (raw: string | undefined, parse: (value: string) => RoutineScheduleDeliveryTargetSpec | string): void => {
    for (const value of (raw ?? '').split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const target = parse(value);
      if (typeof target === 'string') errors.push(target);
      else deliveryTargets.push(target);
    }
  };
  add(values.channel, parseChannelDeliveryTarget);
  add(values.route, parseRouteDeliveryTarget);
  add(values.webhook, parseWebhookDeliveryTarget);
  add(values.link, parseLinkDeliveryTarget);
  const kind = values.how as 'cron' | 'every' | 'at';
  if (values.tz && kind !== 'cron') errors.push(`A time zone only applies to a calendar pattern; an "${kind}" schedule would ignore it.`);
  const deliveryError = validateDeliveryTargets(deliveryTargets, 'routine promotion');
  if (deliveryError) errors.push(deliveryError);
  return {
    routineId: values.routine ?? null, schedule: { kind, value: values.when ?? '' }, deliveryTargets,
    ...(values.name ? { name: values.name } : {}), ...(values.tz ? { timezone: values.tz } : {}),
    ...(values.provider ? { provider: values.provider } : {}), ...(values.model ? { model: values.model } : {}),
    enabled: values.paused !== 'yes', yes: true, errors,
  };
}

function connectionOf(context: StoreActContext) {
  if (!context.scheduleHost) throw new CapabilityRefusal('This daemon cannot reach its own schedules; nothing was done.');
  return context.scheduleHost();
}

export const SCHEDULE_ACTS: Readonly<Record<string, StoreAct>> = {
  async 'routines.enable'(values, context) {
    const routine = storeStep(() => routinesOf(context).setEnabled(values.routine!, true));
    return { text: `Switched on routine ${routine.name}.`, data: { routine: routine.id, enabled: true } };
  },
  async 'routines.disable'(values, context) {
    const routine = storeStep(() => routinesOf(context).setEnabled(values.routine!, false));
    return { text: `Switched off routine ${routine.name}.`, data: { routine: routine.id, enabled: false } };
  },
  async 'routines.promote'(values, context) {
    const parsed = promotionOf(values);
    if (parsed.errors.length > 0) throw new CapabilityRefusal(['No schedule was made:', ...parsed.errors.map((error) => `  ${error}`)].join('\n'));
    const routine = routineOrRefuse(context, values.routine!);
    const blockers = routinePromotionBlockers(routine);
    if (blockers.length > 0) throw new CapabilityRefusal([`No schedule was made for routine ${routine.name}:`, ...blockers.map((blocker) => `  ${blocker}`)].join('\n'));
    // Its runs work in the asking program's project; a caller that names none gets no schedule.
    if (!context.projectGiven) throw new CapabilityRefusal(`No schedule was made for routine ${routine.name}: no project folder came with the request, and a schedule's runs work in a project.`, 'Send workingDirectory, the project folder its runs work in.');
    const preview = storeStep(() => buildRoutineSchedulePreview(routine, parsed));
    const connection = connectionOf(context);
    // A retry after a lost answer finds the schedule the first attempt made (promoteRoutineToConnectedSchedule), so none runs twice.
    const result = await promoteRoutineToConnectedSchedule(connection, preview, { workingDirectory: context.shellPaths.workingDirectory });
    let receiptLine: string;
    try {
      receiptLine = `  receipt ${receiptsOf(context).append(connection, preview, result).id}`;
    } catch (error) {
      // The schedule's answer comes first; a receipt that cannot be written must not hide it.
      receiptLine = `  the receipt was not recorded: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!result.ok) throw new CapabilityRefusal(`${formatRoutineScheduleFailure(result)}\n${receiptLine}`);
    const schedule = result.schedule as { readonly id?: unknown };
    return { text: `${formatRoutineScheduleSuccess(result)}\n${receiptLine}`, data: { routine: routine.id, ...(typeof schedule.id === 'string' ? { schedule: schedule.id } : {}) } };
  },
  async 'routines.receipts'(_values, context) {
    const snapshot = storeStep(() => receiptsOf(context).snapshot());
    return {
      text: formatRoutineScheduleReceipts(snapshot),
      data: { receipts: snapshot.receipts.map((receipt) => ({ id: receipt.id, routine: receipt.routineId, routineName: receipt.routineName, schedule: receipt.scheduleName, state: receipt.status, createdAt: receipt.createdAt })) },
    };
  },
  async 'routines.receipt'(values, context) {
    const receipt = storeStep(() => receiptsOf(context).get(values.receipt!));
    if (!receipt) throw new CapabilityRefusal(`No schedule receipt ${values.receipt}.`, 'The receipts are listed with the routines put on a schedule.', 'NOT_FOUND');
    return { text: formatRoutineScheduleReceipt(receipt), data: { receipt: receipt.id, state: receipt.status } };
  },
  async 'routines.reconcile'(_values, context) {
    const store = receiptsOf(context);
    const result = await reconcileRoutineScheduleReceipts(connectionOf(context), storeStep(() => store.snapshot()), store);
    return {
      text: [formatRoutineScheduleCorrelation(result), ...formatReceiptsOnOtherHosts(result)].join('\n'),
      data: { ok: result.ok, ...(result.ok ? { matched: result.correlations.filter((entry) => entry.liveStatus === 'matched').length, gone: result.correlations.filter((entry) => entry.liveStatus === 'missing').length } : {}) },
    };
  },
};
