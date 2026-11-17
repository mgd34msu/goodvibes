import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { atomicWriteFileSync } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandRegistry } from '../command-registry.ts';
import { listHookPointContracts } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { SetupTransferBundle } from './local-setup-transfer.ts';
import {
  applySetupTransferChanges,
  buildSetupTransferBundle,
  describeSetupTransferChanges,
  exportSetupTransferBundle,
  inspectSetupTransferBundle,
  planSetupTransferImport,
  restoreSetupTransferChanges,
  settleSetupTransferChanges,
} from './local-setup-transfer.ts';
import { buildSetupReviewSnapshot, exportSetupSupportBundle, inspectSetupSupportBundle, renderSetupSandboxReview } from './local-setup-review.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { setupReviewLines } from '@goodvibes-jev/engine/terminal-shell/setup-review';
import { openOnboardingWizard, requireShellPaths } from './runtime-services.ts';
import { DEEP_LINK_SURFACES, buildDeepLink, openDeepLink, parseDeepLink } from './deep-link.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

type SetupSnapshot = Awaited<ReturnType<typeof buildSetupReviewSnapshot>>;

/** The files a setup transfer import replaces whole. */
function setupTransferReplacedFiles(bundle: SetupTransferBundle): string[] {
  return [
    bundle.services ? 'services.json' : undefined,
    bundle.ecosystem?.plugins ? 'ecosystem/plugins.json' : undefined,
    bundle.ecosystem?.skills ? 'ecosystem/skills.json' : undefined,
  ].filter((name): name is string => name !== undefined);
}

