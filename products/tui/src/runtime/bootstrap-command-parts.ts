import {
  projectCommandSessionSection,
  projectCommandWorkspaceSection,
  projectCommandClientsSection,
} from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-context';
import { createBootstrapActionBase } from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-actions';
import { createModelSelectionAction } from '@goodvibes-jev/engine/terminal-shell/model-selection-action';
import { projectCommandProviderServices } from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-context';
import { EvalRegistry } from '@goodvibes-jev/engine/platform/platform/observe';
import { activeTokens } from '../renderer/theme.ts';
import { getConfigSnapshot } from '@goodvibes-jev/engine/platform/platform/config';
import { publishActiveEffortOptions, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { AdaptivePlanner } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemorySpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { HookApi } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { McpApi } from '@goodvibes-jev/engine/platform/platform/mcp';
import type { ProviderApi } from '@goodvibes-jev/engine/platform/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { CodeIndexStore, FileUndoManager } from '@goodvibes-jev/engine/platform/platform/state';
import type { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/platform/platform/workspace';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { WorkspaceTrustManager } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { WorkspaceRegistrationManager } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';
import type { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import type { IntegrationHelperService } from '@/runtime/index.ts';
import type { KnowledgeService } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { PluginManager } from '@goodvibes-jev/engine/platform/platform/plugins';
import type { HookWorkbench } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { WorktreeRegistry } from '@/runtime/index.ts';
import type { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService, SessionSurface } from '@/runtime/index.ts';
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
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/platform/platform/voice';
import '@goodvibes-jev/engine/platform/platform/utils';

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
  readonly localUserAuthManager?: import('@goodvibes-jev/engine/platform/platform/security').UserAuthManager;
}

export interface BootstrapCommandSectionOptions {
  readonly configManager: ConfigManager;
  readonly pairingTokens?: import('@goodvibes-jev/engine/platform/platform/pairing').PairingTokenManager;
  readonly featureFlagManager?: FeatureFlagManager;
  readonly providerRegistry: ProviderRegistry;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly keybindingsManager?: KeybindingsManager;
  readonly requestRender: () => void;
  readonly requestPermission: PermissionRequestHandler;
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
  /** Direct-command consumers (`/search`, `/image`) of already-constructed RuntimeServices. */
  readonly webSearchService?: import('@goodvibes-jev/engine/platform/platform/web-search').WebSearchService;
  readonly mediaProviders?: import('@goodvibes-jev/engine/platform/platform/media').MediaProviderRegistry;
  readonly artifactStore?: import('@goodvibes-jev/engine/platform/platform/artifacts').ArtifactStore;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly readModels: UiReadModels;
  readonly shellPaths: ShellPathService;
  /** The runtime's declare-once session-storage handle (runtime/services.ts). */
  readonly surface: SessionSurface;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager?: WorkspaceCheckpointManager;
  readonly gatewayMethods?: GatewayMethodCatalog;
  readonly workspaceTrustManager?: WorkspaceTrustManager;
  readonly workspaceRegistrationManager?: WorkspaceRegistrationManager;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly projectPlanningService?: import('@goodvibes-jev/engine/platform/platform/knowledge').ProjectPlanningService;
  readonly projectPlanningProjectId?: string;
  readonly workPlanStore?: import('@goodvibes-jev/engine/platform/platform/workflow').WorkPlanStore;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
  readonly providerOptimizer?: import('@goodvibes-jev/engine/platform/platform/providers').ProviderOptimizer;
  readonly sessionManager?: import('@goodvibes-jev/engine/platform/platform/sessions').SessionManager;
  readonly profileManager?: import('@goodvibes-jev/engine/platform/platform/profiles').ProfileManager;
  readonly bookmarkManager?: import('@goodvibes-jev/engine/platform/platform/bookmarks').BookmarkManager;
  readonly favoritesStore?: import('@goodvibes-jev/engine/platform/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@goodvibes-jev/engine/platform/platform/providers').BenchmarkStore;
  readonly subscriptionManager?: import('@goodvibes-jev/engine/platform/platform/config').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.ts').SecretsManager;
  readonly serviceRegistry?: import('@goodvibes-jev/engine/platform/platform/config').ServiceRegistry;
  readonly localUserAuthManager?: import('@goodvibes-jev/engine/platform/platform/security').UserAuthManager;
  readonly tokenAuditor?: import('@goodvibes-jev/engine/platform/platform/security').ApiTokenAuditor;
  readonly replayEngine?: import('@goodvibes-jev/engine/platform/platform/core').DeterministicReplayEngine;
  readonly webhookNotifier?: import('@goodvibes-jev/engine/platform/platform/integrations').WebhookNotifier;
  readonly sessionMemoryStore?: import('@goodvibes-jev/engine/platform/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@goodvibes-jev/engine/platform/platform/core').SessionLineageTracker;
  readonly contractRunner?: import('@goodvibes-jev/engine/platform/platform/contract').ContractRunner;
  readonly changeTracker?: import('@goodvibes-jev/engine/platform/platform/sessions').SessionChangeTracker;
  readonly hydrateSessionUsage?: () => void;
  readonly contractOperator?: import('@goodvibes-jev/engine/platform/platform/contract').ContractOperatorService;
  readonly codeIndexStore?: CodeIndexStore;
  readonly codeIndexReindexScheduler?: import('@goodvibes-jev/engine/platform/platform/state').CodeIndexReindexScheduler;
  readonly isPassiveCodeInjectionFlagEnabled?: () => boolean;
  readonly getMainSessionTurnInjections?: () => readonly import('../renderer/turn-injection.ts').TurnInjectionEntry[];
  readonly agentManager?: ShellAgentManagerService;
  readonly modeManager?: ShellModeManagerService;
  readonly automationManager?: ShellAutomationManagerRuntimeService;
  readonly planManager?: ShellPlanManagerService;
  readonly adaptivePlanner?: AdaptivePlanner;
  readonly sessionOrchestration?: ShellSessionOrchestrationService;
  readonly remoteRuntime?: RemoteCommandService;
  readonly planRuntime?: PlanRuntimeService;
  readonly operatorClient?: OperatorClient;
  readonly userPermissionRuleStore?: import('@goodvibes-jev/engine/platform/platform/permissions').UserPermissionRuleStore;
  readonly peerClient?: PeerClient;
  readonly providerApi?: ProviderApi;
  readonly knowledgeApi?: KnowledgeApi;
  readonly memorySpine?: MemorySpineClient;
  readonly hookApi?: HookApi;
  readonly mcpApi?: McpApi;
  readonly opsApi?: OpsApi;
  readonly directTransport?: DirectTransport;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
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
  | 'openForensicsView'
  | 'openIncidentView'
  | 'openPolicyView'
  | 'openHooksView'
  | 'openCommunicationView'
  | 'openOrchestrationView'
  | 'openCockpitView'
  | 'openMcpWorkspace'
  | 'openSecurityView'
  | 'openKnowledgeView'
  | 'openMemoryView'
  | 'openRemoteView'
  | 'openSubscriptionView'
  | 'openLocalAuthMaskedEntry'
> {
  const { providerRegistry, configManager, conversation, runtime, requestRender, completeModelSelectionSideEffect } = options;

  // The views these open are kit modals, which exist once the shell attaches
  // (shell/ui-openers.ts replaces every one of these with the real opener).
  const viewNotAttached = (what: string) => (): void => {
    conversation.log(`${what} opens once the terminal UI is attached.`, { fg: activeTokens().textMuted });
    requestRender();
  };

  return {
    ...createBootstrapActionBase(options, {
      unwiredMessage: (name) => `commandContext.${name} was called before the shell bridge was attached in main.ts`,
      completeModelSelection: createModelSelectionAction(
        { providerRegistry, configManager, conversation, runtime, requestRender, completeModelSelectionSideEffect },
        {
          setToolEnabled: () => configManager.setDynamic('tools.llmEnabled' as never, true),
          effortModel: (model) => toEffortModel(model),
          publishEffortOptions: (model) => publishActiveEffortOptions(model),
          alwaysShowEffort: true,
          noteColor: () => activeTokens().warning,
        },
      ),
    }),
    openForensicsView: viewNotAttached('Agents'),
    openIncidentView: viewNotAttached('Agents'),
    openPolicyView: viewNotAttached('Policy'),
    openHooksView: viewNotAttached('Hooks'),
    openCommunicationView: viewNotAttached('Agents'),
    openOrchestrationView: viewNotAttached('Agents'),
    openCockpitView: viewNotAttached('Agents'),
    openSecurityView: viewNotAttached('Security'),
    openKnowledgeView: viewNotAttached('Knowledge'),
    openMemoryView: viewNotAttached('Memory'),
    openRemoteView: viewNotAttached('Remote'),
    openSubscriptionView: viewNotAttached('Subscriptions'),
    openLocalAuthMaskedEntry: viewNotAttached('The password prompt'),
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
    | 'contractRunner'
    | 'changeTracker'
    | 'hydrateSessionUsage'
    | 'contractOperator'
    | 'codeIndexStore'
    | 'codeIndexReindexScheduler'
    | 'isPassiveCodeInjectionFlagEnabled'
    | 'getMainSessionTurnInjections'
  >,
): BootstrapCommandSessionSection {
  return {
    ...projectCommandSessionSection(options),
    contractRunner: options.contractRunner,
    contractOperator: options.contractOperator,
    codeIndexStore: options.codeIndexStore,
    codeIndexReindexScheduler: options.codeIndexReindexScheduler,
    isPassiveCodeInjectionFlagEnabled: options.isPassiveCodeInjectionFlagEnabled,
    getMainSessionTurnInjections: options.getMainSessionTurnInjections,
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
    | 'surface'
    | 'keybindingsManager'
    | 'fileUndoManager'
    | 'workspaceCheckpointManager'
    | 'gatewayMethods'
    | 'workspaceTrustManager'
    | 'workspaceRegistrationManager'
    | 'profileManager'
    | 'bookmarkManager'
    | 'projectPlanningService'
    | 'projectPlanningProjectId'
    | 'workPlanStore'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandWorkspaceSection {
  return {
    ...projectCommandWorkspaceSection(options),
    surface: options.surface,
    workspaceCheckpointManager: options.workspaceCheckpointManager,
    gatewayMethods: options.gatewayMethods,
    workspaceTrustManager: options.workspaceTrustManager,
    workspaceRegistrationManager: options.workspaceRegistrationManager,
    ...shellServices.workspace,
  };
}

export function createBootstrapCommandPlatformSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    | 'configManager'
    | 'pairingTokens'
    | 'featureFlagManager'
    | 'voiceProviderRegistry'
    | 'voiceService'
    | 'webSearchService'
    | 'mediaProviders'
    | 'artifactStore'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandPlatformSection {
  return {
    config: getConfigSnapshot(options.configManager),
    configManager: options.configManager,
    ...(options.pairingTokens ? { pairingTokens: options.pairingTokens } : {}),
    featureFlagManager: options.featureFlagManager,
    voiceProviderRegistry: options.voiceProviderRegistry,
    voiceService: options.voiceService,
    webSearchService: options.webSearchService,
    mediaProviders: options.mediaProviders,
    artifactStore: options.artifactStore,
    ...shellServices.platform,
  };
}

export function createBootstrapCommandOpsSection(shellServices: BootstrapCommandShellServices): BootstrapCommandOpsSection {
  return shellServices.ops;
}

export function createBootstrapCommandExtensionsSection(
  options: Pick<BootstrapCommandSectionOptions, 'toolRegistry' | 'mcpRegistry'>,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandExtensionSection {
  return {
    toolRegistry: options.toolRegistry,
    mcpRegistry: options.mcpRegistry,
    ...shellServices.extensions,
    // One read model per command context, shared by /eval run, gate and compare.
    evalRegistry: new EvalRegistry(),
  };
}

export function createBootstrapCommandClientsSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    | 'operatorClient'
    | 'userPermissionRuleStore'
    | 'peerClient'
    | 'providerApi'
    | 'knowledgeApi'
    | 'memorySpine'
    | 'hookApi'
    | 'mcpApi'
    | 'opsApi'
    | 'directTransport'
  >,
): BootstrapCommandClientSection {
  return {
    ...projectCommandClientsSection(options),
    userPermissionRuleStore: options.userPermissionRuleStore,
    knowledgeApi: options.knowledgeApi,
    memorySpine: options.memorySpine,
  };
}
