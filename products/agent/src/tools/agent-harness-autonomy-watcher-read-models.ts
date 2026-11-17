/**
 * Watchers and the automation runs they triggered, read from the two read
 * models the daemon publishes: `readModels.watchers` (each watcher with its
 * provider source) and `readModels.automation` (runs, filtered to those a
 * watcher triggered). Every control route is built here from a record id; no
 * route text is copied from a host record.
 */
import { redactSensitiveData } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CommandContext } from '../input/command-registry.ts';
import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { AutonomyQueueLiveRecord, AutonomyQueueRecordControl } from './agent-harness-autonomy-queue-types.ts';
import type { UiAutomationSnapshot, UiWatchersSnapshot } from '../runtime/ui-read-models.ts';

type WatcherRun = UiAutomationSnapshot['runs'][number];
type Watcher = UiWatchersSnapshot['watchers'][number];

const WATCHER_RECORD_LIMIT = 20;

/** One read of each model. A model that is not composed reads as absent; one that fails reads as unavailable. */
function readWatcherSources(context: CommandContext): {
  readonly runs: readonly WatcherRun[] | null; readonly watchers: readonly Watcher[] | null; readonly unavailable: boolean;
} {
  const models = context.platform.readModels;
  let unavailable = false;
  let runs: readonly WatcherRun[] | null = null, watchers: readonly Watcher[] | null = null;
  try { runs = models?.automation ? models.automation.getSnapshot().runs.filter(isWatcherRun) : null; } catch { unavailable = true; }
  try { watchers = models?.watchers ? models.watchers.getSnapshot().watchers : null; } catch { unavailable = true; }
  return { runs, watchers, unavailable };
}

function isWatcherRun(run: WatcherRun): boolean {
  return run.triggeredBy.kind === 'watcher';
}

function runStatus(run: WatcherRun): string {
  switch (run.status) {
    case 'completed': return 'succeeded';
    case 'missed': return 'blocked';
    default: return run.status;
  }
}

/** Startup counts: literal statuses only. */
export function watcherReadModelNativeFacts(context: CommandContext): readonly { readonly status: string }[] {
  const { runs, watchers } = readWatcherSources(context);
  return [...(runs ?? []).map(run => ({ status: runStatus(run) })), ...(watchers ?? []).map(watcher => ({ status: watcher.state }))];
}

