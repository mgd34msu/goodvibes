import { classicPersonalOpsReceiptStatus } from '@goodvibes/engine/platform/platform/runtime';
import type { CommandContext } from '../input/command-registry.ts';
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools';
import { redactSensitiveData } from '@goodvibes/engine/platform/platform/utils';
import { isOpenApprovalStatus, type SharedApprovalStatus } from '@goodvibes/engine/platform/platform/control-plane';
import { AgentResearchRunRegistry, researchRunStorePath, type AgentResearchRunRecord } from '@goodvibes/engine/terminal-shell/agent-turn/research-run-registry';
import { summarizeResearchRunItem } from '../input/agent-workspace-local-library-snapshot.ts';
import type { CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { researchCheckpointRoute, researchRouteString } from './agent-harness-research-catalog-source.ts';
import type { UiAutomationSnapshot, UiTasksSnapshot, UiControlPlaneSnapshot } from '../runtime/ui-read-models.ts';
import type { AutonomyQueueLiveRecord, AutonomyQueueRecordControl, AutonomyQueueRecordOutput, SnapshotReader } from './agent-harness-autonomy-queue-types.ts';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';
import { readAgentHostPairing } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-pairing-store';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
export interface AutonomyLiveRecordBundle {
  readonly tasks: readonly AutonomyQueueLiveRecord[];
  readonly approvals: readonly AutonomyQueueLiveRecord[];
  readonly automationRuns: readonly AutonomyQueueLiveRecord[];
  readonly watcherReceipts: readonly AutonomyQueueLiveRecord[];
  readonly schedules: readonly AutonomyQueueLiveRecord[];
  readonly researchRuns: readonly AutonomyQueueLiveRecord[];
  /** Records the source holds beyond what each list shows, so a count can say "N of M". */
  readonly omitted?: Readonly<Record<'tasks' | 'approvals' | 'automationRuns' | 'watcherReceipts' | 'schedules' | 'researchRuns', number>>;
  /** Sources that could not be read this time; their lanes are missing, not empty. */
  readonly unavailable?: readonly string[];
}

const LIVE_RECORD_LIMIT = 20;
const RESEARCH_RECORD_LIMIT = 8;
const omittedFrom = (total: number, limit: number): number => Math.max(0, total - limit);

export interface AutonomyLiveNativeFact {
  readonly status: string;
  readonly cancellable: boolean;
}

/** An approval's fact keeps the lifecycle's own status type, so a new open status reaches every reader. */
export interface AutonomyLiveApprovalFact {
  readonly status: SharedApprovalStatus;
  readonly cancellable: boolean;
}

export interface AutonomyLiveNativeFacts {
  readonly tasks: readonly AutonomyLiveNativeFact[];
  readonly approvals: readonly AutonomyLiveApprovalFact[];
  readonly automationRuns: readonly AutonomyLiveNativeFact[];
  readonly watcherReceipts: readonly AutonomyLiveNativeFact[];
  readonly schedules: readonly AutonomyLiveNativeFact[];
  readonly researchRuns: readonly AutonomyLiveNativeFact[];
}

/** How many of the newest artifacts are looked through for watcher receipts. */
const RECEIPT_SCAN_LIMIT = 500;

type LiveSourceName = 'tasks' | 'approvals' | 'automation' | 'artifacts' | 'researchRuns';

/**
 * One read of each source. A listing is correct for the moment it was taken;
 * each row carries its own `updatedAt`, so nothing re-reads to prove it.
 * A source that cannot be read is named in `unavailable`, not shown as empty.
 */
function readLiveSources(context: CommandContext) {
  const unavailable: LiveSourceName[] = [];
  const read = <T>(name: LiveSourceName, model: SnapshotReader<T> | undefined): T | null => {
    if (!model) return null;
    try { return model.getSnapshot(); } catch { unavailable.push(name); return null; }
  };
  const models = context.platform.readModels;
  const tasks = read<UiTasksSnapshot>('tasks', models?.tasks);
  const approvals = read<UiControlPlaneSnapshot>('approvals', models?.controlPlane);
  const automation = read<UiAutomationSnapshot>('automation', models?.automation);
  let artifacts: readonly ArtifactDescriptor[] = [];
  const store = context.platform.artifactStore;
  if (store) {
    // A store that cannot list cannot show its receipts: name it, do not show it empty.
    if (!store.list) unavailable.push('artifacts');
    else {
      try { artifacts = store.list(RECEIPT_SCAN_LIMIT).filter(artifact => WATCHER_RECEIPT_PURPOSES.has(artifactMetadataString(artifact, 'purpose'))); }
      catch { unavailable.push('artifacts'); }
    }
  }
  let researchRuns: readonly AgentResearchRunRecord[] = [];
  const shellPaths = context.workspace.shellPaths;
  if (shellPaths) {
    try { researchRuns = new AgentResearchRunRegistry(researchRunStorePath(shellPaths)).snapshot().runs; }
    catch { unavailable.push('researchRuns'); }
  }
  return { tasks, approvals, automation, artifacts, researchRuns, unavailable };
}

/** Startup observes only literal native statuses and cancellation flags. */
export function autonomyLiveNativeFacts(context: CommandContext): AutonomyLiveNativeFacts {
  const { tasks, approvals, automation, artifacts, researchRuns } = readLiveSources(context);
  return {
    tasks: (tasks?.tasks ?? []).map(task => ({ status: task.status, cancellable: task.cancellable && ['queued', 'running', 'blocked'].includes(task.status) })),
    approvals: (approvals?.approvals ?? []).map(approval => ({ status: approval.status, cancellable: isOpenApprovalStatus(approval.status) })),
    automationRuns: nonWatcherRuns(automation).map(run => ({ status: run.status, cancellable: run.status === 'queued' || run.status === 'running' })),
    watcherReceipts: watcherReceiptArtifacts(artifacts).map(artifact => ({ status: receiptStatus(artifact), cancellable: false })),
    schedules: (automation?.jobs ?? []).map(job => ({ status: job.status, cancellable: job.enabled && job.status === 'enabled' })),
    researchRuns: researchRuns.map(run => ({ status: run.status, cancellable: !['cancelled', 'completed', 'failed'].includes(run.status) })),
  };
}

/** A receipt's status as its producer wrote it; anything else is `unknown`, never a reading. */
function receiptStatus(artifact: ArtifactDescriptor): string {
  const status = classicPersonalOpsReceiptStatus(artifact);
  return status === 'unassessed' ? 'unknown' : status;
}

/** Mask the prose of one row that will be returned: titles, summaries, previews, tails and notes. */
function maskRecord(record: AutonomyQueueLiveRecord): AutonomyQueueLiveRecord {
  const mask = (text: string): string => redactSensitiveData(text);
  return {
    ...record,
    label: mask(record.label),
    summary: mask(record.summary),
    ...(record.logTail ? { logTail: record.logTail.map(mask) } : {}),
    ...(record.diagnostics ? { diagnostics: record.diagnostics.map(mask) } : {}),
    ...(record.output?.preview ? { output: { ...record.output, preview: mask(record.output.preview) } } : {}),
  };
}

/**
 * Select first, mask second, read once: each source is read once, each lane is
 * sorted and cut to its limit, and only the prose of the rows returned is
 * masked locally. Cost: one read per source and no model request, whatever
 * the stores hold.
 */
export async function captureAutonomyLiveRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<AutonomyLiveRecordBundle> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const data = readLiveSources(context);
  const mask = (records: readonly AutonomyQueueLiveRecord[]) => records.map(maskRecord);
  return {
    tasks: mask(taskLiveRecords(data.tasks)),
    approvals: mask(approvalLiveRecords(data.approvals, ownHostPrincipal(context))),
    automationRuns: mask(automationRunLiveRecords(data.automation)),
    watcherReceipts: mask(watcherReceiptLiveRecords(data.artifacts)),
    schedules: mask(scheduleLiveRecords(data.automation)),
    researchRuns: mask(researchRunLiveRecords(data.researchRuns)),
    omitted: {
      tasks: omittedFrom(data.tasks?.tasks.length ?? 0, LIVE_RECORD_LIMIT),
      approvals: omittedFrom(data.approvals?.approvals.length ?? 0, LIVE_RECORD_LIMIT),
      automationRuns: omittedFrom(nonWatcherRuns(data.automation).length, LIVE_RECORD_LIMIT),
      watcherReceipts: omittedFrom(allWatcherReceiptArtifacts(data.artifacts).length, LIVE_RECORD_LIMIT),
      schedules: omittedFrom(data.automation?.jobs.length ?? 0, LIVE_RECORD_LIMIT),
      researchRuns: omittedFrom(data.researchRuns.length, RESEARCH_RECORD_LIMIT),
    },
    ...(data.unavailable.length > 0 ? { unavailable: data.unavailable } : {}),
  };
}

function formatEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function formatTimeFragment(label: string, value: number | undefined): string {
  const formatted = formatEpochMs(value);
  return formatted ? `${label} ${formatted}` : '';
}

const WATCHER_RECEIPT_PURPOSES = new Set([
  'watcher-receipt',
  'watcher-run-receipt',
  'automation-watcher-receipt',
  'automation-run-history-receipt',
  'durable-run-history-receipt',
  'agent-watcher-receipt',
  'agent-watcher-run-receipt',
  'connected-host-watcher-receipt',
  'connected-host-watcher-run-receipt',
  'connected-host-automation-run-history-receipt',
  'provider-source-record-receipt',
]);

/** Presentation runs only after complete original-source protection. */
function compactUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = JSON.stringify(value);
  if (text === undefined) throw new ToolInputProjectionError('held');
  return text.replace(/\s+/g, ' ').trim();
}

function artifactMetadata(artifact: ArtifactDescriptor): Readonly<Record<string, unknown>> {
  return artifact.metadata && typeof artifact.metadata === 'object'
    ? artifact.metadata
    : {};
}

function artifactMetadataString(artifact: ArtifactDescriptor, key: string): string {
  return readString(artifactMetadata(artifact)[key]);
}

function artifactMetadataBoolean(artifact: ArtifactDescriptor, key: string): boolean | null {
  const value = artifactMetadata(artifact)[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function artifactTimestamp(artifact: ArtifactDescriptor): number {
  const explicit = artifactMetadataString(artifact, 'createdAt')
    || artifactMetadataString(artifact, 'recordedAt')
    || artifactMetadataString(artifact, 'completedAt')
    || artifactMetadataString(artifact, 'timestamp');
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt) ? artifact.createdAt : 0;
}

function allWatcherReceiptArtifacts(artifacts: readonly ArtifactDescriptor[]): readonly ArtifactDescriptor[] {
  return artifacts.filter(artifact => WATCHER_RECEIPT_PURPOSES.has(artifactMetadataString(artifact, 'purpose')))
    .sort((left, right) => artifactTimestamp(right) - artifactTimestamp(left));
}

function watcherReceiptArtifacts(artifacts: readonly ArtifactDescriptor[]): readonly ArtifactDescriptor[] {
  return allWatcherReceiptArtifacts(artifacts).slice(0, LIVE_RECORD_LIMIT);
}

function formatIntervalMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return `${value}ms`;
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, suffix] of units) {
    if (value >= size && value % size === 0) return `${value / size}${suffix}`;
  }
  return `${value}ms`;
}

