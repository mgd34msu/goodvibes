import { PERMISSIONS_COMMAND, runPermissionsCommand, type RememberedRuleStore } from '@goodvibes-jev/engine/platform/platform/gate/policy';
import type { CommandRegistry } from '../command-registry.ts';
import { readExecutionModeInForce } from '../../permissions/execution-mode.ts';

/**
 * `/permissions` in the Agent: the shared command (gate/policy/permissions-runtime.ts)
 * over the remembered-approval store this process adds to when an approval is
 * remembered, so the owner can see and revoke what was remembered here.
 * `ruleStore` returns that store; a surface without one says so.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry, ruleStore: () => RememberedRuleStore | undefined): void {
  registry.register({
    ...PERMISSIONS_COMMAND,
    aliases: [...PERMISSIONS_COMMAND.aliases],
    async handler(args, ctx) {
      await runPermissionsCommand(args, {
        print: (text) => ctx.print(text),
        ruleStore: ruleStore(),
        configManager: ctx.platform.configManager,
        // A rule added here (other than a never-run rule) is scoped to this project.
        projectRoot: () => ctx.platform.configManager.getWorkingDirectory(),
        // A hosted session's mode in force is its host's; otherwise this process's settings decide it.
        modeInForce: () => readExecutionModeInForce(ctx.platform.configManager),
        openSelection: ctx.openSelection,
      });
    },
  });
}
