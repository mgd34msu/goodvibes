import { withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { captureCatalogMethods, captureCatalogSnapshot, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import { calendarWorkflows, connectorSignalsMatching, inboxWorkflows, contractMethodsForLane, contractMethodsForLanes, retainPersonalOpsContractSource, reminderWorkflows, taskWorkflows } from './agent-harness-personal-ops-discovery.ts';
import { NOTE_CAPTURE_ROUTE } from './agent-harness-personal-ops-routes.ts';
import { cappedCount, channelRecords, connectorRecords, localRecord, refreshableSavedRecordCount, reminderOperationRecords, routineReceiptRecord, savedArtifactScanWindowFull, SAVED_ARTIFACT_SCAN_WINDOW_SIGNAL, savedProviderEffectReceiptRecords, savedReviewArtifactRecords, savedReviewQueueRecords, taskOperationRecords } from './agent-harness-personal-ops-records.ts';
import type { McpToolRecord, McpToolSchema, PersonalOpsLane, PersonalOpsLiveRecord } from './agent-harness-personal-ops-types.ts';
import { personalOpsStyleDraftRecord, personalOpsStyleDraftWorkflow } from './agent-harness-personal-ops-style-draft.ts';

/** Methods a lane reading could not settle are left out of the lane; say so instead of dropping them silently. */
export function withUnassessed(lane: PersonalOpsLane, unassessed: readonly string[] | undefined): PersonalOpsLane {
  if (!unassessed?.length) return lane;
  return { ...lane, signals: [...lane.signals, `${unassessed.length} method(s) not assessed for this lane (reading could not settle them): ${unassessed.join(', ')}`] };
}

function notesLane(snapshot: ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>): PersonalOpsLane {
  return {
    id: 'notes',
    label: 'Notes',
    status: 'ready',
    outcome: 'Capture working context, source triage, decisions, and handoff notes without polluting durable memory.',
    current: `Agent-local notes are available: ${snapshot.localNoteCount} note(s), ${snapshot.localNoteReviewQueueCount} needing review.`,
    next: snapshot.localNoteCount > 0
      ? 'Review or promote selected notes into memory, skills, routines, or Agent Knowledge when useful.'
      : 'Create a note from the Personal Ops or Notes workspace when the next decision or source needs tracking.',
    userRoute: 'Agent Workspace -> Personal Ops -> Create note',
    modelRoute: NOTE_CAPTURE_ROUTE,
    signals: [
      `${snapshot.localNoteCount} local note(s)`,
      `${snapshot.localNoteReviewQueueCount} note(s) in review queue`,
    ],
    liveRecords: snapshot.localNotes.slice(0, 5).map((note) => localRecord('note', note)),
  };
}

function remindersLane(scheduleMethods: readonly string[],
  reminderEffectReceiptRecords: readonly PersonalOpsLiveRecord[], configuredTargets: number, readyChannels: number): PersonalOpsLane {
  return {
    id: 'reminders',
    label: 'Reminders',
    status: scheduleMethods.length > 0 || reminderEffectReceiptRecords.length > 0 ? 'ready' : 'partial',
    outcome: 'Turn a user request into a visible reminder or autonomous schedule with delivery target and cancellation path.',
    current: reminderEffectReceiptRecords.length > 0
      ? 'Saved reminder provider-effect receipts are available for audit and follow-up; no fresh reminder provider record is currently ready.'
      : `Reminder and autonomous schedule creation are available through Agent tools; ${scheduleMethods.length} schedule/reminder daemon method(s) are discoverable.`,
    next: reminderEffectReceiptRecords.length > 0
      ? 'Review saved reminder provider-effect receipts, then repair or refresh the reminder provider before another provider update.'
      : 'Create one confirmed reminder or autonomous schedule with title, time, scope, delivery target, success criteria, and explicit user request.',
    userRoute: 'Agent Workspace -> Personal Ops -> Create reminder',
    modelRoute: 'schedule action:"remind"',
    signals: [
      `${cappedCount(reminderEffectReceiptRecords.length, 'record')} saved reminder provider-effect receipt(s)`,
      `${scheduleMethods.length} schedule/reminder daemon method(s)`,
      `${configuredTargets} configured delivery target(s)`,
    ],
    methodIds: scheduleMethods,
    workflows: reminderWorkflows(scheduleMethods, configuredTargets > 0 || readyChannels > 0),
    liveRecords: [
      ...reminderEffectReceiptRecords,
      ...reminderOperationRecords(scheduleMethods, configuredTargets > 0 || readyChannels > 0),
    ],
  };
}

function inboxLane({ snapshot, emailMethods, unavailableEmailMethods, emailConnectors, inboxArtifactRecords, inboxReviewQueueRecords, inboxEffectReceiptRecords, refreshableInboxQueueRecords, readyChannels }: {
  readonly snapshot: ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>;
  readonly emailMethods: readonly string[];
  readonly unavailableEmailMethods: readonly string[];
  readonly emailConnectors: Awaited<ReturnType<typeof connectorSignalsMatching>>;
  readonly inboxArtifactRecords: readonly PersonalOpsLiveRecord[];
  readonly inboxReviewQueueRecords: readonly PersonalOpsLiveRecord[];
  readonly inboxEffectReceiptRecords: readonly PersonalOpsLiveRecord[];
  readonly refreshableInboxQueueRecords: number;
  readonly readyChannels: number;
}): PersonalOpsLane {
  return {
    id: 'inbox',
    label: 'Inbox',
    status: emailMethods.length > 0 || emailConnectors.length > 0 || inboxArtifactRecords.length > 0 || inboxEffectReceiptRecords.length > 0 ? 'partial' : 'gap',
    outcome: 'Triage inbound email or message inboxes, summarize threads, draft replies, and send only after confirmation.',
    current: emailMethods.length > 0 && emailConnectors.length === 0 && inboxArtifactRecords.length === 0 && inboxEffectReceiptRecords.length === 0
      ? 'The daemon contract exposes email-like methods; Personal Ops workflow cards now guide inbox triage and draft boundaries around exact methods.'
      : emailConnectors.length > 0
        ? 'A configured MCP connector looks email-capable; Personal Ops workflow cards now guide inbox triage, schema-derived operation records, and draft boundaries around its exact tools.'
        : inboxArtifactRecords.length > 0
          ? 'Saved inbox review artifacts and thread queue items are available for recap, local draft review, or promotion; no fresh email connector is currently ready.'
          : inboxEffectReceiptRecords.length > 0
            ? 'Saved inbox provider-effect receipts are available for audit and follow-up; no fresh email connector is currently ready.'
      : unavailableEmailMethods.length > 0
        ? `The operator contract advertises ${unavailableEmailMethods.length} email method(s), but they are unavailable (route not served by this daemon) and cannot be dispatched.`
      : 'No email/IMAP/SMTP methods are present in the current GoodVibes platform operator contract.',
    next: emailMethods.length > 0 && emailConnectors.length === 0 && inboxArtifactRecords.length === 0 && inboxEffectReceiptRecords.length === 0
      ? 'Use the inbox workflow cards to inspect exact methods, read selected threads, summarize priorities, and keep send as a separate confirmation.'
      : emailConnectors.length > 0
        ? 'Use the inbox workflow cards and operation records to inspect matching MCP connector schemas, then route triage only through reviewed connector actions.'
        : inboxArtifactRecords.length > 0
          ? 'Use saved thread queue records for local draft review or recap, then repair an email connector before reading fresh inbox data or sending.'
          : inboxEffectReceiptRecords.length > 0
            ? 'Review saved inbox provider-effect receipts, then repair an email connector before reading fresh inbox data or sending another provider effect.'
      : 'Connect a Google account with /google connect, then triage and draft replies through the built-in google tool.',
    userRoute: 'Agent Workspace -> Personal Ops -> Delivery channels',
    modelRoute: emailConnectors.length > 0 ? 'agent_harness mode:"mcp_servers" query:"email"' : 'host action:"methods" query:"email"',
    signals: [
      `${emailMethods.length} dispatchable email-like daemon method(s)`,
      ...(unavailableEmailMethods.length > 0 ? [`${unavailableEmailMethods.length} advertised-but-unavailable email method(s) (route not served by this daemon)`] : []),
      `${emailConnectors.length} email-like MCP connector(s)`,
      `${cappedCount(inboxArtifactRecords.length, 'review')} saved inbox review artifact(s)`,
      `${cappedCount(inboxReviewQueueRecords.length, 'record')} saved inbox thread queue item(s)`,
      `${cappedCount(inboxEffectReceiptRecords.length, 'record')} saved inbox provider-effect receipt(s)`,
      `${refreshableInboxQueueRecords} refreshable saved inbox queue item(s)`,
      `${readyChannels}/${snapshot.channels.length} channel(s) ready for delivery`,
    ],
    methodIds: emailMethods,
    connectorSignals: emailConnectors,
    workflows: [...inboxWorkflows(emailMethods, emailConnectors, unavailableEmailMethods), personalOpsStyleDraftWorkflow()],
    liveRecords: [
      personalOpsStyleDraftRecord(),
      ...inboxReviewQueueRecords,
      ...inboxArtifactRecords,
      ...inboxEffectReceiptRecords,
      ...connectorRecords(emailConnectors, 'Inbox', 'inbox'),
    ],
  };
}

export function buildLanes(...args: Parameters<typeof ownedBuildLanes>): ReturnType<typeof ownedBuildLanes> {
  return withConfiguredDecisionModelPolicy(() => ownedBuildLanes(...args));
}

async function ownedBuildLanes(
  context: CommandContext,
  options: CatalogRankingOptions & {
    readonly toolsByServer?: ReadonlyMap<string, readonly McpToolRecord[]>;
    readonly schemasByQualifiedName?: ReadonlyMap<string, McpToolSchema>;
  } = {},
  exactLane?: 'notes' | 'reminders' | 'inbox',
): Promise<readonly PersonalOpsLane[]> {
  if (exactLane !== undefined && exactLane !== 'notes' && exactLane !== 'reminders' && exactLane !== 'inbox') throw new ToolInputProjectionError('invalid');
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'assertCurrent', 'retainCurrent', 'sourceOwner', 'toolsByServer', 'schemasByQualifiedName']);
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const sourceOwner = options.sourceOwner;
  const ownerCurrent = sourceOwner ? captureCatalogMethods(sourceOwner, ['capture', 'screen', 'project', 'release']) : () => {};
  const staged = new Map<string | (() => void), Set<() => void>>();
  const retainChild = (guard: () => void, key?: string) => {
    const guards = staged.get(key ?? guard) ?? new Set<() => void>();
    guards.add(guard); staged.set(key ?? guard, guards);
  };
  const assertCaller = () => {
    optionsCurrent(); ownerCurrent(); signal?.throwIfAborted();
    const result: unknown = callerCurrent?.();
    if (result !== undefined) {
      drainOwned(result);
      throw new ToolInputProjectionError('held');
    }
    optionsCurrent(); ownerCurrent(); signal?.throwIfAborted();
  };
  optionsCurrent(); ownerCurrent(); signal?.throwIfAborted(); assertCaller();
  const original = buildAgentWorkspaceRuntimeSnapshot(context);
  const workspaceCapture = captureCatalogSnapshot(original);
  const assertSnapshot = workspaceCapture.assertCurrent;
  const assertSource = () => {
    optionsCurrent(); ownerCurrent(); signal?.throwIfAborted();
    assertSnapshot(buildAgentWorkspaceRuntimeSnapshot(context));
  };
  const assertCurrent = () => { assertSource(); assertCaller(); assertSource(); };
  const assertChildren = () => { for (const guards of staged.values()) for (const guard of guards) guard(); };
  const publicationCurrent = () => { assertSource(); assertChildren(); assertSource(); };
  const readOptions = { ...options, assertCurrent, retainCurrent: retainChild };
  const lanes = await withModelReadingSource(workspaceCapture.captured, readOptions, async (snapshot, current): Promise<readonly PersonalOpsLane[]> => {
  // Each child owns its active source. Previously completed children remain
  // current at phase boundaries without entering every later child's callbacks.
  const childOptions = { ...current, assertCurrent: assertCaller, retainCurrent: retainChild };
  const readChild = async <T>(read: () => Promise<T>): Promise<T> => {
    current.assertCurrent?.(); assertChildren(); current.assertCurrent?.();
    const result = await read();
    current.assertCurrent?.(); assertChildren(); current.assertCurrent?.();
    return result;
  };
  // Readiness counts only DISPATCHABLE methods (capability-advertisement honesty): a
  // method the contract marks invokable:false has no serving route, so it
  // must not make a lane read "ready"/"partial". The unavailable lists feed
  // honest degraded wording instead.
  let contract: { readonly scope: 'all'; readonly values: Awaited<ReturnType<typeof contractMethodsForLanes>> }
    | { readonly scope: 'reminders'; readonly values: Awaited<ReturnType<typeof contractMethodsForLane>> }
    | { readonly scope: 'inbox'; readonly values: Awaited<ReturnType<typeof contractMethodsForLane>> }
    | { readonly scope: 'notes' };
  if (exactLane === 'notes') {
    await readChild(() => retainPersonalOpsContractSource(childOptions));
    contract = { scope: 'notes' };
  } else if (exactLane === 'reminders') {
    contract = { scope: 'reminders', values: await readChild(() => contractMethodsForLane('reminders', childOptions)) };
  } else if (exactLane === 'inbox') {
    contract = { scope: 'inbox', values: await readChild(() => contractMethodsForLane('inbox', childOptions)) };
  } else {
    contract = { scope: 'all', values: await readChild(() => contractMethodsForLanes(childOptions)) };
  }
  const toolsByName = options.toolsByServer ?? new Map<string, readonly McpToolRecord[]>();
  const schemasByQualifiedName = options.schemasByQualifiedName ?? new Map<string, McpToolSchema>();
  // A lane's reads are skipped when the caller asked for another lane alone.
  const wants = (lane: 'inbox' | 'calendar' | 'tasks' | 'reminders') => exactLane === undefined || exactLane === lane;
  const none: readonly PersonalOpsLiveRecord[] = [];
  const emailConnectors = wants('inbox') ? await readChild(() => connectorSignalsMatching(context, { ...childOptions, lane: 'inbox', toolsByServer: toolsByName, schemasByQualifiedName })) : [];
  const calendarConnectors = wants('calendar') ? await readChild(() => connectorSignalsMatching(context, { ...childOptions, lane: 'calendar', toolsByServer: toolsByName, schemasByQualifiedName })) : [];
  const inboxArtifactRecords = wants('inbox') ? await readChild(() => savedReviewArtifactRecords(context, 'inbox', emailConnectors, childOptions)) : none;
  const calendarArtifactRecords = wants('calendar') ? await readChild(() => savedReviewArtifactRecords(context, 'calendar', calendarConnectors, childOptions)) : none;
  const inboxReviewQueueRecords = wants('inbox') ? await readChild(() => savedReviewQueueRecords(context, 'inbox', emailConnectors, childOptions)) : none;
  const calendarReviewQueueRecords = wants('calendar') ? await readChild(() => savedReviewQueueRecords(context, 'calendar', calendarConnectors, childOptions)) : none;
  const inboxEffectReceiptRecords = wants('inbox') ? await readChild(() => savedProviderEffectReceiptRecords(context, 'inbox', childOptions)) : none;
  const calendarEffectReceiptRecords = wants('calendar') ? await readChild(() => savedProviderEffectReceiptRecords(context, 'calendar', childOptions)) : none;
  const refreshableInboxQueueRecords = refreshableSavedRecordCount(inboxReviewQueueRecords);
  const refreshableCalendarQueueRecords = refreshableSavedRecordCount(calendarReviewQueueRecords);
  const taskEffectReceiptRecords = wants('tasks') ? await readChild(() => savedProviderEffectReceiptRecords(context, 'tasks', childOptions)) : none;
  const reminderEffectReceiptRecords = wants('reminders') ? await readChild(() => savedProviderEffectReceiptRecords(context, 'reminders', childOptions)) : none;
  const readyChannels = snapshot.channels.filter((channel) => channel.ready).length;
  const enabledChannels = snapshot.channels.filter((channel) => channel.enabled).length;
  const configuredTargets = snapshot.channels.filter((channel) => channel.defaultTarget === 'configured').length;
  const scheduleReadyRoutines = snapshot.localRoutines.filter((routine) => (
    routine.enabled === true
    && routine.reviewState === 'reviewed'
    && (routine.missingRequirementCount ?? 0) === 0
  )).length;
  if (contract.scope === 'notes') return [notesLane(snapshot)];
  if (contract.scope === 'reminders') return [withUnassessed(remindersLane(contract.values.available,
    reminderEffectReceiptRecords, configuredTargets, readyChannels), contract.values.unassessed)];
  if (contract.scope === 'inbox') return [withUnassessed(inboxLane({ snapshot, emailMethods: contract.values.available,
    unavailableEmailMethods: contract.values.unavailable, emailConnectors, inboxArtifactRecords,
    inboxReviewQueueRecords, inboxEffectReceiptRecords, refreshableInboxQueueRecords, readyChannels }), contract.values.unassessed)];
  const { inbox: email, calendar, tasks, reminders } = contract.values;
  const emailMethods = email.available, unavailableEmailMethods = email.unavailable;
  const calendarMethods = calendar.available, unavailableCalendarMethods = calendar.unavailable;
  const taskMethods = tasks.available, scheduleMethods = reminders.available;
  const unassessedByLane: Readonly<Record<string, readonly string[] | undefined>> = {
    inbox: email.unassessed, calendar: calendar.unassessed, tasks: tasks.unassessed, reminders: reminders.unassessed,
  };
  const allLanes: readonly PersonalOpsLane[] = [
    inboxLane({ snapshot, emailMethods, unavailableEmailMethods, emailConnectors, inboxArtifactRecords, inboxReviewQueueRecords, inboxEffectReceiptRecords, refreshableInboxQueueRecords, readyChannels }),
    {
      id: 'calendar',
      label: 'Calendar',
      status: calendarMethods.length > 0 || calendarConnectors.length > 0 || calendarArtifactRecords.length > 0 || calendarEffectReceiptRecords.length > 0 ? 'partial' : 'gap',
      outcome: 'Read agenda context, identify conflicts, prepare briefings, and create reminders for calendar-driven work.',
      current: calendarMethods.length > 0 && calendarConnectors.length === 0 && calendarArtifactRecords.length === 0 && calendarEffectReceiptRecords.length === 0
        ? 'The daemon contract exposes calendar-like methods; Personal Ops workflow cards now guide agenda briefing and conflict-scan boundaries.'
        : calendarConnectors.length > 0
          ? 'A configured MCP connector looks calendar-capable; Personal Ops workflow cards now guide agenda briefing, schema-derived operation records, and conflict-scan boundaries around its exact tools.'
          : calendarArtifactRecords.length > 0
            ? 'Saved calendar review artifacts and event queue items are available for agenda recap, reminder creation, or follow-up planning; no fresh calendar connector is currently ready.'
            : calendarEffectReceiptRecords.length > 0
              ? 'Saved calendar provider-effect receipts are available for audit and follow-up; no fresh calendar connector is currently ready.'
        : unavailableCalendarMethods.length > 0
          ? `The operator contract advertises ${unavailableCalendarMethods.length} calendar method(s), but they are unavailable (route not served by this daemon) and cannot be dispatched. The local Agent calendar (/calendar) remains available.`
        : 'No calendar/CalDAV/agenda methods are present in the current GoodVibes platform operator contract.',
      next: calendarMethods.length > 0 && calendarConnectors.length === 0 && calendarArtifactRecords.length === 0 && calendarEffectReceiptRecords.length === 0
        ? 'Use the calendar workflow cards to inspect exact methods, fetch a bounded agenda window, and propose reminders or follow-ups.'
        : calendarConnectors.length > 0
          ? 'Use the calendar workflow cards and operation records to inspect matching MCP connector schemas, then route agenda work only through reviewed connector actions.'
          : calendarArtifactRecords.length > 0
            ? 'Use saved event queue records for recap or reminder creation, then repair a calendar connector before reading fresh agenda data or editing events.'
            : calendarEffectReceiptRecords.length > 0
              ? 'Review saved calendar provider-effect receipts, then repair a calendar connector before reading fresh agenda data or editing events.'
        : 'Connect a Google account with /google connect, then route agenda briefing, conflicts, and reminders through this lane.',
      userRoute: 'Agent Workspace -> Personal Ops -> Create reminder',
      modelRoute: calendarConnectors.length > 0 ? 'agent_harness mode:"mcp_servers" query:"calendar"' : 'host action:"methods" query:"calendar"',
      signals: [
        `${calendarMethods.length} dispatchable calendar-like daemon method(s)`,
        ...(unavailableCalendarMethods.length > 0 ? [`${unavailableCalendarMethods.length} advertised-but-unavailable calendar method(s) (route not served by this daemon)`] : []),
        `${calendarConnectors.length} calendar-like MCP connector(s)`,
        `${cappedCount(calendarArtifactRecords.length, 'review')} saved calendar review artifact(s)`,
        `${cappedCount(calendarReviewQueueRecords.length, 'record')} saved calendar event queue item(s)`,
        `${cappedCount(calendarEffectReceiptRecords.length, 'record')} saved calendar provider-effect receipt(s)`,
        `${refreshableCalendarQueueRecords} refreshable saved calendar queue item(s)`,
        `${scheduleMethods.length} schedule/reminder method(s) available for follow-up`,
      ],
      methodIds: calendarMethods,
      connectorSignals: calendarConnectors,
      workflows: calendarWorkflows(calendarMethods, calendarConnectors, unavailableCalendarMethods),
      liveRecords: [
        ...calendarReviewQueueRecords,
        ...calendarArtifactRecords,
        ...calendarEffectReceiptRecords,
        ...connectorRecords(calendarConnectors, 'Calendar', 'calendar'),
      ],
    },
    notesLane(snapshot),
    {
      id: 'tasks',
      label: 'Tasks',
      status: taskMethods.length > 0 || taskEffectReceiptRecords.length > 0 ? 'ready' : 'partial',
      outcome: 'Track user-visible work items, inspect host task state, and update work plan status without hidden jobs.',
      current: taskEffectReceiptRecords.length > 0
        ? 'Saved task provider-effect receipts are available for audit and follow-up; no fresh task provider record is currently ready.'
        : `Agent has work-plan actions and ${taskMethods.length} task/work-plan daemon method(s) in the platform contract.`,
      next: taskEffectReceiptRecords.length > 0
        ? 'Review saved task provider-effect receipts, then repair or refresh the task provider before another provider update.'
        : 'Use work plans for user-visible task tracking; inspect runtime host tasks separately before mutating anything.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Autonomy queue',
      modelRoute: 'agent_work_plan action:"list"',
      signals: [
        `${cappedCount(taskEffectReceiptRecords.length, 'record')} saved task provider-effect receipt(s)`,
        `${taskMethods.length} task/work-plan daemon method(s)`,
        'Work plan list/get/create/update/set_status/remove/clear_completed actions are available',
      ],
      methodIds: taskMethods,
      workflows: taskWorkflows(taskMethods),
      liveRecords: [
        ...taskEffectReceiptRecords,
        ...taskOperationRecords(taskMethods),
      ],
    },
    remindersLane(scheduleMethods, reminderEffectReceiptRecords, configuredTargets, readyChannels),
    {
      id: 'routines',
      label: 'Routines',
      status: scheduleReadyRoutines > 0 ? 'ready' : snapshot.localRoutineCount > 0 ? 'partial' : 'needs-setup',
      outcome: 'Reuse repeatable local workflows and promote reviewed routines to connected schedules only when useful.',
      current: `${snapshot.localRoutineCount} routine(s), ${snapshot.enabledRoutineCount} enabled, ${scheduleReadyRoutines} schedule-ready, ${snapshot.routineScheduleReceiptCount} promotion receipt(s).`,
      next: scheduleReadyRoutines > 0
        ? 'Promote a reviewed routine to a connected schedule when the user asks for recurrence.'
        : 'Create or review a routine, resolve setup gaps, then promote only with explicit schedule confirmation.',
      userRoute: 'Agent Workspace -> Personal Ops -> Routine library',
      modelRoute: 'workspace action:"actions" categoryId:"routines"',
      signals: [
        `${scheduleReadyRoutines} schedule-ready routine(s)`,
        `${snapshot.failedRoutineScheduleReceiptCount} failed promotion receipt(s)`,
      ],
      liveRecords: [
        ...snapshot.localRoutines.slice(0, 5).map((routine) => localRecord('routine', routine)),
        ...[routineReceiptRecord(snapshot.latestRoutineScheduleReceipt)].filter((record): record is PersonalOpsLiveRecord => record !== null),
      ],
    },
    {
      id: 'delivery',
      label: 'Delivery',
      status: readyChannels > 0 ? 'ready' : enabledChannels > 0 ? 'needs-setup' : 'partial',
      outcome: 'Reach the user through configured channels and send messages or notifications only after explicit confirmation.',
      current: `${readyChannels}/${snapshot.channels.length} channel(s) ready, ${enabledChannels} enabled, ${configuredTargets} configured default target(s).`,
      next: readyChannels > 0
        ? 'Use confirmed channel send or notification tools when the user asks for delivery.'
        : 'Enable and configure one delivery channel so personal-ops reminders and summaries can reach the user.',
      userRoute: 'Agent Workspace -> Personal Ops -> Delivery channels',
      modelRoute: 'channels action:"status"',
      signals: [
        `${readyChannels} ready channel(s)`,
        `${configuredTargets} configured default target(s)`,
      ],
      liveRecords: channelRecords(snapshot),
    },
  ];
  return allLanes.map(lane => withUnassessed(lane, unassessedByLane[lane.id]));
  });
  assertCurrent(); publicationCurrent();
  for (const [key, guards] of staged) {
    retainCurrent?.(() => { for (const guard of guards) guard(); }, typeof key === 'string' ? key : undefined);
    assertCurrent(); publicationCurrent();
  }
  retainCurrent?.(publicationCurrent, 'personal-ops-lanes');
  assertCurrent(); publicationCurrent();
  if (!savedArtifactScanWindowFull(context)) return lanes;
  const readsSavedArtifacts = new Set(['inbox', 'calendar', 'tasks', 'reminders']);
  return lanes.map(lane => readsSavedArtifacts.has(lane.id) ? { ...lane, signals: [...lane.signals, SAVED_ARTIFACT_SCAN_WINDOW_SIGNAL] } : lane);
}