function summarizeSchedule(schedule: UiAutomationSnapshot['jobs'][number]['schedule']): string {
  if (schedule.kind === 'cron') {
    return [
      `cron ${schedule.expression}`,
      schedule.timezone ? `timezone ${schedule.timezone}` : '',
      schedule.staggerMs !== undefined ? `stagger ${schedule.staggerMs}ms` : '',
    ].filter(Boolean).join(', ');
  }
  if (schedule.kind === 'every') return `every ${formatIntervalMs(schedule.intervalMs)}`;
  return `at ${formatEpochMs(schedule.at) ?? schedule.at}`;
}

/** Slash commands are typed by the owner; the model reaches the read-only ones through workspace run_command. */
function commandRoute(command: string): string {
  return `workspace action:"run_command" command:"${quoteRouteValue(command)}"`;
}

const SCHEDULE_LIST_ROUTE = 'schedule action:"list"';

function quoteRouteValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function operatorMethodRoute(methodId: string, input: Record<string, string>): string {
  const payload = JSON.stringify(input);
  return `agent_operator_method methodId:"${quoteRouteValue(methodId)}" input:${payload}`;
}

function availableControl(
  id: string,
  label: string,
  effect: AutonomyQueueRecordControl['effect'],
  modelRoute: string,
): AutonomyQueueRecordControl {
  return {
    id,
    label,
    state: 'available',
    effect,
    confirmationRequired: effect === 'confirmed-effect',
    modelRoute,
  };
}

function unavailableControl(id: string, label: string, reason: string): AutonomyQueueRecordControl {
  return {
    id,
    label,
    state: 'unavailable',
    effect: 'confirmed-effect',
    confirmationRequired: true,
    reason,
  };
}

export function controlAvailable(record: AutonomyQueueLiveRecord, id: string): boolean {
  return record.controls?.some((control) => control.id === id && control.state === 'available') === true;
}

function availableControlRoute(record: AutonomyQueueLiveRecord, id: string): string | undefined {
  return record.controls?.find((control) => control.id === id && control.state === 'available')?.modelRoute;
}

export function firstAvailableControlRoute(records: readonly AutonomyQueueLiveRecord[], id: string): string | undefined {
  for (const record of records) {
    const route = availableControlRoute(record, id);
    if (route) return route;
  }
  return undefined;
}

function taskOutputDescriptor(task: UiTasksSnapshot['tasks'][number]): AutonomyQueueRecordOutput {
  const route = commandRoute(`/tasks output ${task.id}`);
  const resultPreview = task.result !== undefined ? compactUnknown(task.result) : '';
  if (resultPreview.length > 0) {
    return {
      status: 'preview',
      route,
      source: 'runtime-task-result',
      preview: previewHarnessText(resultPreview, 240),
      policy: 'Bounded preview from the connected-host task read model; complete original source has passed privacy screening. Use the route for the full host-owned output view when available.',
    };
  }
  const errorPreview = task.error ? compactUnknown(task.error) : '';
  if (errorPreview.length > 0) {
    return {
      status: 'preview',
      route,
      source: 'runtime-task-error',
      preview: previewHarnessText(errorPreview, 240),
      policy: 'Bounded error preview from the connected-host task read model; complete original source has passed privacy screening. Use the route for the full host-owned output view when available.',
    };
  }
  return {
    status: 'route-only',
    route,
    source: 'not-published',
    policy: 'The connected host has not published task result/error text in the task read model. Use the route for host-owned output if that host exposes it.',
  };
}

function taskDiagnostics(task: UiTasksSnapshot['tasks'][number]): readonly string[] {
  const retry = task.retryPolicy
    ? `retry attempt ${task.retryPolicy.currentAttempt}/${task.retryPolicy.maxAttempts} backoff ${task.retryPolicy.backoff} delay ${task.retryPolicy.delayMs}ms categories ${task.retryPolicy.retryOn.join(',')}`
    : '';
  return [
    retry,
    task.retryAt ? `retry eligible ${formatEpochMs(task.retryAt)}` : '',
    task.exitCode !== undefined ? `exit code ${task.exitCode}` : '',
    task.parentTaskId ? `parent ${task.parentTaskId}` : '',
    task.childTaskIds.length > 0 ? `children ${task.childTaskIds.join(',')}` : '',
    task.correlationId ? `correlation ${task.correlationId}` : '',
    task.turnId ? `turn ${task.turnId}` : '',
    task.error ? `error ${compactUnknown(task.error)}` : '',
    task.result !== undefined ? `result ${compactUnknown(task.result)}` : '',
    `output route ${commandRoute(`/tasks output ${task.id}`)}`,
  ].filter((value): value is string => value.length > 0);
}

