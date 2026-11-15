import { readExecutionMode } from '../permissions/execution-mode.ts';
// Sub-builders extracted out of the single ~516-line `buildAgentWorkspaceRuntimeSnapshot`
// function in agent-workspace-snapshot.ts (per the design ruling's
// giant-single-function-assembler verdict: "splitting into cohesive sub-builders...
// would reduce single-function size without changing behavior"). Each function here
// is the verbatim body of one of that function's local IIFEs or local variable blocks,
// moved unchanged so the top-level snapshot builder now composes named sub-builders
// instead of assembling everything inline. No behavior changes: same context reads,
// same try/catch fallbacks, same field shapes.
import { listAvailableSubscriptionProviders } from '@goodvibes-jev/engine/platform/platform/config';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { CommandContext } from './command-registry.ts';
import { AgentNoteRegistry } from '../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentResearchRunRegistry } from '../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry } from '../agent/research-source-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { RoutineScheduleReceiptStore } from '../agent/routine-schedule-receipts.ts';
import {
  getAgentRuntimeProfilesRoot,
  listAgentRuntimeProfiles,
  listAgentRuntimeProfileTemplates,
  readAgentRuntimeProfileSelection,
} from '../agent/runtime-profile.ts';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../config/surface.ts';
import { readConnectedHostOperatorToken, type ConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { summarizePersonaItem, summarizeNoteItem, summarizeResearchRunItem, summarizeRoutineScheduleReceipt, summarizeSkillBundleItem, summarizeSkillItem } from './agent-workspace-local-library-snapshot.ts';
import { isReviewerHandoffArtifact, summarizeReviewerHandoffArtifact } from './agent-workspace-review-packet-utils.ts';
import { readMailboxStatus } from './commands/email-settings.ts';
import { CALENDAR_OAUTH_CLIENT_ID_KEYS } from '../agent/calendar/calendar-oauth-service.ts';
import { readConfigBoolean, readConfigNumber, readConfigString } from './agent-workspace-snapshot-config.ts';
import type { AgentWorkspaceCalendarOAuthConfigStatus } from './agent-workspace-calendar-oauth-editor.ts';
import type { AgentWorkspaceEmailConnectStatus } from './agent-workspace-types.ts';

/**
 * Store ids whose read failed, with the reason. A snapshot builder that cannot
 * read its store reports it here instead of passing off an empty default as the
 * real contents, so the workspace can say "unreadable" rather than "none yet".
 */
export type AgentWorkspaceReadFailures = Map<string, string>;

function recordReadFailure(failures: AgentWorkspaceReadFailures | undefined, id: string, error: unknown): void {
  failures?.set(id, error instanceof Error ? error.message : String(error));
}

export function buildAgentWorkspaceCurrentModelSnapshot(context: CommandContext): ReturnType<NonNullable<NonNullable<CommandContext['provider']>['providerRegistry']>['getCurrentModel']> | null | undefined {
  try {
    return context.provider?.providerRegistry?.getCurrentModel?.();
  } catch {
    return null;
  }
}

export function buildAgentWorkspaceSessionMemoryCount(context: CommandContext): number {
  try {
    return context.session?.sessionMemoryStore?.list?.().length ?? 0;
  } catch {
    return 0;
  }
}

export function buildAgentWorkspacePersonaSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures) {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { count: 0, activeName: '(none)', items: [] };
    const snapshot = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot();
    return {
      count: snapshot.personas.length,
      activeName: snapshot.activePersona?.name ?? '(none)',
      items: snapshot.personas.map((persona) => summarizePersonaItem(persona, snapshot.activePersonaId)),
    };
  } catch (error) {
    recordReadFailure(failures, 'personas', error);
    return { count: 0, activeName: '(unavailable)', items: [] };
  }
}

export function buildAgentWorkspaceNoteSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures) {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { count: 0, reviewQueueCount: 0, items: [] };
    const snapshot = AgentNoteRegistry.fromShellPaths(shellPaths).snapshot();
    return {
      count: snapshot.notes.length,
      reviewQueueCount: snapshot.reviewQueue.length,
      items: snapshot.notes.map(summarizeNoteItem),
    };
  } catch (error) {
    recordReadFailure(failures, 'notes', error);
    return { count: 0, reviewQueueCount: 0, items: [] };
  }
}

export function buildAgentWorkspaceSkillSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures) {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { count: 0, enabled: 0, active: 0, bundleCount: 0, enabledBundleCount: 0, items: [], bundleItems: [] };
    const snapshot = AgentSkillRegistry.fromShellPaths(shellPaths).snapshot();
    return {
      count: snapshot.skills.length,
      enabled: snapshot.enabledSkills.length,
      active: snapshot.activeSkills.length,
      bundleCount: snapshot.bundles.length,
      enabledBundleCount: snapshot.enabledBundles.length,
      items: snapshot.skills.map(summarizeSkillItem),
      bundleItems: snapshot.bundles.map((bundle) => summarizeSkillBundleItem(bundle, snapshot.skills)),
    };
  } catch (error) {
    recordReadFailure(failures, 'skills', error);
    return { count: 0, enabled: 0, active: 0, bundleCount: 0, enabledBundleCount: 0, items: [], bundleItems: [] };
  }
}

export function buildAgentWorkspaceRoutineScheduleReceiptsSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures) {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { count: 0, successful: 0, failed: 0, latest: null };
    const receipts = RoutineScheduleReceiptStore.fromShellPaths(shellPaths).snapshot().receipts;
    return {
      count: receipts.length,
      successful: receipts.filter((receipt) => receipt.status === 'created').length,
      failed: receipts.filter((receipt) => receipt.status === 'failed').length,
      latest: receipts[0] ? summarizeRoutineScheduleReceipt(receipts[0]) : null,
    };
  } catch (error) {
    recordReadFailure(failures, 'routine-receipts', error);
    return { count: 0, successful: 0, failed: 0, latest: null };
  }
}

export function buildAgentWorkspaceResearchSourceSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures) {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { count: 0, candidate: 0, reviewed: 0, rejected: 0, used: 0 };
    const snapshot = AgentResearchSourceRegistry.fromShellPaths(shellPaths).snapshot();
    return {
      count: snapshot.sources.length,
      candidate: snapshot.candidates.length,
      reviewed: snapshot.reviewed.length,
      rejected: snapshot.rejected.length,
      used: snapshot.used.length,
    };
  } catch (error) {
    recordReadFailure(failures, 'research-sources', error);
    return { count: 0, candidate: 0, reviewed: 0, rejected: 0, used: 0 };
  }
}

export function buildAgentWorkspaceResearchRunSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures) {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { count: 0, planned: 0, running: 0, paused: 0, blocked: 0, terminal: 0, items: [] };
    const snapshot = AgentResearchRunRegistry.fromShellPaths(shellPaths).snapshot();
    const actionable = [
      ...snapshot.blocked,
      ...snapshot.running,
      ...snapshot.paused,
      ...snapshot.planned,
      ...snapshot.failed,
      ...snapshot.completed,
      ...snapshot.cancelled,
    ];
    return {
      count: snapshot.runs.length,
      planned: snapshot.planned.length,
      running: snapshot.running.length,
      paused: snapshot.paused.length,
      blocked: snapshot.blocked.length,
      terminal: snapshot.cancelled.length + snapshot.completed.length + snapshot.failed.length,
      items: actionable.slice(0, 8).map(summarizeResearchRunItem),
    };
  } catch (error) {
    recordReadFailure(failures, 'research-runs', error);
    return { count: 0, planned: 0, running: 0, paused: 0, blocked: 0, terminal: 0, items: [] };
  }
}

/** The artifact list is a window onto the newest artifacts, not the whole store. */
export const AGENT_WORKSPACE_ARTIFACT_LIST_LIMIT = 100;

export function buildAgentWorkspaceArtifactListSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures) {
  try {
    const store = context.platform?.artifactStore;
    const list = store?.list;
    const items = [...(list?.call(store, AGENT_WORKSPACE_ARTIFACT_LIST_LIMIT) ?? [])];
    return {
      available: Boolean(list),
      items,
      // A full page means older artifacts may exist that this snapshot never saw.
      truncated: items.length >= AGENT_WORKSPACE_ARTIFACT_LIST_LIMIT,
    };
  } catch (error) {
    recordReadFailure(failures, 'artifacts', error);
    return { available: false, items: [], truncated: false };
  }
}

