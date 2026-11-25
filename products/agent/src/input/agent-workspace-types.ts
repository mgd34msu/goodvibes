import type { ModelPickerTarget } from './model-picker.ts';
import type { AgentWorkspaceChannelSetupGuide, AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
import type { AgentWorkspaceSetupChecklistItem } from './agent-workspace-setup.ts';
import type { AgentWorkspaceVoiceMediaReadiness } from './agent-workspace-voice-media.ts';
import type { AgentBehaviorDiscoverySnapshot } from '../agent/behavior-discovery-summary.ts';
import type { AgentSetupWizard } from '../agent/setup-wizard.ts';
import type { WorkspaceActionTarget } from './workspace-actions.ts';
import type { AgentWorkspaceLocalLibraryItem } from '@goodvibes/engine/terminal-shell/agent-turn/local-library-items';

export type { AgentWorkspaceLocalLibraryItem };

export const AGENT_WORKSPACE_MODAL_NAME = 'agentWorkspace';

export type AgentWorkspaceCategoryGroup = 'START' | 'SETUP' | 'ONBOARDING' | 'DAY-TO-DAY' | 'CAPABILITIES' | 'LOCAL BEHAVIOR' | 'OPERATIONS' | 'FINISH';

/** The order the groups are listed in: what a person does on an ordinary day first, setting up after. */
export const AGENT_WORKSPACE_GROUP_ORDER: readonly AgentWorkspaceCategoryGroup[] = [
  'START', 'DAY-TO-DAY', 'LOCAL BEHAVIOR', 'CAPABILITIES', 'OPERATIONS', 'SETUP', 'ONBOARDING', 'FINISH',
];

/**
 * What each group is called on screen, for the job its areas do; the group key
 * stays the name the workspace filters by. Home stands alone, with no title;
 * groups with the same title next to each other share one heading (the setup
 * areas and Finish).
 */
export const AGENT_WORKSPACE_GROUP_TITLES: Readonly<Record<AgentWorkspaceCategoryGroup, string>> = {
  START: '',
  'DAY-TO-DAY': 'Get things done',
  'LOCAL BEHAVIOR': 'Memory & habits',
  CAPABILITIES: 'Tools & knowledge',
  OPERATIONS: 'Where it runs',
  SETUP: 'Set up',
  ONBOARDING: 'Set up',
  FINISH: 'Set up',
};

export type AgentWorkspaceFocusPane = 'categories' | 'actions';

export const AGENT_WORKSPACE_CATEGORY_IDS = [
  'home',
  'setup',
  'account-model',
  'assistant-behavior',
  'tools-permissions',
  'onboarding-display',
  'onboarding-channels',
  'onboarding-voice-media',
  'onboarding-context',
  'onboarding-automation',
  'personal-ops',
  'research',
  'documents',
  'artifacts',
  'conversation',
  'channels',
  'tools',
  'knowledge',
  'voice-media',
  'profiles',
  'owner-profile',
  'memory',
  'notes',
  'personas',
  'skills',
  'routines',
  'work',
  'host',
  'automation',
  'delegate',
  'finish',
] as const;

export type AgentWorkspaceCategoryId = (typeof AGENT_WORKSPACE_CATEGORY_IDS)[number];

/**
 * `act`: runs a described command's action (its guided form, the same one the
 * slash command opens); `command`: runs a typed line; `setting`: one setting,
 * cycled in place or opened in the settings screen; the rest open a picker, an
 * area of this workspace, or say something.
 */
export type AgentWorkspaceActionKind = 'act' | 'command' | 'guidance' | 'workspace' | 'setting' | 'settings-import' | 'model-picker' | 'settings-modal' | 'onboarding-complete';

export interface AgentWorkspaceAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly command?: string;
  /** For an `act` row: the described command and action it runs. */
  readonly act?: WorkspaceActionTarget;
  readonly targetCategoryId?: AgentWorkspaceCategoryId;
  readonly settingKey?: string;
  readonly settingValueHint?: string;
  readonly modelPickerTarget?: ModelPickerTarget;
  readonly modelPickerFlow?: 'providerModel' | 'model';
  readonly settingsTarget?: string;
  readonly visibleWhenSettingKey?: string;
  readonly visibleWhenSettingValue?: string | boolean | number;
  readonly kind: AgentWorkspaceActionKind;
  readonly safety: 'safe' | 'read-only' | 'delegates' | 'blocked';
  readonly commandBehavior?: 'inline' | 'compose' | 'exit';
}

