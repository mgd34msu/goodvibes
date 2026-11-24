import { registerTriggerCommands } from './commands/trigger-supervisor.ts';
import { COMMAND_TASK_GROUPS } from '@goodvibes/engine/terminal-shell/command-palette';
import { CommandRegistry, type CommandContext } from './command-registry.ts';
import type { SlashCommand } from './command-registry.ts';
import { evalCommand } from './commands/eval.ts';
import { sessionCommand, resumeCommand, saveCommand } from './commands/session.ts';
import { memoryCommand } from './commands/memory.ts';
import { registerKnowledgeRuntimeCommands } from './commands/knowledge.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
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
import { registerSecurityRuntimeCommands } from './commands/security-runtime.ts';
import { registerProfileSyncRuntimeCommands } from './commands/profile-sync-runtime.ts';
import { registerManagedRuntimeCommands } from './commands/managed-runtime.ts';
import { registerPlatformAccessRuntimeCommands } from './commands/platform-access-runtime.ts';
import { registerPlatformServicesRuntimeCommands } from './commands/platform-services-runtime.ts';
import { registerMarketplaceRuntimeCommands } from './commands/marketplace-runtime.ts';
import { registerGuidanceRuntimeCommands } from './commands/guidance-runtime.ts';
import { registerRemoteRuntimeCommands } from './commands/remote-runtime.ts';
import { registerHooksCommand } from '@goodvibes/engine/terminal-shell/hooks-command';
import { registerEditorRuntimeCommands } from './commands/editor-runtime.ts';
import { registerControlRoomRuntimeCommands } from './commands/control-room-runtime.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerCheckpointRuntimeCommands } from './commands/checkpoint-runtime.ts';
import { registerWorkstreamRuntimeCommands } from './commands/workstream-runtime.ts';
import { registerCodebaseRuntimeCommands } from './commands/codebase-runtime.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerExperienceRuntimeCommands } from './commands/experience-runtime.ts';
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
import { registerDevicesRuntimeCommands } from './commands/devices-runtime.ts';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerCloudflareRuntimeCommands } from './commands/cloudflare-runtime.ts';
import { registerWorkPlanRuntimeCommands } from './commands/work-plan-runtime.ts';
import { registerCostRuntimeCommands } from './commands/cost-runtime.ts';
import { registerOwnerInboxCommands } from './commands/owner-inbox-runtime.ts';
import { registerHeldCallsCommands } from './commands/held-calls-runtime.ts';
import { registerWebSearchRuntimeCommands } from './commands/websearch-runtime.ts';
import { registerImageRuntimeCommands } from './commands/image-runtime.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';
import { registerReviewRuntimeCommands } from './commands/review-runtime.ts';
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
 * The task groups the command list, the help palette and the command
 * reference sort commands into: what a person came to do, not how the code is
 * split (the shared list in terminal-shell, so the Agent uses the same words).
 */
const TASK = COMMAND_TASK_GROUPS;


/**
 * Every built-in command group, in registration order. Keeping runtime
 * registration and doc/palette categorization on one array means a category
 * label can never drift between the two.
 */
