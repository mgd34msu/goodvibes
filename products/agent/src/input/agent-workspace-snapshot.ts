import { readConnectedHostOperatorToken } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-auth';
import { basename, sep } from 'node:path';
import type { CommandContext } from './command-registry.ts';
import { AgentRoutineRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/routine-registry';
import { memoryRecordTemporalStatus, resolveCanonicalMemoryDbPath } from '@goodvibes-jev/engine/platform/platform/state';
import { storeFileChangeStamp } from '@goodvibes-jev/engine/terminal-shell/agent-turn/store-change-stamp';
import { describeMemoryPromptEligibility, isPromptActiveMemory } from '@goodvibes-jev/engine/terminal-shell/agent-turn/memory-prompt';
import { summarizeAgentBehaviorDiscovery } from '../agent/behavior-discovery-summary.ts';
import { buildAgentWorkspaceChannelSetupGuide, buildAgentWorkspaceChannels } from './agent-workspace-channels.ts';
import { buildAgentWorkspaceSetupChecklist } from './agent-workspace-setup.ts';
import { buildAgentWorkspaceVoiceMediaReadiness } from './agent-workspace-voice-media.ts';
import { buildProcessSupervisionSummary, buildProjectContextSummary, buildPromptContextReceiptTimeline, buildResearchBrowserRunnerContract, buildResearchVisualReportContract, buildVibeSummary } from './agent-workspace-context-snapshot.ts';
import { summarizeMemoryItem, summarizeRoutineItem, summarizeRuntimeProfile, summarizeStarterTemplate } from './agent-workspace-local-library-snapshot.ts';
import { buildReviewPacketDefaults, buildReviewPacketTimeline, buildReviewPacketWizard, readDocumentDrafts, reviewerReadinessBadge } from './agent-workspace-review-packet-snapshot.ts';
import { buildSetupSmokeHistory, buildSetupWizardCheckpoint, buildWorkspaceSetupWizard, setupCompletionMarkerExists } from './agent-workspace-setup-snapshot.ts';
import { readConfigNumber, readConfigString } from './agent-workspace-snapshot-config.ts';
import {
  buildAgentWorkspaceArtifactListSnapshot,
  buildAgentWorkspaceCalendarOAuthConfigStatus,
  buildAgentWorkspaceCompanionAccessSnapshot,
  buildAgentWorkspaceConfigSettingsSnapshot,
  buildAgentWorkspaceCurrentModelSnapshot,
  buildAgentWorkspaceEmailConnectStatus,
  buildAgentWorkspaceMcpServerSnapshot,
  buildAgentWorkspaceNoteSnapshot,
  buildAgentWorkspacePersonaSnapshot,
  buildAgentWorkspaceRecentReviewerHandoffsSnapshot,
  buildAgentWorkspaceResearchRunSnapshot,
  buildAgentWorkspaceResearchSourceSnapshot,
  buildAgentWorkspaceRoutineScheduleReceiptsSnapshot,
  buildAgentWorkspaceRuntimeProfilesSnapshot,
  buildAgentWorkspaceSessionMemoryCount,
  buildAgentWorkspaceSkillSnapshot,
  buildAgentWorkspaceSubscriptionSnapshot,
  buildAgentWorkspaceVoiceMediaProvidersSnapshot,
  buildAgentWorkspaceArtifactResolver,
  type AgentWorkspaceReadFailures,
} from './agent-workspace-snapshot-builders.ts';
import type { AgentWorkspaceLocalLibraryItem, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
import { connectedHostBaseUrl } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-dial';

// Re-exported so this module's public surface still carries this builder,
// whose body now lives in agent-workspace-snapshot-builders.ts.
export { buildAgentWorkspaceEmailConnectStatus } from './agent-workspace-snapshot-builders.ts';

const READ_FAILURE_LABELS: Readonly<Record<string, string>> = {
  personas: 'personas',
  notes: 'notes',
  skills: 'skills',
  routines: 'routines',
  memory: 'memory',
  documents: 'document drafts',
  artifacts: 'artifacts',
  'routine-receipts': 'routine schedule receipts',
  'research-sources': 'research sources',
  'research-runs': 'research runs',
};

/** Store ids that map onto a setup checklist item, with that item's id. */
const UNREADABLE_CHECKLIST_ITEMS: readonly (readonly [string, string])[] = [
  ['personas', 'persona'],
  ['skills', 'skills'],
  ['routines', 'routines'],
  ['memory', 'memory'],
  ['notes', 'notes'],
];

/** Turns failed reads into warnings, so an unreadable store is never shown as an empty one. */
function describeReadFailures(failures: AgentWorkspaceReadFailures): string[] {
  const warnings: string[] = [];
  const settingKeys: string[] = [];
  for (const [id, reason] of failures) {
    if (id.startsWith('config:')) {
      settingKeys.push(id.slice('config:'.length));
      continue;
    }
    warnings.push(`Could not read ${READ_FAILURE_LABELS[id] ?? id}: ${reason}. It is shown as empty, which may not be what is stored.`);
  }
  if (settingKeys.length > 0) {
    warnings.push(`Could not read ${settingKeys.length} setting(s) (${settingKeys.join(', ')}); the values shown for them are defaults, not what is stored.`);
  }
  return warnings;
}

function inferActiveRuntimeProfile(homeDirectory: string): string {
  const marker = `${sep}.goodvibes${sep}agent${sep}profile-homes${sep}`;
  return homeDirectory.includes(marker) ? basename(homeDirectory) : '(default home)';
}

function inferRuntimeProfileBaseHome(homeDirectory: string): string {
  const marker = `${sep}.goodvibes${sep}agent${sep}profile-homes${sep}`;
  const markerIndex = homeDirectory.indexOf(marker);
  return markerIndex >= 0 ? homeDirectory.slice(0, markerIndex) : homeDirectory;
}

export interface AgentWorkspaceLiveMemoryCounters {
  readonly count: number;
  readonly reviewQueueCount: number;
  readonly promptActiveCount: number;
  /** Stored but not yet valid (now < validFrom). Still counted in `count`. */
  readonly temporallyPendingCount: number;
  /** Stored but past validUntil. Still counted in `count`, never deleted. */
  readonly temporallyExpiredCount: number;
  readonly items: readonly AgentWorkspaceLocalLibraryItem[];
}

/**
 * Reads the Agent memory count + items directly from the live memory API
 * (no caching). Throws if the read itself fails (e.g. the memory API errors
 * mid-call) rather than swallowing it, callers that need a best-effort,
 * never-throws default (the full runtime snapshot builder below) should use
 * buildAgentWorkspaceMemorySnapshot instead. The render-path live-counter
 * refresh (AgentWorkspace.syncLiveCountersForRender) calls this
 * directly so a genuine read failure can be surfaced as "stale" instead of
 * being silently rewritten to a fabricated 0.
 *
 * NOTE (observability flag): these live process/state counters are
 * flagged as observability-shaped content whose eventual surface home is the
 * fleet/observability layer, not this admin-console snapshot builder. Nothing
 * moves today (no observability layer exists yet); this function is kept
 * intact and separate rather than folded into the sibling sub-builders in
 * agent-workspace-snapshot-builders.ts extracted alongside it.
 */
export function readLiveAgentMemoryCounters(context: CommandContext): AgentWorkspaceLiveMemoryCounters {
  const memory = context.clients?.agentKnowledgeApi?.memory;
  if (!memory) {
    return { count: 0, reviewQueueCount: 0, promptActiveCount: 0, temporallyPendingCount: 0, temporallyExpiredCount: 0, items: [] };
  }
  const records = [...memory.getAll()].sort((left, right) => right.updatedAt - left.updatedAt);
  let temporallyPendingCount = 0;
  let temporallyExpiredCount = 0;
  for (const record of records) {
    const temporalStatus = memoryRecordTemporalStatus(record);
    if (temporalStatus === 'pending') temporallyPendingCount += 1;
    else if (temporalStatus === 'expired') temporallyExpiredCount += 1;
  }
  return {
    count: records.length,
    // The public review queue ranks all retrieved records without filtering.
    // Its capped cardinality is known locally; a repaint must not launch readings.
    reviewQueueCount: Math.min(records.length, 100),
    // Bound to one arg, a bare `.filter(isPromptActiveMemory)` leaks the
    // array index in as Array.filter's second (index) argument, which lands
    // in isPromptActiveMemory's `now` param and silently breaks the
    // temporal-validity check for every record past index 0.
    promptActiveCount: records.filter((record) => isPromptActiveMemory(record)).length,
    temporallyPendingCount,
    temporallyExpiredCount,
    // Each item carries the honest, per-record eligibility reason straight from
    // describeMemoryPromptEligibility, the same wording source
    // prompt-context-receipts.ts and agent-harness-prompt-context.ts use for prompt
    // recall. No locally invented "not reviewed"/"outside prompt limit" paraphrase here.
    items: records.map((record) => ({
      ...summarizeMemoryItem(record),
      promptEligible: isPromptActiveMemory(record),
      promptEligibilityReason: describeMemoryPromptEligibility(record).reason,
    })),
  };
}

/**
 * Best-effort variant of readLiveAgentMemoryCounters for the full runtime
 * snapshot builder: never throws, defaults to empty on any read failure.
 */
export function buildAgentWorkspaceMemorySnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures): AgentWorkspaceLiveMemoryCounters {
  try {
    return readLiveAgentMemoryCounters(context);
  } catch (error) {
    failures?.set('memory', error instanceof Error ? error.message : String(error));
    return { count: 0, reviewQueueCount: 0, promptActiveCount: 0, temporallyPendingCount: 0, temporallyExpiredCount: 0, items: [] };
  }
}

export interface AgentWorkspaceLiveRoutineCounters {
  readonly count: number;
  readonly enabled: number;
  readonly items: readonly AgentWorkspaceLocalLibraryItem[];
}

/**
 * Reads the Agent routine count + items (including each routine's live
 * startCount) directly from the on-disk routine store (no caching). Throws
 * if the store read fails (e.g. a corrupt/unreadable routines.json,
 * AgentRoutineRegistry.snapshot() itself throws in that case) rather than
 * swallowing it; see readLiveAgentMemoryCounters above for why the
 * render-path live-counter refresh wants that.
 *
 * NOTE (observability flag): see readLiveAgentMemoryCounters above,
 * the same flag applies to these routine counters.
 */
export function readLiveAgentRoutineCounters(context: CommandContext): AgentWorkspaceLiveRoutineCounters {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return { count: 0, enabled: 0, items: [] };
  const snapshot = AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot();
  return {
    count: snapshot.routines.length,
    enabled: snapshot.enabledRoutines.length,
    items: snapshot.routines.map(summarizeRoutineItem),
  };
}

/**
 * One stamp for the stores the live counters read: the shared memory file and
 * the routine store, two stat calls. Null when a store has no file to stamp
 * (an in-memory memory API, or no memory file yet), so the caller reads it.
 */
export function readLiveAgentCounterStamp(context: CommandContext): string | null {
  const shellPaths = context.workspace?.shellPaths;
  const memory = context.clients?.agentKnowledgeApi?.memory;
  if (!shellPaths) return memory ? null : 'no-stores';
  // A stub shell path service may carry no home; such a store is read every paint.
  const home: unknown = shellPaths.homeDirectory;
  const memoryStamp = !memory ? 'no-memory' : typeof home === 'string' ? storeFileChangeStamp(resolveCanonicalMemoryDbPath(home)) : 'absent';
  if (memoryStamp === 'absent') return null;
  return `${memoryStamp}|${AgentRoutineRegistry.fromShellPaths(shellPaths).changeStamp()}`;
}

/**
 * Best-effort variant of readLiveAgentRoutineCounters for the full runtime
 * snapshot builder: never throws, defaults to empty on any read failure.
 */
export function buildAgentWorkspaceRoutineCounters(context: CommandContext, failures?: AgentWorkspaceReadFailures): AgentWorkspaceLiveRoutineCounters {
  try {
    return readLiveAgentRoutineCounters(context);
  } catch (error) {
    failures?.set('routines', error instanceof Error ? error.message : String(error));
    return { count: 0, enabled: 0, items: [] };
  }
}

/** Where the Agent's isolated knowledge is served, and how it is kept apart; fixed by this build. */
export const AGENT_KNOWLEDGE_ROUTE = '/api/goodvibes-agent/knowledge';
export const AGENT_KNOWLEDGE_ISOLATION = 'agent-only';

/**
 * The review packet part: document drafts and the artifact list it is built
 * from. A tool that needs only this part builds only this part.
 */
/** Stores a caller already read; the part uses them instead of reading again. */
export interface AgentWorkspaceReviewPacketReads {
  readonly documentDrafts: ReturnType<typeof readDocumentDrafts>;
  readonly artifactList: ReturnType<typeof buildAgentWorkspaceArtifactListSnapshot>;
}

export function buildAgentWorkspaceReviewPacketPart(context: CommandContext, readFailures?: AgentWorkspaceReadFailures, reads?: AgentWorkspaceReviewPacketReads) {
  const artifactListSnapshot = reads?.artifactList ?? buildAgentWorkspaceArtifactListSnapshot(context, readFailures);
  const recentReviewerHandoffs = buildAgentWorkspaceRecentReviewerHandoffsSnapshot(artifactListSnapshot.items);
  const documentDrafts = reads?.documentDrafts ?? readDocumentDrafts(context, readFailures);
  const artifactListInfo = {
    truncated: artifactListSnapshot.truncated,
    resolveArtifact: buildAgentWorkspaceArtifactResolver(context),
  };
  const reviewPacketDefaults = buildReviewPacketDefaults(documentDrafts, artifactListSnapshot.items);
  return {
    artifactListSnapshot,
    recentReviewerHandoffs,
    documentDrafts,
    reviewPacketDefaults,
    reviewerBadge: reviewerReadinessBadge(documentDrafts, artifactListSnapshot.items, artifactListSnapshot.available, artifactListInfo, reviewPacketDefaults),
    reviewPacketTimeline: buildReviewPacketTimeline(documentDrafts, artifactListSnapshot.items, artifactListSnapshot.available, artifactListInfo),
    reviewPacketWizard: buildReviewPacketWizard(documentDrafts, artifactListSnapshot.available, reviewPacketDefaults, artifactListInfo),
  };
}

/** The voice and media part: provider descriptors and their readiness. */
export function buildAgentWorkspaceVoiceMediaPart(context: CommandContext) {
  const { voiceProviders, mediaProviders } = buildAgentWorkspaceVoiceMediaProvidersSnapshot(context);
  const voiceProviderDescriptors = voiceProviders.map((provider) => ({ id: provider.id, label: provider.label, capabilities: provider.capabilities }));
  const mediaProviderDescriptors = mediaProviders.map((provider) => ({ id: provider.id, label: provider.label, capabilities: provider.capabilities }));
  return {
    voiceProviders,
    mediaProviders,
    voiceMediaReadiness: buildAgentWorkspaceVoiceMediaReadiness({ context, voiceProviders: voiceProviderDescriptors, mediaProviders: mediaProviderDescriptors }),
  };
}

/** What the Document Ops lanes read: the review packet part, the voice and media part, and a few runtime facts. */
export function buildAgentWorkspaceDocumentOpsPart(context: CommandContext, reads?: AgentWorkspaceReviewPacketReads): Pick<AgentWorkspaceRuntimeSnapshot,
  'modelDisplayName' | 'provider' | 'artifactMaxBytes' | 'sessionId' | 'knowledgeRoute' | 'knowledgeIsolation'
  | 'mediaProviderCount' | 'mediaGenerationProviderCount' | 'voiceMediaReadiness' | 'reviewPacketTimeline' | 'reviewPacketWizard'> {
  const model = context.session?.runtime?.model ?? 'unknown';
  const reviewPacket = buildAgentWorkspaceReviewPacketPart(context, undefined, reads);
  const voiceMedia = buildAgentWorkspaceVoiceMediaPart(context);
  return {
    modelDisplayName: buildAgentWorkspaceCurrentModelSnapshot(context)?.displayName ?? model,
    provider: context.session?.runtime?.provider ?? 'unknown',
    artifactMaxBytes: buildAgentWorkspaceConfigSettingsSnapshot(context).artifactMaxBytes,
    sessionId: context.session?.runtime?.sessionId ?? 'unknown',
    knowledgeRoute: AGENT_KNOWLEDGE_ROUTE,
    knowledgeIsolation: AGENT_KNOWLEDGE_ISOLATION,
    mediaProviderCount: voiceMedia.mediaProviders.length,
    mediaGenerationProviderCount: voiceMedia.mediaProviders.filter((entry) => entry.capabilities.includes('generate')).length,
    voiceMediaReadiness: voiceMedia.voiceMediaReadiness,
    reviewPacketTimeline: reviewPacket.reviewPacketTimeline,
    reviewPacketWizard: reviewPacket.reviewPacketWizard,
  };
}

/** What a workspace editor opened by a model tool reads: starter templates, routines, the review packet part, calendar OAuth status. */
export function buildAgentWorkspaceEditorContextPart(context: CommandContext): Pick<AgentWorkspaceRuntimeSnapshot,
  'runtimeStarterTemplates' | 'localRoutines' | 'recentReviewerHandoffArtifacts' | 'reviewPacketDefaults' | 'calendarOAuthConfigStatus'> {
  const { runtimeStarterTemplates } = buildAgentWorkspaceRuntimeProfilesSnapshot(inferRuntimeProfileBaseHome(context.workspace?.shellPaths?.homeDirectory ?? ''));
  const reviewPacket = buildAgentWorkspaceReviewPacketPart(context);
  return {
    runtimeStarterTemplates: runtimeStarterTemplates.map(summarizeStarterTemplate),
    localRoutines: buildAgentWorkspaceRoutineCounters(context).items,
    recentReviewerHandoffArtifacts: reviewPacket.recentReviewerHandoffs.items,
    reviewPacketDefaults: reviewPacket.reviewPacketDefaults,
    calendarOAuthConfigStatus: buildAgentWorkspaceCalendarOAuthConfigStatus(context),
  };
}

/**
 * What the Personal Ops lanes read: channels, notes, and routines with their
 * schedule receipts. A lane read builds this part once; comparing it again
 * before publishing reads only these stores, not the whole workspace.
 */
export function buildAgentWorkspacePersonalOpsPart(context: CommandContext): Pick<AgentWorkspaceRuntimeSnapshot,
  'channels' | 'localNotes' | 'localNoteCount' | 'localNoteReviewQueueCount' | 'localRoutines' | 'localRoutineCount'
  | 'enabledRoutineCount' | 'routineScheduleReceiptCount' | 'failedRoutineScheduleReceiptCount' | 'latestRoutineScheduleReceipt'> {
  const notes = buildAgentWorkspaceNoteSnapshot(context);
  const routines = buildAgentWorkspaceRoutineCounters(context);
  const receipts = buildAgentWorkspaceRoutineScheduleReceiptsSnapshot(context);
  return {
    channels: buildAgentWorkspaceChannels(context),
    localNotes: notes.items,
    localNoteCount: notes.count,
    localNoteReviewQueueCount: notes.reviewQueueCount,
    localRoutines: routines.items,
    localRoutineCount: routines.count,
    enabledRoutineCount: routines.enabled,
    routineScheduleReceiptCount: receipts.count,
    failedRoutineScheduleReceiptCount: receipts.failed,
    latestRoutineScheduleReceipt: receipts.latest,
  };
}

/**
 * Assembles the full Agent workspace runtime snapshot. Composes the
 * sub-builders in agent-workspace-snapshot-builders.ts (split out of what
 * was previously one ~516-line function) plus the two live-counter builders
 * above, then maps everything onto the AgentWorkspaceRuntimeSnapshot shape.
 */
export function buildAgentWorkspaceRuntimeSnapshot(context: CommandContext): AgentWorkspaceRuntimeSnapshot {
  const readFailures: AgentWorkspaceReadFailures = new Map();
  const host = readConfigString(context, 'controlPlane.host', '127.0.0.1', readFailures);
  const port = readConfigNumber(context, 'controlPlane.port', 3421, readFailures);
  const model = context.session?.runtime?.model ?? 'unknown';
  const provider = context.session?.runtime?.provider ?? 'unknown';
  const currentModel = buildAgentWorkspaceCurrentModelSnapshot(context);
  const sessionMemoryCount = buildAgentWorkspaceSessionMemoryCount(context);
  const memorySnapshot = buildAgentWorkspaceMemorySnapshot(context, readFailures);
  const personaSnapshot = buildAgentWorkspacePersonaSnapshot(context, readFailures);
  const noteSnapshot = buildAgentWorkspaceNoteSnapshot(context, readFailures);
  const skillSnapshot = buildAgentWorkspaceSkillSnapshot(context, readFailures);
  const routineSnapshot = buildAgentWorkspaceRoutineCounters(context, readFailures);
  const routineScheduleReceipts = buildAgentWorkspaceRoutineScheduleReceiptsSnapshot(context, readFailures);
  const researchSourceSnapshot = buildAgentWorkspaceResearchSourceSnapshot(context, readFailures);
  const researchRunSnapshot = buildAgentWorkspaceResearchRunSnapshot(context, readFailures);
  const reviewPacket = buildAgentWorkspaceReviewPacketPart(context, readFailures);
  const { artifactListSnapshot, recentReviewerHandoffs, reviewPacketDefaults, reviewerBadge, reviewPacketTimeline, reviewPacketWizard } = reviewPacket;
  const setupSmokeHistory = buildSetupSmokeHistory(artifactListSnapshot.items, artifactListSnapshot.available);
  const discoveredBehavior = summarizeAgentBehaviorDiscovery(context.workspace?.shellPaths);
  const profileBaseHome = inferRuntimeProfileBaseHome(context.workspace?.shellPaths?.homeDirectory ?? '');
  const { runtimeProfiles, runtimeStarterTemplates, selectedRuntimeProfile, runtimeProfileRoot } = buildAgentWorkspaceRuntimeProfilesSnapshot(profileBaseHome);
  const { voiceProviders, mediaProviders, voiceMediaReadiness } = buildAgentWorkspaceVoiceMediaPart(context);
  const mcpSnapshot = buildAgentWorkspaceMcpServerSnapshot(context);
  const warnings: string[] = [];
  if (provider === 'unknown' || model === 'unknown') warnings.push('Provider/model unavailable in this runtime context.');
  if (!context.executeCommand) warnings.push('Command dispatch is unavailable; workspace actions will show guidance only.');
  const config = buildAgentWorkspaceConfigSettingsSnapshot(context, readFailures);
  const runtimeBaseUrl = connectedHostBaseUrl(host, port);
  const companionAccess = buildAgentWorkspaceCompanionAccessSnapshot(context, runtimeBaseUrl);
  const subscriptionSnapshot = buildAgentWorkspaceSubscriptionSnapshot(context);
  const channels = buildAgentWorkspaceChannels(context);
  const channelSetupGuide = buildAgentWorkspaceChannelSetupGuide(channels);
  const homeDirectory = context.workspace?.shellPaths?.homeDirectory;
  const nativeCredential = homeDirectory
    ? readConnectedHostOperatorToken(homeDirectory, runtimeBaseUrl)
    : { present: false, token: null, path: '(Agent home unavailable)', error: undefined };
  const setupChecklist = buildAgentWorkspaceSetupChecklist({
    provider,
    model,
    runtimeBaseUrl,
    connectedHostTokenPresent: nativeCredential.present,
    connectedHostTokenReadable: Boolean(nativeCredential.token),
    connectedHostTokenPath: nativeCredential.path,
    connectedHostTokenError: nativeCredential.error,
    agentHomeUnavailable: !homeDirectory,
    unreadableItemIds: UNREADABLE_CHECKLIST_ITEMS.filter(([storeId]) => readFailures.has(storeId)).map(([, itemId]) => itemId),
    activeSubscriptionCount: subscriptionSnapshot.active,
    pendingSubscriptionCount: subscriptionSnapshot.pending,
    availableSubscriptionProviderCount: subscriptionSnapshot.available,
    sessionMemoryCount,
    localMemoryCount: memorySnapshot.count,
    localMemoryReviewQueueCount: memorySnapshot.reviewQueueCount,
    localNoteCount: noteSnapshot.count,
    localNoteReviewQueueCount: noteSnapshot.reviewQueueCount,
    routineCount: routineSnapshot.count,
    enabledRoutineCount: routineSnapshot.enabled,
    missingRoutineRequirementCount: routineSnapshot.items.reduce((total, item) => total + (item.missingRequirementCount ?? 0), 0),
    skillCount: skillSnapshot.count,
    enabledSkillCount: skillSnapshot.enabled,
    skillBundleCount: skillSnapshot.bundleCount,
    enabledSkillBundleCount: skillSnapshot.enabledBundleCount,
    missingSkillRequirementCount: skillSnapshot.items.reduce((total, item) => total + (item.missingRequirementCount ?? 0), 0),
    activePersonaName: personaSnapshot.activeName,
    discoveredPersonas: discoveredBehavior.personas,
    discoveredSkills: discoveredBehavior.skills,
    discoveredRoutines: discoveredBehavior.routines,
    readyChannelCount: channels.filter((channel) => channel.ready).length,
    voiceProviderCount: voiceProviders.length,
    mediaProviderCount: mediaProviders.length,
    runtimeProfileCount: runtimeProfiles.length,
    runtimeStarterTemplateCount: runtimeStarterTemplates.length,
  });
  const setupWizard = buildWorkspaceSetupWizard(
    setupChecklist,
    setupSmokeHistory,
    buildSetupWizardCheckpoint(context),
    // Setup status comes from the checks this Agent runs itself; artifact
    // metadata and host read models are not setup evidence.
    setupCompletionMarkerExists(context),
  );
  warnings.push(...describeReadFailures(readFailures));
  const researchBrowserRunnerContract = buildResearchBrowserRunnerContract(context);
  const researchVisualReportContract = buildResearchVisualReportContract(researchSourceSnapshot);
  const vibe = buildVibeSummary(context);
  const projectContext = buildProjectContextSummary(context);
  const promptContextReceipts = buildPromptContextReceiptTimeline(context);
  const processSupervision = buildProcessSupervisionSummary(context);

  return {
    provider,
    model,
    modelDisplayName: currentModel?.displayName ?? model,
    embeddingProvider: config.embeddingProvider,
    reasoningEffort: config.reasoningEffort,
    helperEnabled: config.helperEnabled,
    toolLlmEnabled: config.toolLlmEnabled,
    providerFailureHints: config.providerFailureHints,
    cacheEnabled: config.cacheEnabled,
    cacheStableTtl: config.cacheStableTtl,
    cacheMonitorHitRate: config.cacheMonitorHitRate,
    cacheHitRateWarningThreshold: config.cacheHitRateWarningThreshold,
    hitlMode: config.hitlMode,
    guidanceMode: config.guidanceMode,
    saveHistory: config.saveHistory,
    autoApprove: config.autoApprove,
    autoCompactThreshold: config.autoCompactThreshold,
    staleContextWarnings: config.staleContextWarnings,
    showThinking: config.showThinking,
    showReasoningSummary: config.showReasoningSummary,
    theme: config.theme,
    stream: config.stream,
    lineNumbers: config.lineNumbers,
    operationalMessages: config.operationalMessages,
    systemMessages: config.systemMessages,
    permissionMode: config.permissionMode,
    toolAutoHeal: config.toolAutoHeal,
    toolsDefaultTokenBudget: config.toolsDefaultTokenBudget,
    artifactMaxBytes: config.artifactMaxBytes,
    rawPromptTelemetry: config.rawPromptTelemetry,
    automationEnabled: config.automationEnabled,
    automationMaxConcurrentRuns: config.automationMaxConcurrentRuns,
    automationRunHistoryLimit: config.automationRunHistoryLimit,
    automationDefaultTimeoutMs: config.automationDefaultTimeoutMs,
    automationCatchUpWindowMinutes: config.automationCatchUpWindowMinutes,
    automationFailureCooldownMs: config.automationFailureCooldownMs,
    automationDeleteAfterRun: config.automationDeleteAfterRun,
    sessionId: context.session?.runtime?.sessionId ?? 'unknown',
    workingDirectory: context.workspace?.shellPaths?.workingDirectory ?? 'unavailable',
    homeDirectory: context.workspace?.shellPaths?.homeDirectory ?? 'unavailable',
    runtimeBaseUrl,
    activeSubscriptionCount: subscriptionSnapshot.active,
    pendingSubscriptionCount: subscriptionSnapshot.pending,
    availableSubscriptionProviderCount: subscriptionSnapshot.available,
    sessionMemoryCount,
    localMemoryCount: memorySnapshot.count,
    localMemoryReviewQueueCount: memorySnapshot.reviewQueueCount,
    localMemoryPromptActiveCount: memorySnapshot.promptActiveCount,
    localMemoryTemporallyPendingCount: memorySnapshot.temporallyPendingCount,
    localMemoryTemporallyExpiredCount: memorySnapshot.temporallyExpiredCount,
    localMemories: memorySnapshot.items,
    localNoteCount: noteSnapshot.count,
    localNoteReviewQueueCount: noteSnapshot.reviewQueueCount,
    localNotes: noteSnapshot.items,
    researchSourceCount: researchSourceSnapshot.count,
    researchSourceCandidateCount: researchSourceSnapshot.candidate,
    researchSourceReviewedCount: researchSourceSnapshot.reviewed,
    researchSourceRejectedCount: researchSourceSnapshot.rejected,
    researchSourceUsedCount: researchSourceSnapshot.used,
    researchRunCount: researchRunSnapshot.count,
    researchRunPlannedCount: researchRunSnapshot.planned,
    researchRunRunningCount: researchRunSnapshot.running,
    researchRunPausedCount: researchRunSnapshot.paused,
    researchRunBlockedCount: researchRunSnapshot.blocked,
    researchRunTerminalCount: researchRunSnapshot.terminal,
    researchRuns: researchRunSnapshot.items,
    researchBrowserRunnerContract,
    researchVisualReportContract,
    vibe,
    projectContext,
    promptContextReceipts,
    processSupervision,
    recentReviewerHandoffArtifactCount: recentReviewerHandoffs.count,
    recentReviewerHandoffArtifacts: recentReviewerHandoffs.items,
    reviewerReadinessBadge: reviewerBadge,
    reviewPacketTimeline,
    reviewPacketDefaults,
    reviewPacketWizard,
    localRoutineCount: routineSnapshot.count,
    enabledRoutineCount: routineSnapshot.enabled,
    localRoutines: routineSnapshot.items,
    routineScheduleReceiptCount: routineScheduleReceipts.count,
    successfulRoutineScheduleReceiptCount: routineScheduleReceipts.successful,
    failedRoutineScheduleReceiptCount: routineScheduleReceipts.failed,
    latestRoutineScheduleReceipt: routineScheduleReceipts.latest,
    localSkillCount: skillSnapshot.count,
    enabledSkillCount: skillSnapshot.enabled,
    localSkillBundleCount: skillSnapshot.bundleCount,
    enabledSkillBundleCount: skillSnapshot.enabledBundleCount,
    activeSkillCount: skillSnapshot.active,
    localSkillBundles: skillSnapshot.bundleItems,
    localSkills: skillSnapshot.items,
    localPersonaCount: personaSnapshot.count,
    activePersonaName: personaSnapshot.activeName,
    localPersonas: personaSnapshot.items,
    discoveredBehavior,
    knowledgeRoute: AGENT_KNOWLEDGE_ROUTE,
    knowledgeIsolation: AGENT_KNOWLEDGE_ISOLATION,
    executionPolicy: 'serial-proactive',
    delegatedReviewPolicy: 'explicit-build-delegation-only',
    companionAccess,
    channels,
    channelSetupGuide,
    voiceProviderCount: voiceProviders.length,
    voiceStreamingProviderCount: voiceProviders.filter((entry) => entry.capabilities.includes('tts-stream')).length,
    voiceSttProviderCount: voiceProviders.filter((entry) => entry.capabilities.includes('stt')).length,
    voiceRealtimeProviderCount: voiceProviders.filter((entry) => entry.capabilities.includes('realtime')).length,
    ttsProvider: config.ttsProvider,
    ttsVoice: config.ttsVoice,
    ttsResponseModel: config.ttsLlmProvider && config.ttsLlmModel ? `${config.ttsLlmProvider}/${config.ttsLlmModel}` : '(chat route)',
    voiceSurfaceEnabled: config.voiceSurfaceEnabled,
    mediaProviderCount: mediaProviders.length,
    mediaUnderstandingProviderCount: mediaProviders.filter((entry) => entry.capabilities.includes('understand')).length,
    mediaGenerationProviderCount: mediaProviders.filter((entry) => entry.capabilities.includes('generate')).length,
    voiceMediaReadiness,
    mcpServerCount: mcpSnapshot.serverCount,
    mcpConnectedServerCount: mcpSnapshot.connectedCount,
    mcpQuarantinedServerCount: mcpSnapshot.quarantinedCount,
    mcpAllowAllServerCount: mcpSnapshot.allowAllCount,
    browserToolExposureEnabled: config.browserPwaEnabled,
    activeRuntimeProfile: inferActiveRuntimeProfile(context.workspace?.shellPaths?.homeDirectory ?? ''),
    selectedRuntimeProfile: selectedRuntimeProfile?.id ?? null,
    selectedRuntimeProfileExists: selectedRuntimeProfile?.exists ?? false,
    selectedRuntimeProfileSelectedAt: selectedRuntimeProfile?.selectedAt ?? null,
    runtimeProfileCount: runtimeProfiles.length,
    runtimeProfiles: runtimeProfiles.map(summarizeRuntimeProfile),
    runtimeProfileRoot,
    runtimeStarterTemplateCount: runtimeStarterTemplates.length,
    localStarterTemplateCount: runtimeStarterTemplates.filter((template) => template.source === 'local').length,
    runtimeStarterTemplates: runtimeStarterTemplates.map(summarizeStarterTemplate),
    setupChecklist,
    setupWizard,
    warnings,
    liveCountersStale: false,
    emailConnectStatus: buildAgentWorkspaceEmailConnectStatus(context),
    calendarOAuthConfigStatus: buildAgentWorkspaceCalendarOAuthConfigStatus(context),
  };
}
