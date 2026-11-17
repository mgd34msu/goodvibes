import { withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import { googleConnectionState, type AgentGoogleConnectionState } from './agent-google-tool.ts';
import { calendarWorkflows, connectorSignals, contractLaneMethods, inboxWorkflows, NO_CONNECTORS, readConnectorInventory, reminderWorkflows, taskWorkflows, type ConnectorInventory, type GoogleLaneRoute } from './agent-harness-personal-ops-discovery.ts';
import { NOTE_CAPTURE_ROUTE } from './agent-harness-personal-ops-routes.ts';
import { cappedCount, channelRecords, connectorRecords, localRecord, NO_SAVED_ARTIFACTS, readPersonalOpsSavedArtifacts, refreshableSavedRecordCount, reminderOperationRecords, routineReceiptRecord, SAVED_ARTIFACT_SCAN_WINDOW_SIGNAL, savedProviderEffectReceiptRecords, savedReviewArtifactRecords, savedReviewQueueRecords, taskOperationRecords, type PersonalOpsSavedArtifacts } from './agent-harness-personal-ops-records.ts';
import type { PersonalOpsLane, PersonalOpsLiveRecord } from './agent-harness-personal-ops-types.ts';
import { personalOpsStyleDraftRecord, personalOpsStyleDraftWorkflow } from './agent-harness-personal-ops-style-draft.ts';

/** What the session's Google connection serves: the built-in google tool is the inbox and calendar route when it is connected. */
interface GoogleLanes {
  readonly state: AgentGoogleConnectionState;
  readonly inbox: GoogleLaneRoute | null;
  readonly calendar: GoogleLaneRoute | null;
}

const NO_GOOGLE_LANES: GoogleLanes = { state: { status: 'not-connected' }, inbox: null, calendar: null };

async function readGoogleLanes(context: CommandContext): Promise<GoogleLanes> {
  const state = await googleConnectionState(context.platform?.secretsManager);
  if (state.status !== 'connected') return { state, inbox: null, calendar: null };
  const granted = state.scopesKnown ? 'its granted scopes permit' : 'its scopes are confirmed on the first google call, which is expected to permit';
  return {
    state,
    inbox: state.canReadMail ? { modelRoute: 'google action:"mail.list"', summary: `A Google account is connected; ${granted} reading mail through the built-in google tool.` } : null,
    calendar: state.canReadCalendar ? { modelRoute: 'google action:"calendar.list"', summary: `A Google account is connected; ${granted} reading the calendar through the built-in google tool.` } : null,
  };
}

/** The setup step a lane names when nothing serves it, from the Google connection's actual state. */
function googleSetupNext(state: AgentGoogleConnectionState, lane: 'inbox' | 'calendar'): string {
  const work = lane === 'inbox' ? 'triage and draft replies' : 'route agenda briefing, conflicts, and reminders';
  if (state.status === 'connected') return `The connected Google account was not granted ${lane === 'inbox' ? 'mail' : 'calendar'} read access; re-authorize with /google reauthorize, then ${work} through the built-in google tool.`;
  if (state.status === 'unreadable') return 'The credential store could not be read, so whether a Google account is connected is unknown; run google action:"status" to see the reason.';
  return `Connect a Google account with /google connect, then ${work} through the built-in google tool.`;
}

function googleSignal(state: AgentGoogleConnectionState, route: GoogleLaneRoute | null): string {
  if (route) return `Google account connected (${route.modelRoute})`;
  if (state.status === 'connected') return 'Google account connected without read access for this lane';
  if (state.status === 'unreadable') return 'Google connection unknown (credential store unreadable)';
  return 'No Google account connected';
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
      ...reminderOperationRecords(configuredTargets > 0 || readyChannels > 0),
    ],
  };
}

