import {
  createCommandServiceAccessors,
  createCommandPathAccessors,
  requireContextValue,
} from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
export { requireShellPaths, requirePluginPathOptions } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
export const {
  requireSession,
  requireProvider,
  requireWorkspace,
  requirePlatform,
  requireOps,
  requireExtensions,
  requireReadModels,
  requireKeybindingsManager,
  requireProfileManager,
  requireBookmarkManager,
  requireSessionManager,
  requireSecretsManager,
  requireSubscriptionManager,
  requireServiceRegistry,
  requireLocalUserAuthManager,
  requireTokenAuditor,
  requireReplayEngine,
  requireWebhookNotifier,
  requireSessionMemoryStore,
  requireSessionLineageTracker,
  requireSessionChangeTracker,
  requirePlanManager,
  requireAdaptivePlanner,
  requireSessionOrchestration,
  requireForensicsRegistry,
  requirePluginManager,
  requirePolicyRuntimeState,
  requireMcpRegistry,
  requireToolRegistry,
  requireHookWorkbench,
  requireIntegrationHelpers,
  requireProviderOptimizer,
  requireFavoritesStore,
  requireBenchmarkStore,
  requireRemoteRuntime,
  requireOperatorClient,
  requirePeerClient,
  requireProviderApi,
  requireHookApi,
  requireMcpApi,
  requireDirectTransport,
  requireAgentManager,
  requireModeManager,
  requireAutomationManager,
} = createCommandServiceAccessors<CommandContext>();
export const { requireEcosystemCatalogPaths } = createCommandPathAccessors(GOODVIBES_AGENT_SURFACE_ROOT);
import type { CommandContext } from '../command-registry.ts';





import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';




import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';



export function requireVoiceSetup(context: CommandContext) {
  return requireContextValue(context.platform.voiceSetup, 'platform.voiceSetup');
}

export function requireMemoryGovernor(context: CommandContext) {
  return requireContextValue(context.platform.memoryGovernor, 'platform.memoryGovernor');
}

export async function compactConversation(context: CommandContext): Promise<void> {
  await context.session.conversationManager.compact(
    context.provider.providerRegistry,
    context.session.runtime.model,
    'manual',
    context.session.runtime.provider,
  );
}

export function requireAgentKnowledgeApi(context: CommandContext): KnowledgeApi {
  return requireContextValue(context.clients?.agentKnowledgeApi, 'clients.agentKnowledgeApi');
}

export function requireKnowledgeApi(context: CommandContext): KnowledgeApi {
  return requireAgentKnowledgeApi(context);
}