/** Looks one artifact up by id, so a reference older than the list window is not reported missing. */
export function buildAgentWorkspaceArtifactResolver(context: CommandContext): (artifactId: string) => ArtifactDescriptor | null {
  return (artifactId) => {
    try {
      return context.platform?.artifactStore?.get?.(artifactId) ?? null;
    } catch {
      return null;
    }
  };
}

export function buildAgentWorkspaceRecentReviewerHandoffsSnapshot(artifactItems: ReturnType<typeof buildAgentWorkspaceArtifactListSnapshot>['items']) {
  try {
    const handoffs = artifactItems
      .filter(isReviewerHandoffArtifact)
      .sort((left, right) => right.createdAt - left.createdAt);
    return {
      count: handoffs.length,
      items: handoffs.slice(0, 6).map(summarizeReviewerHandoffArtifact),
    };
  } catch {
    return { count: 0, items: [] };
  }
}

export function buildAgentWorkspaceRuntimeProfilesSnapshot(profileBaseHome: string) {
  const runtimeProfiles = (() => {
    try {
      return listAgentRuntimeProfiles(profileBaseHome);
    } catch {
      return [];
    }
  })();
  const runtimeStarterTemplates = (() => {
    try {
      return listAgentRuntimeProfileTemplates(profileBaseHome);
    } catch {
      return [];
    }
  })();
  const selectedRuntimeProfile = (() => {
    try {
      return readAgentRuntimeProfileSelection(profileBaseHome);
    } catch {
      return null;
    }
  })();
  return { runtimeProfiles, runtimeStarterTemplates, selectedRuntimeProfile, runtimeProfileRoot: getAgentRuntimeProfilesRoot(profileBaseHome) };
}

export function buildAgentWorkspaceVoiceMediaProvidersSnapshot(context: CommandContext) {
  const voiceProviders = (() => {
    try {
      return context.platform?.voiceProviderRegistry?.list?.() ?? [];
    } catch {
      return [];
    }
  })();
  const mediaProviders = (() => {
    try {
      return context.platform?.mediaProviderRegistry?.list?.() ?? [];
    } catch {
      return [];
    }
  })();
  return { voiceProviders, mediaProviders };
}

export function buildAgentWorkspaceMcpServerSnapshot(context: CommandContext) {
  try {
    const servers = context.clients?.mcpApi?.listServerSecurity?.() ?? context.extensions?.mcpRegistry?.listServerSecurity?.() ?? [];
    return {
      serverCount: servers.length,
      connectedCount: servers.filter((server) => server.connected).length,
      quarantinedCount: servers.filter((server) => server.schemaFreshness === 'quarantined').length,
      allowAllCount: servers.filter((server) => server.trustMode === 'allow-all').length,
    };
  } catch {
    return {
      serverCount: 0,
      connectedCount: 0,
      quarantinedCount: 0,
      allowAllCount: 0,
    };
  }
}

export function buildAgentWorkspaceCompanionAccessSnapshot(context: CommandContext, runtimeBaseUrl: string) {
  const homeDirectory = context.workspace?.shellPaths?.homeDirectory ?? '';
  const tokenRecord: Pick<ConnectedHostOperatorToken, 'path' | 'present' | 'token' | 'error'> = homeDirectory.length > 0
    ? readConnectedHostOperatorToken(homeDirectory)
    : { path: '(Agent home unavailable)', present: false, token: null };
  const pairingReady = Boolean(tokenRecord.token);
  const nextStep = tokenRecord.error
    ? 'Repair the connected-host operator token file through the owning GoodVibes host, then rerun /pair.'
    : pairingReady
      ? 'Use /pair to scan the QR code. Manual token display stays hidden unless /pair --show-token --yes is used.'
      : 'Pair or provision connected-host access through the owning GoodVibes host, then rerun /pair.';
  return {
    surface: GOODVIBES_AGENT_PAIRING_SURFACE,
    hostUrl: runtimeBaseUrl,
    tokenPath: tokenRecord.path,
    tokenPresent: tokenRecord.present,
    tokenReadable: Boolean(tokenRecord.token),
    tokenError: tokenRecord.error ?? null,
    pairingReady,
    qrCommand: '/pair',
    manualTokenCommand: '/pair --show-token --yes',
    nextStep,
  } as const;
}