function automationRunDiagnostics(run: UiAutomationSnapshot['runs'][number]): readonly string[] {
  const telemetry = run.telemetry;
  const usage = telemetry?.usage;
  const usageSummary = usage
    ? [
      `telemetry usage input ${usage.inputTokens}`,
      `output ${usage.outputTokens}`,
      `cache-read ${usage.cacheReadTokens}`,
      `cache-write ${usage.cacheWriteTokens}`,
      usage.reasoningTokens !== undefined ? `reasoning ${usage.reasoningTokens}` : '',
    ].filter(Boolean).join(' ')
    : '';
  const callSummary = telemetry
    ? [
      telemetry.llmCallCount !== undefined ? `llm ${telemetry.llmCallCount}` : '',
      telemetry.toolCallCount !== undefined ? `tool ${telemetry.toolCallCount}` : '',
      telemetry.turnCount !== undefined ? `turns ${telemetry.turnCount}` : '',
      telemetry.reasoningSummaryPresent !== undefined ? `reasoning-summary ${telemetry.reasoningSummaryPresent ? 'yes' : 'no'}` : '',
    ].filter(Boolean).join(' ')
    : '';
  const route = run.route
    ? [
      `route ${run.route.id}`,
      run.route.surfaceKind,
      run.route.kind,
      run.route.title,
    ].filter(Boolean).join(' ')
    : '';
  const deliveries = (run.deliveryAttempts ?? []).slice(-3).map((delivery) => [
    `delivery ${delivery.id}`,
    delivery.status,
    delivery.responseId ? `response ${delivery.responseId}` : '',
    delivery.endedAt ? `ended ${formatEpochMs(delivery.endedAt)}` : '',
  ].filter(Boolean).join(' '));
  return [
    run.continuationMode ? `continuation ${run.continuationMode}` : '',
    run.executionIntent ? `intent ${compactUnknown(run.executionIntent)}` : '',
    telemetry?.source ? `telemetry source ${telemetry.source}` : '',
    telemetry?.modelId ? `telemetry model ${telemetry.modelId}` : '',
    telemetry?.providerId ? `telemetry provider ${telemetry.providerId}` : '',
    usageSummary,
    callSummary ? `telemetry calls ${callSummary}` : '',
    route,
    ...deliveries,
    run.result !== undefined ? `result ${compactUnknown(run.result)}` : '',
    run.cancelledReason ? `cancelled ${run.cancelledReason}` : '',
  ].filter((value): value is string => value.length > 0);
}

function scheduleEditRoute(job: UiAutomationSnapshot['jobs'][number]): string {
  const schedule = job.schedule;
  const value = schedule.kind === 'cron'
    ? schedule.expression
    : schedule.kind === 'every'
      ? formatIntervalMs(schedule.intervalMs)
      : formatEpochMs(schedule.at) ?? String(schedule.at);
  const timezone = schedule.kind === 'cron' && schedule.timezone
    ? ` timezone:"${quoteRouteValue(schedule.timezone)}"`
    : '';
  return `schedule action:"edit" scheduleId:"${quoteRouteValue(job.id)}" scheduleKind:"${schedule.kind}" scheduleValue:"${quoteRouteValue(value)}"${timezone}`;
}

function taskStatusRank(status: UiTasksSnapshot['tasks'][number]['status']): number {
  if (status === 'running') return 0;
  if (status === 'queued') return 1;
  if (status === 'blocked') return 2;
  if (status === 'failed') return 3;
  if (status === 'completed') return 4;
  return 5;
}

