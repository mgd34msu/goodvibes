import {
  projectCommandSessionSection,
  projectCommandWorkspaceSection,
  projectCommandClientsSection,
} from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-context';
import { createBootstrapActionBase } from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-actions';
import { createModelSelectionAction } from '@goodvibes-jev/engine/terminal-shell/model-selection-action';
import { projectCommandProviderServices } from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-context';
import { getConfigSnapshot } from '../config/index.ts';
import { publishActiveEffortOptions, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { AdaptivePlanner } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { AgentPromptContextReceiptStore } from '../agent/prompt-context-receipts.ts';
import type { HookApi } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { McpApi } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import type { IntegrationHelperService } from '@/runtime/index.ts';
import type { KnowledgeService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import type { HookWorkbench } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { WorktreeRegistry } from '@/runtime/index.ts';
import type { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type {
  ShellAgentManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
  RemoteCommandService,
  PlanRuntimeService,
} from '@/runtime/index.ts';
import type { BootstrapCommandShellServices } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { AgentMemoryDiagnostics, AgentVoiceSetupService } from './services.ts';
import type { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { AgentExecutionLedger } from './execution-ledger.ts';
import type { ApprovalsView } from './client/approvals-view.ts';
import '@goodvibes-jev/engine/sdk/platform/utils';
import type { ConsolidationReceiptSource } from '../agent/memory-consolidation-proposals.ts';
import { listPendingConsolidationProposals } from '../agent/memory-consolidation-proposals.ts';
import { activeTokens } from '../renderer/theme.ts';

export type BootstrapCommandSessionSection = CommandContext['session'];
export type BootstrapCommandProviderSection = CommandContext['provider'];
export type BootstrapCommandWorkspaceSection = CommandContext['workspace'];
export type BootstrapCommandPlatformSection = CommandContext['platform'];
export type BootstrapCommandOpsSection = CommandContext['ops'];
export type BootstrapCommandExtensionSection = CommandContext['extensions'];
export type BootstrapCommandClientSection = NonNullable<CommandContext['clients']>;

export interface BootstrapCommandActionOptions {
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: ConfigManager;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly requestRender: () => void;
  readonly loadSystemPrompt: () => string;
  readonly activatePlan: (planId: string, task: string) => void;
  readonly requestPermission: PermissionRequestHandler;
  readonly completeModelSelectionSideEffect?: () => void;
}

export interface BootstrapCommandSectionOptions {
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly keybindingsManager?: KeybindingsManager;
  readonly processManager?: import('@goodvibes-jev/engine/sdk/platform/tools').ProcessManager;
  readonly requestRender: () => void;
  readonly requestPermission: PermissionRequestHandler;
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
  readonly voiceSetup?: AgentVoiceSetupService;
  readonly memoryGovernor?: AgentMemoryDiagnostics;
  readonly mediaProviderRegistry?: MediaProviderRegistry;
  readonly artifactStore?: ArtifactStore;
  readonly channelDeliveryRouter?: ChannelDeliveryRouter;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly readModels: UiReadModels;
  readonly shellPaths: ShellPathService;
  readonly fileUndoManager: FileUndoManager;
  readonly executionLedger?: AgentExecutionLedger;
  readonly approvalsView?: ApprovalsView;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly projectPlanningService?: import('@goodvibes-jev/engine/sdk/platform/knowledge').ProjectPlanningService;
  readonly projectPlanningProjectId?: string;
  readonly workPlanStore?: import('@goodvibes-jev/engine/sdk/platform/workflow').WorkPlanStore;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
  readonly providerOptimizer?: import('@goodvibes-jev/engine/sdk/platform/providers').ProviderOptimizer;
  readonly sessionManager?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionManager;
  readonly profileManager?: import('@goodvibes-jev/engine/sdk/platform/profiles').ProfileManager;
  readonly bookmarkManager?: import('@goodvibes-jev/engine/sdk/platform/bookmarks').BookmarkManager;
  readonly favoritesStore?: import('@goodvibes-jev/engine/sdk/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@goodvibes-jev/engine/sdk/platform/providers').BenchmarkStore;
  readonly subscriptionManager?: import('@goodvibes-jev/engine/sdk/platform/config').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.ts').SecretsManager;
  readonly serviceRegistry?: import('@goodvibes-jev/engine/sdk/platform/config').ServiceRegistry;
  readonly localUserAuthManager?: import('@goodvibes-jev/engine/sdk/platform/security').UserAuthManager;
  readonly tokenAuditor?: import('@goodvibes-jev/engine/sdk/platform/security').ApiTokenAuditor;
  readonly replayEngine?: import('@goodvibes-jev/engine/sdk/platform/core').DeterministicReplayEngine;
  readonly webhookNotifier?: import('@goodvibes-jev/engine/sdk/platform/integrations').WebhookNotifier;
  readonly sessionMemoryStore?: import('@goodvibes-jev/engine/sdk/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@goodvibes-jev/engine/sdk/platform/core').SessionLineageTracker;
  readonly changeTracker?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionChangeTracker;
  readonly writeLastSessionPointer?: (sessionId: string) => void;
  /** Reload a resumed session's persisted rewind anchors. Bound at bootstrap to the runtime's SessionSurface; returns how many were restored. */
  readonly restoreTurnAnchors?: (sessionId: string) => number;
  readonly surface?: import('@/runtime/index.ts').SessionSurface;
  readonly hydrateSessionUsage?: () => void;
  readonly agentManager?: ShellAgentManagerService;
  readonly modeManager?: ShellModeManagerService;
  readonly automationManager?: ShellAutomationManagerRuntimeService;
  readonly planManager?: ShellPlanManagerService;
  readonly adaptivePlanner?: AdaptivePlanner;
  readonly sessionOrchestration?: ShellSessionOrchestrationService;
  readonly remoteRuntime?: RemoteCommandService;
  readonly planRuntime?: PlanRuntimeService;
  readonly operatorClient?: OperatorClient;
  readonly peerClient?: PeerClient;
  readonly providerApi?: ProviderApi;
  readonly agentKnowledgeApi?: KnowledgeApi;
  readonly promptContextReceipts?: AgentPromptContextReceiptStore;
  readonly hookApi?: HookApi;
  readonly mcpApi?: McpApi;
  readonly opsApi?: OpsApi;
  readonly directTransport?: DirectTransport;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  /**
   * The runtime's own memory-consolidation scheduler, exposed to the memory
   * review surface (input/commands/recall-review.ts) as
   * clients.memoryConsolidation, see agent/memory-consolidation-proposals.ts.
   */
  readonly memoryConsolidationScheduler?: ConsolidationReceiptSource;
}

function unwiredShellAction(name: string): never {
  throw new Error(`Agent runtime action "${name}" was called before the operator route was attached.`);
}

export function createBootstrapCommandActions(
  options: BootstrapCommandActionOptions,
): Pick<
  CommandContext,
  | 'renderRequest'
  | 'submitInput'
  | 'executeCommand'
  | 'cancelGeneration'
  | 'clearScreen'
  | 'activatePlan'
  | 'requestPermission'
  | 'completeModelSelection'
  | 'jumpToBookmark'
  | 'scrollToLine'
  | 'print'
  | 'exit'
  | 'reloadSystemPrompt'
  | 'openMcpWorkspace'
  | 'openAgentWorkspace'
  | 'dismissAgentWorkspace'
  | 'openSecurityWorkspace'
  | 'openKnowledgeWorkspace'
  | 'openSubscriptionWorkspace'
> {
  const { providerRegistry, configManager, conversation, runtime, requestRender, completeModelSelectionSideEffect } = options;

  const pointToWorkspace = (what: string) => {
    conversation.log(`${what} lives in the Agent workspace, press Ctrl+P or run /agent.`, { fg: activeTokens().warning });
    requestRender();
  };

  return {
    ...createBootstrapActionBase(options, {
      unwiredMessage: (name) => `Agent runtime action "${name}" was called before the operator route was attached.`,
      completeModelSelection: createModelSelectionAction(
        { providerRegistry, configManager, conversation, runtime, requestRender, completeModelSelectionSideEffect },
        {
          setToolEnabled: () => configManager.setDynamic('tools.llmEnabled', true),
          effortModel: () => toEffortModel(providerRegistry.getCurrentModel()),
          publishEffortOptions: (model) => publishActiveEffortOptions(model, runtime.sessionId),
          alwaysShowEffort: false,
          noteColor: () => activeTokens().secondary,
        },
      ),
    }),
    openAgentWorkspace: () => unwiredShellAction('openAgentWorkspace'),
    dismissAgentWorkspace: () => unwiredShellAction('dismissAgentWorkspace'),
    openSecurityWorkspace: () => {
      pointToWorkspace('Security review');
    },
    openKnowledgeWorkspace: () => {
      pointToWorkspace('Knowledge');
    },
    openSubscriptionWorkspace: () => {
      pointToWorkspace('Provider subscriptions');
    },
  };
}

export function createBootstrapCommandSessionSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    | 'conversation'
    | 'runtime'
    | 'sessionManager'
    | 'sessionMemoryStore'
    | 'sessionLineageTracker'
    | 'changeTracker'
    | 'writeLastSessionPointer'
    | 'restoreTurnAnchors'
    | 'surface'
    | 'hydrateSessionUsage'
  >,
): BootstrapCommandSessionSection {
  return {
    ...projectCommandSessionSection(options),
    writeLastSessionPointer: options.writeLastSessionPointer,
    restoreTurnAnchors: options.restoreTurnAnchors,
    surface: options.surface,
  };
}

export function createBootstrapCommandProviderSection(
  options: Pick<BootstrapCommandSectionOptions, 'providerRegistry' | 'providerOptimizer' | 'favoritesStore' | 'benchmarkStore'>,
): BootstrapCommandProviderSection {
  return projectCommandProviderServices(options);
}

export function createBootstrapCommandWorkspaceSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    | 'keybindingsManager'
    | 'fileUndoManager'
    | 'profileManager'
    | 'bookmarkManager'
    | 'processManager'
    | 'projectPlanningService'
    | 'projectPlanningProjectId'
    | 'workPlanStore'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandWorkspaceSection {
  return { ...projectCommandWorkspaceSection(options), processManager: options.processManager, ...shellServices.workspace };
}

export function createBootstrapCommandPlatformSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    | 'configManager'
    | 'voiceProviderRegistry'
    | 'voiceService'
    | 'voiceSetup'
    | 'memoryGovernor'
    | 'mediaProviderRegistry'
    | 'artifactStore'
    | 'channelDeliveryRouter'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandPlatformSection {
  return {
    config: getConfigSnapshot(options.configManager),
    configManager: options.configManager,
    voiceProviderRegistry: options.voiceProviderRegistry,
    voiceService: options.voiceService,
    voiceSetup: options.voiceSetup,
    memoryGovernor: options.memoryGovernor,
    mediaProviderRegistry: options.mediaProviderRegistry,
    artifactStore: options.artifactStore,
    channelDeliveryRouter: options.channelDeliveryRouter,
    ...shellServices.platform,
  };
}

export function createBootstrapCommandOpsSection(
  shellServices: BootstrapCommandShellServices,
  options: Pick<BootstrapCommandSectionOptions, 'executionLedger' | 'approvalsView'> = {},
): BootstrapCommandOpsSection {
  return {
    ...shellServices.ops,
    executionLedger: options.executionLedger,
    approvalsView: options.approvalsView,
  };
}

export function createBootstrapCommandExtensionsSection(
  options: Pick<BootstrapCommandSectionOptions, 'toolRegistry' | 'mcpRegistry'>,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandExtensionSection {
  const shellExtensionServices = shellServices.extensions;
  return {
    toolRegistry: options.toolRegistry,
    mcpRegistry: options.mcpRegistry,
    ...shellExtensionServices,
    agentKnowledgeService: shellExtensionServices.knowledgeService,
  };
}

export function createBootstrapCommandClientsSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    | 'operatorClient'
    | 'peerClient'
    | 'providerApi'
    | 'agentKnowledgeApi'
    | 'promptContextReceipts'
    | 'hookApi'
    | 'mcpApi'
    | 'opsApi'
    | 'directTransport'
    | 'memoryConsolidationScheduler'
  >,
): BootstrapCommandClientSection {
  const memoryConsolidationScheduler = options.memoryConsolidationScheduler;
  return {
    ...projectCommandClientsSection(options),
    agentKnowledgeApi: options.agentKnowledgeApi,
    promptContextReceipts: options.promptContextReceipts,
    ...(memoryConsolidationScheduler
      ? { memoryConsolidation: { listPendingProposals: () => listPendingConsolidationProposals(memoryConsolidationScheduler) } }
      : {}),
  };
}
