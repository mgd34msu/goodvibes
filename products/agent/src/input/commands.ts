import { registerAutomationLists } from '@goodvibes/engine/terminal-shell/automation-lists';
import type { CommandRegistry } from './command-registry.ts';
import type { CommandContext } from './command-registry.ts';
import { forkCommand, resumeCommand } from './commands/session.ts';
import { memoryCommand } from './commands/memory.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
// Plugins are in Tools and extensions (capabilities/builtin/plugins.ts); the lists a form picks one from read the daemon.
import '@goodvibes/engine/terminal-shell/plugin-trust-command';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerDevicesRuntimeCommands } from './commands/devices-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerStatusRuntimeCommands } from './commands/status-runtime.ts';
import { registerModelsLists } from '@goodvibes/engine/terminal-shell/models-lists';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerAgentWorkspaceRuntimeCommands } from './commands/agent-workspace-runtime.ts';
import { registerDelegationRuntimeCommands } from './commands/delegation-runtime.ts';
import { registerChannelLists } from '@goodvibes/engine/terminal-shell/channel-lists';
import { registerKnowledgeLists } from '@goodvibes/engine/terminal-shell/knowledge-lists';
import { registerConnectedHostAdminCommands } from './commands/connected-host-admin-runtime.ts';
import { registerWaitingLists } from '@goodvibes/engine/terminal-shell/waiting-lists';
import { registerMailLists } from '@goodvibes/engine/terminal-shell/mail-lists';
import { registerCalendarLists } from '@goodvibes/engine/terminal-shell/calendar-lists';
import { registerUpdateCommand } from './commands/update-runtime.ts';
import { commandVerbPolicy, declareCommandVerbs, SHARED_COMMAND_VERBS } from './commands/command-verbs.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';
import { capabilityBinding } from './commands/capability-binding.ts';
import type { RememberedRuleStore } from '@goodvibes/engine/platform/platform/gate/policy';


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
  // Automation is the daemon's (capabilities/builtin/automation.ts): no slash command; its lists reach the daemon with this binding.
  registerAutomationLists<CommandContext>(capabilityBinding);
  registerAgentWorkspaceRuntimeCommands(registry);
  // Memory and knowledge: notes, personas, routines, saved artifacts and drafts are the daemon's (capabilities/builtin/agent-stores.ts),
  // controls in the Memory and knowledge place (routines that run by themselves in Automation too; the review packet's
  // readiness, steps and timeline on the Drafts tab).
  // `/compare` is gone: model comparisons are the daemon's (capabilities/builtin/compare.ts), controls on the
  // Comparisons tab of Models and providers, in both terminal programs.
  // `/research` is gone: research runs, the research queue and reports are the daemon's (capabilities/builtin/research.ts),
  // asking a question or looking at a page goes to this conversation; each a control in the Work place's Research.
  // `/brief` is gone: the briefing is a capability (`work.brief`) with its control in the Work place.
  // `/bundle` is gone: the support bundle is the daemon's (capabilities/builtin/system-bundles.ts `bundle.*`), controls on
  // the Support and transfer tab of the System place, in both terminal programs.
  registerConnectedHostAdminCommands(registry);
  // Memory and knowledge is the daemon's (capabilities/builtin/knowledge.ts, profile.ts, templates.ts): no slash command but /memory; its lists reach the daemon with this binding.
  registerKnowledgeLists<CommandContext>(capabilityBinding);
  // Waiting for you is the daemon's and the program's own (capabilities/builtin/waiting.ts, telegram.ts): no slash command; its lists reach the daemon with this binding.
  registerWaitingLists<CommandContext>(capabilityBinding);
  // Cloudflare and the machine group are the daemon's (capabilities/builtin/cloudflare.ts, cluster.ts): controls in the Devices place.
  // Code lookups and language servers are controls in Code and changes and capabilities the model runs (builtin/code.ts).
  // The calendar is the daemon's (capabilities/builtin/messages.ts, calendar.ts): no slash command; each action a control
  // on the Calendar tabs of Mail, calendar and channels; its lists reach the daemon with this binding.
  registerCalendarLists<CommandContext>(capabilityBinding);
  // Agent homes and their starters are the daemon's (capabilities/builtin/agent-homes.ts): the Agent homes and Starters tabs
  // of Memory and knowledge, no slash command.
  // Skills are the daemon's one skill store (capabilities/builtin/skills.ts): controls in Tools and extensions, no slash command.
  // Channels are the daemon's (capabilities/builtin/messages.ts, channel-reads.ts, channel-send.ts): no slash command;
  // each action a control on the Channels tab of Mail, calendar and channels; its lists reach the daemon with this binding.
  registerChannelLists<CommandContext>(capabilityBinding);
  // Mail is the daemon's (capabilities/builtin/messages.ts): no slash command; its list reaches the daemon with this binding.
  registerMailLists<CommandContext>(capabilityBinding);
  // Google has no command: the one Google connection is the daemon's work (capabilities/builtin/google.ts), each action a
  // control on the Google tab of Mail, calendar and channels; a refused send is answered in Waiting for you.
  registerDelegationRuntimeCommands(registry);
  registerOperatorRuntimeCommands(registry);
  registerNotifyRuntimeCommands(registry);
  // Security is Permissions and safety (capabilities/builtin/security.ts, security-review.ts): no slash command.
  registerMcpRuntimeCommands(registry);
  // Hooks are in Tools and extensions (capabilities/builtin/hooks.ts): no slash command; the lists their forms choose
  // from read the daemon (terminal-shell places/tools-lists.ts, bound in wirePlaces).
  // `/voice` is gone: speaking, the voice runtime, the wake word and the voice settings file are controls in the System
  // place (This session, Voice), each a capability (capabilities/builtin/system*.ts).
  registerTasksRuntimeCommands(registry);
  // `/health` is gone: its actions are the System place's Health tab (capabilities health.*), stopping an agent is
  // Work and agents' Your agents (agents.stop).
  registerStatusRuntimeCommands(registry);
  registerUpdateCommand(registry);
  // Models and providers are the daemon's (capabilities/builtin/models.ts, services.ts): controls in their place; the
  // lists their forms choose from reach the daemon with this binding.
  registerModelsLists<CommandContext>(capabilityBinding);
  registerOnboardingRuntimeCommands(registry);
  registerLocalRuntimeCommands(registry);
  registerDevicesRuntimeCommands(registry);
  registerSessionContentCommands(registry);
  // Money is the daemon's (capabilities/builtin/money.ts): no slash command; every action a control in the Money place
  // (the purchases waiting, Waiting for you's Purchases tab); its lists read the daemon (places/money-lists.ts, bound in wirePlaces).
  registry.register(memoryCommand);

  // ── /resume and /fork (every other session action is a control of the Sessions place) ──
  registry.register(resumeCommand);
  registry.register(forkCommand);

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