export interface AgentWorkspaceCategory {
  readonly id: AgentWorkspaceCategoryId;
  readonly group: AgentWorkspaceCategoryGroup;
  readonly label: string;
  readonly summary: string;
  readonly detail: string;
  readonly actions: readonly AgentWorkspaceAction[];
}

export interface AgentWorkspaceActionSearchResult {
  readonly category: AgentWorkspaceCategory;
  readonly categoryIndex: number;
  readonly action: AgentWorkspaceAction;
  readonly actionIndex: number;
}

/**
 * `displayCommand` is what the result pane may show for the command. It differs from
 * `command` only when the dispatched text carries a secret that must run but not be drawn.
 */
export type AgentWorkspaceCommandDispatcher = (command: string, behavior?: 'inline' | 'compose' | 'exit', displayCommand?: string) => void;

export type AgentWorkspaceActionResultKind = 'guidance' | 'blocked' | 'dispatched' | 'refreshed' | 'error' | 'recap';

export interface AgentWorkspaceActionResult {
  readonly kind: AgentWorkspaceActionResultKind;
  readonly title: string;
  readonly detail: string;
  readonly command?: string;
  readonly safety?: AgentWorkspaceAction['safety'];
  /** Lines to display when kind is 'recap'. */
  readonly lines?: readonly string[];
}

export interface AgentWorkspaceRecentReviewerHandoffArtifact {
  readonly id: string;
  readonly filename: string;
  readonly createdAt: number;
  readonly handoffId: string;
  readonly comparisonId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: string;
  readonly relatedArtifactCount: number;
}

export type AgentWorkspaceReviewPacketTimelineEventKind =
  | 'document'
  | 'comment'
  | 'suggestion'
  | 'attachment'
  | 'document-export'
  | 'compare'
  | 'compare-export'
  | 'judgment'
  | 'route-decision'
  | 'packet-preset'
  | 'handoff'
  | 'handoff-archive';

export interface AgentWorkspaceReviewPacketTimelineEvent {
  readonly id: string;
  readonly kind: AgentWorkspaceReviewPacketTimelineEventKind;
  readonly at: number;
  readonly label: string;
  readonly detail: string;
  readonly status: 'ready' | 'attention' | 'complete' | 'info';
  readonly route: string;
  readonly sourceId: string;
}

export interface AgentWorkspaceReviewPacketTimeline {
  readonly available: boolean;
  readonly count: number;
  readonly next: string;
  readonly items: readonly AgentWorkspaceReviewPacketTimelineEvent[];
}

export interface AgentWorkspaceReviewPacketPresetLineage {
  readonly artifactId: string;
  readonly presetId: string | null;
  readonly name: string | null;
  readonly refreshed: boolean;
  readonly refreshedFromArtifactId: string | null;
  readonly refreshedFromPresetId: string | null;
  readonly freshnessMissingCount: number | null;
  readonly freshnessSupersededCount: number | null;
  readonly freshnessUnresolvedCount: number | null;
  readonly summary: string;
  readonly inspectRoute: string;
}

export interface AgentWorkspaceReviewPacketDefaults {
  readonly documentId: string | null;
  readonly documentTitle: string | null;
  readonly documentExportArtifactId: string | null;
  readonly comparisonArtifactId: string | null;
  readonly judgmentArtifactId: string | null;
  readonly revealedJudgmentArtifactId: string | null;
  readonly routeDecisionArtifactId: string | null;
  readonly routeDecision: string | null;
  readonly handoffArtifactId: string | null;
  readonly handoffArchiveArtifactId: string | null;
  readonly reviewPacketPresetArtifactId: string | null;
  readonly reviewPacketPresetName: string | null;
  readonly reviewPacketPresetLineage: AgentWorkspaceReviewPacketPresetLineage | null;
  readonly relatedArtifactIds: readonly string[];
  readonly summary: string;
}

export type AgentWorkspaceReviewPacketWizardStepStatus = 'done' | 'current' | 'pending' | 'blocked';