export function registerLocalSetupCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'setup',
    aliases: ['startup'],
    description: 'Launch the onboarding wizard and review startup readiness, service posture, and sandbox bring-up',
    usage: '[review|doctor|services|hooks|remote|sandbox|onboarding|support-bundle <dir> [--overwrite]|support-bundle inspect <dir>|export <path> [--overwrite]|transfer <export [--overwrite]|inspect|import> <path>|link <surface> [target]|open-link <uri>]',
    subcommands: {
      'support-bundle': '<dir> [--overwrite] | inspect <dir>', export: '<path> [--overwrite]',
      transfer: '<export [--overwrite]|inspect|import> <path>', link: '<surface> [target]', 'open-link': '<uri>',
    },
    confirm(args, ctx) {
      // One admission, at the caller when the caller is not a person: the owner
      // who typed the import has decided; a model-run import shows the owner the
      // plan (every security-bearing change in full) once.
      if (ctx.invokedByModel !== true) return undefined;
      if (args[0] !== 'transfer' || args[1]?.toLowerCase() !== 'import') return undefined;
      const pathArg = args.slice(2).find((value) => !value.startsWith('--'));
      if (!pathArg) return undefined;
      let plan: ReturnType<typeof planSetupTransferImport>;
      try {
        plan = planSetupTransferImport(ctx.platform.configManager, JSON.parse(readFileSync(requireShellPaths(ctx).resolveWorkspacePath(pathArg), 'utf-8')));
      } catch {
        return undefined; // The handler reports an unreadable bundle; nothing would change.
      }
      if (!plan.ok) return undefined;
      const { bundle, changes, ignoredKeys, skippedParts } = plan;
      const replacedFiles = setupTransferReplacedFiles(bundle);
      return {
        title: `Import setup from ${pathArg}?`,
        detail: [
          ...describeSetupTransferChanges(changes),
          `Files replaced: ${replacedFiles.length > 0 ? replacedFiles.join(', ') : 'none'}.`,
          ...(skippedParts.length > 0 ? [`Kept as they are here (the bundle masked credentials in them): ${skippedParts.join(', ')}.`] : []),
          ...(ignoredKeys.length > 0 ? [`Unknown settings skipped: ${ignoredKeys.join(', ')}.`] : []),
          'The replaced files are not kept.',
        ].join('\n'),
        confirmLabel: 'Import',
      };
    },
    async handler(args, ctx) {
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
          'Startup Readiness Review',
          `  session: ${snapshot.sessionId}`,
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

      if (sub === 'hooks') {
        const snapshot = await getSnapshot();
        const contracts = listHookPointContracts();
        ctx.print([
          'Startup Hooks',
          `  managed hooks: ${snapshot.managedHookCount}`,
          `  managed chains: ${snapshot.managedHookChainCount}`,
          `  hook contracts: ${contracts.length}`,
        ].join('\n'));
        return;
      }

      if (sub === 'remote') {
        const snapshot = await getSnapshot();
        const runners = ctx.ops.remoteRuntime?.listContracts() ?? [];
        ctx.print([
          'Startup Remote',
          `  runner contracts: ${snapshot.remoteRunnerCount}`,
          ...runners.map((runner) => `  ${runner.id}  [${runner.trustClass}]  ${runner.label}`),
        ].join('\n'));
        return;
      }

      if (sub === 'sandbox') {
        ctx.print(renderSetupSandboxReview(ctx));
        return;
      }

      if (sub === 'onboarding') {
        openOnboardingWizard(ctx, { mode: 'edit', reset: true });
        ctx.print('Opening onboarding wizard.');
        return;
      }

      if (sub === 'support-bundle' && args[1] === 'inspect') {
        // Reads a bundle back: the install, storage, helper and sandbox facts it carries.
        if (!args[2]) throw commandRefusal('Usage: /setup support-bundle inspect <dir>', 'Export one first with /setup support-bundle <dir>');
        const bundleDir = getShellPaths().resolveWorkspacePath(args[2]);
        let text: string;
        try {
          text = inspectSetupSupportBundle(bundleDir);
        } catch (error) {
          throw commandRefusal(`Could not read the support bundle in ${bundleDir}: ${summarizeError(error)}`, 'Export one with /setup support-bundle <dir>', 'BUNDLE_UNREADABLE');
        }
        ctx.print(text);
        return;
      }

      if (sub === 'support-bundle') {
        const snapshot = await getSnapshot();
        const dirArg = args[1];
        if (!dirArg) {
          ctx.print('Usage: /setup support-bundle <dir>');
          return;
        }
        const plannedDir = getShellPaths().resolveWorkspacePath(dirArg);
        if (existsSync(join(plannedDir, 'startup-review.json')) && !args.includes('--overwrite')) {
          ctx.print(`${plannedDir} already holds a support bundle; nothing was written. Choose another directory or add --overwrite.`);
          return;
        }
        const { targetDir, masked } = await exportSetupSupportBundle(dirArg, snapshot, ctx);
        writeFileSync(join(targetDir, 'remote-summary.json'), JSON.stringify({
          runners: ctx.ops.remoteRuntime?.listContracts() ?? [],
          artifacts: (ctx.ops.remoteRuntime?.listArtifacts() ?? []).map((artifact) => ({
            id: artifact.id,
            runnerId: artifact.runnerId,
            status: artifact.task.status,
            createdAt: artifact.createdAt,
          })),
        }, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported support bundle to ${targetDir}${masked > 0 ? ` (${masked} literal credential value(s) masked)` : ''}`);
        return;
      }

      if (sub === 'export') {
        const snapshot = await getSnapshot();
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /setup export <path>');
          return;
        }
        const targetPath = getShellPaths().resolveWorkspacePath(pathArg);
        if (existsSync(targetPath) && !args.includes('--overwrite')) {
          ctx.print(`${targetPath} already exists; nothing was written. Choose another path or add --overwrite.`);
          return;
        }
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported startup review to ${targetPath}`);
        return;
      }

      if (sub === 'transfer') {
        const mode = args[1]?.toLowerCase();
        const pathArg = args.slice(2).find((value) => !value.startsWith('--'));
        if (!mode || !pathArg) {
          ctx.print('Usage: /setup transfer <export [--overwrite]|inspect|import> <path>');
          return;
        }
        const targetPath = getShellPaths().resolveWorkspacePath(pathArg);
        if (mode === 'export') {
          if (existsSync(targetPath) && !args.includes('--overwrite')) {
            ctx.print(`${targetPath} already exists; nothing was written. Choose another path or add --overwrite.`);
            return;
          }
          const snapshot = await getSnapshot();
          const bundle = buildSetupTransferBundle(ctx, snapshot);
          const redacted = bundle.redacted ?? [];
          ctx.print([
            `Exported setup transfer bundle to ${exportSetupTransferBundle(ctx, pathArg, bundle)}`,
            ...(redacted.length > 0 ? [`  ${redacted.length} literal credential(s) were left out or masked (${redacted.slice(0, 8).join(', ')}${redacted.length > 8 ? ', ...' : ''}); secret-store references travel, so link credentials with /secrets link to carry them.`] : []),
          ].join('\n'));
          return;
        }
        if (mode === 'inspect') {
          try {
            const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SetupTransferBundle;
            ctx.print(`${inspectSetupTransferBundle(bundle)}\n  path: ${targetPath}`);
          } catch (error) {
            ctx.print(`Failed to inspect setup transfer bundle: ${summarizeError(error)}`);
          }
          return;
        }
        if (mode === 'import') {
          try {
            const plan = planSetupTransferImport(ctx.platform.configManager, JSON.parse(readFileSync(targetPath, 'utf-8')));
            if (!plan.ok) {
              ctx.print(`Setup transfer bundle not imported: ${plan.reason}`);
              return;
            }
            const { bundle, changes, ignoredKeys, skippedParts } = plan;
            const replacedFiles = setupTransferReplacedFiles(bundle);
            applySetupTransferChanges(ctx.platform.configManager, changes);
            // A daemon setting is answered by the daemon after the loop: a refusal undoes the whole import before any file is replaced.
            const settled = await settleSetupTransferChanges(ctx.platform.configManager, changes);
            if (settled.refused.length > 0) {
              ctx.print([
                `Setup transfer bundle not imported: the daemon refused ${settled.refused.length} setting(s), so ${settled.notRestored.length > 0 ? 'the other settings were put back where it allowed' : 'every setting was put back'} and no file was replaced.`,
                ...settled.refused.map((entry) => `  ${entry.key}: ${summarizeError(entry.error)}`),
                ...(settled.notRestored.length > 0 ? [`  these settings could not be put back and still hold the imported value: ${settled.notRestored.join(', ')}`] : []),
                'Change or remove those settings in the bundle (or set them on the daemon machine) and import again.',
              ].join('\n'));
              return;
            }
            const fileWrites: Array<{ path: string; body: unknown }> = [];
            if (bundle.services) fileWrites.push({ path: getShellPaths().resolveUserPath('tui', 'services.json'), body: bundle.services });
            if (bundle.ecosystem?.plugins) fileWrites.push({ path: getShellPaths().resolveProjectPath('tui', 'ecosystem', 'plugins.json'), body: bundle.ecosystem.plugins });
            if (bundle.ecosystem?.skills) fileWrites.push({ path: getShellPaths().resolveProjectPath('tui', 'ecosystem', 'skills.json'), body: bundle.ecosystem.skills });
            // Remember each file's previous contents so a failed write can put every replaced file back, not only the settings.
            const replaced: Array<{ path: string; previous: string | null }> = [];
            try {
              for (const write of fileWrites) {
                const previous = existsSync(write.path) ? readFileSync(write.path, 'utf-8') : null;
                atomicWriteFileSync(write.path, JSON.stringify(write.body, null, 2) + '\n', { mkdirp: true });
                replaced.push({ path: write.path, previous });
              }
            } catch (error) {
              const settingsNotRestored = await restoreSetupTransferChanges(ctx.platform.configManager, changes);
              const notRestored: string[] = [];
              for (const entry of replaced.reverse()) {
                try {
                  if (entry.previous === null) rmSync(entry.path, { force: true });
                  else atomicWriteFileSync(entry.path, entry.previous, { mkdirp: true });
                } catch {
                  notRestored.push(entry.path);
                }
              }
              ctx.print(`Failed to import setup transfer bundle: ${summarizeError(error)}. ${settingsNotRestored.length > 0 ? `Settings were restored except ${settingsNotRestored.join(', ')}, which the daemon would not take back` : 'Settings were restored'}${notRestored.length > 0 ? `; these files could not be put back and still hold the imported contents: ${notRestored.join(', ')}` : ' and any files already replaced were put back'}.`);
              return;
            }
            ctx.print(`Imported setup transfer bundle from ${targetPath}: ${changes.length} setting(s) changed, ${replacedFiles.length} file(s) replaced${skippedParts.length > 0 ? `, ${skippedParts.join(' and ')} kept as they are here (the bundle masked credentials in them; move those credentials into the secret store with /secrets link on the exporting machine and export again)` : ''}${ignoredKeys.length > 0 ? `, ${ignoredKeys.length} unknown setting(s) skipped (${ignoredKeys.join(', ')})` : ''}.`);
          } catch (error) {
            ctx.print(`Failed to import setup transfer bundle (settings written before the failure were restored): ${summarizeError(error)}`);
          }
          return;
        }
        ctx.print('Usage: /setup transfer <export [--overwrite]|inspect|import> <path>');
        return;
      }

      if (sub === 'link') {
        const surface = args[1];
        const target = args[2];
        if (!surface) {
          ctx.print(`Usage: /setup link <${DEEP_LINK_SURFACES.join('|')}> [target]`);
          return;
        }
        ctx.print(buildDeepLink(surface, target));
        return;
      }

      if (sub === 'open-link') {
        const link = args[1];
        if (!link) {
          ctx.print('Usage: /setup open-link <goodvibes://open/...>');
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

      ctx.print('Usage: /setup [review|doctor|services|hooks|remote|sandbox|onboarding|support-bundle <dir> [--overwrite]|export <path> [--overwrite]|transfer <export [--overwrite]|inspect|import> <path>|link <surface> [target]|open-link <uri>]');
    },
  });
}
