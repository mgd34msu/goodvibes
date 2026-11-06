import { createTrustReviewTools } from '@goodvibes-jev/engine/terminal-shell/trust-review';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireReadModels, requireSecretsManager, requireServiceRegistry, requireShellPaths } from './runtime-services.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

const { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle } = createTrustReviewTools<CommandContext>({
 listSecrets: ctx => requireSecretsManager(ctx).list(),
 serviceNames: ctx => Object.keys(requireServiceRegistry(ctx).getAll()),
 security: ctx => requireReadModels(ctx).security.getSnapshot(),
 permissionMode: ctx => ctx.platform.configManager.get('permissions.mode'),
 serviceLabel: 'integrations',
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
      const sub = commandArgs[0] ?? 'review';
      if (sub === 'review') {
        const bundle = await buildTrustReviewBundle(ctx);
        ctx.print(formatTrustReview(bundle));
        return;
      }
      if (sub === 'bundle') {
        const mode = commandArgs[1];
        const pathArg = commandArgs[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /trust bundle ${mode} <path>${mode === 'export' ? ' --yes' : ''}`);
          return;
        }
        if (mode === 'export') {
          if (!parsed.yes) {
            requireYesFlag(ctx, `export trust bundle to ${pathArg}`, '/trust bundle export <path> --yes');
            return;
          }
          const bundle = await buildTrustReviewBundle(ctx);
          const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Trust bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          try {
            ctx.print(inspectTrustBundle(shellPaths.resolveWorkspacePath(pathArg!)));
          } catch (error) {
            ctx.print(`Could not read that bundle file: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
      }
      ctx.print('Usage: /trust [review|bundle export <path> --yes|bundle inspect <path>]');
    },
  });
}
