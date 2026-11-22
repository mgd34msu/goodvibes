import { readConnectedHostOperatorToken } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-auth';
import type { CommandContext } from './command-registry.ts';
import { AgentRoutineRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/routine-registry';
import { memoryRecordTemporalStatus } from '@goodvibes/engine/platform/platform/state';
import { describeMemoryPromptEligibility, isPromptActiveMemory } from '@goodvibes/engine/terminal-shell/agent-turn/memory-prompt';
import { summarizeAgentBehaviorDiscovery } from '../agent/behavior-discovery-summary.ts';
import { agentRuntimeProfileName } from '../agent/runtime-profile.ts';
import { buildAgentWorkspaceChannels } from './agent-workspace-channels.ts';
import { buildAgentWorkspaceSetupChecklist } from './agent-workspace-setup.ts';
import { buildAgentWorkspaceVoiceMediaReadiness } from './agent-workspace-voice-media.ts';
import { buildPromptContextReceiptTimeline, buildVibeSummary } from './agent-workspace-context-snapshot.ts';
import { summarizeMemoryItem, summarizeRoutineItem } from './agent-workspace-local-library-snapshot.ts';
import { buildReviewPacketDefaults, buildReviewPacketTimeline, buildReviewPacketWizard, readDocumentDrafts } from './agent-workspace-review-packet-snapshot.ts';
import { buildSetupSmokeHistory, buildWorkspaceSetupWizard, setupCompletionMarkerExists } from './agent-workspace-setup-snapshot.ts';
import { readConfigBoolean, readConfigValue } from './agent-workspace-snapshot-config.ts';
import {
  buildAgentWorkspaceArtifactListSnapshot,
  buildAgentWorkspaceCompanionAccessSnapshot,
  buildAgentWorkspaceConfigSettingsSnapshot,
  buildAgentWorkspaceCurrentModelSnapshot,
  buildAgentWorkspaceMcpServerSnapshot,
  buildAgentWorkspaceNoteSnapshot,
  buildAgentWorkspacePersonaSnapshot,
  buildAgentWorkspaceRecentReviewerHandoffsSnapshot,
  buildAgentWorkspaceResearchRunSnapshot,
  buildAgentWorkspaceRoutineScheduleReceiptsSnapshot,
  buildAgentWorkspaceRuntimeProfilesSnapshot,
  buildAgentWorkspaceSessionMemoryCount,
  buildAgentWorkspaceSkillSnapshot,
  buildAgentWorkspaceSubscriptionSnapshot,
  buildAgentWorkspaceVoiceMediaProvidersSnapshot,
  buildAgentWorkspaceArtifactResolver,
  type AgentWorkspaceReadFailures,
} from './agent-workspace-snapshot-builders.ts';
import type { AgentWorkspaceLocalLibraryItem, AgentWorkspaceRuntimeSnapshot, AgentWorkspaceSetupPart } from './agent-workspace-types.ts';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';

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

/** The profile this session runs in: a profile home is one the profile module's own path rule recognises. */
function activeRuntimeProfileName(homeDirectory: string): string {
  return agentRuntimeProfileName(homeDirectory) ?? '(default home)';
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
 * buildAgentWorkspaceMemorySnapshot instead.
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
    reviewPacketTimeline: buildReviewPacketTimeline(documentDrafts, artifactListSnapshot.items, artifactListSnapshot.available, artifactListInfo),
    reviewPacketWizard: buildReviewPacketWizard(documentDrafts, artifactListSnapshot.available, reviewPacketDefaults, artifactListInfo),
  };
}

/** The voice and media part: provider descriptors and their readiness. */
export function buildAgentWorkspaceVoiceMediaPart(context: CommandContext) {
  const { voiceProviders, mediaProviders } = buildAgentWorkspaceVoiceMediaProvidersSnapshot(context);
  return { voiceProviders, mediaProviders, voiceMediaReadiness: voiceMediaReadinessOf(context, voiceProviders, mediaProviders) };
}

type VoiceMediaProviders = ReturnType<typeof buildAgentWorkspaceVoiceMediaProvidersSnapshot>;

