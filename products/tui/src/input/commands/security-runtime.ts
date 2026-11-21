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
  requireReadModels,
  requireSecretsManager,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
  requireTokenAuditor,
} from './runtime-services.ts';
import { createPolicyCommandContext } from './policy-dispatch.ts';
import { describePermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';

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
    folder: {
      async status(ctx) {
        const manager = trustManager(ctx);
        const level = manager.getLevel();
        const lines = [
          `This folder is ${manager.isDecided() ? level : 'not decided yet (restricted until you decide)'}.`,
          level === 'trusted'
            ? 'Every tool may run here, subject to your permission settings.'
            : 'Reading only: tools that write, run commands or hand work to agents are refused here.',
        ];
        if (manager.hasIgnoredLegacyDecision()) lines.push('A trust.json inside this folder was found and is not honored: a project cannot decide its own trust. Decisions are kept in your own GoodVibes state.');
        const registrationManager = ctx.workspace.workspaceRegistrationManager;
        if (registrationManager) lines.push(`Registration: ${await registrationManager.describe()}`);
        return lines.join('\n');
      },
      async set(ctx, level) {
        const saved = await trustManager(ctx).setLevel(level);
        ctx.renderRequest();
        return [
          level === 'trusted'
            ? 'This folder is trusted: every tool may run here, subject to your permission settings.'
            : 'This folder is restricted: tools that write, run commands or hand work to agents are refused here.',
          ...(saved.saved ? [] : [`This applies to this session only: ${saved.fault ?? 'the decision could not be saved'}. It will be asked again next time.`]),
        ].join('\n');
      },
      decided: (ctx) => ctx.workspace.workspaceTrustManager?.isDecided(),
    },
    policyContext: createPolicyCommandContext,
    sandboxConfig: (ctx) => ({
      get: (key) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
      setMcpIsolation: (mode) => ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', mode),
    }),
    sandboxSessions: (ctx) => ctx.workspace.sandboxSessionRegistry ?? undefined,
    resolvePath: (ctx, path) => requireShellPaths(ctx).resolveWorkspacePath(path),
    elsewhere: 'the Agent (goodvibes-agent)',
  }));
}