/** Which watcher lanes the host publishes: the run history (automation read model) and the provider sources (watcher read model). */
export function watcherReadModelPublication(context: CommandContext): { readonly runs: boolean; readonly providerSources: boolean; readonly omitted: number } {
  const { runs, watchers } = readWatcherSources(context);
  const total = (runs?.length ?? 0) + (watchers?.length ?? 0);
  return { runs: runs !== null, providerSources: watchers !== null, omitted: Math.max(0, total - WATCHER_RECORD_LIMIT) };
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function operatorRoute(methodId: string, input: Record<string, string>): string {
  return `agent_operator_method methodId:"${methodId}" input:${JSON.stringify(input)}`;
}

function iso(value: number | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

function available(id: string, label: string, effect: AutonomyQueueRecordControl['effect'], modelRoute: string): AutonomyQueueRecordControl {
  return { id, label, state: 'available', effect, confirmationRequired: effect === 'confirmed-effect', modelRoute };
}

function unavailable(id: string, label: string, reason: string): AutonomyQueueRecordControl {
  return { id, label, state: 'unavailable', effect: 'confirmed-effect', confirmationRequired: true, reason };
}

function watcherRunRecord(run: WatcherRun): AutonomyQueueLiveRecord {
  const status = runStatus(run);
  const active = run.status === 'queued' || run.status === 'running';
  const failed = run.status === 'failed';
  const inspectRoute = `autonomy action:"item" queueItemId:"automation-runs" query:"${quote(run.id)}" includeParameters:true`;
  const cancelRoute = `agent_operator_action action:"automation.runs.cancel" runId:"${quote(run.id)}"`;
  const retryRoute = `agent_operator_action action:"automation.runs.retry" runId:"${quote(run.id)}"`;
  const watcherId = run.triggeredBy.id;
  return {
    id: `watcher-run:${run.id}`,
    label: `Watcher run: ${previewHarnessText(redactSensitiveData(run.triggeredBy.label || watcherId), 48)} ${run.id}`,
    status,
    phase: 'watcher',
    updatedAt: iso(run.endedAt ?? run.startedAt ?? run.queuedAt),
    summary: redactSensitiveData([
      `Run ${run.id} of job ${run.jobId}, triggered by watcher ${watcherId}, is ${status}.`,
      run.error ? `Failure ${previewHarnessText(run.error, 160)}.` : '',
      run.cancelledReason ? `Cancelled ${previewHarnessText(run.cancelledReason, 120)}.` : '',
    ].filter(Boolean).join(' ')),
    inspectRoute,
    ...(active ? { cancelRoute } : {}),
    nextSteps: [inspectRoute, ...(active ? [cancelRoute] : []), ...(failed ? [retryRoute] : [])],
    sourceIds: [watcherId, run.jobId, run.sessionId].filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...(run.error ? { logTail: [redactSensitiveData(previewHarnessText(run.error, 220))] } : {}),
    controls: [
      available('inspect', 'Inspect watcher run', 'read-only', inspectRoute),
      active ? available('cancel', 'Cancel watcher run', 'confirmed-effect', cancelRoute)
        : unavailable('cancel', 'Cancel watcher run', `Run is ${status}; cancel is only offered for queued or running runs.`),
      failed ? available('retry', 'Retry watcher run', 'confirmed-effect', retryRoute)
        : unavailable('retry', 'Retry watcher run', `Run is ${status}; retry is only offered for failed runs.`),
    ],
  };
}

function watcherRecord(watcher: Watcher): AutonomyQueueLiveRecord {
  const running = watcher.state === 'running' || watcher.state === 'starting' || watcher.state === 'degraded';
  const listRoute = operatorRoute('watchers.list', {});
  const runRoute = operatorRoute('watchers.run', { watcherId: watcher.id });
  const startRoute = operatorRoute('watchers.start', { watcherId: watcher.id });
  const stopRoute = operatorRoute('watchers.stop', { watcherId: watcher.id });
  const source = watcher.source;
  return {
    id: `watcher:${watcher.id}`,
    label: `Watcher: ${previewHarnessText(redactSensitiveData(watcher.label || watcher.id), 64)}`,
    status: watcher.state,
    phase: source.kind,
    updatedAt: iso(watcher.lastHeartbeatAt ?? source.lastSeenAt ?? source.updatedAt),
    summary: redactSensitiveData([
      `Watcher ${watcher.id} (${watcher.kind}) is ${watcher.state}.`,
      `Source ${source.label || source.id} (${source.kind}) is ${source.enabled ? 'enabled' : 'disabled'}${watcher.sourceStatus ? `, ${watcher.sourceStatus}` : ''}.`,
      typeof watcher.sourceLagMs === 'number' ? `Source lag ${watcher.sourceLagMs}ms.` : '',
      watcher.lastCheckpoint ? `Checkpoint ${previewHarnessText(watcher.lastCheckpoint, 120)}.` : '',
      watcher.degradedReason ? `Degraded ${previewHarnessText(watcher.degradedReason, 120)}.` : '',
      watcher.lastError ? `Last error ${previewHarnessText(watcher.lastError, 160)}.` : '',
    ].filter(Boolean).join(' ')),
    inspectRoute: listRoute,
    nextSteps: [listRoute, runRoute, running ? stopRoute : startRoute],
    sourceIds: [watcher.id, source.id, source.routeId].filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...(watcher.lastError ? { logTail: [redactSensitiveData(previewHarnessText(watcher.lastError, 220))] } : {}),
    controls: [
      available('inspect', 'List watchers', 'read-only', listRoute),
      available('run', 'Run watcher now', 'confirmed-effect', runRoute),
      running ? available('stop', 'Stop watcher', 'confirmed-effect', stopRoute)
        : available('start', 'Start watcher', 'confirmed-effect', startRoute),
    ],
  };
}

/** Statuses a person would act on come first. */
function attentionRank(status: string): number {
  return ['queued', 'running', 'starting', 'degraded', 'failed', 'blocked'].includes(status) ? 0 : 1;
}

/** Watcher runs and watchers, the ones needing attention first, cut to the row limit; only returned rows are built and masked. */
export async function watcherReadModelLiveRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly AutonomyQueueLiveRecord[]> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const { runs, watchers } = readWatcherSources(context);
  const rows: { readonly status: string; readonly order: number; readonly build: () => AutonomyQueueLiveRecord }[] = [
    ...(runs ?? []).map((run, index) => ({ status: runStatus(run), order: index, build: () => watcherRunRecord(run) })),
    ...(watchers ?? []).map((watcher, index) => ({ status: watcher.state, order: 10_000 + index, build: () => watcherRecord(watcher) })),
  ];
  return rows.sort((left, right) => attentionRank(left.status) - attentionRank(right.status) || left.order - right.order)
    .slice(0, WATCHER_RECORD_LIMIT).map(row => row.build());
}
