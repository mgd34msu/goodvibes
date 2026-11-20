import type { RememberedRuleStore } from '@goodvibes-jev/engine/platform/platform/gate/policy';
import { registerPermissionsCommand } from '@goodvibes-jev/engine/terminal-shell/permissions-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { readExecutionModeInForce } from '../../permissions/execution-mode.ts';

/**
 * `/permissions` is one description shared with the terminal app
 * (terminal-shell/permissions-command.ts), over the remembered-approval store
 * this process adds to when an approval is remembered. `ruleStore` returns
 * that store; a surface without one says so.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry, ruleStore: () => RememberedRuleStore | undefined): void {
  registerPermissionsCommand<CommandContext>(registry, (ctx) => ({
    ruleStore: ruleStore(),
    configManager: ctx.platform.configManager,
    // A rule added here (other than a never-run rule) is scoped to this project.
    projectRoot: () => ctx.platform.configManager.getWorkingDirectory(),
    // A hosted session's mode in force is its host's; otherwise this process's settings decide it.
    modeInForce: () => readExecutionModeInForce(ctx.platform.configManager),
  }));
}