export const BUILTIN_COMMAND_GROUPS: readonly BuiltinCommandGroup[] = [
  { category: TASK.agents, register: registerTriggerCommands },
  { category: TASK.sessions, register: registerShellCoreCommands },
  { category: TASK.agents, register: registerOperatorRuntimeCommands },
  { category: TASK.tools, register: registerPluginRuntimeCommands },
  { category: TASK.code, register: registerDiffRuntimeCommands },
  { category: TASK.code, register: registerGitRuntimeCommands },
  { category: TASK.sessions, register: registerQueueRuntimeCommands },
  { category: TASK.settings, register: registerPowerRuntimeCommands },
  { category: TASK.agents, register: registerGraphRuntimeCommands },
  { category: TASK.check, register: registerTestRuntimeCommands },
  { category: TASK.channels, register: registerNotifyRuntimeCommands },
  { category: TASK.sessions, register: registerReplayRuntimeCommands },
  { category: TASK.channels, register: registerChannelRuntimeCommands },
  { category: TASK.channels, register: registerTelegramIntakeCommands },
  { category: TASK.help, register: registerProductRuntimeCommands },
  { category: TASK.settings, register: registerSecurityRuntimeCommands },
  { category: TASK.settings, register: registerProfileSyncRuntimeCommands },
  { category: TASK.help, register: registerManagedRuntimeCommands },
  { category: TASK.settings, register: registerPlatformAccessRuntimeCommands },
  { category: TASK.help, register: registerPlatformServicesRuntimeCommands },
  { category: TASK.tools, register: registerMarketplaceRuntimeCommands },
  { category: TASK.help, register: registerGuidanceRuntimeCommands },
  { category: TASK.channels, register: registerRemoteRuntimeCommands },
  { category: TASK.tools, register: (registry) => registerHooksCommand<CommandContext>(registry) },
  { category: TASK.code, register: registerEditorRuntimeCommands },
  { category: TASK.agents, register: registerControlRoomRuntimeCommands },
  { category: TASK.tools, register: registerMcpRuntimeCommands },
  { category: TASK.tools, register: registerSkillsRuntimeCommands },
  { category: TASK.settings, register: registerExperienceRuntimeCommands },
  { category: TASK.tools, register: registerServicesRuntimeCommands },
  { category: TASK.agents, register: registerTasksRuntimeCommands },
  { category: TASK.models, register: registerLocalProviderRuntimeCommands },
  { category: TASK.check, register: registerHealthRuntimeCommands },
  { category: TASK.check, register: registerStatusRuntimeCommands },
  { category: TASK.agents, register: registerClusterRuntimeCommands },
  { category: TASK.settings, register: registerSettingsSyncRuntimeCommands },
  { category: TASK.code, register: registerWorktreeRuntimeCommands },
  { category: TASK.agents, register: registerAcpRuntimeCommands },
  { category: TASK.models, register: registerProviderAccountsRuntimeCommands },
  { category: TASK.settings, register: registerLocalAuthRuntimeCommands },
  { category: TASK.code, register: registerIntelligenceRuntimeCommands },
  { category: TASK.channels, register: registerDevicesRuntimeCommands },
  { category: TASK.help, register: registerOnboardingRuntimeCommands },
  { category: TASK.channels, register: registerCloudflareRuntimeCommands },
  { category: TASK.agents, register: registerWorkPlanRuntimeCommands },
  { category: TASK.models, register: registerCostRuntimeCommands },
  { category: TASK.models, register: registerLocalRuntimeCommands },
  { category: TASK.channels, register: registerDiscoveryRuntimeCommands },
  { category: TASK.agents, register: registerPlanningRuntimeCommands },
  { category: TASK.settings, register: registerPaymentCardCommands },
  { category: TASK.agents, register: registerScheduleRuntimeCommands },
  { category: TASK.sessions, register: registerSessionContentCommands },
  { category: TASK.code, register: registerCheckpointRuntimeCommands },
  { category: TASK.agents, register: registerWorkstreamRuntimeCommands },
  { category: TASK.code, register: registerCodebaseRuntimeCommands },
  { category: TASK.knowledge, register: registerWebSearchRuntimeCommands },
  { category: TASK.models, register: registerImageRuntimeCommands },
  { category: TASK.settings, register: registerPermissionsRuntimeCommands },
  { category: TASK.settings, register: registerOwnerInboxCommands },
  { category: TASK.settings, register: registerHeldCallsCommands },
  { category: TASK.code, register: registerReviewRuntimeCommands },
  { category: TASK.check, register: registerCiRuntimeCommands },
  { category: TASK.agents, register: registerCheckinRuntimeCommands },
  { category: TASK.channels, register: registerMailRuntimeCommands },
  { category: TASK.channels, register: registerCalendarRuntimeCommands },
  { category: TASK.settings, register: registerPrincipalsRuntimeCommands },
  { category: TASK.settings, register: registerProfileRuntimeCommands },
  { category: TASK.check, register: (registry) => registry.register(evalCommand) },
  { category: TASK.sessions, register: registerHostedRuntimeCommands },
  { category: TASK.sessions, register: (registry) => registry.register(sessionCommand) },
  { category: TASK.sessions, register: (registry) => registry.register(resumeCommand) },
  { category: TASK.sessions, register: (registry) => registry.register(saveCommand) },
  { category: TASK.knowledge, register: (registry) => registry.register(memoryCommand) },
  { category: TASK.knowledge, register: registerKnowledgeRuntimeCommands },
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
