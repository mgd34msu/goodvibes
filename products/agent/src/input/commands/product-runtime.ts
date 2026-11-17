import { createTrustReviewTools, createTrustCommandFlow, trustBundleExportConfirmation } from '@goodvibes-jev/engine/terminal-shell/trust-review';
import 'node:fs';
import 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireReadModels, requireSecretsManager, requireServiceRegistry, requireShellPaths } from './runtime-services.ts';
import { commandRefusal, stripYesFlag } from './confirmation.ts';

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
    effect: 'mixed',
    description: "Review trust posture, set this workspace's trust level, or export portable trust bundles",
    hidden: true,
    usage: '[review|workspace [trusted|restricted]|bundle export <path>|bundle inspect <path>]',
    confirm: (args, ctx) => trustBundleExportConfirmation(args, (path) => requireShellPaths(ctx).resolveWorkspacePath(path)),
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      if (commandArgs[0] === 'workspace') {
        // The decision every GoodVibes app reads for this directory; here it decides whether the
        // repository's hooks file loads and the MCP servers its files name start.
        const manager = ctx.workspace.workspaceTrustManager;
        if (!manager) throw commandRefusal('Workspace trust is unavailable in this context.');
        await manager.load();
        const choice = (commandArgs[1] ?? '').toLowerCase();
        if (choice === 'trusted' || choice === 'trust' || choice === 'yes' || choice === 'restricted' || choice === 'restrict' || choice === 'no') {
          const level = choice === 'trusted' || choice === 'trust' || choice === 'yes' ? 'trusted' : 'restricted';
          const saved = await manager.setLevel(level);
          ctx.print(level === 'trusted'
            ? `${manager.workspaceRoot} is now TRUSTED: its hooks file loads and the MCP servers its files name start.`
            : `${manager.workspaceRoot} is now RESTRICTED: its hooks file and the MCP servers its files name stay off from the next start.`);
          if (!saved.saved) ctx.print(`This applies to this session only: ${saved.fault ?? 'the decision could not be saved'}. It will be asked again next time.`);
          ctx.renderRequest();
          return;
        }
        if (choice && choice !== 'status' && choice !== 'show') throw commandRefusal(`Unknown workspace trust option "${commandArgs[1]}". Usage: /trust workspace [trusted|restricted]`);
        const lines = [
          `Workspace trust for ${manager.workspaceRoot}: ${manager.isTrusted() ? 'TRUSTED' : manager.isDecided() ? 'RESTRICTED' : 'NOT DECIDED'}`,
          manager.isTrusted()
            ? 'Its hooks file loads and the MCP servers its files name start.'
            : 'Its hooks file is not loaded and the MCP servers its files name do not start; your own hooks and MCP files are not affected.',
          'Change with:  /trust workspace trusted   |   /trust workspace restricted',
        ];
        ctx.print(lines.join('\n'));
        return;
      }
      const shellPaths = requireShellPaths(ctx);
      if (
        await runTrustCommand(ctx, commandArgs, {
          resolvePath: (path) => shellPaths.resolveWorkspacePath(path),
          inspectError: (error) => ctx.print(`Could not read that bundle file: ${error instanceof Error ? error.message : String(error)}`),
        })
      )
        return;
      throw commandRefusal('Usage: /trust [review|bundle export <path>|bundle inspect <path>]');
    },
  });
}