/**
 * Honest email-connect status for the inbox connect wizard's entry state
 *, config validation only, no network I/O. Best-effort: never
 * throws, returns null on any read failure.
 */
export function buildAgentWorkspaceEmailConnectStatus(context: CommandContext): AgentWorkspaceEmailConnectStatus | null {
  try {
    const cm = context.platform.configManager as unknown as { get: (key: string) => unknown };
    const status = readMailboxStatus((key) => cm.get(key));
    return {
      connected: status.ready,
      username: status.settings.username ?? '',
      imapHost: status.settings.imapHost ?? '',
      errors: [...status.problems],
    };
  } catch {
    return null;
  }
}

/**
 * Honest calendar-OAuth build state per provider for the advanced connect
 * cards (F1c), config read only, no network I/O. "Configured" means a
 * config-override client id has been stored (through this same card);
 * "not configured" means the build still ships only the bundled platform
 * placeholder client id, the state in which a bare /calendar connect always
 * fails at the config stage. Best-effort: never throws, returns null on any
 * read failure.
 */
export function buildAgentWorkspaceCalendarOAuthConfigStatus(context: CommandContext): AgentWorkspaceCalendarOAuthConfigStatus | null {
  try {
    const cm = context.platform.configManager as unknown as { get: (key: string) => unknown };
    const hasClientId = (key: string): boolean => {
      let value: unknown;
      try {
        value = cm.get(key);
      } catch {
        return false;
      }
      return typeof value === 'string' && value.trim().length > 0;
    };
    return {
      google: hasClientId(CALENDAR_OAUTH_CLIENT_ID_KEYS.google),
      microsoft: hasClientId(CALENDAR_OAUTH_CLIENT_ID_KEYS.microsoft),
    };
  } catch {
    return null;
  }
}

export function buildAgentWorkspaceSubscriptionSnapshot(context: CommandContext) {
  try {
    const manager = context.platform?.subscriptionManager;
    const services = context.platform?.serviceRegistry;
    const active = manager?.list?.().length ?? 0;
    const pending = manager?.listPending?.().length ?? 0;
    const available = services ? listAvailableSubscriptionProviders(services.getAll()).length : 0;
    return { active, pending, available };
  } catch {
    return { active: 0, pending: 0, available: 0 };
  }
}

export interface AgentWorkspaceConfigSettingsSnapshot {
  readonly ttsProvider: string;
  readonly ttsVoice: string;
  readonly ttsLlmProvider: string;
  readonly ttsLlmModel: string;
  readonly embeddingProvider: string;
  readonly reasoningEffort: string;
  readonly helperEnabled: boolean;
  readonly toolLlmEnabled: boolean;
  readonly providerFailureHints: boolean;
  readonly cacheEnabled: boolean;
  readonly cacheStableTtl: string;
  readonly cacheMonitorHitRate: boolean;
  readonly cacheHitRateWarningThreshold: number;
  readonly hitlMode: string;
  readonly guidanceMode: string;
  readonly saveHistory: boolean;
  readonly autoApprove: boolean;
  readonly autoCompactThreshold: number;
  readonly staleContextWarnings: boolean;
  readonly showThinking: boolean;
  readonly showReasoningSummary: boolean;
  readonly theme: string;
  readonly stream: boolean;
  readonly lineNumbers: string;
  readonly operationalMessages: string;
  readonly systemMessages: string;
  readonly permissionMode: string;
  readonly toolAutoHeal: boolean;
  readonly toolsDefaultTokenBudget: number;
  readonly artifactMaxBytes: number;
  readonly rawPromptTelemetry: boolean;
  readonly automationEnabled: boolean;
  readonly automationMaxConcurrentRuns: number;
  readonly automationRunHistoryLimit: number;
  readonly automationDefaultTimeoutMs: number;
  readonly automationCatchUpWindowMinutes: number;
  readonly automationFailureCooldownMs: number;
  readonly automationDeleteAfterRun: boolean;
  readonly browserPwaEnabled: boolean;
  readonly browserPwaPublicBaseUrl: string;
  readonly voiceSurfaceEnabled: boolean;
}

