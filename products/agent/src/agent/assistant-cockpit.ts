import { presetForMode } from '@goodvibes-jev/engine/platform/platform/gate';
import type { AgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-types.ts';

/** `unmeasured`: the caller had no data for the lane, so it is neither healthy nor a finding. */
export type AssistantCockpitLaneState = 'ready' | 'attention' | 'setup' | 'unmeasured';
export type AssistantCockpitStatus = 'ready' | 'ready-with-optional-setup' | 'attention';

export interface AssistantCockpitLane {
  readonly id:
    | 'setup'
    | 'chat-and-model'
    | 'work-and-files'
    | 'personal-ops'
    | 'research-and-docs'
    | 'background-work'
    | 'safety-and-recovery';
  readonly label: string;
  readonly state: AssistantCockpitLaneState;
  readonly summary: string;
  readonly nextAction: string;
  readonly routes: readonly string[];
}

export interface AssistantCockpit {
  readonly status: AssistantCockpitStatus;
  readonly primaryNextAction: string;
  readonly lanes: readonly AssistantCockpitLane[];
  readonly boundaryPolicy: string;
}

export interface AssistantCockpitMetrics {
  readonly setupBlockers: number;
  readonly setupSmokeResult?: string;
  readonly setupSmokeTrend?: string;
  readonly modelStatus: string;
  readonly executionRoutes: number;
  readonly personalGaps: number;
  readonly runningWork: number;
  readonly researchRuns: number;
  readonly documentLanes: number;
  readonly documentGaps: number;
  readonly securityFindings: number;
  /**
   * Lanes whose numbers the caller could not measure, so their state is not a
   * finding. Their summaries say so instead of reporting a healthy lane.
   */
  readonly unmeasured?: readonly AssistantCockpitLane['id'][];
}

const UNMEASURED_PREFIX = 'Not measured in this view; ';

function lane(options: AssistantCockpitLane, unmeasured?: readonly AssistantCockpitLane['id'][]): AssistantCockpitLane {
  // Only a lane that would read healthy is downgraded; a measured problem stays visible.
  return options.state === 'ready' && unmeasured?.includes(options.id)
    ? { ...options, state: 'unmeasured', summary: `${UNMEASURED_PREFIX}${options.summary.charAt(0).toLowerCase()}${options.summary.slice(1)}` }
    : options;
}

function setupLaneSummary(metrics: AssistantCockpitMetrics): string {
  const base = metrics.setupBlockers > 0
    ? `${metrics.setupBlockers} setup blocker(s) before autonomous work.`
    : 'First-run setup has no blocking assistant issue.';
  const latest = metrics.setupSmokeResult ? ` Last smoke ${metrics.setupSmokeResult}.` : '';
  const trend = metrics.setupSmokeTrend && metrics.setupSmokeTrend !== 'none'
    ? ` Trend ${metrics.setupSmokeTrend}.`
    : '';
  return `${base}${latest}${trend}`;
}

function setupLaneNextAction(metrics: AssistantCockpitMetrics): string {
  if (metrics.setupSmokeTrend === 'regressing') return 'Review recent smoke history, fix new blockers, then save new setup evidence.';
  if (metrics.setupSmokeResult === 'blocked') return 'Review the saved smoke artifact, resolve blockers, then save new setup evidence.';
  if (metrics.setupSmokeResult === 'passed') return 'Setup evidence passed; start the user task.';
  if (metrics.setupSmokeResult === 'ready-for-user-run') return 'Have the user run the remaining user-run checks, then save what they saw as setup evidence.';
  if (metrics.setupBlockers === 0 && !metrics.setupSmokeResult) return 'Have the user run the setup smoke checks (setup action:"item" setupItemId:"install-smoke"), then save the evidence.';
  return 'Use setup posture for the next visible setup step.';
}

export function buildAssistantCockpitFromMetrics(metrics: AssistantCockpitMetrics): AssistantCockpit {
  const status: AssistantCockpitStatus = metrics.setupBlockers > 0 || metrics.modelStatus === 'degraded'
    ? 'attention'
    : metrics.personalGaps > 0
      ? 'ready-with-optional-setup'
      : 'ready';
  const primaryNextAction = metrics.setupBlockers > 0
    ? 'Finish first-run setup blockers before trusting autonomous work.'
    : metrics.modelStatus === 'degraded'
      ? 'Review provider and model routing before starting a new assistant task.'
      : metrics.runningWork > 0
        ? 'Review visible background work before starting another long-running task.'
        : 'Start with the user task; route details are available only when needed.';

  return {
    status,
    primaryNextAction,
    lanes: [
      lane({
        id: 'setup',
        label: 'Get the assistant working',
        state: metrics.setupBlockers > 0 ? 'attention' : 'ready',
        summary: setupLaneSummary(metrics),
        nextAction: setupLaneNextAction(metrics),
        routes: [
          'setup action:"status"',
          'setup action:"item"',
          'setup action:"checkpoint"',
          'setup action:"save_checkpoint"',
          'setup action:"clear_checkpoint"',
          'setup action:"token"',
          'setup action:"smoke"',
        ],
      }, metrics.unmeasured),
      lane({
        id: 'chat-and-model',
        label: 'Talk and choose models',
        state: metrics.modelStatus === 'degraded' ? 'attention' : 'ready',
        summary: metrics.modelStatus === 'degraded' ? 'Model/provider API is degraded; routing still has diagnostics.' : 'Model route posture is available.',
        nextAction: 'Inspect routing only when model choice, cost, privacy, or local setup matters.',
        routes: ['models action:"status"', 'models action:"providers"', 'models action:"local"'],
      }),
      lane({
        id: 'work-and-files',
        label: 'Work in this project',
        state: metrics.executionRoutes > 0 ? 'ready' : 'setup',
        summary: metrics.executionRoutes > 0 ? 'Local read/edit/exec and recovery posture is inspectable.' : 'Execution posture needs tool availability review.',
        nextAction: 'Use local work routes first; delegate only for isolation, remote work, or explicit review.',
        routes: ['context action:"files"', 'agent_harness mode:"execution_posture"', 'agent_harness mode:"file_recovery"'],
      }, metrics.unmeasured),
      lane({
        id: 'personal-ops',
        label: 'Handle personal operations',
        state: metrics.personalGaps > 0 ? 'attention' : 'ready',
        summary: metrics.personalGaps > 0 ? `${metrics.personalGaps} personal-ops lane(s) need setup.` : 'Personal Ops lanes are available or safely identified.',
        nextAction: 'Use Personal Ops lanes and queue for inbox, calendar, notes, tasks, and delivery readiness.',
        routes: ['personal_ops action:"briefing"', 'personal_ops action:"queue"', 'personal_ops action:"intake" query:"..."', 'personal_ops action:"lane" laneId:"..."'],
      }),
      lane({
        id: 'research-and-docs',
        label: 'Research and write',
        state: metrics.documentGaps > 0 ? 'attention' : 'ready',
        summary: `${metrics.researchRuns} research run(s); ${metrics.documentLanes} document lane(s).`,
        nextAction: 'Start with the research briefing, then use source queues, reports, documents, artifacts, and blind compare as one writing path.',
        routes: ['research action:"briefing"', 'research action:"plan"', 'research action:"search"', 'research action:"runner"', 'research action:"reports"', 'agent_harness mode:"document_ops"'],
      }, metrics.unmeasured),
      lane({
        id: 'background-work',
        label: 'Supervise background work',
        state: metrics.runningWork > 0 ? 'attention' : 'ready',
        summary: metrics.runningWork > 0 ? `${metrics.runningWork} running item(s) need visible supervision.` : 'No running background work reported by the summary.',
        nextAction: 'Inspect the autonomy queue, visible agents, and tracked local processes before starting, pausing, resuming, or canceling ongoing work.',
        routes: ['agent_harness mode:"autonomy_queue"', 'agent_harness mode:"agent_orchestration"', 'agent_harness mode:"background_processes"', 'agent_harness mode:"autonomy_intake"'],
      }, metrics.unmeasured),
      lane({
        id: 'safety-and-recovery',
        label: 'Stay safe and recover',
        state: metrics.securityFindings > 0 ? 'attention' : 'ready',
        summary: metrics.securityFindings > 0 ? `${metrics.securityFindings} safety finding(s) need review.` : 'Security and recovery posture is inspectable.',
        nextAction: 'Use security, support bundle, execution history, and file recovery routes when risk or rollback matters.',
        routes: ['agent_harness mode:"security_posture"', 'agent_harness mode:"support_bundles"', 'agent_harness mode:"execution_history"'],
      }),
    ],
    boundaryPolicy: 'Primary UX is one assistant. Host, daemon, provider, MCP, and delegation details are diagnostics and confirmation boundaries, not first questions for the user.',
  };
}

export interface AssistantCockpitRoutes {
  readonly lanes: readonly Pick<AssistantCockpitLane, 'id' | 'label' | 'routes'>[];
  readonly boundaryPolicy: string;
}

/**
 * The cockpit's lanes and the routes that read each one, with no state: the
 * harness summary reads no live status, so it shows where to look, not what
 * is there.
 */
export function assistantCockpitRouteMap(): AssistantCockpitRoutes {
  const cockpit = buildAssistantCockpitFromMetrics({
    setupBlockers: 0, modelStatus: 'ready', executionRoutes: 1, personalGaps: 0, runningWork: 0,
    researchRuns: 0, documentLanes: 0, documentGaps: 0, securityFindings: 0,
  });
  return { lanes: cockpit.lanes.map(({ id, label, routes }) => ({ id, label, routes })), boundaryPolicy: cockpit.boundaryPolicy };
}

export function buildAssistantCockpitFromWorkspaceSnapshot(snapshot: AgentWorkspaceRuntimeSnapshot): AssistantCockpit {
  const setupBlockers = snapshot.setupChecklist.filter((item) => item.status === 'blocked').length;
  const modelStatus = snapshot.provider === 'unknown' || snapshot.model === 'unknown' ? 'degraded' : 'ready';
  const readyChannels = snapshot.channels.filter((channel) => channel.ready).length;
  const enabledChannels = snapshot.channels.filter((channel) => channel.enabled).length;
  const scheduleReadyRoutines = snapshot.localRoutines.filter((routine) => (
    routine.enabled === true
    && routine.reviewState === 'reviewed'
    && (routine.missingRequirementCount ?? 0) === 0
  )).length;
  const personalGaps = [
    enabledChannels > 0 && readyChannels === 0,
    snapshot.localRoutineCount > 0 && scheduleReadyRoutines === 0,
  ].filter(Boolean).length;
  // Blocked runs wait for the owner; only running runs are background work.
  const runningWork = snapshot.researchRunRunningCount;
  const securityFindings = [
    presetForMode(snapshot.permissionMode).name === 'yolo',
    snapshot.rawPromptTelemetry,
    snapshot.browserToolExposureEnabled,
    snapshot.mcpQuarantinedServerCount > 0,
    snapshot.mcpAllowAllServerCount > 0,
    snapshot.failedRoutineScheduleReceiptCount > 0,
  ].filter(Boolean).length;

  return buildAssistantCockpitFromMetrics({
    setupBlockers,
    setupSmokeResult: undefined,
    setupSmokeTrend: undefined,
    // The snapshot carries no execution, document, setup-smoke or background
    // process data; those lanes say so rather than report a healthy state.
    unmeasured: ['setup', 'work-and-files', 'research-and-docs', 'background-work'],
    modelStatus,
    executionRoutes: 1,
    personalGaps,
    runningWork,
    researchRuns: snapshot.researchRunCount,
    documentLanes: 7,
    documentGaps: 0,
    securityFindings,
  });
}
