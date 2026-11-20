import { registerTriggerCommands } from './commands/trigger-supervisor.ts';
import { registerHostPairingCommands } from './commands/host-pairing.ts';
import { CommandRegistry } from './command-registry.ts';
import type { SlashCommand } from './command-registry.ts';
import { policyCommand } from './commands/policy.ts';
import { providerCommand } from './commands/provider.ts';
import { evalCommand } from './commands/eval.ts';
import { sessionCommand, resumeCommand, saveCommand } from './commands/session.ts';
import { memoryCommand } from './commands/memory.ts';
import { knowledgeCommand } from './commands/knowledge.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerDiscoveryRuntimeCommands } from './commands/discovery-runtime.ts';
import { registerPlanningRuntimeCommands } from './commands/planning-runtime.ts';
import { registerPaymentCardCommands } from './commands/payment-card-intake.ts';
import { registerScheduleRuntimeCommands } from './commands/schedule-runtime.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
import { registerPluginRuntimeCommands } from './commands/plugin-runtime.ts';
import { registerDiffRuntimeCommands } from './commands/diff-runtime.ts';
import { registerGitRuntimeCommands } from './commands/git-runtime.ts';
import { registerQueueRuntimeCommands } from './commands/queue-runtime.ts';
import { registerPowerRuntimeCommands } from './commands/power-runtime.ts';
import { registerGraphRuntimeCommands } from './commands/graph-runtime.ts';
import { registerTestRuntimeCommands } from './commands/test-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
import { registerReplayRuntimeCommands } from './commands/replay-runtime.ts';
import { registerChannelRuntimeCommands } from './commands/channel-runtime.ts';
import { registerTelegramIntakeCommands } from './commands/telegram-intake-runtime.ts';
import { registerProductRuntimeCommands } from './commands/product-runtime.ts';
import { registerPlatformRuntimeCommands } from './commands/platform-runtime.ts';
import { registerProfileSyncRuntimeCommands } from './commands/profile-sync-runtime.ts';
import { registerManagedRuntimeCommands } from './commands/managed-runtime.ts';
import { registerPlatformAccessRuntimeCommands } from './commands/platform-access-runtime.ts';
import { registerPlatformServicesRuntimeCommands } from './commands/platform-services-runtime.ts';
import { registerTeamworkRuntimeCommands } from './commands/teamwork-runtime.ts';
import { registerMarketplaceRuntimeCommands } from './commands/marketplace-runtime.ts';
import { registerGuidanceRuntimeCommands } from './commands/guidance-runtime.ts';
import { registerStateRuntimeCommands } from './commands/state-runtime.ts';
import { registerRemoteRuntimeCommands } from './commands/remote-runtime.ts';
import { registerSubscriptionRuntimeCommands } from './commands/subscription-runtime.ts';
import { registerHooksRuntimeCommands } from './commands/hooks-runtime.ts';
import { registerEditorRuntimeCommands } from './commands/editor-runtime.ts';
import { registerControlRoomRuntimeCommands } from './commands/control-room-runtime.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerCheckpointRuntimeCommands } from './commands/checkpoint-runtime.ts';
import { registerRewindRuntimeCommands } from './commands/rewind-runtime.ts';
import { registerWorkstreamRuntimeCommands } from './commands/workstream-runtime.ts';
import { registerCodebaseRuntimeCommands } from './commands/codebase-runtime.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerExperienceRuntimeCommands } from './commands/experience-runtime.ts';
import { registerIncidentRuntimeCommands } from './commands/incident-runtime.ts';
import { registerSkillsRuntimeCommands } from './commands/skills-runtime.ts';
import { registerServicesRuntimeCommands } from './commands/services-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerLocalProviderRuntimeCommands } from './commands/local-provider-runtime.ts';
import { registerHealthRuntimeCommands } from './commands/health-runtime.ts';
import { registerStatusRuntimeCommands } from './commands/status-runtime.ts';
import { registerClusterRuntimeCommands } from './commands/cluster-runtime.ts';
import { registerSettingsSyncRuntimeCommands } from './commands/settings-sync-runtime.ts';
import { registerWorktreeRuntimeCommands } from './commands/worktree-runtime.ts';
import { registerAcpRuntimeCommands } from './commands/acp-runtime.ts';
import { registerProviderAccountsRuntimeCommands } from './commands/provider-accounts-runtime.ts';
import { registerLocalAuthRuntimeCommands } from './commands/local-auth-runtime.ts';
import { registerIntelligenceRuntimeCommands } from './commands/intelligence-runtime.ts';
import { registerQrcodeRuntimeCommands } from './commands/qrcode-runtime.ts';
import { registerDevicesRuntimeCommands } from './commands/devices-runtime.ts';
import { registerRelayRuntimeCommands } from './commands/relay-runtime.ts';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerTtsRuntimeCommands } from './commands/tts-runtime.ts';
import { registerCloudflareRuntimeCommands } from './commands/cloudflare-runtime.ts';
import { registerWorkPlanRuntimeCommands } from './commands/work-plan-runtime.ts';
import { registerCostRuntimeCommands } from './commands/cost-runtime.ts';
import { registerOwnerInboxCommands } from './commands/owner-inbox-runtime.ts';
import { registerHeldCallsCommands } from './commands/held-calls-runtime.ts';
import { registerWebSearchRuntimeCommands } from './commands/websearch-runtime.ts';
import { registerImageRuntimeCommands } from './commands/image-runtime.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';
import { registerReviewRuntimeCommands } from './commands/review-runtime.ts';
import { registerPaletteRuntimeCommands } from './commands/palette-runtime.ts';
import { registerCiRuntimeCommands } from './commands/ci-runtime.ts';
import { registerCheckinRuntimeCommands } from './commands/checkin-runtime.ts';
import { registerHostedRuntimeCommands } from './commands/hosted-runtime.ts';
import { registerMailRuntimeCommands } from './commands/mail-runtime.ts';
import { registerCalendarRuntimeCommands } from './commands/calendar-runtime.ts';
import { registerPrincipalsRuntimeCommands } from './commands/principals-runtime.ts';
import { registerProfileRuntimeCommands } from './commands/profile-runtime.ts';

