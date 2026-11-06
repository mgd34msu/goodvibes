import { createTrustReviewTools, createTrustCommandFlow } from '@goodvibes-jev/engine/terminal-shell/trust-review';
import 'node:fs';
import 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireReadModels, requireSecretsManager, requireServiceRegistry, requireShellPaths } from './runtime-services.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

const { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle } = createTrustReviewTools<CommandContext>({
  listSecrets: (ctx) => requireSecretsManager(ctx).list(),
  serviceNames: (ctx) => Object.keys(requireServiceRegistry(ctx).getAll()),
  security: (ctx) => requireReadModels(ctx).security.getSnapshot(),
  permissionMode: (ctx) => ctx.platform.configManager.get('permissions.mode'),
  serviceLabel: 'integrations',
});

const runTrustCommand = createTrustCommandFlow<CommandContext, Awaited<ReturnType<typeof buildTrustReviewBundle>>>({
  buildTrustReviewBundle,
  formatTrustReview,
  inspectTrustBundle,
});

export function registerProductRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'trust',
    description: 'Review trust posture and export portable trust bundles',
    hidden: true,
    usage: '[review|bundle export <path> --yes|bundle inspect <path>]',
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const shellPaths = requireShellPaths(ctx);
      if (
        await runTrustCommand(ctx, commandArgs, {
          resolvePath: (path) => shellPaths.resolveWorkspacePath(path),
          missingPathSuffix: (mode) => (mode === 'export' ? ' --yes' : ''),
          allowExport(path) {
            if (parsed.yes) return true;
            requireYesFlag(ctx, `export trust bundle to ${path}`, '/trust bundle export <path> --yes');
            return false;
          },
          inspectError: (error) => ctx.print(`Could not read that bundle file: ${error instanceof Error ? error.message : String(error)}`),
        })
      )
        return;
      ctx.print('Usage: /trust [review|bundle export <path> --yes|bundle inspect <path>]');
    },
  });
}
