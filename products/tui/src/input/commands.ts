import { COMMAND_TASK_GROUPS } from '@goodvibes/engine/terminal-shell/command-palette';
import { CommandRegistry, type CommandContext } from './command-registry.ts';
import type { SlashCommand } from './command-registry.ts';
import { forkCommand, resumeCommand } from './commands/session.ts';
import { memoryCommand } from './commands/memory.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
// Plugins are in Tools and extensions (capabilities/builtin/plugins.ts); the lists a form picks one from read the daemon.
import '@goodvibes/engine/terminal-shell/plugin-trust-command';
import { registerDiffRuntimeCommands } from './commands/diff-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
import { registerChannelLists } from '@goodvibes/engine/terminal-shell/channel-lists';
import { registerPlatformAccessRuntimeCommands } from './commands/platform-access-runtime.ts';
import { capabilityBinding } from './commands/capability-binding.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerCheckpointRuntimeCommands } from './commands/checkpoint-runtime.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerStatusRuntimeCommands } from './commands/status-runtime.ts';
import { registerAcpRuntimeCommands } from './commands/acp-runtime.ts';
import { registerModelsLists } from '@goodvibes/engine/terminal-shell/models-lists';
// Who may sign in is the daemon's, in Permissions and safety (no slash command): the lists a form chooses a user or session from.
import './commands/local-auth-runtime.ts';
import { registerDevicesRuntimeCommands } from './commands/devices-runtime.ts';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';
import { registerAutomationLists } from '@goodvibes/engine/terminal-shell/automation-lists';
import './commands/hosted-runtime.ts';
import { registerMailLists } from '@goodvibes/engine/terminal-shell/mail-lists';
import { registerWaitingLists } from '@goodvibes/engine/terminal-shell/waiting-lists';
import { registerCalendarLists } from '@goodvibes/engine/terminal-shell/calendar-lists';
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
  // Channels are the daemon's (capabilities/builtin/messages.ts, channel-reads.ts, channel-send.ts): no slash command;
  // each action a control on the Channels tab of Mail, calendar and channels; its lists reach the daemon with this binding.
  { category: TASK.channels, register: () => registerChannelLists<CommandContext>(capabilityBinding) },
  // Security is Permissions and safety (capabilities/builtin/security.ts, security-review.ts): no slash command.
  { category: TASK.settings, register: registerPlatformAccessRuntimeCommands },
  // Hooks and the marketplace are in Tools and extensions (capabilities/builtin/hooks.ts, marketplace.ts): no slash command;
  // the lists their forms choose from read the daemon (terminal-shell places/tools-lists.ts, bound in wirePlaces).
  { category: TASK.tools, register: registerMcpRuntimeCommands },
  // `/voice` is gone: speaking, the voice runtime, the wake word and the voice settings file are controls in the System
  // place (This session, Voice), each a capability (capabilities/builtin/system*.ts).
  { category: TASK.agents, register: registerTasksRuntimeCommands },
  // `/health` is gone: its actions are the System place's Health tab (capabilities health.*), stopping an agent is
  // Work and agents' Your agents (agents.stop).
  { category: TASK.check, register: registerStatusRuntimeCommands },
  { category: TASK.agents, register: registerAcpRuntimeCommands },
  // Models and providers: the lists their forms choose from, read from the daemon (models-lists.ts).
  { category: TASK.models, register: () => registerModelsLists<CommandContext>(capabilityBinding) },
  { category: TASK.channels, register: registerDevicesRuntimeCommands },
  { category: TASK.help, register: registerOnboardingRuntimeCommands },
  { category: TASK.models, register: registerLocalRuntimeCommands },
  // Plan mode is a control on This conversation in Permissions and safety (capabilities/builtin/plan.ts): no slash command.
  // Money is the daemon's (capabilities/builtin/money.ts): no slash command; every action a control in the Money place
  // (the purchases waiting, Waiting for you's Purchases tab); its lists read the daemon (places/money-lists.ts, bound in wirePlaces).
  { category: TASK.sessions, register: registerSessionContentCommands },
  { category: TASK.code, register: registerCheckpointRuntimeCommands },
  // Images and video are the daemon's (media.make in Tools and extensions, media.collect in Work, media.providers in
  // Models and providers): controls in those places, no slash command; a made file opens here after the person's press (media-viewer.ts).
  { category: TASK.settings, register: registerPermissionsRuntimeCommands },
  // Code and changes (capabilities/builtin/code.ts): git, worktrees, the code index, code lookups, tests and review
  // are controls in their place and capabilities the model runs; /changes opens the place.
  // Automation is the daemon's (capabilities/builtin/automation.ts): no slash command; its lists reach the daemon with this binding.
  { category: TASK.agents, register: () => registerAutomationLists<CommandContext>(capabilityBinding) },
  // Mail is the daemon's (capabilities/builtin/messages.ts): no slash command; its list reaches the daemon with this binding.
  { category: TASK.channels, register: () => registerMailLists<CommandContext>(capabilityBinding) },
  // Waiting for you is the daemon's and this app's own (capabilities/builtin/waiting.ts, telegram.ts): no slash command; its lists reach the daemon with this binding.
  { category: TASK.settings, register: () => registerWaitingLists<CommandContext>(capabilityBinding) },
  // The calendar is the daemon's (capabilities/builtin/messages.ts, calendar.ts): no slash command; each action a control
  // on the Calendar tabs of Mail, calendar and channels; its lists reach the daemon with this binding.
  { category: TASK.channels, register: () => registerCalendarLists<CommandContext>(capabilityBinding) },
  { category: TASK.settings, register: registerPrincipalsRuntimeCommands },
  // `/eval` is gone: task suites are capabilities (builtin/eval.ts) with their controls on the Work place's Evaluations tab.
  // Hosted sessions are the daemon's (capabilities/builtin/sessions.ts): no slash command; every act a control in the
  // Sessions place (Hosted, Joined here) or on This conversation; this app's own join is hosted-runtime.ts (its lists
  // and what a press of "start" does here after the daemon started it), loaded above for those.
  { category: TASK.sessions, register: (registry) => registry.register(resumeCommand) },
  { category: TASK.sessions, register: (registry) => registry.register(forkCommand) },
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