export interface AgentWorkspaceReviewPacketWizardStep {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceReviewPacketWizardStepStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly actionId: string;
  readonly backtrackRoute: string | null;
  /** The line a person types for this step, with a blank in angle brackets where they choose. */
  readonly ownerLine: string;
}

export interface AgentWorkspaceReviewPacketWizard {
  readonly available: boolean;
  readonly status: 'complete' | 'active' | 'blocked' | 'empty';
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly currentStepId: string | null;
  readonly currentStepLabel: string | null;
  readonly next: string;
  readonly finalReview: string;
  readonly presetLineage: AgentWorkspaceReviewPacketPresetLineage | null;
  readonly steps: readonly AgentWorkspaceReviewPacketWizardStep[];
}

export interface AgentWorkspaceRuntimeProfileItem {
  readonly id: string;
  readonly homeDirectory: string;
  readonly createdAt: string | null;
  readonly starterTemplateId?: string;
  readonly starterTemplateName?: string;
}

export interface AgentWorkspaceRuntimeStarterTemplateItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly personaName: string;
  readonly skillNames: readonly string[];
  readonly routineNames: readonly string[];
  readonly source: string;
}

export interface AgentWorkspaceRoutineScheduleReceiptSummary {
  readonly id: string;
  readonly status: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly scheduleName: string;
  readonly scheduleKind: string;
  readonly scheduleValue: string;
  readonly createdAt: string;
}

export interface AgentWorkspaceResearchRunSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly progress: number;
  readonly sourceIds: readonly string[];
  readonly nextSteps: readonly string[];
  readonly checkpointCount: number;
  readonly logTail: readonly string[];
  readonly updatedAt: string;
  readonly note?: string;
  readonly reportArtifactId?: string;
}

export interface AgentWorkspaceVibeSummary {
  readonly status: 'ready' | 'attention' | 'needs-setup' | 'unavailable';
  readonly applied: number;
  readonly blocked: number;
  readonly truncated: number;
  readonly projectInitPath: string | null;
  readonly globalInitPath: string | null;
  readonly statusRoute: 'capability personas.vibe';
  readonly initProjectRoute: 'capability personas.vibe-create where:"project"';
  readonly initGlobalRoute: 'capability personas.vibe-create where:"global"';
  readonly next: string;
}

export interface AgentWorkspacePromptContextReceiptSummary {
  readonly receiptId: string;
  readonly turnId: string | null;
  readonly source: string;
  readonly provider: string;
  readonly model: string;
  readonly createdAt: number;
  readonly activeRecords: number;
  readonly suppressedRecords: number;
  readonly segmentCount: number;
  readonly approxPromptTokens: number;
  readonly outcomeStatus: 'completed' | 'error' | 'cancelled' | 'pending';
  readonly stopReason: string | null;
  readonly completedAt: number | null;
  readonly detail: string | null;
  readonly inspectRoute: string;
  readonly outcomeFilterRoute: string;
}

export interface AgentWorkspacePromptContextReceiptTimeline {
  readonly status: 'ready' | 'empty' | 'unavailable';
  readonly count: number;
  readonly latestReceiptId: string | null;
  readonly latestTurnId: string | null;
  readonly completedCount: number;
  readonly errorCount: number;
  readonly cancelledCount: number;
  readonly pendingCount: number;
  readonly inspectRoute: 'context action:"prompt" includeParameters:true';
  readonly filterRoutes: {
    readonly completed: string;
    readonly error: string;
    readonly cancelled: string;
    readonly pending: string;
  };
  readonly next: string;
  readonly items: readonly AgentWorkspacePromptContextReceiptSummary[];
}

export interface AgentWorkspaceProcessSupervisionSummary {
  readonly status: 'available' | 'unavailable';
  readonly tracked: number;
  readonly running: number;
  readonly completed: number;
  readonly stdinWriteStatus: 'supported-with-confirmation' | 'not-yet-supported';
  readonly stdinMethod: string | null;
  readonly ptyStatus: 'contract-discovered' | 'not-yet-supported';
  readonly ptyMethod: string | null;
  readonly sudoStatus: 'foreground-only';
  readonly processRoute: string;
  readonly capabilitiesRoute: string;
  readonly visibleMonitorRoute: string;
  readonly liveTailRoute: string;
}

