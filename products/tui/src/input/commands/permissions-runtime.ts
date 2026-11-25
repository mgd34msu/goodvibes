import type { PermissionsCommandContext } from '@goodvibes/engine/platform/platform/gate/policy';
import { registerPermissionsCommand } from '@goodvibes/engine/terminal-shell/permissions-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';

/** This conversation's permission settings, rule store and evaluator flag, as `/permissions` and the model read them. */
export function permissionsDeps(ctx: CommandContext): Omit<PermissionsCommandContext, 'print' | 'openSelection'> {
  const flags = ctx.platform.featureFlagManager;
  return {
    ruleStore: ctx.clients?.userPermissionRuleStore,
    configManager: ctx.platform.configManager,
    projectRoot: () => ctx.platform.configManager.getWorkingDirectory(),
    evaluatorInForce: () => flags ? (flags.isEnabled('permissions-policy-engine') ? 'policy-engine' : 'baseline') : undefined,
  };
}

/**
 * `/permissions` is one description shared with the Agent
 * (terminal-shell/permissions-command.ts): this conversation's mode and
 * settings are read here, the rules are the daemon's to list, add and remove.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry): void {
  registerPermissionsCommand<CommandContext>(registry, permissionsDeps, capabilityBinding);
}