function taskLiveRecords(snapshot: UiTasksSnapshot | null): readonly AutonomyQueueLiveRecord[] {
  const tasks = [...(snapshot?.tasks ?? [])].sort((left, right) => {
    const rankDelta = taskStatusRank(left.status) - taskStatusRank(right.status);
    if (rankDelta !== 0) return rankDelta;
    const leftTime = left.endedAt ?? left.startedAt ?? left.queuedAt;
    const rightTime = right.endedAt ?? right.startedAt ?? right.queuedAt;
    return rightTime - leftTime || left.title.localeCompare(right.title);
  });
  return tasks.slice(0, LIVE_RECORD_LIMIT).map((task) => {
    const active = task.status === 'queued' || task.status === 'running' || task.status === 'blocked';
    const canCancel = task.cancellable && active;
    const canRetry = task.status === 'failed' || task.status === 'cancelled';
    const cancelRoute = operatorMethodRoute('tasks.cancel', { taskId: task.id });
    const retryRoute = operatorMethodRoute('tasks.retry', { taskId: task.id });
    const retry = task.retryPolicy
      ? `attempt ${task.retryPolicy.currentAttempt}/${task.retryPolicy.maxAttempts}`
      : '';
    const summary = [
      `${task.status} ${task.kind}`,
      `owner ${task.owner}`,
      task.cancellable ? 'host-cancellable' : 'not cancellable',
      formatTimeFragment('queued', task.queuedAt),
      formatTimeFragment('started', task.startedAt),
      formatTimeFragment('ended', task.endedAt),
      retry,
      task.retryAt ? `retry ${formatEpochMs(task.retryAt)}` : '',
      task.error ? `error ${compactUnknown(task.error)}` : '',
      task.result !== undefined ? `result ${compactUnknown(task.result)}` : compactUnknown(task.description),
    ].filter(Boolean).join(' | ');
    const output = taskOutputDescriptor(task);
    return {
      id: task.id,
      label: task.title,
      status: task.status,
      phase: task.kind,
      updatedAt: formatEpochMs(task.endedAt ?? task.startedAt ?? task.queuedAt),
      summary,
      inspectRoute: commandRoute(`/tasks show ${task.id}`),
      ...(canCancel ? { cancelRoute } : {}),
      nextSteps: [
        commandRoute(`/tasks show ${task.id}`),
        commandRoute(`/tasks output ${task.id}`),
        ...(canCancel ? [cancelRoute] : []),
        ...(canRetry ? [retryRoute] : []),
        'Use /todo for Agent-owned visible task changes; host task mutation requires current recorded admission on the exact owning daemon method.',
      ],
      sourceIds: [
        task.parentTaskId,
        ...task.childTaskIds,
        task.correlationId,
        task.turnId,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      ...(task.error ? { logTail: [compactUnknown(task.error)] } : {}),
      output,
      diagnostics: taskDiagnostics(task),
      controls: [
        availableControl('inspect', 'Inspect task', 'read-only', commandRoute(`/tasks show ${task.id}`)),
        availableControl('output', 'Show output', 'read-only', commandRoute(`/tasks output ${task.id}`)),
        canCancel
          ? availableControl('cancel', 'Cancel task', 'confirmed-effect', cancelRoute)
          : unavailableControl('cancel', 'Cancel task', task.cancellable ? `Task is ${task.status}; cancel is only useful before terminal completion.` : 'Task owner did not mark this task cancellable.'),
        canRetry
          ? availableControl('retry', 'Retry task', 'confirmed-effect', retryRoute)
          : unavailableControl('retry', 'Retry task', `Task is ${task.status}; retry is only offered for failed or cancelled tasks.`),
      ],
    };
  });
}

/**
 * The principal this Agent's paired credential is on its host (`pairing:<token id>`), or undefined
 * when it is not paired. The host lets that credential cancel only the asks it raised itself.
 */
function ownHostPrincipal(context: CommandContext): string | undefined {
  const home = context.workspace.shellPaths?.homeDirectory;
  if (!home) return undefined;
  try {
    const pairing = readAgentHostPairing(home, resolveConnectedHostAddress(context.platform.configManager).baseUrl);
    return pairing.status === 'paired' ? `pairing:${pairing.tokenId}` : undefined;
  } catch { return undefined; }
}

function approvalLiveRecords(snapshot: UiControlPlaneSnapshot | null, ownPrincipal: string | undefined): readonly AutonomyQueueLiveRecord[] {
  const statusRank = new Map([
    ['pending', 0],
    ['claimed', 1],
    ['denied', 2],
    ['cancelled', 3],
    ['expired', 4],
    ['approved', 5],
  ]);
  return [...(snapshot?.approvals ?? [])]
    .sort((left, right) => {
      const rankDelta = (statusRank.get(left.status) ?? 99) - (statusRank.get(right.status) ?? 99);
      if (rankDelta !== 0) return rankDelta;
      return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
    })
    .slice(0, LIVE_RECORD_LIMIT)
    .map((approval) => {
      const active = isOpenApprovalStatus(approval.status);
      // The host refuses this Agent's cancel of an ask it did not raise, so the route is shown only for its own.
      const raisedHere = ownPrincipal !== undefined && approval.metadata['raisedByPrincipal'] === ownPrincipal;
      const cancellable = active && raisedHere;
      const label = `${approval.request.tool}: ${approval.request.analysis.summary}`;
      // Answering an approval put to the owner is his own act: the model is shown where he answers it, never a route to answer it.
      const ownerAnswers = `only the owner answers approval ${approval.id}: the approval prompt, /questions answer, or the web UI`;
      const cancelRoute = `agent_operator_action action:"approvals.cancel" approvalId:"${approval.id}"`;
      return {
        id: approval.id,
        label,
        status: approval.status,
        phase: approval.request.analysis.riskLevel,
        updatedAt: formatEpochMs(approval.updatedAt),
        summary: [
          `${approval.request.category}/${approval.request.analysis.riskLevel}`,
          approval.request.analysis.classification,
          `call ${approval.callId}`,
          approval.sessionId ? `session ${approval.sessionId}` : '',
          approval.routeId ? `route ${approval.routeId}` : '',
          approval.claimedBy ? `claimed by ${approval.claimedBy}` : '',
          approval.resolvedBy ? `resolved by ${approval.resolvedBy}` : '',
          compactUnknown(approval.request.args),
        ].filter(Boolean).join(' | '),
        inspectRoute: commandRoute('/approval kinds'),
        ...(cancellable ? {
          cancelRoute,
        } : {}),
        nextSteps: active ? [
          `tell the owner: ${ownerAnswers}`,
          ...(cancellable ? [cancelRoute] : []),
        ] : [commandRoute('/approval kinds')],
        sourceIds: [
          approval.callId,
          approval.sessionId,
          approval.routeId,
          ...approval.audit.map((entry) => entry.id),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        logTail: approval.audit.slice(-3).map((entry) => [
          entry.action,
          entry.actor,
          formatEpochMs(entry.createdAt),
          entry.note,
        ].filter(Boolean).join(' ')),
        controls: [
          availableControl('inspect', 'Inspect approval matrix', 'read-only', commandRoute('/approval kinds')),
          active
            ? unavailableControl('approve', 'Approve approval', `It was put to the owner; ${ownerAnswers}.`)
            : unavailableControl('approve', 'Approve approval', `Approval is ${approval.status}; only pending or claimed approvals can be approved.`),
          active
            ? unavailableControl('deny', 'Deny approval', `It was put to the owner; ${ownerAnswers}.`)
            : unavailableControl('deny', 'Deny approval', `Approval is ${approval.status}; only pending or claimed approvals can be denied.`),
          cancellable
            ? availableControl('cancel', 'Cancel approval', 'confirmed-effect', cancelRoute)
            : active
              ? unavailableControl('cancel', 'Cancel approval', `It was raised by someone else; only the asks this Agent raised can be withdrawn here, and ${ownerAnswers}.`)
              : unavailableControl('cancel', 'Cancel approval', `Approval is ${approval.status}; only pending or claimed approvals can be cancelled.`),
        ],
      };
    });
}

/** Runs a watcher triggered are listed with their watcher (agent-harness-autonomy-watcher-read-models.ts), not twice. */
function nonWatcherRuns(snapshot: UiAutomationSnapshot | null): UiAutomationSnapshot['runs'] {
  return (snapshot?.runs ?? []).filter(run => run.triggeredBy.kind !== 'watcher');
}

function automationRunLiveRecords(snapshot: UiAutomationSnapshot | null): readonly AutonomyQueueLiveRecord[] {
  return [...nonWatcherRuns(snapshot)]
    .sort((left, right) => {
      const activeDelta = Number(right.status === 'queued' || right.status === 'running') - Number(left.status === 'queued' || left.status === 'running');
      if (activeDelta !== 0) return activeDelta;
      return right.queuedAt - left.queuedAt || left.id.localeCompare(right.id);
    })
    .slice(0, LIVE_RECORD_LIMIT)
    .map((run) => {
      const active = run.status === 'queued' || run.status === 'running';
      const failed = run.status === 'failed';
      const cancelRoute = `agent_operator_action action:"automation.runs.cancel" runId:"${run.id}"`;
      const retryRoute = `agent_operator_action action:"automation.runs.retry" runId:"${run.id}"`;
      const timing = [
        formatTimeFragment('queued', run.queuedAt),
        formatTimeFragment('started', run.startedAt),
        formatTimeFragment('ended', run.endedAt),
        run.durationMs !== undefined ? `duration ${run.durationMs}ms` : '',
      ].filter(Boolean).join(', ');
      return {
        id: run.id,
        label: `${run.jobId} -> ${run.target.kind}`,
        status: run.status,
        phase: run.scheduleKind ?? run.triggeredBy.kind,
        updatedAt: formatEpochMs(run.updatedAt),
        summary: [
          `job ${run.jobId}`,
          `target ${run.target.kind}`,
          `attempt ${run.attempt}`,
          run.agentId ? `agent ${run.agentId}` : '',
          run.sessionId ? `session ${run.sessionId}` : '',
          run.routeId ? `route ${run.routeId}` : '',
          run.modelId ? `model ${run.modelId}` : '',
          run.providerId ? `provider ${run.providerId}` : '',
          timing,
          run.error ? `error ${run.error}` : '',
          run.result !== undefined ? `result ${compactUnknown(run.result)}` : '',
        ].filter(Boolean).join(' | '),
        inspectRoute: SCHEDULE_LIST_ROUTE,
        ...(active ? {
          cancelRoute,
        } : {}),
        nextSteps: [
          ...(active ? [cancelRoute] : []),
          ...(failed ? [retryRoute] : []),
          SCHEDULE_LIST_ROUTE,
        ],
        sourceIds: [
          run.jobId,
          run.agentId,
          run.sessionId,
          run.routeId,
          run.triggeredBy.id,
          ...run.deliveryIds,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        logTail: [
          run.error,
          run.cancelledReason,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        diagnostics: automationRunDiagnostics(run),
        controls: [
          availableControl('inspect', 'Inspect schedule list', 'read-only', SCHEDULE_LIST_ROUTE),
          active
            ? availableControl('cancel', 'Cancel automation run', 'confirmed-effect', cancelRoute)
            : unavailableControl('cancel', 'Cancel automation run', `Run is ${run.status}; cancel is only offered for queued or running runs.`),
          failed
            ? availableControl('retry', 'Retry automation run', 'confirmed-effect', retryRoute)
            : unavailableControl('retry', 'Retry automation run', `Run is ${run.status}; retry is only offered for failed runs.`),
        ],
      };
    });
}

function watcherReceiptLiveRecords(artifacts: readonly ArtifactDescriptor[]): readonly AutonomyQueueLiveRecord[] {
  return watcherReceiptArtifacts(artifacts).map((artifact) => {
    const purpose = artifactMetadataString(artifact, 'purpose');
    const operation = artifactMetadataString(artifact, 'operation')
      || artifactMetadataString(artifact, 'action')
      || artifactMetadataString(artifact, 'event')
      || 'watcher-run';
    const status = receiptStatus(artifact);
    const watcherId = artifactMetadataString(artifact, 'watcherId')
      || artifactMetadataString(artifact, 'sourceId')
      || artifactMetadataString(artifact, 'providerSourceId');
    const runId = artifactMetadataString(artifact, 'runId')
      || artifactMetadataString(artifact, 'jobRunId')
      || artifactMetadataString(artifact, 'automationRunId');
    const provider = artifactMetadataString(artifact, 'providerId')
      || artifactMetadataString(artifact, 'provider')
      || artifactMetadataString(artifact, 'sourceProvider');
    const trigger = artifactMetadataString(artifact, 'trigger')
      || artifactMetadataString(artifact, 'triggerKind')
      || artifactMetadataString(artifact, 'eventKind');
    const correlationId = artifactMetadataString(artifact, 'correlationId')
      || artifactMetadataString(artifact, 'turnId')
      || artifactMetadataString(artifact, 'sessionId');
    const redaction = artifactMetadataString(artifact, 'redaction')
      || artifactMetadataString(artifact, 'redactionPolicy')
      || 'metadata-only';
    const failureReason = artifactMetadataString(artifact, 'failureReason')
      || artifactMetadataString(artifact, 'error');
    const sourceTool = artifactMetadataString(artifact, 'sourceTool')
      || artifactMetadataString(artifact, 'qualifiedName');
    const payloadRedacted = artifactMetadataBoolean(artifact, 'payloadRedacted');
    const artifactRoute = `agent_artifacts mode:"show" artifactId:"${artifact.id}" includeContent:false`;
    const queueRoute = 'autonomy action:"item" queueItemId:"automation-runs" includeParameters:true';
    return {
      id: `watcher-receipt:${artifact.id}`,
      label: `Watcher receipt: ${operation.replace(/[-_]+/g, ' ')}`,
      status,
      phase: trigger || operation,
      updatedAt: formatEpochMs(artifactTimestamp(artifact)),
      summary: [
        `Durable watcher/run receipt ${artifact.id} reports ${operation} ${status}.`,
        `Redaction ${redaction}.`,
        payloadRedacted === true ? 'Payload redacted.' : payloadRedacted === false ? 'Payload redaction not asserted.' : '',
        provider ? `Provider ${provider}.` : '',
        watcherId ? `Watcher ${compactUnknown(watcherId)}.` : '',
        runId ? `Run ${compactUnknown(runId)}.` : '',
        trigger ? `Trigger ${compactUnknown(trigger)}.` : '',
        failureReason ? `Failure ${compactUnknown(failureReason)}.` : '',
        sourceTool ? `Source ${sourceTool}.` : '',
      ].filter(Boolean).join(' '),
      inspectRoute: artifactRoute,
      nextSteps: [
        artifactRoute,
        queueRoute,
      ],
      sourceIds: [
        watcherId,
        runId,
        provider,
        trigger,
        correlationId,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      diagnostics: [
        `purpose ${purpose}`,
        `receipt artifact ${artifact.id}`,
        `redaction ${redaction}`,
        failureReason ? `failure ${compactUnknown(failureReason)}` : '',
      ].filter((value): value is string => value.length > 0),
      ...(failureReason ? { logTail: [compactUnknown(failureReason)] } : {}),
      controls: [
        availableControl('inspect', 'Inspect watcher receipt', 'read-only', artifactRoute),
        availableControl('queue', 'Inspect automation queue', 'read-only', queueRoute),
      ],
    };
  });
}

function scheduleLiveRecords(snapshot: UiAutomationSnapshot | null): readonly AutonomyQueueLiveRecord[] {
  return [...(snapshot?.jobs ?? [])]
    .sort((left, right) => {
      const errorDelta = Number(right.status === 'error') - Number(left.status === 'error');
      if (errorDelta !== 0) return errorDelta;
      return (right.nextRunAt ?? 0) - (left.nextRunAt ?? 0) || left.name.localeCompare(right.name);
    })
    .slice(0, LIVE_RECORD_LIMIT)
    .map((job) => {
      const enabled = job.enabled && job.status === 'enabled';
      const paused = job.status === 'paused' || !job.enabled;
      const toggleRoute = enabled
        ? `schedule action:"pause" scheduleId:"${job.id}"`
        : `schedule action:"resume" scheduleId:"${job.id}"`;
      const runRoute = `schedule action:"run" scheduleId:"${job.id}"`;
      const editRoute = scheduleEditRoute(job);
      const deleteRoute = `schedule action:"delete" scheduleId:"${job.id}"`;
      return {
        id: job.id,
        label: job.name,
        status: job.status,
        phase: job.schedule.kind,
        updatedAt: formatEpochMs(job.updatedAt),
        summary: [
          enabled ? 'enabled' : paused ? 'paused' : job.status,
          summarizeSchedule(job.schedule),
          `runs ${job.runCount}`,
          `success ${job.successCount}`,
          `failed ${job.failureCount}`,
          formatTimeFragment('next', job.nextRunAt),
          formatTimeFragment('last', job.lastRunAt),
          job.lastRunId ? `last run ${job.lastRunId}` : '',
          job.description ?? '',
          job.pausedReason ? `paused ${job.pausedReason}` : '',
        ].filter(Boolean).join(' | '),
        inspectRoute: SCHEDULE_LIST_ROUTE,
        ...(enabled ? { pauseRoute: toggleRoute } : { resumeRoute: toggleRoute }),
        nextSteps: [
          runRoute,
          editRoute,
          toggleRoute,
          deleteRoute,
          SCHEDULE_LIST_ROUTE,
        ],
        sourceIds: [
          job.source.id,
          job.lastRunId,
          ...job.labels,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        ...(job.pausedReason || job.status === 'error' ? {
          logTail: [job.pausedReason ?? `Schedule status ${job.status}`],
        } : {}),
        controls: [
          availableControl('inspect', 'Inspect schedules', 'read-only', SCHEDULE_LIST_ROUTE),
          availableControl('run', 'Run schedule now', 'confirmed-effect', runRoute),
          availableControl('edit', 'Edit schedule', 'confirmed-effect', editRoute),
          availableControl(enabled ? 'pause' : 'resume', enabled ? 'Pause schedule' : 'Resume schedule', 'confirmed-effect', toggleRoute),
          availableControl(enabled ? 'disable' : 'enable', enabled ? 'Disable schedule' : 'Enable schedule', 'confirmed-effect', toggleRoute),
          availableControl('delete', 'Delete schedule', 'confirmed-effect', deleteRoute),
        ],
      };
    });
}

function researchRunLiveRecords(runs: readonly AgentResearchRunRecord[]): readonly AutonomyQueueLiveRecord[] {
  return runs.slice(0, RESEARCH_RECORD_LIMIT).map(summarizeResearchRunItem).map((run) => {
    const terminal = run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed';
    const canPause = run.status === 'running' || run.status === 'blocked';
    const canResume = run.status === 'paused' || run.status === 'planned' || run.status === 'blocked';
    const quotedId = researchRouteString(run.id);
    const inspectRoute = `research action:"run" runId:${quotedId}`;
    const cancelRoute = `research action:"cancel" id:${quotedId} note:"..."`;
    const checkpointRoute = researchCheckpointRoute(run.id, run.progress);
    const pauseRoute = `research action:"pause" id:${quotedId} note:"..."`;
    const resumeRoute = `research action:"resume" id:${quotedId} note:"..."`;
    const availableNextRoutes = [
      checkpointRoute,
      ...(canPause ? [pauseRoute] : []),
      ...(canResume ? [resumeRoute] : []),
      cancelRoute,
    ];
    return {
      id: run.id,
      label: run.title,
      status: run.status,
      phase: run.phase,
      progress: run.progress,
      updatedAt: run.updatedAt,
      summary: [
        `${run.status}/${run.phase} ${run.progress}%`,
        `${run.checkpointCount} checkpoint(s)`,
        `${run.sourceIds.length} source(s)`,
        run.reportArtifactId ? `report ${run.reportArtifactId}` : '',
        run.note ?? '',
      ].filter(Boolean).join(' | '),
      inspectRoute,
      ...(terminal ? {} : {
        cancelRoute,
        checkpointRoute,
        ...(canPause ? { pauseRoute } : {}),
        ...(canResume ? { resumeRoute } : {}),
      }),
      nextSteps: terminal ? run.nextSteps : [...run.nextSteps, ...availableNextRoutes],
      sourceIds: run.sourceIds,
      logTail: run.logTail,
      controls: [
        availableControl('inspect', 'Inspect research run', 'read-only', inspectRoute),
        terminal
          ? unavailableControl('checkpoint', 'Checkpoint research run', `Research run is ${run.status}; checkpoint is only offered before terminal completion.`)
          : availableControl('checkpoint', 'Checkpoint research run', 'confirmed-effect', checkpointRoute),
        canPause
          ? availableControl('pause', 'Pause research run', 'confirmed-effect', pauseRoute)
          : unavailableControl('pause', 'Pause research run', terminal ? `Research run is ${run.status}; pause is only offered before terminal completion.` : `Research run is ${run.status}; pause is offered for running or blocked runs.`),
        canResume
          ? availableControl('resume', 'Resume research run', 'confirmed-effect', resumeRoute)
          : unavailableControl('resume', 'Resume research run', terminal ? `Research run is ${run.status}; resume is only offered before terminal completion.` : `Research run is ${run.status}; resume is offered for planned, paused, or blocked runs.`),
        terminal
          ? unavailableControl('cancel', 'Cancel research run', `Research run is ${run.status}; cancel is only offered before terminal completion.`)
          : availableControl('cancel', 'Cancel research run', 'confirmed-effect', cancelRoute),
      ],
    };
  });
}
