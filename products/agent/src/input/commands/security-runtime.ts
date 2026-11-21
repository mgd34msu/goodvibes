/**
 * `/security` in the Agent: one description shared with the terminal app
 * (terminal-shell/security-command.ts). This file holds what the Agent reads
 * and does for it: its security read model, its trust summary, this folder's
 * trust (which decides whether the folder's hooks file loads and the MCP
 * servers its files name start), the policy bundles and the sandbox setting.
 * Sandbox sessions and the screens are the terminal app's.
 */
import { createSecurityCommand } from '@goodvibes/engine/terminal-shell/security-command';
import { createTrustReviewTools } from '@goodvibes/engine/terminal-shell/trust-review';
import { registerPluginCommand } from '@goodvibes/engine/terminal-shell/plugin-trust-command';
import { atomicWriteFileSync } from '@goodvibes/engine/platform/platform/config';
import type { PolicyCommandContext } from '@goodvibes/engine/platform/platform/gate/policy';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import {
  requireReadModels,
  requireSecretsManager,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
  requireTokenAuditor,
} from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';
import { describePermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';
import { readExecutionModeInForce } from '../../permissions/execution-mode.ts';

const { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle } = createTrustReviewTools<CommandContext>({
  listSecrets: (ctx) => requireSecretsManager(ctx).list(),
  serviceNames: (ctx) => Object.keys(requireServiceRegistry(ctx).getAll()),
  security: (ctx) => requireReadModels(ctx).security.getSnapshot(),
  permissionMode: (ctx) => readExecutionModeInForce(ctx.platform.configManager) ?? describePermissionModeInForce(ctx.platform.configManager),
  serviceLabel: 'integrations',
});

async function trustManager(ctx: CommandContext) {
  const manager = ctx.workspace.workspaceTrustManager;
  if (!manager) throw commandRefusal('Folder trust is not available in this session.');
  await manager.load();
  return manager;
}

function policyContext(ctx: CommandContext): PolicyCommandContext {
  return {
    print: (text) => ctx.print(text),
    get policyRuntimeState() { return ctx.extensions.policyRuntimeState; },
    workingDirectory: () => requireShellPaths(ctx).workingDirectory,
    config: () => ctx.platform.configManager.getAll(),
    listMcpServerSecurity: () => ctx.extensions.mcpRegistry.listServerSecurity(),
  };
}

export function registerSecurityRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createSecurityCommand<CommandContext>({
    tokens: requireTokenAuditor,
    security: (ctx) => requireReadModels(ctx).security.getSnapshot(),
    policySnapshot: (ctx) => ctx.extensions.policyRuntimeState?.getSnapshot(),
    plugins: (ctx) => ctx.extensions.pluginManager?.list() ?? [],
    subscriptions: requireSubscriptionManager,
    screens: {},
    trust: {
      async review(ctx) { return formatTrustReview(await buildTrustReviewBundle(ctx)); },
      async save(ctx, path) {
        const target = requireShellPaths(ctx).resolveWorkspacePath(path);
        // Owner-only (0600): the summary lists secret key names and service names.
        atomicWriteFileSync(target, JSON.stringify(await buildTrustReviewBundle(ctx), null, 2) + '\n', { mkdirp: true });
        return `Saved the trust summary to ${target}.`;
      },
      read(ctx, path) {
        try {
          return inspectTrustBundle(requireShellPaths(ctx).resolveWorkspacePath(path));
        } catch (error) {
          throw commandRefusal(`Could not read that file: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    folder: {
      async status(ctx) {
        const manager = await trustManager(ctx);
        return [
          `${manager.workspaceRoot} is ${manager.isTrusted() ? 'trusted' : manager.isDecided() ? 'restricted' : 'not decided yet (restricted until you decide)'}.`,
          manager.isTrusted()
            ? 'Its hooks file loads and the MCP servers its files name start.'
            : 'Its hooks file is not loaded and the MCP servers its files name do not start; your own hooks and MCP files are not affected.',
        ].join('\n');
      },
      async set(ctx, level) {
        const manager = await trustManager(ctx);
        const saved = await manager.setLevel(level);
        ctx.renderRequest();
        return [
          level === 'trusted'
            ? `${manager.workspaceRoot} is trusted: its hooks file loads and the MCP servers its files name start.`
            : `${manager.workspaceRoot} is restricted: its hooks file and the MCP servers its files name are stopped now; your own hooks and MCP files are not affected.`,
          ...(saved.saved ? [] : [`This applies to this session only: ${saved.fault ?? 'the decision could not be saved'}. It will be asked again next time.`]),
        ].join('\n');
      },
      decided: (ctx) => ctx.workspace.workspaceTrustManager?.isDecided(),
    },
    policyContext,
    sandboxConfig: (ctx) => ({
      get: (key) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
      setMcpIsolation: (mode) => ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', mode),
    }),
    resolvePath: (ctx, path) => requireShellPaths(ctx).resolveWorkspacePath(path),
    elsewhere: 'the terminal app (goodvibes)',
  }));
  // Plugins load here as in the terminal app, so /plugin is here too; the plugins screen and the local curated catalog are the terminal app's.
  registerPluginCommand<CommandContext>(registry, { manager: (ctx) => ctx.extensions.pluginManager });
}
