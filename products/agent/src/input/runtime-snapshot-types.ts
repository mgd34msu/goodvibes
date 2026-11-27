import type { AgentChannelSetupGuide, AgentChannelStatus } from './channel-readiness.ts';
import type { AgentSetupChecklistItem } from './setup-checklist.ts';
import type { AgentVoiceMediaReadiness } from './voice-media-readiness.ts';
import type { AgentBehaviorDiscoverySnapshot } from '../agent/behavior-discovery-summary.ts';
import type { AgentSetupWizard } from '../agent/setup-wizard.ts';
import type { AgentLocalLibraryItem } from '@goodvibes/engine/terminal-shell/agent-turn/local-library-items';

export type { AgentLocalLibraryItem };

// The review packet's shapes are shared with the daemon, which reports the same packet (terminal-shell agent-turn/review-packet-utils.ts).
export type {
  AgentRecentReviewerHandoffArtifact, AgentReviewPacketDefaults, AgentReviewPacketPresetLineage, AgentReviewPacketTimeline,
  AgentReviewPacketTimelineEvent, AgentReviewPacketTimelineEventKind, AgentReviewPacketWizard, AgentReviewPacketWizardStep,
  AgentReviewPacketWizardStepStatus,
} from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-utils';
import type { AgentReviewPacketTimeline, AgentReviewPacketWizard } from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-utils';

export interface AgentRuntimeProfileItem {
  readonly id: string;
  readonly homeDirectory: string;
  readonly createdAt: string | null;
  readonly starterTemplateId?: string;
  readonly starterTemplateName?: string;
}

export interface AgentRuntimeStarterTemplateItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly personaName: string;
  readonly skillNames: readonly string[];
  readonly routineNames: readonly string[];
  readonly source: string;
}

export interface AgentRoutineScheduleReceiptSummary {
  readonly id: string;
  readonly status: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly scheduleName: string;
  readonly scheduleKind: string;
  readonly scheduleValue: string;
  readonly createdAt: string;
}

export interface AgentResearchRunSummary {
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

export interface AgentVibeSummary {
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

export interface AgentPromptContextReceiptSummary {
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

export interface AgentPromptContextReceiptTimeline {
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
  readonly items: readonly AgentPromptContextReceiptSummary[];
}

export interface AgentProcessSupervisionSummary {
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

export interface AgentCompanionAccessSummary {
  readonly surface: 'goodvibes-agent';
  readonly hostUrl: string;
  readonly tokenPath: string;
  readonly tokenPresent: boolean;
  readonly tokenReadable: boolean;
  readonly tokenError: string | null;
  readonly pairingReady: boolean;
  readonly qrCommand: 'Devices and network, Pair something, A phone or another device';
  readonly nextStep: string;
}

export interface AgentRuntimeSnapshot {
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
  readonly localNotes: readonly AgentLocalLibraryItem[];
  readonly researchRunCount: number;
  readonly researchRunPlannedCount: number;
  readonly researchRunRunningCount: number;
  readonly researchRunPausedCount: number;
  readonly researchRunBlockedCount: number;
  readonly researchRuns: readonly AgentResearchRunSummary[];
  readonly vibe: AgentVibeSummary;
  readonly promptContextReceipts: AgentPromptContextReceiptTimeline;
  readonly reviewPacketTimeline: AgentReviewPacketTimeline;
  readonly reviewPacketWizard: AgentReviewPacketWizard;
  readonly localRoutineCount: number;
  readonly enabledRoutineCount: number;
  readonly localRoutines: readonly AgentLocalLibraryItem[];
  readonly routineScheduleReceiptCount: number;
  readonly successfulRoutineScheduleReceiptCount: number;
  readonly failedRoutineScheduleReceiptCount: number;
  readonly latestRoutineScheduleReceipt: AgentRoutineScheduleReceiptSummary | null;
  readonly localSkillCount: number;
  readonly enabledSkillCount: number;
  readonly localSkillBundleCount: number;
  readonly enabledSkillBundleCount: number;
  readonly activeSkillCount: number;
  readonly localSkillBundles: readonly AgentLocalLibraryItem[];
  readonly localSkills: readonly AgentLocalLibraryItem[];
  readonly localPersonaCount: number;
  readonly activePersonaName: string;
  readonly knowledgeRoute: '/api/goodvibes-agent/knowledge';
  readonly knowledgeIsolation: 'agent-only';
  readonly executionPolicy: 'serial-proactive';
  readonly delegatedReviewPolicy: 'explicit-build-delegation-only';
  readonly companionAccess: AgentCompanionAccessSummary;
  readonly channels: readonly AgentChannelStatus[];
  readonly voiceProviderCount: number;
  readonly voiceSurfaceEnabled: boolean;
  readonly mediaProviderCount: number;
  readonly mediaGenerationProviderCount: number;
  readonly voiceMediaReadiness: AgentVoiceMediaReadiness;
  readonly mcpQuarantinedServerCount: number;
  readonly mcpAllowAllServerCount: number;
  readonly browserToolExposureEnabled: boolean;
  readonly activeRuntimeProfile: string;
  readonly runtimeProfileCount: number;
  readonly runtimeStarterTemplateCount: number;
  readonly setupChecklist: readonly AgentSetupChecklistItem[];
  readonly setupWizard: AgentSetupWizard;
  readonly warnings: readonly string[];
}

/** The setup part of the snapshot: its setup steps and the onboarding route built on them. */
export type AgentSetupPart = Pick<AgentRuntimeSnapshot, 'setupChecklist' | 'setupWizard'>;
