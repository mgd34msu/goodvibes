import { COMMAND_TASK_GROUPS } from '@goodvibes/engine/terminal-shell/command-palette';
import { CommandRegistry, type CommandContext } from './command-registry.ts';
import type { SlashCommand } from './command-registry.ts';
import { sessionCommand, resumeCommand } from './commands/session.ts';
import { memoryCommand } from './commands/memory.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerDiscoveryRuntimeCommands } from './commands/discovery-runtime.ts';
import { registerPlanningRuntimeCommands } from './commands/planning-runtime.ts';
import { registerPaymentCardCommands } from './commands/payment-card-intake.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
// Plugins are in Tools and extensions (capabilities/builtin/plugins.ts); the lists a form picks one from read the daemon.
import '@goodvibes/engine/terminal-shell/plugin-trust-command';
import { registerDiffRuntimeCommands } from './commands/diff-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
import { registerChannelRuntimeCommands } from './commands/channel-runtime.ts';
import { registerSecurityRuntimeCommands } from './commands/security-runtime.ts';
import { registerPlatformAccessRuntimeCommands } from './commands/platform-access-runtime.ts';
import { registerPlatformServicesRuntimeCommands } from './commands/platform-services-runtime.ts';
import { registerMarketplaceRuntimeCommands } from './commands/marketplace-runtime.ts';
import { registerHooksCommand } from '@goodvibes/engine/terminal-shell/hooks-command';
import { capabilityBinding } from './commands/capability-binding.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerCheckpointRuntimeCommands } from './commands/checkpoint-runtime.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerExperienceRuntimeCommands } from './commands/experience-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerHealthRuntimeCommands } from './commands/health-runtime.ts';
import { registerStatusRuntimeCommands } from './commands/status-runtime.ts';
import { registerAcpRuntimeCommands } from './commands/acp-runtime.ts';
import { registerModelsLists } from '@goodvibes/engine/terminal-shell/models-lists';
import { registerLocalAuthRuntimeCommands } from './commands/local-auth-runtime.ts';
import { registerDevicesRuntimeCommands } from './commands/devices-runtime.ts';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerCostRuntimeCommands } from './commands/cost-runtime.ts';
import { registerImageRuntimeCommands } from './commands/image-runtime.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';
import { registerAutomationLists } from '@goodvibes/engine/terminal-shell/automation-lists';
import { registerHostedRuntimeCommands } from './commands/hosted-runtime.ts';
import { registerMailLists } from '@goodvibes/engine/terminal-shell/mail-lists';
import { registerWaitingLists } from '@goodvibes/engine/terminal-shell/waiting-lists';
import { registerCalendarRuntimeCommands } from './commands/calendar-runtime.ts';
import { registerPrincipalsRuntimeCommands } from './commands/principals-runtime.ts';
import { registerKnowledgeLists } from '@goodvibes/engine/terminal-shell/knowledge-lists';

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
  { category: TASK.sessions, register: registerShellCoreCommands },
  { category: TASK.agents, register: registerOperatorRuntimeCommands },
  { category: TASK.code, register: registerDiffRuntimeCommands },
  { category: TASK.channels, register: registerNotifyRuntimeCommands },
  { category: TASK.channels, register: registerChannelRuntimeCommands },
  { category: TASK.settings, register: registerSecurityRuntimeCommands },
  { category: TASK.settings, register: registerPlatformAccessRuntimeCommands },
  { category: TASK.help, register: registerPlatformServicesRuntimeCommands },
  { category: TASK.tools, register: registerMarketplaceRuntimeCommands },
  { category: TASK.tools, register: (registry) => registerHooksCommand<CommandContext>(registry, capabilityBinding) },
  { category: TASK.tools, register: registerMcpRuntimeCommands },
  { category: TASK.settings, register: registerExperienceRuntimeCommands },
  { category: TASK.agents, register: registerTasksRuntimeCommands },
  { category: TASK.check, register: registerHealthRuntimeCommands },
  { category: TASK.check, register: registerStatusRuntimeCommands },
  { category: TASK.agents, register: registerAcpRuntimeCommands },
  // Models and providers: the lists their forms choose from, read from the daemon (models-lists.ts).
  { category: TASK.models, register: () => registerModelsLists<CommandContext>(capabilityBinding) },
  { category: TASK.settings, register: registerLocalAuthRuntimeCommands },
  { category: TASK.channels, register: registerDevicesRuntimeCommands },
  { category: TASK.help, register: registerOnboardingRuntimeCommands },
  { category: TASK.models, register: registerCostRuntimeCommands },
  { category: TASK.models, register: registerLocalRuntimeCommands },
  { category: TASK.channels, register: registerDiscoveryRuntimeCommands },
  { category: TASK.agents, register: registerPlanningRuntimeCommands },
  { category: TASK.settings, register: registerPaymentCardCommands },
  { category: TASK.sessions, register: registerSessionContentCommands },
  { category: TASK.code, register: registerCheckpointRuntimeCommands },
  { category: TASK.models, register: registerImageRuntimeCommands },
  { category: TASK.settings, register: registerPermissionsRuntimeCommands },
  // Code and changes (capabilities/builtin/code.ts): git, worktrees, the code index, code lookups, tests and review
  // are controls in their place and capabilities the model runs; /changes opens the place.
  // Automation is the daemon's (capabilities/builtin/automation.ts): no slash command; its lists reach the daemon with this binding.
  { category: TASK.agents, register: () => registerAutomationLists<CommandContext>(capabilityBinding) },
  // Mail is the daemon's (capabilities/builtin/messages.ts): no slash command; its list reaches the daemon with this binding.
  { category: TASK.channels, register: () => registerMailLists<CommandContext>(capabilityBinding) },
  // Waiting for you is the daemon's and this app's own (capabilities/builtin/waiting.ts, telegram.ts): no slash command; its lists reach the daemon with this binding.
  { category: TASK.settings, register: () => registerWaitingLists<CommandContext>(capabilityBinding) },
  { category: TASK.channels, register: registerCalendarRuntimeCommands },
  { category: TASK.settings, register: registerPrincipalsRuntimeCommands },
  // `/eval` is gone: task suites are capabilities (builtin/eval.ts) with their controls on the Work place's Evaluations tab.
  { category: TASK.sessions, register: registerHostedRuntimeCommands },
  { category: TASK.sessions, register: (registry) => registry.register(sessionCommand) },
  { category: TASK.sessions, register: (registry) => registry.register(resumeCommand) },
  { category: TASK.knowledge, register: (registry) => registry.register(memoryCommand) },
  // Memory and knowledge is the daemon's (capabilities/builtin/knowledge.ts, profile.ts, templates.ts): no slash command but /memory; its lists reach the daemon with this binding.
  { category: TASK.knowledge, register: () => registerKnowledgeLists<CommandContext>(capabilityBinding) },
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
