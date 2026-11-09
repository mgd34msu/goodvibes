import { createSecurityCommand } from '@goodvibes-jev/engine/terminal-shell/security-command';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import '@/runtime/index.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import { requireReadModels, requireSubscriptionManager, requireTokenAuditor } from './runtime-services.ts';

export function registerSecurityRuntimeCommands(registry: CommandRegistry): void {
  registry.register(
    createSecurityCommand<CommandContext>(
      {
        tokens: requireTokenAuditor,
        security: (ctx) => requireReadModels(ctx).security.getSnapshot(),
        policy: (ctx) => ctx.extensions.policyRuntimeState?.getSnapshot(),
        plugins: (ctx) => ctx.extensions.pluginManager?.list() ?? [],
        subscriptions: requireSubscriptionManager,
      },
      {
        hidden: true,
        separator: ' ',
        tokenTitle: 'Token Review',
        emptyTokens: 'No registered API tokens are currently available for security review.',
        policyUnavailable: 'Policy state is not available in this Agent session.',
        beforeRead(args, ctx) {
          const subcommand = args[0]?.toLowerCase() ?? 'review';
          if (subcommand !== 'open' && subcommand !== 'panel') return false;
          ctx.print(
            'Open Agent Workspace -> Tools & Permissions for permission settings, or run /security review for the security report.',
          );
          return true;
        },
      },
    ),
  );
}
