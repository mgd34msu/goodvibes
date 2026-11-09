import { composeTerminalCommandContext } from '@goodvibes-jev/engine/terminal-shell/bootstrap-command-context';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { AdaptivePlanner } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemorySpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { HookApi } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { McpApi } from '@goodvibes-jev/engine/platform/platform/mcp';
import type { ProviderApi } from '@goodvibes-jev/engine/platform/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { FileUndoManager } from '@goodvibes-jev/engine/platform/platform/state';
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
} from '@/runtime/index.ts';
import { createBootstrapCommandShellServices, type PlanRuntimeService, type RemoteCommandService } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/platform/platform/voice';
import {
  createBootstrapCommandActions,
  createBootstrapCommandClientsSection,
  createBootstrapCommandExtensionsSection,
  createBootstrapCommandOpsSection,
  createBootstrapCommandPlatformSection,
  createBootstrapCommandProviderSection,
  createBootstrapCommandSessionSection,
  createBootstrapCommandWorkspaceSection,
} from './bootstrap-command-parts.ts';

export type CreateBootstrapCommandContextOptions = {
  configManager: ConfigManager;
  pairingTokens?: import('@goodvibes-jev/engine/platform/platform/pairing').PairingTokenManager;
  featureFlagManager?: import('@/runtime/index.ts').FeatureFlagManager;
  providerRegistry: ProviderRegistry;
  conversation: ConversationManager;
  runtime: MutableRuntimeState;
  requestRender: () => void;
  keybindingsManager?: KeybindingsManager;
  requestPermission: PermissionRequestHandler;
  toolRegistry: ToolRegistry;
  mcpRegistry: McpRegistry;
  voiceProviderRegistry?: VoiceProviderRegistry;
  voiceService?: VoiceService;
  /** Direct-command consumers (`/search`, `/image`) of already-constructed RuntimeServices. */
  webSearchService?: import('@goodvibes-jev/engine/platform/platform/web-search').WebSearchService;
  mediaProviders?: import('@goodvibes-jev/engine/platform/platform/media').MediaProviderRegistry;
  artifactStore?: import('@goodvibes-jev/engine/platform/platform/artifacts').ArtifactStore;
  forensicsRegistry: ForensicsRegistry;
  policyRuntimeState: PolicyRuntimeState;
  readModels: UiReadModels;
  shellPaths: ShellPathService;
  /** The runtime's declare-once session-storage handle (runtime/services.ts). */
  surface: SessionSurface;
  remoteRuntime?: RemoteCommandService;
  planRuntime?: PlanRuntimeService;
  fileUndoManager: FileUndoManager;
  workspaceCheckpointManager?: WorkspaceCheckpointManager;
  gatewayMethods?: GatewayMethodCatalog;
  workspaceTrustManager?: WorkspaceTrustManager;
  workspaceRegistrationManager?: WorkspaceRegistrationManager;
  memoryRegistry?: MemoryRegistry;
  integrationHelpers?: IntegrationHelperService;
  automationManager?: ShellAutomationManagerRuntimeService;
  knowledgeService?: KnowledgeService;
  projectPlanningService?: import('@goodvibes-jev/engine/platform/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlanStore?: import('@goodvibes-jev/engine/platform/platform/workflow').WorkPlanStore;
  providerOptimizer?: import('@goodvibes-jev/engine/platform/platform/providers').ProviderOptimizer;
  pluginManager?: PluginManager;
  hookWorkbench?: HookWorkbench;
  agentManager?: ShellAgentManagerService;
  modeManager?: ShellModeManagerService;
  sessionManager?: import('@goodvibes-jev/engine/platform/platform/sessions').SessionManager;
  profileManager?: import('@goodvibes-jev/engine/platform/platform/profiles').ProfileManager;
  bookmarkManager?: import('@goodvibes-jev/engine/platform/platform/bookmarks').BookmarkManager;
  favoritesStore?: import('@goodvibes-jev/engine/platform/platform/providers').FavoritesStore;
  benchmarkStore?: import('@goodvibes-jev/engine/platform/platform/providers').BenchmarkStore;
  providerApi?: ProviderApi;
  subscriptionManager?: import('@goodvibes-jev/engine/platform/platform/config').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('@goodvibes-jev/engine/platform/platform/config').ServiceRegistry;
  localUserAuthManager?: import('@goodvibes-jev/engine/platform/platform/security').UserAuthManager;
  tokenAuditor?: import('@goodvibes-jev/engine/platform/platform/security').ApiTokenAuditor;
  replayEngine?: import('@goodvibes-jev/engine/platform/platform/core').DeterministicReplayEngine;
  webhookNotifier?: import('@goodvibes-jev/engine/platform/platform/integrations').WebhookNotifier;
  sessionMemoryStore?: import('@goodvibes-jev/engine/platform/platform/core').SessionMemoryStore;
  changeTracker?: import('@goodvibes-jev/engine/platform/platform/sessions').SessionChangeTracker;
  planManager?: ShellPlanManagerService;
  adaptivePlanner?: AdaptivePlanner;
  sessionOrchestration?: ShellSessionOrchestrationService;
  operatorClient?: OperatorClient;
  userPermissionRuleStore?: import('@goodvibes-jev/engine/platform/platform/permissions').UserPermissionRuleStore;
  peerClient?: PeerClient;
  knowledgeApi?: KnowledgeApi;
  memorySpine?: MemorySpineClient;
  hookApi?: HookApi;
  mcpApi?: McpApi;
  opsApi?: OpsApi;
  directTransport?: DirectTransport;
  worktreeRegistry: WorktreeRegistry;
  sandboxSessionRegistry: SandboxSessionRegistry;
  loadSystemPrompt: () => string;
  activatePlan: (planId: string, task: string) => void;
  completeModelSelectionSideEffect?: () => void;
  sessionLineageTracker?: import('@goodvibes-jev/engine/platform/platform/core').SessionLineageTracker;
  contractRunner?: import('@goodvibes-jev/engine/platform/platform/contract').ContractRunner;
  componentHealthMonitor: import('@/runtime/index.ts').ComponentHealthMonitor;
  hydrateSessionUsage?: () => void;
  contractOperator?: import('@goodvibes-jev/engine/platform/platform/contract').ContractOperatorService;
  codeIndexStore?: import('@goodvibes-jev/engine/platform/platform/state').CodeIndexStore;
  codeIndexReindexScheduler?: import('@goodvibes-jev/engine/platform/platform/state').CodeIndexReindexScheduler;
  isPassiveCodeInjectionFlagEnabled?: () => boolean;
  getMainSessionTurnInjections?: () => readonly import('../renderer/turn-injection.ts').TurnInjectionEntry[];
};

export function createBootstrapCommandContext(options: CreateBootstrapCommandContextOptions): CommandContext {
  return composeTerminalCommandContext(
    options,
    [
      'providerRegistry',
      'configManager',
      'pairingTokens',
      'featureFlagManager',
      'conversation',
      'runtime',
      'requestRender',
      'keybindingsManager',
      'requestPermission',
      'toolRegistry',
      'mcpRegistry',
      'voiceProviderRegistry',
      'voiceService',
      'webSearchService',
      'mediaProviders',
      'artifactStore',
      'forensicsRegistry',
      'policyRuntimeState',
      'readModels',
      'shellPaths',
      'surface',
      'remoteRuntime',
      'planRuntime',
      'fileUndoManager',
      'workspaceCheckpointManager',
      'gatewayMethods',
      'workspaceTrustManager',
      'workspaceRegistrationManager',
      'memoryRegistry',
      'integrationHelpers',
      'automationManager',
      'knowledgeService',
      'projectPlanningService',
      'projectPlanningProjectId',
      'workPlanStore',
      'providerOptimizer',
      'pluginManager',
      'hookWorkbench',
      'agentManager',
      'modeManager',
      'sessionManager',
      'profileManager',
      'bookmarkManager',
      'favoritesStore',
      'benchmarkStore',
      'providerApi',
      'subscriptionManager',
      'secretsManager',
      'serviceRegistry',
      'localUserAuthManager',
      'tokenAuditor',
      'replayEngine',
      'webhookNotifier',
      'sessionMemoryStore',
      'sessionLineageTracker',
      'contractRunner',
      'changeTracker',
      'hydrateSessionUsage',
      'contractOperator',
      'codeIndexStore',
      'codeIndexReindexScheduler',
      'isPassiveCodeInjectionFlagEnabled',
      'getMainSessionTurnInjections',
      'planManager',
      'adaptivePlanner',
      'sessionOrchestration',
      'operatorClient',
      'userPermissionRuleStore',
      'peerClient',
      'knowledgeApi',
      'memorySpine',
      'hookApi',
      'mcpApi',
      'opsApi',
      'directTransport',
      'worktreeRegistry',
      'sandboxSessionRegistry',
      'loadSystemPrompt',
      'activatePlan',
      'completeModelSelectionSideEffect',
      'componentHealthMonitor',
    ],
    {
      shell: createBootstrapCommandShellServices,
      session: createBootstrapCommandSessionSection,
      provider: createBootstrapCommandProviderSection,
      workspace: createBootstrapCommandWorkspaceSection,
      platform: createBootstrapCommandPlatformSection,
      extensions: createBootstrapCommandExtensionsSection,
      clients: createBootstrapCommandClientsSection,
      actions: createBootstrapCommandActions,
      ops: (shell) => createBootstrapCommandOpsSection(shell),
    },
  );
}
