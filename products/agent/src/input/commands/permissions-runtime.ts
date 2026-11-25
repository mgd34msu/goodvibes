import type { PermissionsCommandContext, RememberedRuleStore } from '@goodvibes/engine/platform/platform/gate/policy';
import { registerPermissionsCommand } from '@goodvibes/engine/terminal-shell/permissions-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { readExecutionModeInForce } from '../../permissions/execution-mode.ts';
import { capabilityBinding } from './capability-binding.ts';

/** This conversation's permission settings and rule store, as `/permissions` and the model read them. */
export function permissionsDeps(ctx: CommandContext, ruleStore: RememberedRuleStore | undefined): Omit<PermissionsCommandContext, 'print' | 'openSelection'> {
  return {
    ruleStore,
    configManager: ctx.platform.configManager,
    projectRoot: () => ctx.platform.configManager.getWorkingDirectory(),
    // A hosted session's mode in force is its host's; otherwise this process's settings decide it.
    modeInForce: () => readExecutionModeInForce(ctx.platform.configManager),
  };
}

/**
 * `/permissions` is one description shared with the terminal app
 * (terminal-shell/permissions-command.ts): this conversation's mode and
 * settings are read here, the rules are the daemon's to list, add and remove.
 * `ruleStore` returns the remembered-approval store this process adds to.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry, ruleStore: () => RememberedRuleStore | undefined): void {
  rememberedRules = ruleStore;
  registerPermissionsCommand<CommandContext>(registry, (ctx) => permissionsDeps(ctx, ruleStore()), capabilityBinding);
}

/** The remembered-approval store, as registered: the model's reads of this conversation's permissions count its rules too. */
let rememberedRules: () => RememberedRuleStore | undefined = () => undefined;

/** This conversation's permission settings and rule store, for the model's `capability_run`. */
export function agentPermissionsDeps(ctx: CommandContext): Omit<PermissionsCommandContext, 'print' | 'openSelection'> {
  return permissionsDeps(ctx, rememberedRules());
}
