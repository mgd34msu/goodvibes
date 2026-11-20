import { composeTerminalCommandContext } from '@goodvibes/engine/terminal-shell/bootstrap-command-context';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { AdaptivePlanner } from '@goodvibes/engine/platform/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@goodvibes/engine/platform/platform/knowledge';
import type { MemorySpineClient } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import type { HookApi } from '@goodvibes/engine/platform/platform/hooks';
import type { McpApi } from '@goodvibes/engine/platform/platform/mcp';
import type { ProviderApi } from '@goodvibes/engine/platform/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@goodvibes/engine/platform/platform/permissions';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { FileUndoManager } from '@goodvibes/engine/platform/platform/state';
import type { WorkspaceCheckpointManager } from '@goodvibes/engine/platform/platform/workspace';
import type { GatewayMethodCatalog } from '@goodvibes/engine/platform/platform/control-plane';
import type { WorkspaceTrustManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { WorkspaceRegistrationManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import type { MemoryRegistry } from '@goodvibes/engine/platform/platform/state';
import type { IntegrationHelperService } from '@/runtime/index.ts';
import type { KnowledgeService } from '@goodvibes/engine/platform/platform/knowledge';
import type { PluginManager } from '@goodvibes/engine/platform/platform/plugins';
import type { HookWorkbench } from '@goodvibes/engine/platform/platform/hooks';
import type { WorktreeRegistry } from '@/runtime/index.ts';
import type { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService, SessionSurface } from '@/runtime/index.ts';
import type {
  ShellAcpManagerService,
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
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes/engine/platform/platform/voice';
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
  pairingTokens?: import('@goodvibes/engine/platform/platform/pairing').PairingTokenManager;
  devices?: import('@goodvibes/engine/platform/platform/runtime/client').DevicesClient;
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
  voiceSetup?: import('@goodvibes/engine/platform/platform/runtime/voice-setup').VoiceSetupService;
  runtimeStore?: { getState(): object };
  /** Direct-command consumers (`/web-search`, `/media`) of already-constructed RuntimeServices. */
  webSearchService?: import('@goodvibes/engine/platform/platform/web-search').WebSearchService;
  mediaProviders?: import('@goodvibes/engine/platform/platform/media').MediaProviderRegistry;
  artifactStore?: import('@goodvibes/engine/platform/platform/artifacts').ArtifactStore;
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
  projectPlanningService?: import('@goodvibes/engine/platform/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlan?: import('@goodvibes/engine/platform/platform/knowledge').ProjectWorkPlan;
  providerOptimizer?: import('@goodvibes/engine/platform/platform/providers').ProviderOptimizer;
  pluginManager?: PluginManager;
  hookWorkbench?: HookWorkbench;
  agentManager?: ShellAgentManagerService;
  acpManager?: ShellAcpManagerService;
  modeManager?: ShellModeManagerService;
  sessionManager?: import('@goodvibes/engine/platform/platform/sessions').SessionManager;
  profileManager?: import('@goodvibes/engine/platform/platform/profiles').ProfileManager;
  bookmarkManager?: import('@goodvibes/engine/platform/platform/bookmarks').BookmarkManager;
  favoritesStore?: import('@goodvibes/engine/platform/platform/providers').FavoritesStore;
  benchmarkStore?: import('@goodvibes/engine/platform/platform/providers').BenchmarkStore;
  providerApi?: ProviderApi;
  subscriptionManager?: import('@goodvibes/engine/platform/platform/config').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('@goodvibes/engine/platform/platform/config').ServiceRegistry;
  localUserAuthManager?: import('@goodvibes/engine/platform/platform/security').UserAuthManager;
  tokenAuditor?: import('@goodvibes/engine/platform/platform/security').ApiTokenAuditor;
  replayEngine?: import('@goodvibes/engine/platform/platform/core').DeterministicReplayEngine;
  webhookNotifier?: import('@goodvibes/engine/platform/platform/integrations').WebhookNotifier;
  sessionMemoryStore?: import('@goodvibes/engine/platform/platform/core').SessionMemoryStore;
  changeTracker?: import('@goodvibes/engine/platform/platform/sessions').SessionChangeTracker;
  planManager?: ShellPlanManagerService;
  adaptivePlanner?: AdaptivePlanner;
  sessionOrchestration?: ShellSessionOrchestrationService;
  operatorClient?: OperatorClient;
  userPermissionRuleStore?: import('@goodvibes/engine/platform/platform/permissions').UserPermissionRuleStore;
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
  sessionLineageTracker?: import('@goodvibes/engine/platform/platform/core').SessionLineageTracker;
  contractRunner?: import('@goodvibes/engine/platform/platform/contract').ContractRunner;
  hydrateSessionUsage?: () => void;
  contractOperator?: import('@goodvibes/engine/platform/platform/contract').ContractOperatorService;
  workstreamDrafts?: import('@goodvibes/engine/platform/platform/orchestration').WorkstreamDraftService;
  codeIndexStore?: import('@goodvibes/engine/platform/platform/state').CodeIndexStore;
  codeIndexReindexScheduler?: import('@goodvibes/engine/platform/platform/state').CodeIndexReindexScheduler;
  isPassiveCodeInjectionFlagEnabled?: () => boolean;
  getMainSessionTurnInjections?: () => readonly import('../renderer/turn-injection.ts').TurnInjectionEntry[];
};

export function createBootstrapCommandContext(options: CreateBootstrapCommandContextOptions): CommandContext {
  return composeTerminalCommandContext(
    options,
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
