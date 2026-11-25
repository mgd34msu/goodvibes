import type { ForensicsRegistry } from './forensics/index.js';
import type { IntegrationHelperService } from './integration/helpers.js';
import type { HookWorkbench } from '../hooks/workbench.js';
import type { KnowledgeService } from '../knowledge/index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import type { ShellPathService } from './shell-paths.js';
import type { WorktreeRegistry } from './worktree/registry.js';
import type { SandboxSessionRegistry } from './sandbox/session-registry.js';
import type { CommandExtensionShellServices } from './shell-command-extensions.js';
import type { CommandOpsShellServices, RemoteCommandService } from './shell-command-ops.js';
import type { CommandPlatformShellServices } from './shell-command-platform.js';
import type { CommandWorkspaceShellServices } from './shell-command-workspace.js';

export type { CommandWorkspaceShellServices } from './shell-command-workspace.js';
export type { CommandPlatformShellServices } from './shell-command-platform.js';
export type {
  ShellAgentManagerService,
  ShellAcpManagerService,
  ShellAutomationManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from './shell-command-ops.js';
export type { CommandOpsShellServices, RemoteCommandService } from './shell-command-ops.js';
export type { CommandExtensionShellServices } from './shell-command-extensions.js';

export interface BootstrapCommandShellServices {
  readonly workspace: CommandWorkspaceShellServices;
  readonly platform: CommandPlatformShellServices;
  readonly ops: CommandOpsShellServices;
  readonly extensions: CommandExtensionShellServices;
}

export interface CreateBootstrapCommandShellServicesOptions {
  readonly agentManager?: import('./shell-command-ops.js').ShellAgentManagerService | undefined;
  readonly acpManager?: import('./shell-command-ops.js').ShellAcpManagerService | undefined;
  readonly automationManager?: import('./shell-command-ops.js').ShellAutomationManagerRuntimeService | undefined;
  readonly modeManager?: import('./shell-command-ops.js').ShellModeManagerService | undefined;
  readonly planManager?: import('./shell-command-ops.js').ShellPlanManagerService | undefined;
  readonly sessionOrchestration?: import('./shell-command-ops.js').ShellSessionOrchestrationService | undefined;
  readonly shellPaths: ShellPathService;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly readModels: import('./ui-read-models.js').UiReadModels;
  readonly serviceRegistry?: import('../config/service-registry.js').ServiceRegistry | undefined;
  readonly subscriptionManager?: import('../config/subscriptions.js').SubscriptionManager | undefined;
  readonly secretsManager?: import('../config/secrets.js').SecretsManager | undefined;
  readonly localUserAuthManager?: import('../security/user-auth.js').UserAuthManager | undefined;
  readonly tokenAuditor?: import('../security/token-audit.js').ApiTokenAuditor | undefined;
  readonly replayEngine?: import('../core/deterministic-replay.js').DeterministicReplayEngine | undefined;
  readonly webhookNotifier?: import('../integrations/webhooks.js').WebhookNotifier | undefined;
  readonly remoteRuntime?: RemoteCommandService | undefined;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly memoryRegistry?: import('../state/memory-store.js').MemoryRegistry | undefined;
  readonly integrationHelpers?: IntegrationHelperService | undefined;
  readonly knowledgeService?: KnowledgeService | undefined;
  readonly pluginManager?: PluginManager | undefined;
  readonly hookWorkbench?: HookWorkbench | undefined;
}

/**
 * The four sections a command context reads. Each is its interface's fields
 * taken from the options as given: a service is added by naming it in its
 * section interface and in the options, nowhere else.
 */
export function createBootstrapCommandShellServices(
  options: CreateBootstrapCommandShellServicesOptions,
): BootstrapCommandShellServices {
  const workspace: CommandWorkspaceShellServices = {
    shellPaths: options.shellPaths,
    worktreeRegistry: options.worktreeRegistry,
    sandboxSessionRegistry: options.sandboxSessionRegistry,
  };
  const platform: CommandPlatformShellServices = {
    readModels: options.readModels,
    serviceRegistry: options.serviceRegistry,
    subscriptionManager: options.subscriptionManager,
    secretsManager: options.secretsManager,
    localUserAuthManager: options.localUserAuthManager,
    tokenAuditor: options.tokenAuditor,
    replayEngine: options.replayEngine,
    webhookNotifier: options.webhookNotifier,
  };
  const ops: CommandOpsShellServices = {
    agentManager: options.agentManager,
    acpManager: options.acpManager,
    automationManager: options.automationManager,
    modeManager: options.modeManager,
    planManager: options.planManager,
    sessionOrchestration: options.sessionOrchestration,
    remoteRuntime: options.remoteRuntime,
  };
  const extensions: CommandExtensionShellServices = {
    forensicsRegistry: options.forensicsRegistry,
    policyRuntimeState: options.policyRuntimeState,
    memoryRegistry: options.memoryRegistry,
    integrationHelpers: options.integrationHelpers,
    knowledgeService: options.knowledgeService,
    pluginManager: options.pluginManager,
    hookWorkbench: options.hookWorkbench,
  };
  return { workspace, platform, ops, extensions };
}

export { createShellRemoteCommandService } from './shell-command-ops.js';
