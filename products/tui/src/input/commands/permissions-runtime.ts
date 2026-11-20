import { PERMISSIONS_COMMAND, runPermissionsCommand } from '@goodvibes-jev/engine/platform/platform/gate/policy';
import type { CommandRegistry } from '../command-registry.ts';

/**
 * `/permissions`, the permission settings surface: the shared command
 * (gate/policy/permissions-runtime.ts) over this surface's remembered-rule
 * store, config manager, evaluator flag and selection picker.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    ...PERMISSIONS_COMMAND,
    aliases: [...PERMISSIONS_COMMAND.aliases],
    async handler(args, ctx) {
      const flags = ctx.platform.featureFlagManager;
      await runPermissionsCommand(args, {
        print: (text) => ctx.print(text),
        ruleStore: ctx.clients?.userPermissionRuleStore,
        configManager: ctx.platform.configManager,
        // A rule added here (other than a never-run rule) is scoped to this project.
        projectRoot: () => ctx.platform.configManager.getWorkingDirectory(),
        evaluatorInForce: () => flags ? (flags.isEnabled('permissions-policy-engine') ? 'policy-engine' : 'baseline') : undefined,
        openSelection: ctx.openSelection,
      });
    },
  });
}
