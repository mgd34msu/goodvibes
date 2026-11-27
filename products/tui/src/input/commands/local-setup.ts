import { dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { buildSetupReviewSnapshot } from './local-setup-review.ts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { setupReviewLines } from '@goodvibes/engine/terminal-shell/setup-review';
import { requireShellPaths } from './runtime-services.ts';
import { DEEP_LINK_SURFACES, buildDeepLink, openDeepLink, parseDeepLink } from './deep-link.ts';
import { printedText } from '@goodvibes/engine/terminal-shell/health-command';
import { CapabilityRefusal, type SystemSessionServices } from '@goodvibes/engine/platform/platform/capabilities';

type SetupSnapshot = Awaited<ReturnType<typeof buildSetupReviewSnapshot>>;

/**
 * This app's own start, as the System capabilities `startup.*` take it (capabilities/builtin/system-program.ts;
 * session-capabilities.ts `systemSessionOf`): each runs one branch of `runStartupTool` and returns what it printed.
 */
export function startupOf(ctx: CommandContext): NonNullable<NonNullable<SystemSessionServices['systemSession']>['startup']> {
  const words = (args: readonly string[]): Promise<string> => printedText(ctx, (collecting) => runStartupTool(args, collecting));
  return {
    review: () => words(['review']),
    doctor: () => words(['doctor']),
    services: () => words(['services']),
    save: (path, replace) => words(['export', path, ...(replace ? ['--overwrite'] : [])]),
    link: (view, target) => buildDeepLink(view, target || undefined),
    openLink(uri) {
      const parsed = parseDeepLink(uri);
      if (!parsed) throw new CapabilityRefusal(`Not opened: ${uri} is not a goodvibes://open/<view> link.`);
      return openDeepLink(ctx, parsed.surface, parsed.target);
    },
  };
}

// `/startup` is gone: the System capabilities `startup.*` are the System place's controls (Health, "What it started
// with"; Support and transfer; Links), run there with this program's services (`startupOf`); the remote runners are
// Work and agents' Runners tab.

/** One setup check, by its words (`review`, `export <path>`, …). */
async function runStartupTool(args: readonly string[], ctx: CommandContext): Promise<void> {
    const sub = args[0] ?? 'review';
    let shellPaths: ReturnType<typeof requireShellPaths> | null = null;
    let snapshotPromise: Promise<SetupSnapshot> | null = null;
    const getShellPaths = () => (shellPaths ??= requireShellPaths(ctx));
    const getSnapshot = async (): Promise<SetupSnapshot> => {
      snapshotPromise ??= buildSetupReviewSnapshot(ctx);
      return snapshotPromise;
    };

    if (sub === 'review') {
      const snapshot = await getSnapshot();
      ctx.print([
        // A person reads this: no session id (an id names nothing they know; this is the program they are in).
        'What this program started with:',
        `  providers/models: ${snapshot.providerCount}`,
        `  services configured: ${snapshot.serviceCount}`,
        `  oauth providers: ${snapshot.oauthProviderCount + snapshot.builtinSubscriptionProviderCount}`,
        `  active subscriptions: ${snapshot.activeSubscriptionCount}`,
        `  pending subscriptions: ${snapshot.pendingSubscriptionCount}`,
        `  skills discovered: ${snapshot.skillCount}`,
        `  plugins discovered: ${snapshot.pluginCount}`,
        `  quarantined plugins: ${snapshot.quarantinedPluginCount}`,
        `  plugin search dirs: ${snapshot.pluginDirectories.length}`,
        `  managed hooks: ${snapshot.managedHookCount}`,
        `  managed hook chains: ${snapshot.managedHookChainCount}`,
        `  mcp servers known: ${snapshot.mcpServerCount}`,
        `  mcp quarantined: ${snapshot.quarantinedMcpCount}`,
        `  mcp elevated: ${snapshot.elevatedMcpCount}`,
        `  remote runners: ${snapshot.remoteRunnerCount}`,
        `  mcp server isolation: ${ctx.platform.configManager.get('sandbox.mcpIsolation')}`,
        '',
        `  service ids: ${snapshot.services.join(', ') || '(none)'}`,
        `  plugin dirs: ${snapshot.pluginDirectories.join(', ') || '(none)'}`,
      ].join('\n'));
      return;
    }

    if (sub === 'doctor') {
      const snapshot = await getSnapshot();
      ctx.print([
        'Startup Doctor',
        ...setupReviewLines(snapshot.checks),
        ...(snapshot.serviceIssues.length > 0
          ? ['', '  Service issues:', ...snapshot.serviceIssues.map((issue) => `    - ${issue}`)]
          : []),
      ].join('\n'));
      return;
    }

    if (sub === 'services') {
      const snapshot = await getSnapshot();
      ctx.print([
        'Startup Services',
        `  configured: ${snapshot.serviceCount}`,
        `  oauth providers: ${snapshot.oauthProviderCount + snapshot.builtinSubscriptionProviderCount}`,
        `  active subscriptions: ${snapshot.activeSubscriptionCount}`,
        `  pending subscriptions: ${snapshot.pendingSubscriptionCount}`,
        `  issues: ${snapshot.serviceIssues.length}`,
        ...snapshot.services.map((name) => `  ${name}`),
        ...(snapshot.serviceIssues.length > 0
          ? ['', ...snapshot.serviceIssues.map((issue) => `  issue: ${issue}`)]
          : []),
      ].join('\n'));
      return;
    }

    if (sub === 'export') {
      const snapshot = await getSnapshot();
      const pathArg = args[1];
      if (!pathArg) {
        ctx.print('Name the file the setup review is written to; nothing was written.');
        return;
      }
      const targetPath = getShellPaths().resolveWorkspacePath(pathArg);
      if (existsSync(targetPath) && !args.includes('--overwrite')) {
        throw commandRefusal(`${targetPath} already exists; nothing was written. Choose another file, or choose to write over it.`);
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
      ctx.print(`Exported startup review to ${targetPath}`);
      return;
    }

    if (sub === 'link') {
      const surface = args[1];
      const target = args[2];
      if (!surface) {
        ctx.print(`Name the view a link opens: ${DEEP_LINK_SURFACES.join(', ')}.`);
        return;
      }
      ctx.print(buildDeepLink(surface, target));
      return;
    }

    if (sub === 'open-link') {
      const link = args[1];
      if (!link) {
        ctx.print('Give the goodvibes://open/... link to open; nothing was opened.');
        return;
      }
      const parsed = parseDeepLink(link);
      if (!parsed) {
        ctx.print(`Not opened: ${link} is not a goodvibes://open/<view> link.`);
        return;
      }
      ctx.print(openDeepLink(ctx, parsed.surface, parsed.target));
      return;
    }

    ctx.print(`${sub} is not a setup check of this program; nothing was done.`);
}
