/**
 * `/security` in the terminal app: one description shared with the Agent
 * (terminal-shell/security-command.ts). This file holds what the terminal app
 * reads and does for it: its security read model, its trust summary, this
 * folder's trust (which decides whether every tool may run here), the policy
 * bundles, the sandbox setting and the sandbox sessions.
 */
import { createSecurityCommand } from '@goodvibes/engine/terminal-shell/security-command';
import { createTrustReviewTools } from '@goodvibes/engine/terminal-shell/trust-review';
import { atomicWriteFileSync } from '@goodvibes/engine/platform/platform/config';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import {
  requireMcpRegistry,
  requireReadModels,
  requireSecretsManager,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
  requireTokenAuditor,
} from './runtime-services.ts';
import { createPolicyCommandContext } from './policy-dispatch.ts';
import { describePermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';
import { capabilityBinding } from './capability-binding.ts';

const { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle } = createTrustReviewTools<CommandContext>({
  listSecrets: (ctx) => requireSecretsManager(ctx).list(),
  serviceNames: (ctx) => Object.keys(requireServiceRegistry(ctx).getAll()),
  security: (ctx) => requireReadModels(ctx).security.getSnapshot(),
  permissionMode: (ctx) => describePermissionModeInForce(ctx.platform.configManager),
  serviceLabel: 'services',
});

function trustManager(ctx: CommandContext) {
  const manager = ctx.workspace.workspaceTrustManager;
  if (!manager) throw commandRefusal('Folder trust is not available in this session.');
  return manager;
}

export function registerSecurityRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createSecurityCommand<CommandContext>({
    tokens: requireTokenAuditor,
    security: (ctx) => requireReadModels(ctx).security.getSnapshot(),
    policySnapshot: (ctx) => ctx.extensions.policyRuntimeState?.getSnapshot(),
    plugins: (ctx) => ctx.extensions.pluginManager?.list() ?? [],
    subscriptions: requireSubscriptionManager,
    screens: {
      security: (ctx) => {
        if (!ctx.openSecurityView) throw commandRefusal('The security screen cannot be shown here.', '/security review prints the same counts.');
        ctx.openSecurityView();
      },
      policy: (ctx) => {
        if (!ctx.openPolicyView) throw commandRefusal('The policy screen cannot be shown here.', '/security policy prints the policy in force.');
        ctx.openPolicyView();
      },
      sandbox: (ctx) => {
        if (!ctx.openModal) throw commandRefusal('The sandbox screen cannot be shown here.', '/security sandbox prints the same review.');
        ctx.openModal('sandbox-modal');
      },
    },
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
          throw commandRefusal(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    // The daemon decides this folder's trust in the shared register; this app reads it again at once, so the
    // folder's hooks file loads or stops and its MCP servers start or stop now.
    binding: capabilityBinding,
    folder: {
      reread: async (ctx) => { await trustManager(ctx).load(); },
      decided: (ctx) => ctx.workspace.workspaceTrustManager?.isDecided(),
    },
    policyContext: createPolicyCommandContext,
    sandboxConfig: (ctx) => ({
      get: (key) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
      setMcpIsolation: (mode) => {
        // The registry restarts its servers when the setting changes; an unchanged value restarts none.
        const registry = requireMcpRegistry(ctx);
        const before = registry.mcpIsolationChange();
        ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', mode);
        const after = registry.mcpIsolationChange();
        return after !== before && after !== null ? after : { mode, restarted: [], afterCall: [] };
      },
    }),
    sandboxSessions: (ctx) => ctx.workspace.sandboxSessionRegistry ?? undefined,
    resolvePath: (ctx, path) => requireShellPaths(ctx).resolveWorkspacePath(path),
    elsewhere: 'the Agent (goodvibes-agent)',
  }));
}