/**
 * A named group of built-in commands. The `category` label is the single
 * source of truth for command categorization: it drives both the runtime
 * registration order (via {@link registerBuiltinCommands}) and the generated
 * command-reference docs / command palette grouping (via
 * {@link categorizeBuiltinCommands}). Adding a new command group here is the
 * only edit needed for it to appear, categorized, everywhere.
 */
export interface BuiltinCommandGroup {
  readonly category: string;
  readonly register: (registry: CommandRegistry) => void;
}

/**
 * Every built-in command group, in registration order. Keeping runtime
 * registration and doc/palette categorization on one array means a category
 * label can never drift between the two.
 */
export const BUILTIN_COMMAND_GROUPS: readonly BuiltinCommandGroup[] = [
  { category: 'Automation', register: registerTriggerCommands },
  { category: 'Shell & Session', register: registerShellCoreCommands },
  { category: 'Shell & Session', register: registerPaletteRuntimeCommands },
  { category: 'Configuration', register: registerConfigCommand },
  { category: 'Operator', register: registerOperatorRuntimeCommands },
  { category: 'Plugins', register: registerPluginRuntimeCommands },
  { category: 'Diff & Review', register: registerDiffRuntimeCommands },
  { category: 'Git', register: registerGitRuntimeCommands },
  { category: 'Shell & Session', register: registerQueueRuntimeCommands },
  { category: 'Shell & Session', register: registerPowerRuntimeCommands },
  { category: 'Automation', register: registerGraphRuntimeCommands },
  { category: 'Testing', register: registerTestRuntimeCommands },
  { category: 'Notifications', register: registerNotifyRuntimeCommands },
  { category: 'Sessions & Replay', register: registerReplayRuntimeCommands },
  { category: 'Channels', register: registerChannelRuntimeCommands },
  { category: 'Channels', register: registerTelegramIntakeCommands },
  { category: 'Product', register: registerProductRuntimeCommands },
  { category: 'Platform', register: registerPlatformRuntimeCommands },
  { category: 'Profiles', register: registerProfileSyncRuntimeCommands },
  { category: 'Managed Runtime', register: registerManagedRuntimeCommands },
  { category: 'Platform Access', register: registerPlatformAccessRuntimeCommands },
  { category: 'Platform Services', register: registerPlatformServicesRuntimeCommands },
  { category: 'Teamwork', register: registerTeamworkRuntimeCommands },
  { category: 'Marketplace', register: registerMarketplaceRuntimeCommands },
  { category: 'Guidance', register: registerGuidanceRuntimeCommands },
  { category: 'Diagnostics', register: registerStateRuntimeCommands },
  { category: 'Remote', register: registerRemoteRuntimeCommands },
  { category: 'Subscriptions', register: registerSubscriptionRuntimeCommands },
  { category: 'Hooks', register: registerHooksRuntimeCommands },
  { category: 'Editor', register: registerEditorRuntimeCommands },
  { category: 'Control Room', register: registerControlRoomRuntimeCommands },
  { category: 'MCP', register: registerMcpRuntimeCommands },
  { category: 'Incidents', register: registerIncidentRuntimeCommands },
  { category: 'Skills', register: registerSkillsRuntimeCommands },
  { category: 'Experience', register: registerExperienceRuntimeCommands },
  { category: 'Services', register: registerServicesRuntimeCommands },
  { category: 'Tasks', register: registerTasksRuntimeCommands },
  { category: 'Local Providers', register: registerLocalProviderRuntimeCommands },
  { category: 'Health', register: registerHealthRuntimeCommands },
  { category: 'Health', register: registerStatusRuntimeCommands },
  { category: 'Cluster', register: registerClusterRuntimeCommands },
  { category: 'Settings Sync', register: registerSettingsSyncRuntimeCommands },
  { category: 'Worktrees', register: registerWorktreeRuntimeCommands },
  { category: 'Agents', register: registerAcpRuntimeCommands },
  { category: 'Provider Accounts', register: registerProviderAccountsRuntimeCommands },
  { category: 'Local Auth', register: registerLocalAuthRuntimeCommands },
  { category: 'Intelligence', register: registerIntelligenceRuntimeCommands },
  { category: 'QR Codes', register: registerQrcodeRuntimeCommands },
  { category: 'Security', register: registerDevicesRuntimeCommands },
  { category: 'Security', register: registerHostPairingCommands },
  { category: 'Relay', register: registerRelayRuntimeCommands },
  { category: 'Onboarding', register: registerOnboardingRuntimeCommands },
  { category: 'Voice & TTS', register: registerTtsRuntimeCommands },
  { category: 'Cloudflare', register: registerCloudflareRuntimeCommands },
  { category: 'Work Plans', register: registerWorkPlanRuntimeCommands },
  { category: 'Cost', register: registerCostRuntimeCommands },
  { category: 'Local Runtime', register: registerLocalRuntimeCommands },
  { category: 'Discovery', register: registerDiscoveryRuntimeCommands },
  { category: 'Planning', register: registerPlanningRuntimeCommands },
  { category: 'Payments', register: registerPaymentCardCommands },
  { category: 'Scheduling', register: registerScheduleRuntimeCommands },
  { category: 'Session Content', register: registerSessionContentCommands },
  { category: 'Checkpoints', register: registerCheckpointRuntimeCommands },
  { category: 'Checkpoints', register: registerRewindRuntimeCommands },
  { category: 'Workstreams', register: registerWorkstreamRuntimeCommands },
  { category: 'Codebase', register: registerCodebaseRuntimeCommands },
  { category: 'Web Search', register: registerWebSearchRuntimeCommands },
  { category: 'Image', register: registerImageRuntimeCommands },
  { category: 'Permissions', register: registerPermissionsRuntimeCommands },
  { category: 'Permissions', register: registerOwnerInboxCommands },
  { category: 'Permissions', register: registerHeldCallsCommands },
  { category: 'Diff & Review', register: registerReviewRuntimeCommands },
  { category: 'CI', register: registerCiRuntimeCommands },
  { category: 'Check-in', register: registerCheckinRuntimeCommands },
  { category: 'Mail & Calendar', register: registerMailRuntimeCommands },
  { category: 'Mail & Calendar', register: registerCalendarRuntimeCommands },
  { category: 'Principals', register: registerPrincipalsRuntimeCommands },
  // "Owner Profile", not "Profiles": the Profiles category above is
  // /profile-sync's named-config-preset bundles, which have nothing to do with
  // what the platform knows about the person who owns it.
  { category: 'Owner Profile', register: registerProfileRuntimeCommands },
  { category: 'Policy', register: (registry) => registry.register(policyCommand) },
  { category: 'Providers', register: (registry) => registry.register(providerCommand) },
  { category: 'Eval', register: (registry) => registry.register(evalCommand) },
  { category: 'Sessions & Replay', register: registerHostedRuntimeCommands },
  { category: 'Sessions & Replay', register: (registry) => registry.register(sessionCommand) },
  { category: 'Sessions & Replay', register: (registry) => registry.register(resumeCommand) },
  { category: 'Sessions & Replay', register: (registry) => registry.register(saveCommand) },
  { category: 'Memory', register: (registry) => registry.register(memoryCommand) },
  { category: 'Knowledge', register: (registry) => registry.register(knowledgeCommand) },
];

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const group of BUILTIN_COMMAND_GROUPS) {
    group.register(registry);
  }
}

/**
 * categorizeBuiltinCommands - Build every built-in command paired with its
 * category label, by replaying the same {@link BUILTIN_COMMAND_GROUPS} into a
 * throwaway registry and attributing each newly-registered command to the
 * group that added it. Handlers are never invoked, so this is side-effect free
 * and safe to call from build scripts and tests. Used by the generated command
 * reference (docs) and the command palette so both stay registry-driven.
 */
export function categorizeBuiltinCommands(): Array<{ command: SlashCommand; category: string }> {
  const registry = new CommandRegistry();
  const out: Array<{ command: SlashCommand; category: string }> = [];
  const seen = new Set<string>();
  for (const group of BUILTIN_COMMAND_GROUPS) {
    group.register(registry);
    for (const command of registry.getAll()) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      out.push({ command, category: group.category });
    }
  }
  return out;
}