function inboxLane({ snapshot, google, emailMethods, unavailableEmailMethods, emailConnectors, inboxArtifactRecords, inboxReviewQueueRecords, inboxEffectReceiptRecords, refreshableInboxQueueRecords, readyChannels }: {
  readonly snapshot: ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>;
  readonly google: GoogleLanes;
  readonly emailMethods: readonly string[];
  readonly unavailableEmailMethods: readonly string[];
  readonly emailConnectors: ReturnType<typeof connectorSignals>;
  readonly inboxArtifactRecords: readonly PersonalOpsLiveRecord[];
  readonly inboxReviewQueueRecords: readonly PersonalOpsLiveRecord[];
  readonly inboxEffectReceiptRecords: readonly PersonalOpsLiveRecord[];
  readonly refreshableInboxQueueRecords: number;
  readonly readyChannels: number;
}): PersonalOpsLane {
  return {
    id: 'inbox',
    label: 'Inbox',
    status: google.inbox ? 'ready'
      : emailMethods.length > 0 || emailConnectors.length > 0 || inboxArtifactRecords.length > 0 || inboxEffectReceiptRecords.length > 0 ? 'partial' : 'gap',
    outcome: 'Triage inbound email or message inboxes, summarize threads, draft replies, and send only after confirmation.',
    current: google.inbox ? google.inbox.summary
      : emailMethods.length > 0 && emailConnectors.length === 0 && inboxArtifactRecords.length === 0 && inboxEffectReceiptRecords.length === 0
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
    next: google.inbox ? `List unread mail with ${google.inbox.modelRoute}, read a thread with google action:"mail.read", draft in the conversation, and send only through google action:"mail.send" under its own admission.`
      : emailMethods.length > 0 && emailConnectors.length === 0 && inboxArtifactRecords.length === 0 && inboxEffectReceiptRecords.length === 0
      ? 'Use the inbox workflow cards to inspect exact methods, read selected threads, summarize priorities, and keep send as a separate confirmation.'
      : emailConnectors.length > 0
        ? 'Use the inbox workflow cards and operation records to inspect matching MCP connector schemas, then route triage only through reviewed connector actions.'
        : inboxArtifactRecords.length > 0
          ? 'Use saved thread queue records for local draft review or recap, then repair an email connector before reading fresh inbox data or sending.'
          : inboxEffectReceiptRecords.length > 0
            ? 'Review saved inbox provider-effect receipts, then repair an email connector before reading fresh inbox data or sending another provider effect.'
      : googleSetupNext(google.state, 'inbox'),
    userRoute: 'Agent Workspace -> Personal Ops -> Delivery channels',
    modelRoute: google.inbox ? google.inbox.modelRoute : emailConnectors.length > 0 ? 'agent_harness mode:"mcp_servers" query:"email"' : 'host action:"methods" query:"email"',
    signals: [
      googleSignal(google.state, google.inbox),
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
    workflows: [...inboxWorkflows(emailMethods, emailConnectors, unavailableEmailMethods, google.inbox), personalOpsStyleDraftWorkflow()],
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

/**
 * Each source is read once: the workspace snapshot, the contract lanes (a
 * per-process partition of the compiled contract), the MCP inventory when an
 * inbox or calendar lane is wanted, the Google connection, and the saved
 * records. Lane membership and connector classification are decided in code.
 */
async function ownedBuildLanes(
  context: CommandContext,
  options: CatalogRankingOptions & { readonly connectors?: ConnectorInventory } = {},
  exactLane?: 'notes' | 'reminders' | 'inbox',
): Promise<readonly PersonalOpsLane[]> {
  options.signal?.throwIfAborted();
  const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
  if (exactLane === 'notes') return [notesLane(snapshot)];
  // A lane's reads are skipped when the caller asked for another lane alone.
  const wants = (lane: 'inbox' | 'calendar' | 'tasks' | 'reminders') => exactLane === undefined || exactLane === lane;
  const none: readonly PersonalOpsLiveRecord[] = [];
  const readsConnectors = wants('inbox') || wants('calendar');
  // One artifact listing serves every lane's saved reviews and effect receipts.
  const readsSaved = readsConnectors || wants('reminders');
  const [connectors, google, saved]: readonly [ConnectorInventory, GoogleLanes, PersonalOpsSavedArtifacts] = await Promise.all([
    readsConnectors ? options.connectors ?? readConnectorInventory(context, options) : NO_CONNECTORS,
    readsConnectors ? readGoogleLanes(context) : NO_GOOGLE_LANES,
    readsSaved ? readPersonalOpsSavedArtifacts(context, options) : NO_SAVED_ARTIFACTS,
  ]);
  options.signal?.throwIfAborted();
  const emailConnectors = wants('inbox') ? connectorSignals(connectors, 'inbox') : [];
  const calendarConnectors = wants('calendar') ? connectorSignals(connectors, 'calendar') : [];
  const inboxArtifactRecords = wants('inbox') ? savedReviewArtifactRecords(saved, 'inbox', emailConnectors) : none;
  const calendarArtifactRecords = wants('calendar') ? savedReviewArtifactRecords(saved, 'calendar', calendarConnectors) : none;
  const inboxReviewQueueRecords = wants('inbox') ? savedReviewQueueRecords(saved, 'inbox', emailConnectors) : none;
  const calendarReviewQueueRecords = wants('calendar') ? savedReviewQueueRecords(saved, 'calendar', calendarConnectors) : none;
  const inboxEffectReceiptRecords = wants('inbox') ? savedProviderEffectReceiptRecords(saved, 'inbox') : none;
  const calendarEffectReceiptRecords = wants('calendar') ? savedProviderEffectReceiptRecords(saved, 'calendar') : none;
  const reminderEffectReceiptRecords = wants('reminders') ? savedProviderEffectReceiptRecords(saved, 'reminders') : none;
  const refreshableInboxQueueRecords = refreshableSavedRecordCount(inboxReviewQueueRecords);
  const refreshableCalendarQueueRecords = refreshableSavedRecordCount(calendarReviewQueueRecords);
  const readyChannels = snapshot.channels.filter((channel) => channel.ready).length;
  const enabledChannels = snapshot.channels.filter((channel) => channel.enabled).length;
  const configuredTargets = snapshot.channels.filter((channel) => channel.defaultTarget === 'configured').length;
  const scheduleReadyRoutines = snapshot.localRoutines.filter((routine) => (
    routine.enabled === true
    && routine.reviewState === 'reviewed'
    && (routine.missingRequirementCount ?? 0) === 0
  )).length;
  const email = contractLaneMethods('inbox'), calendar = contractLaneMethods('calendar');
  const emailMethods = email.available, unavailableEmailMethods = email.unavailable;
  const calendarMethods = calendar.available, unavailableCalendarMethods = calendar.unavailable;
  const taskMethods = contractLaneMethods('tasks').available, scheduleMethods = contractLaneMethods('reminders').available;
  const inbox = () => inboxLane({ snapshot, google, emailMethods, unavailableEmailMethods, emailConnectors, inboxArtifactRecords,
    inboxReviewQueueRecords, inboxEffectReceiptRecords, refreshableInboxQueueRecords, readyChannels });
  const withScanWindow = (lanes: readonly PersonalOpsLane[]): readonly PersonalOpsLane[] => {
    if (!saved.windowFull) return lanes;
    const readsSavedArtifacts = new Set(['inbox', 'calendar', 'reminders']);
    return lanes.map(lane => readsSavedArtifacts.has(lane.id) ? { ...lane, signals: [...lane.signals, SAVED_ARTIFACT_SCAN_WINDOW_SIGNAL] } : lane);
  };
  if (exactLane === 'reminders') return withScanWindow([remindersLane(scheduleMethods, reminderEffectReceiptRecords, configuredTargets, readyChannels)]);
  if (exactLane === 'inbox') return withScanWindow([inbox()]);
  const allLanes: readonly PersonalOpsLane[] = [
    inbox(),
    {
      id: 'calendar',
      label: 'Calendar',
      status: google.calendar ? 'ready'
        : calendarMethods.length > 0 || calendarConnectors.length > 0 || calendarArtifactRecords.length > 0 || calendarEffectReceiptRecords.length > 0 ? 'partial' : 'gap',
      outcome: 'Read agenda context, identify conflicts, prepare briefings, and create reminders for calendar-driven work.',
      current: google.calendar ? google.calendar.summary
        : calendarMethods.length > 0 && calendarConnectors.length === 0 && calendarArtifactRecords.length === 0 && calendarEffectReceiptRecords.length === 0
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
      next: google.calendar ? `Read the agenda with ${google.calendar.modelRoute}, brief conflicts in the conversation, and create events only through google action:"calendar.create" under its own admission.`
        : calendarMethods.length > 0 && calendarConnectors.length === 0 && calendarArtifactRecords.length === 0 && calendarEffectReceiptRecords.length === 0
        ? 'Use the calendar workflow cards to inspect exact methods, fetch a bounded agenda window, and propose reminders or follow-ups.'
        : calendarConnectors.length > 0
          ? 'Use the calendar workflow cards and operation records to inspect matching MCP connector schemas, then route agenda work only through reviewed connector actions.'
          : calendarArtifactRecords.length > 0
            ? 'Use saved event queue records for recap or reminder creation, then repair a calendar connector before reading fresh agenda data or editing events.'
            : calendarEffectReceiptRecords.length > 0
              ? 'Review saved calendar provider-effect receipts, then repair a calendar connector before reading fresh agenda data or editing events.'
        : googleSetupNext(google.state, 'calendar'),
      userRoute: 'Agent Workspace -> Personal Ops -> Create reminder',
      modelRoute: google.calendar ? google.calendar.modelRoute : calendarConnectors.length > 0 ? 'agent_harness mode:"mcp_servers" query:"calendar"' : 'host action:"methods" query:"calendar"',
      signals: [
        googleSignal(google.state, google.calendar),
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
      workflows: calendarWorkflows(calendarMethods, calendarConnectors, unavailableCalendarMethods, google.calendar),
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
      status: taskMethods.length > 0 ? 'ready' : 'partial',
      outcome: 'Track user-visible work items, inspect host task state, and update work plan status without hidden jobs.',
      current: `Agent has work-plan actions and ${taskMethods.length} task/work-plan daemon method(s) in the platform contract.`,
      next: 'Use work plans for user-visible task tracking; inspect runtime host tasks separately before mutating anything.',
      userRoute: 'Agent Workspace -> Work & Approvals -> Autonomy queue',
      modelRoute: 'agent_work_plan action:"list"',
      signals: [
        `${taskMethods.length} task/work-plan daemon method(s)`,
        'Work plan list/get/create/update/set_status/remove/clear_completed actions are available',
      ],
      methodIds: taskMethods,
      workflows: taskWorkflows(taskMethods),
      liveRecords: taskOperationRecords(),
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
  return withScanWindow(allLanes);
}
