import { registerPermissionsCommand } from '@goodvibes-jev/engine/terminal-shell/permissions-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

/**
 * `/permissions` is one description shared with the Agent
 * (terminal-shell/permissions-command.ts), over this surface's
 * remembered-rule store, config manager and evaluator flag.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry): void {
  registerPermissionsCommand<CommandContext>(registry, (ctx) => {
    const flags = ctx.platform.featureFlagManager;
    return {
      ruleStore: ctx.clients?.userPermissionRuleStore,
      configManager: ctx.platform.configManager,
      // A rule added here (other than a never-run rule) is scoped to this project.
      projectRoot: () => ctx.platform.configManager.getWorkingDirectory(),
      evaluatorInForce: () => flags ? (flags.isEnabled('permissions-policy-engine') ? 'policy-engine' : 'baseline') : undefined,
    };
  });
}
