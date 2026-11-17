import type { AutomationJob } from '@goodvibes-jev/engine/platform/platform/automation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../agent-workspace-snapshot.ts';
import { WORK_PLAN_TASK_STATUSES as WORK_PLAN_STATUSES, type ProjectWorkPlanTaskStatus as WorkPlanItemStatus } from '@goodvibes-jev/engine/platform/platform/knowledge';

type StatusCounts = Record<WorkPlanItemStatus, number>;

function countReady<T extends { readonly status: string }>(items: readonly T[], status: string): number {
  return items.filter((item) => item.status === status).length;
}

type WorkPlanReading = { readonly total: number; readonly counts: StatusCounts } | { readonly unavailable: string };
type JobsReading = { readonly jobs: readonly AutomationJob[] } | { readonly unavailable: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workPlanCounts(ctx: CommandContext): WorkPlanReading {
  const counts = Object.fromEntries(WORK_PLAN_STATUSES.map((status) => [status, 0])) as StatusCounts;
  try {
    const plan = ctx.workspace?.workPlanStore?.snapshotNow();
    if (!plan) return { total: 0, counts };
    for (const status of WORK_PLAN_STATUSES) counts[status] = plan.counts[status];
    return { total: plan.counts.total, counts };
  } catch (error) {
    return { unavailable: reason(error) };
  }
}

function automationJobs(ctx: CommandContext): JobsReading {
  try {
    return { jobs: ctx.ops?.automationManager?.listJobs?.() ?? [] };
  } catch (error) {
    return { unavailable: reason(error) };
  }
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function countSetupGaps(items: readonly { readonly missingRequirementCount?: number }[]): number {
  return items.filter((item) => (item.missingRequirementCount ?? 0) > 0).length;
}

function formatWorkPlanLine(reading: WorkPlanReading): string {
  if ('unavailable' in reading) return `  work plan unavailable: ${reading.unavailable}`;
  const { total, counts } = reading;
  if (total === 0) return '  work plan empty';
  const active = counts.pending + counts.in_progress + counts.blocked;
  return [
    `  work plan: ${plural(total, 'item')}`,
    `active ${active}`,
    `pending ${counts.pending}`,
    `in progress ${counts.in_progress}`,
    `blocked ${counts.blocked}`,
    `done ${counts.done}`,
  ].join('; ');
}

function formatWarnings(warnings: readonly string[]): readonly string[] {
  if (warnings.length === 0) return ['  warnings none'];
  return ['  warnings', ...warnings.slice(0, 4).map((warning) => `    - ${warning}`)];
}

export function formatAgentOperatorBriefing(ctx: CommandContext): string {
  const snapshot = buildAgentWorkspaceRuntimeSnapshot(ctx);
  const workPlan = workPlanCounts(ctx);
  const jobReading = automationJobs(ctx);
  const jobs = 'jobs' in jobReading ? jobReading.jobs : [];
  const enabledJobs = jobs.filter((job) => job.enabled).length;
  const setupReady = countReady(snapshot.setupChecklist, 'ready');
  const setupRecommended = countReady(snapshot.setupChecklist, 'recommended');
  const setupBlocked = countReady(snapshot.setupChecklist, 'blocked');
  const readyChannels = snapshot.channels.filter((channel) => channel.ready).length;
  const enabledChannels = snapshot.channels.filter((channel) => channel.enabled).length;
  const channelSetupGaps = snapshot.channels.filter((channel) => channel.enabled && !channel.ready).length;
  const skillSetupGaps = countSetupGaps(snapshot.localSkills);
  const skillBundleSetupGaps = countSetupGaps(snapshot.localSkillBundles);
  const routineSetupGaps = countSetupGaps(snapshot.localRoutines);
  const voiceSetupNeedsReview = snapshot.voiceSurfaceEnabled && snapshot.voiceMediaReadiness.selectedTtsProviderStatus !== 'ready';
  const mediaSetupNeedsReview = snapshot.mediaProviderCount > 0 && snapshot.voiceMediaReadiness.readyMediaProviderCount === 0;
  const hasLocalSkillBehavior = snapshot.localSkillCount > 0 || snapshot.localSkillBundleCount > 0;

  const nextActions = [
    snapshot.provider === 'unknown' || snapshot.model === 'unknown'
      ? 'Choose the assistant model from Agent Workspace -> Start -> Choose main model.'
      : '',
    snapshot.localMemoryCount === 0
      ? 'Store durable non-secret facts from Agent Workspace -> Memory -> Create memory.'
      : snapshot.localMemoryReviewQueueCount > 0
        ? `Review ${plural(snapshot.localMemoryReviewQueueCount, 'memory record')} from Agent Workspace -> Memory -> Learning curator.`
        : '',
    !hasLocalSkillBehavior
      ? 'Create reusable procedures from Agent Workspace -> Skills or import reviewed skill files.'
      : '',
    skillSetupGaps > 0
      ? `Resolve ${plural(skillSetupGaps, 'skill')} with setup gaps from Agent Workspace -> Skills.`
      : '',
    skillBundleSetupGaps > 0
      ? `Resolve ${plural(skillBundleSetupGaps, 'skill bundle')} with setup gaps from Agent Workspace -> Skills.`
      : '',
    hasLocalSkillBehavior && skillSetupGaps === 0 && skillBundleSetupGaps === 0 && snapshot.activeSkillCount === 0
      ? 'Enable reviewed skills or bundles from Agent Workspace -> Skills.'
      : '',
    snapshot.localRoutineCount === 0
      ? 'Create repeatable workflows from Agent Workspace -> Routines; promote schedules only with explicit confirmation.'
      : routineSetupGaps > 0
        ? `Resolve ${plural(routineSetupGaps, 'routine')} with setup gaps from Agent Workspace -> Routines.`
        : snapshot.enabledRoutineCount === 0
        ? 'Enable reviewed routines from Agent Workspace -> Routines.'
        : '',
    channelSetupGaps > 0
      ? `Review ${plural(channelSetupGaps, 'enabled channel')} needing setup from Agent Workspace -> Messaging.`
      : '',
    voiceSetupNeedsReview
      ? 'Review voice setup from Agent Workspace -> Voice & Media before relying on spoken replies.'
      : '',
    mediaSetupNeedsReview
      ? 'Review media provider setup from Agent Workspace -> Voice & Media before relying on image or media workflows.'
      : '',
    'Use Agent Workspace -> Knowledge for Agent Knowledge status, search, and explicit ingest forms.',
    'Use Agent Workspace -> Work & Approvals -> Delegate a build task only for explicit build, fix, implementation, or review handoff to GoodVibes TUI.',
  ].filter((line): line is string => line.length > 0);

  return [
    'Agent Briefing',
    `  chat route: ${snapshot.provider} / ${snapshot.modelDisplayName}`,
    `  session ${snapshot.sessionId}`,
    `  profile ${snapshot.activeRuntimeProfile}`,
    `  policy ${snapshot.executionPolicy}; delegated review ${snapshot.delegatedReviewPolicy}`,
    `  knowledge ${snapshot.knowledgeRoute} (${snapshot.knowledgeIsolation}; no fallback)`,
    '',
    'Readiness',
    `  setup ${setupReady}/${snapshot.setupChecklist.length} ready; ${setupRecommended} recommended; ${setupBlocked} blocked`,
    `  local memory: ${plural(snapshot.localMemoryCount, 'record')}; prompt-active ${snapshot.localMemoryPromptActiveCount}; review queue ${snapshot.localMemoryReviewQueueCount}`,
    `  scratchpad notes: ${plural(snapshot.localNoteCount, 'note')}; review queue ${snapshot.localNoteReviewQueueCount}`,
    `  personas: ${plural(snapshot.localPersonaCount, 'persona')}; active ${snapshot.activePersonaName}`,
    `  skills: ${snapshot.enabledSkillCount}/${snapshot.localSkillCount} enabled; bundles ${snapshot.enabledSkillBundleCount}/${snapshot.localSkillBundleCount}; active ${snapshot.activeSkillCount}; setup gaps ${skillSetupGaps} skill, ${skillBundleSetupGaps} bundle`,
    `  routines: ${snapshot.enabledRoutineCount}/${snapshot.localRoutineCount} enabled; setup gaps ${routineSetupGaps}`,
    `  channels: ${readyChannels}/${snapshot.channels.length} ready; ${enabledChannels} enabled; setup gaps ${channelSetupGaps}`,
    `  voice/media: ${snapshot.voiceProviderCount} voice, ${snapshot.mediaProviderCount} media; browser tools ${snapshot.voiceMediaReadiness.browserToolState}`,
    formatWorkPlanLine(workPlan),
    'unavailable' in jobReading ? `  schedules unavailable: ${jobReading.unavailable}` : `  schedules ${enabledJobs}/${jobs.length} visible jobs enabled`,
    '',
    'Next Actions',
    ...nextActions.map((line) => `  - ${line}`),
    '',
    ...formatWarnings(snapshot.warnings),
  ].join('\n');
}

export function registerBriefRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'brief',
    aliases: ['briefing'],
    description: 'Show a concise Agent operator briefing and next actions',
    usage: '',
    argsHint: '',
    handler(_args, ctx) {
      ctx.print(formatAgentOperatorBriefing(ctx));
    },
  });
}
