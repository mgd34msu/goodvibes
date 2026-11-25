import { registerAutomationLists } from '@goodvibes/engine/terminal-shell/automation-lists';
import type { CommandRegistry } from './command-registry.ts';
import type { CommandContext } from './command-registry.ts';
import { resumeCommand, sessionCommand } from './commands/session.ts';
import { memoryCommand } from './commands/memory.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
import { registerSecurityRuntimeCommands } from './commands/security-runtime.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerDevicesRuntimeCommands } from './commands/devices-runtime.ts';
import { registerExperienceRuntimeCommands } from './commands/experience-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerHealthRuntimeCommands } from './commands/health-runtime.ts';
import { registerStatusRuntimeCommands } from './commands/status-runtime.ts';
import { registerModelsLists } from '@goodvibes/engine/terminal-shell/models-lists';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerAgentWorkspaceRuntimeCommands } from './commands/agent-workspace-runtime.ts';
import { registerAgentRuntimeProfileRuntimeCommands } from './commands/agent-runtime-profile-runtime.ts';
import { registerDelegationRuntimeCommands } from './commands/delegation-runtime.ts';
import { registerReviewPacketReportCommand } from './commands/documents-runtime.ts';
import { registerChannelsRuntimeCommands } from './commands/channels-runtime.ts';
import { registerSupportBundleRuntimeCommands } from './commands/support-bundle-runtime.ts';
import { registerKnowledgeLists } from '@goodvibes/engine/terminal-shell/knowledge-lists';
import { registerConnectedHostAdminCommands } from './commands/connected-host-admin-runtime.ts';
import { registerWaitingLists } from '@goodvibes/engine/terminal-shell/waiting-lists';
import { registerMailLists } from '@goodvibes/engine/terminal-shell/mail-lists';
import { registerCalendarRuntimeCommands } from './commands/calendar-runtime.ts';
import { registerGoogleRuntimeCommands } from './commands/google-runtime.ts';
import { registerUpdateCommand } from './commands/update-runtime.ts';
import { registerPaymentCardCommands } from './commands/payment-card-intake.ts';
import { commandVerbPolicy, declareCommandVerbs, SHARED_COMMAND_VERBS } from './commands/command-verbs.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';
import { registerCompareRuntimeCommands } from './commands/compare-runtime.ts';
import { registerHooksCommand } from '@goodvibes/engine/terminal-shell/hooks-command';
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
  // controls in the Memory and knowledge place (routines that run by themselves in Automation too); /documents keeps the
  // review packet reports, which read the Agent workspace's own view.
  registerReviewPacketReportCommand(registry);
  registerCompareRuntimeCommands(registry);
  // `/research` is gone: research runs, the research queue and reports are the daemon's (capabilities/builtin/research.ts),
  // asking a question or looking at a page goes to this conversation; each a control in the Work place's Research.
  // `/brief` is gone: the briefing is a capability (`work.brief`) with its control in the Work place.
  registerSupportBundleRuntimeCommands(registry);
  registerConnectedHostAdminCommands(registry);
  // Memory and knowledge is the daemon's (capabilities/builtin/knowledge.ts, profile.ts, templates.ts): no slash command but /memory; its lists reach the daemon with this binding.
  registerKnowledgeLists<CommandContext>(capabilityBinding);
  // Waiting for you is the daemon's and the program's own (capabilities/builtin/waiting.ts, telegram.ts): no slash command; its lists reach the daemon with this binding.
  registerWaitingLists<CommandContext>(capabilityBinding);
  // Cloudflare and the machine group are the daemon's (capabilities/builtin/cloudflare.ts, cluster.ts): controls in the Devices place.
  // Code lookups and language servers are controls in Code and changes and capabilities the model runs (builtin/code.ts).
  registerCalendarRuntimeCommands(registry);
  registerAgentRuntimeProfileRuntimeCommands(registry);
  // Skills are the daemon's one skill store (capabilities/builtin/skills.ts): controls in Tools and extensions, no slash command.
  registerChannelsRuntimeCommands(registry);
  // Mail is the daemon's (capabilities/builtin/messages.ts): no slash command; its list reaches the daemon with this binding.
  registerMailLists<CommandContext>(capabilityBinding);
  registerGoogleRuntimeCommands(registry);
  registerDelegationRuntimeCommands(registry);
  registerOperatorRuntimeCommands(registry);
  registerNotifyRuntimeCommands(registry);
  registerSecurityRuntimeCommands(registry);
  registerMcpRuntimeCommands(registry);
  // The Agent loads the hooks file too, so the hook messages that name /hooks hold here.
  registerHooksCommand<CommandContext>(registry, capabilityBinding);
  registerExperienceRuntimeCommands(registry);
  registerTasksRuntimeCommands(registry);
  registerHealthRuntimeCommands(registry);
  registerStatusRuntimeCommands(registry);
  registerUpdateCommand(registry);
  // Models and providers are the daemon's (capabilities/builtin/models.ts, services.ts): controls in their place; the
  // lists their forms choose from reach the daemon with this binding.
  registerModelsLists<CommandContext>(capabilityBinding);
  registerOnboardingRuntimeCommands(registry);
  registerLocalRuntimeCommands(registry);
  registerDevicesRuntimeCommands(registry);
  registerSessionContentCommands(registry);
  registerPaymentCardCommands(registry);
  registry.register(memoryCommand);

  // ── /session ─────────────────────────────────────────────────────────────
  registry.register(sessionCommand);
  registry.register(resumeCommand);

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