function readPermissionMode(context: CommandContext, failures: AgentWorkspaceReadFailures | undefined): string {
  try {
    return (context.platform?.configManager ? readExecutionMode(context.platform.configManager) : undefined) ?? 'unavailable';
  } catch (error) {
    recordReadFailure(failures, 'config:permissions.mode', error);
    return 'unavailable';
  }
}

/** The flat sequence of config reads driving most of the runtime snapshot's settings fields. */
export function buildAgentWorkspaceConfigSettingsSnapshot(context: CommandContext, failures?: AgentWorkspaceReadFailures): AgentWorkspaceConfigSettingsSnapshot {
  const str = (key: string, fallback: string) => readConfigString(context, key, fallback, failures);
  const num = (key: string, fallback: number) => readConfigNumber(context, key, fallback, failures);
  const bool = (key: string, fallback: boolean) => readConfigBoolean(context, key, fallback, failures);
  return {
    ttsProvider: str('tts.provider', '(provider default)'),
    ttsVoice: str('tts.voice', '(voice default)'),
    ttsLlmProvider: str('tts.llmProvider', ''),
    ttsLlmModel: str('tts.llmModel', ''),
    embeddingProvider: str('provider.embeddingProvider', '(provider default)'),
    reasoningEffort: str('provider.reasoningEffort', '(default)'),
    helperEnabled: bool('helper.enabled', false),
    toolLlmEnabled: bool('tools.llmEnabled', false),
    providerFailureHints: bool('behavior.suggestAlternativeOnProviderFail', false),
    cacheEnabled: bool('cache.enabled', true),
    cacheStableTtl: str('cache.stableTtl', '(default)'),
    cacheMonitorHitRate: bool('cache.monitorHitRate', true),
    cacheHitRateWarningThreshold: num('cache.hitRateWarningThreshold', 0.3),
    hitlMode: str('behavior.hitlMode', '(default)'),
    guidanceMode: str('behavior.guidanceMode', '(default)'),
    saveHistory: bool('behavior.saveHistory', true),
    autoApprove: bool('behavior.autoApprove', false),
    autoCompactThreshold: num('behavior.autoCompactThreshold', 0),
    staleContextWarnings: bool('behavior.staleContextWarnings', false),
    showThinking: bool('display.showThinking', false),
    showReasoningSummary: bool('display.showReasoningSummary', false),
    theme: str('display.theme', '(default)'),
    stream: bool('display.stream', true),
    lineNumbers: str('display.lineNumbers', '(default)'),
    operationalMessages: str('ui.operationalMessages', '(default)'),
    systemMessages: str('ui.systemMessages', '(default)'),
    permissionMode: readPermissionMode(context, failures),
    toolAutoHeal: bool('tools.autoHeal', false),
    toolsDefaultTokenBudget: num('tools.defaultTokenBudget', 0),
    artifactMaxBytes: num('storage.artifacts.maxBytes', 512 * 1024 * 1024),
    rawPromptTelemetry: bool('telemetry.includeRawPrompts', false),
    automationEnabled: bool('automation.enabled', false),
    automationMaxConcurrentRuns: num('automation.maxConcurrentRuns', 4),
    automationRunHistoryLimit: num('automation.runHistoryLimit', 100),
    automationDefaultTimeoutMs: num('automation.defaultTimeoutMs', 15 * 60 * 1000),
    automationCatchUpWindowMinutes: num('automation.catchUpWindowMinutes', 30),
    automationFailureCooldownMs: num('automation.failureCooldownMs', 5 * 60 * 1000),
    automationDeleteAfterRun: bool('automation.deleteAfterRun', false),
    browserPwaEnabled: bool('web.enabled', false),
    browserPwaPublicBaseUrl: str('web.publicBaseUrl', '(not configured)'),
    voiceSurfaceEnabled: bool('ui.voiceEnabled', false),
  };
}
