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
// Plugins are in Tools and extensions (capabilities/builtin/plugins.ts); the lists a form picks one from read the daemon.
import '@goodvibes/engine/terminal-shell/plugin-trust-command';
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
import { capabilityBinding } from './capability-binding.ts';

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
    // The daemon decides this folder's trust in the shared register; the Agent reads it again at once, so the
    // folder's hooks file loads or stops and its MCP servers start or stop now.
    binding: capabilityBinding,
    folder: {
      reread: async (ctx) => { await trustManager(ctx); },
      decided: (ctx) => ctx.workspace.workspaceTrustManager?.isDecided(),
    },
    policyContext,
    sandboxConfig: (ctx) => ({
      get: (key) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
      setMcpIsolation: (mode) => {
        // The registry restarts its servers when the setting changes; an unchanged value restarts none.
        const registry = ctx.extensions.mcpRegistry;
        const before = registry.mcpIsolationChange();
        ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', mode);
        const after = registry.mcpIsolationChange();
        return after !== before && after !== null ? after : { mode, restarted: [], afterCall: [] };
      },
    }),
    resolvePath: (ctx, path) => requireShellPaths(ctx).resolveWorkspacePath(path),
    elsewhere: 'the terminal app (goodvibes)',
  }));
}
