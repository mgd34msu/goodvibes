import { composeTerminalCommandContext } from '@goodvibes/engine/terminal-shell/bootstrap-command-context';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@goodvibes/engine/platform/platform/knowledge';
import type { HookApi } from '@goodvibes/engine/platform/platform/hooks';
import type { MemorySpineClient } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import type { McpApi } from '@goodvibes/engine/platform/platform/mcp';
import type { ProviderApi } from '@goodvibes/engine/platform/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { AgentPromptContextReceiptStore } from '@goodvibes/engine/terminal-shell/agent-turn/prompt-context-receipts';
import type { ConsolidationReceiptSource } from '../agent/memory-consolidation-proposals.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@goodvibes/engine/platform/platform/permissions';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { FileUndoManager } from '@goodvibes/engine/platform/platform/state';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import type { MemoryRegistry } from '@goodvibes/engine/platform/platform/state';
import type { IntegrationHelperService } from '@/runtime/index.ts';
import type { KnowledgeService } from '@goodvibes/engine/platform/platform/knowledge';
import type { PluginManager } from '@goodvibes/engine/platform/platform/plugins';
import type { HookWorkbench } from '@goodvibes/engine/platform/platform/hooks';
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
} from '@/runtime/index.ts';
import { createBootstrapCommandShellServices } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes/engine/platform/platform/voice';
import type { AgentMemoryDiagnostics, AgentVoiceSetupService } from './services.ts';
import type { MediaProviderRegistry } from '@goodvibes/engine/platform/platform/media';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { ChannelDeliveryRouter } from '@goodvibes/engine/platform/platform/channels';
import type { AgentExecutionLedger } from './execution-ledger.ts';
import type { ApprovalsView } from './client/approvals-view.ts';
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
  voiceSetup?: AgentVoiceSetupService;
  runtimeStore?: { getState(): object };
  memoryGovernor?: AgentMemoryDiagnostics;
  mediaProviderRegistry?: MediaProviderRegistry;
  artifactStore?: ArtifactStore;
  channelDeliveryRouter?: ChannelDeliveryRouter;
  devices?: import('@goodvibes/engine/platform/platform/runtime/client').DevicesClient;
  forensicsRegistry: ForensicsRegistry;
  policyRuntimeState: PolicyRuntimeState;
  readModels: UiReadModels;
  shellPaths: ShellPathService;
  fileUndoManager: FileUndoManager;
  workspaceCheckpointManager?: import('@goodvibes/engine/platform/platform/workspace').WorkspaceCheckpointManager;
  processManager?: import('@goodvibes/engine/platform/platform/tools').ProcessManager;
  /** The owner's trust of this workspace, which what a repository brings (its hooks file, its MCP files) waits on. */
  workspaceTrustManager?: import('@goodvibes/engine/platform/platform/runtime/operations').WorkspaceTrustManager;
  executionLedger?: AgentExecutionLedger;
  approvalsView?: ApprovalsView;
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
  sessionOrchestration?: ShellSessionOrchestrationService;
  operatorClient?: OperatorClient;
  peerClient?: PeerClient;
  agentKnowledgeApi?: KnowledgeApi;
  memorySpine?: MemorySpineClient;
  promptContextReceipts?: AgentPromptContextReceiptStore;
  hookApi?: HookApi;
  mcpApi?: McpApi;
  opsApi?: OpsApi;
  directTransport?: DirectTransport;
  worktreeRegistry: WorktreeRegistry;
  sandboxSessionRegistry: SandboxSessionRegistry;
  memoryConsolidationScheduler?: ConsolidationReceiptSource;
  loadSystemPrompt: () => string;
  activatePlan: (planId: string, task: string) => void;
  completeModelSelectionSideEffect?: () => void;
  sessionLineageTracker?: import('@goodvibes/engine/platform/platform/core').SessionLineageTracker;
  writeLastSessionPointer?: (sessionId: string) => void;
  announceSessionResumed?: (resumedSessionId: string, turnCount: number) => void;
  announceSessionRecoveryFailed?: (sessionId: string, reason: string) => void;
  surface?: import('@/runtime/index.ts').SessionSurface;
  hydrateSessionUsage?: () => void;
  contractOperator?: import('@goodvibes/engine/platform/platform/contract').ContractOperatorService;
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
      ops: (shell, options) =>
        createBootstrapCommandOpsSection(shell, { executionLedger: options.executionLedger, approvalsView: options.approvalsView }),
    },
  );
}
