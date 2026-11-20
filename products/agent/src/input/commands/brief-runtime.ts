import type { AutomationJob } from '@goodvibes-jev/engine/platform/platform/automation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { readAction } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
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
    const plan = ctx.workspace?.workPlan?.snapshotNow();
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
      ? 'Choose the assistant model: /model use.'
      : '',
    snapshot.localMemoryCount === 0
      ? 'Keep durable, non-secret facts: /memory add.'
      : snapshot.localMemoryReviewQueueCount > 0
        ? `Review ${plural(snapshot.localMemoryReviewQueueCount, 'memory record')}: /memory queue.`
        : '',
    !hasLocalSkillBehavior
      ? 'Make reusable procedures: /my-skills create, or import a skill file with /my-skills import-discovered.'
      : '',
    skillSetupGaps > 0
      ? `Give ${plural(skillSetupGaps, 'skill')} what they need: /my-skills attention.`
      : '',
    skillBundleSetupGaps > 0
      ? `Give ${plural(skillBundleSetupGaps, 'skill bundle')} what they need: /my-skills bundles-attention.`
      : '',
    hasLocalSkillBehavior && skillSetupGaps === 0 && skillBundleSetupGaps === 0 && snapshot.activeSkillCount === 0
      ? 'Switch on reviewed skills or bundles: /my-skills enable.'
      : '',
    snapshot.localRoutineCount === 0
      ? 'Make repeatable workflows: /routines create; put one on a schedule with /routines promote.'
      : routineSetupGaps > 0
        ? `Give ${plural(routineSetupGaps, 'routine')} what they need: /routines list --only attention.`
        : snapshot.enabledRoutineCount === 0
        ? 'Switch on reviewed routines: /routines enable.'
        : '',
    channelSetupGaps > 0
      ? `Finish setting up ${plural(channelSetupGaps, 'enabled channel')}: /channels setup.`
      : '',
    voiceSetupNeedsReview
      ? 'Check the voice setup before relying on spoken replies: /voice status.'
      : '',
    mediaSetupNeedsReview
      ? 'Check the media providers before relying on images or media: /media providers.'
      : '',
    'Agent Knowledge: /knowledge.',
    'Hand build, fix or review work to the terminal app only when you mean to: /agents hand-off.',
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
    `  spoken replies: ${snapshot.voiceMediaReadiness.selectedTtsProviderLabel} (${snapshot.voiceMediaReadiness.selectedTtsProviderStatus}); voice ${snapshot.voiceSurfaceEnabled ? 'on' : 'off'}; ${snapshot.voiceMediaReadiness.readyVoiceProviderCount} voice and ${snapshot.voiceMediaReadiness.readyMediaProviderCount} media providers ready`,
    `  this device: ${snapshot.companionAccess.pairingReady ? 'paired with its host' : 'not paired with a host'} (${snapshot.companionAccess.hostUrl}); phones and their camera, location and notifications: /devices nodes`,
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
  registry.register(defineCommand<CommandContext>({
    name: 'brief',
    title: 'Briefing',
    summary: 'A short briefing: how the Agent is set up, what is ready, and what to do next',
    group: 'Agent',
    actions: [readAction<CommandContext>({
      id: 'brief', label: 'See your briefing', word: '',
      sentence: 'Shows the model in use, what is ready (memory, skills, routines, channels, voice), the work plan and schedules, and what to do next.',
      operator: { terminalOnly: 'It reads this Agent\'s own state.' },
      async run(_values, ctx) { return formatAgentOperatorBriefing(ctx); },
    })],
  }));
}