function voiceMediaReadinessOf(context: CommandContext, voiceProviders: VoiceMediaProviders['voiceProviders'], mediaProviders: VoiceMediaProviders['mediaProviders']) {
  const describe = (provider: { readonly id: string; readonly label: string; readonly capabilities: readonly string[] }) => ({ id: provider.id, label: provider.label, capabilities: provider.capabilities });
  return buildAgentWorkspaceVoiceMediaReadiness({ context, voiceProviders: voiceProviders.map(describe), mediaProviders: mediaProviders.map(describe) });
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
 * What the setup checklist is computed from: the stores and runtime facts it
 * counts. Read once; the setup part, the briefing part and the full snapshot
 * each build from one reading.
 */
function readAgentWorkspaceSetupInputs(context: CommandContext, readFailures: AgentWorkspaceReadFailures) {
  const runtimeBaseUrl = resolveConnectedHostAddress({ get: (key) => readConfigValue(context, key, readFailures) }).baseUrl;
  const homeDirectory = context.workspace?.shellPaths?.homeDirectory;
  // The profile functions resolve the base home themselves, from inside a profile session too.
  const { runtimeProfiles, runtimeStarterTemplates } = buildAgentWorkspaceRuntimeProfilesSnapshot(homeDirectory ?? '');
  return {
    model: context.session?.runtime?.model ?? 'unknown',
    provider: context.session?.runtime?.provider ?? 'unknown',
    runtimeBaseUrl,
    homeDirectory,
    nativeCredential: homeDirectory
      ? readConnectedHostOperatorToken(homeDirectory, runtimeBaseUrl)
      : { present: false, token: null, path: '(Agent home unavailable)', error: undefined },
    sessionMemoryCount: buildAgentWorkspaceSessionMemoryCount(context),
    memorySnapshot: buildAgentWorkspaceMemorySnapshot(context, readFailures),
    personaSnapshot: buildAgentWorkspacePersonaSnapshot(context, readFailures),
    noteSnapshot: buildAgentWorkspaceNoteSnapshot(context, readFailures),
    skillSnapshot: buildAgentWorkspaceSkillSnapshot(context, readFailures),
    routineSnapshot: buildAgentWorkspaceRoutineCounters(context, readFailures),
    subscriptionSnapshot: buildAgentWorkspaceSubscriptionSnapshot(context),
    channels: buildAgentWorkspaceChannels(context),
    discoveredBehavior: summarizeAgentBehaviorDiscovery(context.workspace?.shellPaths),
    runtimeProfiles,
    runtimeStarterTemplates,
    ...buildAgentWorkspaceVoiceMediaProvidersSnapshot(context),
  };
}

type AgentWorkspaceSetupInputs = ReturnType<typeof readAgentWorkspaceSetupInputs>;

/** The setup checklist and the setup wizard built on it, from one reading of their inputs. */
function buildAgentWorkspaceSetupFromInputs(context: CommandContext, inputs: AgentWorkspaceSetupInputs, readFailures: AgentWorkspaceReadFailures): AgentWorkspaceSetupPart {
  const {
    provider, model, runtimeBaseUrl, homeDirectory, nativeCredential, sessionMemoryCount, memorySnapshot, personaSnapshot, noteSnapshot,
    skillSnapshot, routineSnapshot, subscriptionSnapshot, channels, discoveredBehavior, runtimeProfiles, runtimeStarterTemplates,
    voiceProviders, mediaProviders,
  } = inputs;
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
    buildSetupSmokeHistory(context),
    // Setup status comes from the checks this Agent runs itself; artifact
    // metadata and host read models are not setup evidence.
    setupCompletionMarkerExists(context),
  );
  return { setupChecklist, setupWizard };
}

/**
 * The setup part: what the Agent workspace reads when it opens and on each
 * refresh (the setup steps and the onboarding route). It reads only the stores
 * the checklist counts, not the review packet, research runs, schedule
 * receipts, settings or prompt receipts the full snapshot also carries.
 */
export function buildAgentWorkspaceSetupPart(context: CommandContext): AgentWorkspaceSetupPart {
  const readFailures: AgentWorkspaceReadFailures = new Map();
  return buildAgentWorkspaceSetupFromInputs(context, readAgentWorkspaceSetupInputs(context, readFailures), readFailures);
}

function runtimeWarnings(context: CommandContext, provider: string, model: string): string[] {
  const warnings: string[] = [];
  if (provider === 'unknown' || model === 'unknown') warnings.push('Provider/model unavailable in this runtime context.');
  if (!context.executeCommand) warnings.push('Command dispatch is unavailable; workspace actions will show guidance only.');
  return warnings;
}

