import { registerTriggerCommands } from './commands/trigger-supervisor.ts';
import { registerWorkPlanRuntimeCommands } from './commands/workplan-runtime.ts';
import { registerWorkstreamRuntimeCommands } from './commands/workstream-runtime.ts';
import type { CommandRegistry } from './command-registry.ts';
import type { CommandContext } from './command-registry.ts';
import { sessionCommand } from './commands/session.ts';
import { recallCommand } from './commands/memory.ts';
import { knowledgeCommand } from './commands/knowledge.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerScheduleRuntimeCommands } from './commands/schedule-runtime.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
import { registerProductRuntimeCommands } from './commands/product-runtime.ts';
import { registerPlatformAccessRuntimeCommands } from './commands/platform-access-runtime.ts';
import { registerGuidanceRuntimeCommands } from './commands/guidance-runtime.ts';
import { registerStateRuntimeCommands } from './commands/state-runtime.ts';
import { registerSubscriptionRuntimeCommands } from './commands/subscription-runtime.ts';
import { registerSecurityRuntimeCommands } from './commands/security-runtime.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerDevicesRuntimeCommands } from './commands/devices-runtime.ts';
import { registerExperienceRuntimeCommands } from './commands/experience-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerLocalProviderRuntimeCommands } from './commands/local-provider-runtime.ts';
import { registerNetworkScanRuntimeCommands } from './commands/network-scan-runtime.ts';
import { registerHealthRuntimeCommands } from './commands/health-runtime.ts';
import { registerStatusRuntimeCommands } from './commands/status-runtime.ts';
import { registerProviderAccountsRuntimeCommands } from './commands/provider-accounts-runtime.ts';
import { registerConversationRuntimeCommands } from './commands/conversation-runtime.ts';
import { registerQrcodeRuntimeCommands } from './commands/qrcode-runtime.ts';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerTtsRuntimeCommands } from './commands/tts-runtime.ts';
import { registerAgentWorkspaceRuntimeCommands } from './commands/agent-workspace-runtime.ts';
import { registerLegacyWorkLedgerImportCommands } from './commands/legacy-work-ledger-import-runtime.ts';
import { registerAgentRuntimeProfileRuntimeCommands } from './commands/agent-runtime-profile-runtime.ts';
import { registerDelegationRuntimeCommands } from './commands/delegation-runtime.ts';
import { registerPersonasRuntimeCommands } from './commands/personas-runtime.ts';
import { registerVibeRuntimeCommands } from './commands/vibe-runtime.ts';
import { registerAgentSkillsRuntimeCommands } from './commands/agent-skills-runtime.ts';
import { registerRoutinesRuntimeCommands } from './commands/routines-runtime.ts';
import { registerChannelsRuntimeCommands } from './commands/channels-runtime.ts';
import { registerTelegramIntakeCommands } from './commands/telegram-intake-runtime.ts';
import { registerBriefRuntimeCommands } from './commands/brief-runtime.ts';
import { registerSupportBundleRuntimeCommands } from './commands/support-bundle-runtime.ts';
import { registerCompatRuntimeCommands } from './commands/compat-runtime.ts';
import { registerOwnerProfileRuntimeCommands } from './commands/owner-profile-runtime.ts';
import { registerOperatorActionRuntimeCommands } from './commands/operator-actions-runtime.ts';
import { registerConnectedHostAdminCommands } from './commands/connected-host-admin-runtime.ts';
import { registerOwnerInboxCommands } from './commands/owner-inbox-runtime.ts';
import { registerCloudflareRuntimeCommands } from './commands/cloudflare-runtime.ts';
import { registerHeldCallsCommands } from './commands/held-calls-runtime.ts';
import { registerIntelligenceRuntimeCommands } from './commands/intelligence-runtime.ts';
import { registerEmailRuntimeCommands } from './commands/email-runtime.ts';
import { registerCalendarRuntimeCommands } from './commands/calendar-runtime.ts';
import { registerGoogleRuntimeCommands } from './commands/google-runtime.ts';
import { registerUpdateCommand } from './commands/update-runtime.ts';
import { registerPaymentCardCommands } from './commands/payment-card-intake.ts';
import { commandVerbPolicy, declareCommandVerbs, SHARED_COMMAND_VERBS } from './commands/command-verbs.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';
import type { RememberedRuleStore } from '@goodvibes-jev/engine/platform/platform/gate/policy';

function registerAgentMemoryCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'memory',
    effect: 'local-state',
    readVerbs: ['list', 'search', 'queue', 'snapshots'],
    aliases: ['mem'],
    description: 'Agent-local memory: add, search, review, stale, and delete durable memory records; list its copies and restore one',
    usage: '<list|add|search|get|link|queue|review|stale|contradict|promote|remove|snapshots|restore> [args]',
    argsHint: 'list|add|search|get|link|queue|review|stale|contradict|promote|remove|snapshots|restore',
    // The same lines ask the owner as under /recall (remove, restore).
    confirm: recallCommand.confirm,
    handler: async (args: string[], context: CommandContext): Promise<void> => {
      await recallCommand.handler(args.length === 0 ? ['list'] : args, context);
    },
  });
}

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup. `rememberedRules` returns the
 * remembered-approval store `/permissions` lists and revokes from.
 */
export function registerBuiltinCommands(
  registry: CommandRegistry,
  options: { readonly rememberedRules?: (() => RememberedRuleStore | undefined) | undefined } = {},
): void {
  registerShellCoreCommands(registry);
  registerTriggerCommands(registry);
  registerAgentWorkspaceRuntimeCommands(registry);
  registerWorkPlanRuntimeCommands(registry);
  registerWorkstreamRuntimeCommands(registry);
  registerLegacyWorkLedgerImportCommands(registry);
  registerBriefRuntimeCommands(registry);
  registerSupportBundleRuntimeCommands(registry);
  registerCompatRuntimeCommands(registry);
  registerOwnerProfileRuntimeCommands(registry);
  registerOperatorActionRuntimeCommands(registry);
  registerConnectedHostAdminCommands(registry);
  registerOwnerInboxCommands(registry);
  registerCloudflareRuntimeCommands(registry);
  registerHeldCallsCommands(registry);
  registerIntelligenceRuntimeCommands(registry);
  registerCalendarRuntimeCommands(registry);
  registerAgentRuntimeProfileRuntimeCommands(registry);
  registerVibeRuntimeCommands(registry);
  registerPersonasRuntimeCommands(registry);
  registerAgentSkillsRuntimeCommands(registry);
  registerRoutinesRuntimeCommands(registry);
  registerChannelsRuntimeCommands(registry);
  registerTelegramIntakeCommands(registry);
  registerEmailRuntimeCommands(registry);
  registerGoogleRuntimeCommands(registry);
  registerDelegationRuntimeCommands(registry);
  registerConfigCommand(registry);
  registerOperatorRuntimeCommands(registry);
  registerNotifyRuntimeCommands(registry);
  registerProductRuntimeCommands(registry);
  registerPlatformAccessRuntimeCommands(registry);
  registerGuidanceRuntimeCommands(registry);
  registerStateRuntimeCommands(registry);
  registerSubscriptionRuntimeCommands(registry);
  registerSecurityRuntimeCommands(registry);
  registerMcpRuntimeCommands(registry);
  registerExperienceRuntimeCommands(registry);
  registerTasksRuntimeCommands(registry);
  registerLocalProviderRuntimeCommands(registry);
  registerNetworkScanRuntimeCommands(registry);
  registerHealthRuntimeCommands(registry);
  registerStatusRuntimeCommands(registry);
  registerUpdateCommand(registry);
  registerProviderAccountsRuntimeCommands(registry);
  registerConversationRuntimeCommands(registry);
  registerQrcodeRuntimeCommands(registry);
  registerOnboardingRuntimeCommands(registry);
  registerTtsRuntimeCommands(registry);
  registerLocalRuntimeCommands(registry);
  registerDevicesRuntimeCommands(registry);
  registerScheduleRuntimeCommands(registry);
  registerSessionContentCommands(registry);
  registerPaymentCardCommands(registry);
  registerAgentMemoryCommand(registry);

  // ── /session ─────────────────────────────────────────────────────────────
  registry.register(sessionCommand);

  // ── /knowledge ───────────────────────────────────────────────────────────
  registry.register(knowledgeCommand);

  // Shared commands state which of their verbs only read; the model's command runner reads it.
  for (const [name, verbs] of Object.entries(SHARED_COMMAND_VERBS)) {
    const command = registry.get(name);
    if (command) declareCommandVerbs(command, verbs);
  }

  registerPermissionsRuntimeCommands(registry, options.rememberedRules ?? (() => undefined));

  // The model's command runner admits a run from what the command declares, so
  // a command that declares nothing is a start-up error here rather than a
  // refusal the model meets later. One pass over the registered commands.
  const undeclared = registry.getAll().filter((command) => command.effect === undefined && commandVerbPolicy(command, []) === undefined);
  if (undeclared.length > 0) {
    throw new Error(`Commands without a declared effect: ${undeclared.map((command) => `/${command.name}`).join(', ')}. Declare \`effect\` (and \`readVerbs\` for a command whose verbs differ) on each definition.`);
  }
}