export interface AgentWorkspaceCompanionAccessSummary {
  readonly surface: 'goodvibes-agent';
  readonly hostUrl: string;
  readonly tokenPath: string;
  readonly tokenPresent: boolean;
  readonly tokenReadable: boolean;
  readonly tokenError: string | null;
  readonly pairingReady: boolean;
  readonly qrCommand: '/devices pair device';
  readonly nextStep: string;
}

export interface AgentWorkspaceRuntimeSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly modelDisplayName: string;
  readonly embeddingProvider: string;
  readonly reasoningEffort: string;
  readonly helperEnabled: boolean;
  readonly toolLlmEnabled: boolean;
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
  readonly artifactMaxBytes: number;
  readonly rawPromptTelemetry: boolean;
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly runtimeBaseUrl: string;
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly availableSubscriptionProviderCount: number;
  readonly sessionMemoryCount: number;
  readonly localMemoryCount: number;
  readonly localMemoryReviewQueueCount: number;
  readonly localMemoryPromptActiveCount: number;
  readonly localMemoryTemporallyPendingCount: number;
  readonly localMemoryTemporallyExpiredCount: number;
  readonly localNoteCount: number;
  readonly localNoteReviewQueueCount: number;
  readonly localNotes: readonly AgentWorkspaceLocalLibraryItem[];
  readonly researchRunCount: number;
  readonly researchRunPlannedCount: number;
  readonly researchRunRunningCount: number;
  readonly researchRunPausedCount: number;
  readonly researchRunBlockedCount: number;
  readonly researchRuns: readonly AgentWorkspaceResearchRunSummary[];
  readonly vibe: AgentWorkspaceVibeSummary;
  readonly promptContextReceipts: AgentWorkspacePromptContextReceiptTimeline;
  readonly reviewPacketTimeline: AgentWorkspaceReviewPacketTimeline;
  readonly reviewPacketWizard: AgentWorkspaceReviewPacketWizard;
  readonly localRoutineCount: number;
  readonly enabledRoutineCount: number;
  readonly localRoutines: readonly AgentWorkspaceLocalLibraryItem[];
  readonly routineScheduleReceiptCount: number;
  readonly successfulRoutineScheduleReceiptCount: number;
  readonly failedRoutineScheduleReceiptCount: number;
  readonly latestRoutineScheduleReceipt: AgentWorkspaceRoutineScheduleReceiptSummary | null;
  readonly localSkillCount: number;
  readonly enabledSkillCount: number;
  readonly localSkillBundleCount: number;
  readonly enabledSkillBundleCount: number;
  readonly activeSkillCount: number;
  readonly localSkillBundles: readonly AgentWorkspaceLocalLibraryItem[];
  readonly localSkills: readonly AgentWorkspaceLocalLibraryItem[];
  readonly localPersonaCount: number;
  readonly activePersonaName: string;
  readonly knowledgeRoute: '/api/goodvibes-agent/knowledge';
  readonly knowledgeIsolation: 'agent-only';
  readonly executionPolicy: 'serial-proactive';
  readonly delegatedReviewPolicy: 'explicit-build-delegation-only';
  readonly companionAccess: AgentWorkspaceCompanionAccessSummary;
  readonly channels: readonly AgentWorkspaceChannelStatus[];
  readonly voiceProviderCount: number;
  readonly voiceSurfaceEnabled: boolean;
  readonly mediaProviderCount: number;
  readonly mediaGenerationProviderCount: number;
  readonly voiceMediaReadiness: AgentWorkspaceVoiceMediaReadiness;
  readonly mcpQuarantinedServerCount: number;
  readonly mcpAllowAllServerCount: number;
  readonly browserToolExposureEnabled: boolean;
  readonly activeRuntimeProfile: string;
  readonly runtimeProfileCount: number;
  readonly runtimeStarterTemplateCount: number;
  readonly setupChecklist: readonly AgentWorkspaceSetupChecklistItem[];
  readonly setupWizard: AgentSetupWizard;
  readonly warnings: readonly string[];
}

/** The part of the snapshot the Agent workspace reads: its setup steps and the onboarding route built on them. */
export type AgentWorkspaceSetupPart = Pick<AgentWorkspaceRuntimeSnapshot, 'setupChecklist' | 'setupWizard'>;