/** What `/brief` reads: the setup part, the local libraries it counts, voice and media readiness and this device's pairing. */
export type AgentWorkspaceBriefPart = Pick<AgentWorkspaceRuntimeSnapshot,
  | 'provider' | 'model' | 'modelDisplayName' | 'sessionId' | 'activeRuntimeProfile' | 'executionPolicy' | 'delegatedReviewPolicy'
  | 'knowledgeRoute' | 'knowledgeIsolation' | 'setupChecklist' | 'channels' | 'localSkills' | 'localSkillBundles' | 'localRoutines'
  | 'localSkillCount' | 'localSkillBundleCount' | 'enabledSkillCount' | 'enabledSkillBundleCount' | 'activeSkillCount'
  | 'localRoutineCount' | 'enabledRoutineCount' | 'localMemoryCount' | 'localMemoryPromptActiveCount' | 'localMemoryReviewQueueCount'
  | 'localNoteCount' | 'localNoteReviewQueueCount' | 'localPersonaCount' | 'activePersonaName'
  | 'voiceSurfaceEnabled' | 'voiceProviderCount' | 'mediaProviderCount' | 'voiceMediaReadiness' | 'companionAccess' | 'warnings'>;

/** Builds only what `/brief` reads, when it runs. */
export function buildAgentWorkspaceBriefPart(context: CommandContext): AgentWorkspaceBriefPart {
  const readFailures: AgentWorkspaceReadFailures = new Map();
  const inputs = readAgentWorkspaceSetupInputs(context, readFailures);
  const { setupChecklist } = buildAgentWorkspaceSetupFromInputs(context, inputs, readFailures);
  const { provider, model, memorySnapshot, noteSnapshot, skillSnapshot, routineSnapshot, personaSnapshot, voiceProviders, mediaProviders } = inputs;
  const voiceSurfaceEnabled = readConfigBoolean(context, 'ui.voiceEnabled', false, readFailures);
  const warnings = runtimeWarnings(context, provider, model);
  warnings.push(...describeReadFailures(readFailures));
  return {
    provider,
    model,
    modelDisplayName: buildAgentWorkspaceCurrentModelSnapshot(context)?.displayName ?? model,
    sessionId: context.session?.runtime?.sessionId ?? 'unknown',
    activeRuntimeProfile: activeRuntimeProfileName(inputs.homeDirectory ?? ''),
    executionPolicy: 'serial-proactive',
    delegatedReviewPolicy: 'explicit-build-delegation-only',
    knowledgeRoute: AGENT_KNOWLEDGE_ROUTE,
    knowledgeIsolation: AGENT_KNOWLEDGE_ISOLATION,
    setupChecklist,
    channels: inputs.channels,
    localSkills: skillSnapshot.items,
    localSkillBundles: skillSnapshot.bundleItems,
    localRoutines: routineSnapshot.items,
    localSkillCount: skillSnapshot.count,
    localSkillBundleCount: skillSnapshot.bundleCount,
    enabledSkillCount: skillSnapshot.enabled,
    enabledSkillBundleCount: skillSnapshot.enabledBundleCount,
    activeSkillCount: skillSnapshot.active,
    localRoutineCount: routineSnapshot.count,
    enabledRoutineCount: routineSnapshot.enabled,
    localMemoryCount: memorySnapshot.count,
    localMemoryPromptActiveCount: memorySnapshot.promptActiveCount,
    localMemoryReviewQueueCount: memorySnapshot.reviewQueueCount,
    localNoteCount: noteSnapshot.count,
    localNoteReviewQueueCount: noteSnapshot.reviewQueueCount,
    localPersonaCount: personaSnapshot.count,
    activePersonaName: personaSnapshot.activeName,
    voiceSurfaceEnabled,
    voiceProviderCount: voiceProviders.length,
    mediaProviderCount: mediaProviders.length,
    voiceMediaReadiness: voiceMediaReadinessOf(context, voiceProviders, mediaProviders),
    companionAccess: buildAgentWorkspaceCompanionAccessSnapshot(context, inputs.runtimeBaseUrl),
    warnings,
  };
}

/**
 * Assembles the full Agent workspace runtime snapshot. Composes the
 * sub-builders in agent-workspace-snapshot-builders.ts (split out of what
 * was previously one ~516-line function) plus the two live-counter builders
 * above, then maps everything onto the AgentWorkspaceRuntimeSnapshot shape.
 * The workspace itself builds only the setup part, and `/brief` its own part.
 */
export function buildAgentWorkspaceRuntimeSnapshot(context: CommandContext): AgentWorkspaceRuntimeSnapshot {
  const readFailures: AgentWorkspaceReadFailures = new Map();
  const inputs = readAgentWorkspaceSetupInputs(context, readFailures);
  const {
    provider, model, runtimeBaseUrl, sessionMemoryCount, memorySnapshot, personaSnapshot, noteSnapshot, skillSnapshot, routineSnapshot,
    subscriptionSnapshot, channels, runtimeProfiles, runtimeStarterTemplates, voiceProviders, mediaProviders,
  } = inputs;
  const { setupChecklist, setupWizard } = buildAgentWorkspaceSetupFromInputs(context, inputs, readFailures);
  const currentModel = buildAgentWorkspaceCurrentModelSnapshot(context);
  const routineScheduleReceipts = buildAgentWorkspaceRoutineScheduleReceiptsSnapshot(context, readFailures);
  const researchRunSnapshot = buildAgentWorkspaceResearchRunSnapshot(context, readFailures);
  const { reviewPacketTimeline, reviewPacketWizard } = buildAgentWorkspaceReviewPacketPart(context, readFailures);
  const voiceMediaReadiness = voiceMediaReadinessOf(context, voiceProviders, mediaProviders);
  const mcpSnapshot = buildAgentWorkspaceMcpServerSnapshot(context);
  const warnings = runtimeWarnings(context, provider, model);
  const config = buildAgentWorkspaceConfigSettingsSnapshot(context, readFailures);
  const companionAccess = buildAgentWorkspaceCompanionAccessSnapshot(context, runtimeBaseUrl);
  warnings.push(...describeReadFailures(readFailures));
  const vibe = buildVibeSummary(context);
  const promptContextReceipts = buildPromptContextReceiptTimeline(context);

  return {
    provider,
    model,
    modelDisplayName: currentModel?.displayName ?? model,
    embeddingProvider: config.embeddingProvider,
    reasoningEffort: config.reasoningEffort,
    helperEnabled: config.helperEnabled,
    toolLlmEnabled: config.toolLlmEnabled,
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
    artifactMaxBytes: config.artifactMaxBytes,
    rawPromptTelemetry: config.rawPromptTelemetry,
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
    localNoteCount: noteSnapshot.count,
    localNoteReviewQueueCount: noteSnapshot.reviewQueueCount,
    localNotes: noteSnapshot.items,
    researchRunCount: researchRunSnapshot.count,
    researchRunPlannedCount: researchRunSnapshot.planned,
    researchRunRunningCount: researchRunSnapshot.running,
    researchRunPausedCount: researchRunSnapshot.paused,
    researchRunBlockedCount: researchRunSnapshot.blocked,
    researchRuns: researchRunSnapshot.items,
    vibe,
    promptContextReceipts,
    reviewPacketTimeline,
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
    knowledgeRoute: AGENT_KNOWLEDGE_ROUTE,
    knowledgeIsolation: AGENT_KNOWLEDGE_ISOLATION,
    executionPolicy: 'serial-proactive',
    delegatedReviewPolicy: 'explicit-build-delegation-only',
    companionAccess,
    channels,
    voiceProviderCount: voiceProviders.length,
    voiceSurfaceEnabled: config.voiceSurfaceEnabled,
    mediaProviderCount: mediaProviders.length,
    mediaGenerationProviderCount: mediaProviders.filter((entry) => entry.capabilities.includes('generate')).length,
    voiceMediaReadiness,
    mcpQuarantinedServerCount: mcpSnapshot.quarantinedCount,
    mcpAllowAllServerCount: mcpSnapshot.allowAllCount,
    browserToolExposureEnabled: config.browserPwaEnabled,
    activeRuntimeProfile: activeRuntimeProfileName(context.workspace?.shellPaths?.homeDirectory ?? ''),
    runtimeProfileCount: runtimeProfiles.length,
    runtimeStarterTemplateCount: runtimeStarterTemplates.length,
    setupChecklist,
    setupWizard,
    warnings,
  };
}
