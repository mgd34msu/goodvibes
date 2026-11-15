import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { atomicWriteFileSync } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandRegistry } from '../command-registry.ts';
import { listHookPointContracts } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { SetupTransferBundle } from './local-setup-transfer.ts';
import {
  applySetupTransferChanges,
  buildSetupTransferBundle,
  createSetupLink,
  exportSetupTransferBundle,
  inspectSetupTransferBundle,
  parseSetupLink,
  planSetupTransferImport,
  revertSetupTransferChanges,
} from './local-setup-transfer.ts';
import { buildSetupReviewSnapshot, exportSetupSupportBundle, renderSetupSandboxReview } from './local-setup-review.ts';
import { openOnboardingWizard, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

type SetupSnapshot = Awaited<ReturnType<typeof buildSetupReviewSnapshot>>;

export function registerLocalSetupCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'setup',
    aliases: ['startup'],
    description: 'Launch the onboarding wizard and review startup readiness, service posture, and sandbox bring-up',
    usage: '[review|doctor|services|hooks|remote|sandbox|onboarding|support-bundle <dir> [--overwrite]|export <path> [--overwrite]|transfer <export [--overwrite]|inspect|import [--yes]> <path>|link <surface> [target]|open-link <uri>]',
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
          `  sandbox backend: ${ctx.platform.configManager.get('sandbox.vmBackend')}`,
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
          ...snapshot.issues.map((issue) => `  [${issue.severity.toUpperCase()}] ${issue.area}: ${issue.message}`),
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
        const snapshot = await getSnapshot();
        ctx.print(renderSetupSandboxReview(ctx, snapshot));
        return;
      }

      if (sub === 'onboarding') {
        openOnboardingWizard(ctx, { mode: 'edit', reset: true });
        ctx.print('Opening onboarding wizard.');
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
        const targetDir = exportSetupSupportBundle(dirArg, snapshot, ctx);
        writeFileSync(join(targetDir, 'remote-summary.json'), JSON.stringify({
          runners: ctx.ops.remoteRuntime?.listContracts() ?? [],
          artifacts: (ctx.ops.remoteRuntime?.listArtifacts() ?? []).map((artifact) => ({
            id: artifact.id,
            runnerId: artifact.runnerId,
            status: artifact.task.status,
            createdAt: artifact.createdAt,
          })),
        }, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported support bundle to ${targetDir}`);
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
          ctx.print('Usage: /setup transfer <export [--overwrite]|inspect|import [--yes]> <path>');
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
          ctx.print(`Exported setup transfer bundle to ${exportSetupTransferBundle(ctx, pathArg, bundle)}`);
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
            const { bundle, changes, ignoredKeys } = plan;
            const replacedFiles = [
              bundle.services ? 'services.json' : undefined,
              bundle.ecosystem?.plugins ? 'ecosystem/plugins.json' : undefined,
              bundle.ecosystem?.skills ? 'ecosystem/skills.json' : undefined,
            ].filter((name): name is string => name !== undefined);
            if (!args.includes('--yes')) {
              ctx.print([
                `Setup transfer import from ${targetPath}: nothing was changed yet.`,
                `  settings that would change: ${changes.length}${changes.length > 0 ? ` (${changes.slice(0, 12).map((change) => change.key).join(', ')}${changes.length > 12 ? ', ...' : ''})` : ''}`,
                `  files that would be replaced: ${replacedFiles.length > 0 ? replacedFiles.join(', ') : 'none'}`,
                ...(ignoredKeys.length > 0 ? [`  unknown settings that would be skipped: ${ignoredKeys.join(', ')}`] : []),
                '  Review the list, then run /setup transfer import <path> --yes to apply it.',
              ].join('\n'));
              return;
            }
            applySetupTransferChanges(ctx.platform.configManager, changes);
            const fileWrites: Array<{ path: string; body: unknown }> = [];
            if (bundle.services) fileWrites.push({ path: getShellPaths().resolveProjectPath('tui', 'services.json'), body: bundle.services });
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
              revertSetupTransferChanges(ctx.platform.configManager, changes);
              const notRestored: string[] = [];
              for (const entry of replaced.reverse()) {
                try {
                  if (entry.previous === null) rmSync(entry.path, { force: true });
                  else atomicWriteFileSync(entry.path, entry.previous, { mkdirp: true });
                } catch {
                  notRestored.push(entry.path);
                }
              }
              ctx.print(`Failed to import setup transfer bundle: ${summarizeError(error)}. Settings were restored${notRestored.length > 0 ? `; these files could not be put back and still hold the imported contents: ${notRestored.join(', ')}` : ' and any files already replaced were put back'}.`);
              return;
            }
            ctx.print(`Imported setup transfer bundle from ${targetPath}: ${changes.length} setting(s) changed, ${replacedFiles.length} file(s) replaced${ignoredKeys.length > 0 ? `, ${ignoredKeys.length} unknown setting(s) skipped (${ignoredKeys.join(', ')})` : ''}.`);
          } catch (error) {
            ctx.print(`Failed to import setup transfer bundle (settings written before the failure were restored): ${summarizeError(error)}`);
          }
          return;
        }
        ctx.print('Usage: /setup transfer <export [--overwrite]|inspect|import [--yes]> <path>');
        return;
      }

      if (sub === 'link') {
        const surface = args[1];
        const target = args[2];
        if (!surface) {
          ctx.print('Usage: /setup link <cockpit|security|remote|knowledge|incident|hooks|orchestration|tasks> [target]');
          return;
        }
        ctx.print(createSetupLink(surface, target));
        return;
      }

      if (sub === 'open-link') {
        const link = args[1];
        if (!link) {
          ctx.print('Usage: /setup open-link <goodvibes://...>');
          return;
        }
        const parsed = parseSetupLink(link);
        if (!parsed) {
          ctx.print(`Invalid setup link: ${link}`);
          return;
        }
        const viewOpeners: Record<string, (() => void) | undefined> = {
          cockpit: ctx.openCockpitView,
          security: ctx.openSecurityView,
          remote: ctx.openRemoteView,
          knowledge: ctx.openKnowledgeView,
          incident: ctx.openIncidentView,
          hooks: ctx.openHooksView,
          orchestration: ctx.openOrchestrationView,
        };
        if (parsed.surface === 'tasks') {
          ctx.openView?.('tasks');
          ctx.print(`Opened setup link for tasks${parsed.target ? ` (${parsed.target})` : ''}.`);
          return;
        }
        const openSurface = viewOpeners[parsed.surface];
        if (!openSurface) {
          ctx.print(`Unsupported setup link surface: ${parsed.surface}`);
          return;
        }
        openSurface();
        ctx.print(`Opened setup link for ${parsed.surface}${parsed.target ? ` (${parsed.target})` : ''}.`);
        return;
      }

      ctx.print('Usage: /setup [review|doctor|services|hooks|remote|sandbox|onboarding|support-bundle <dir> [--overwrite]|export <path> [--overwrite]|transfer <export [--overwrite]|inspect|import [--yes]> <path>|link <surface> [target]|open-link <uri>]');
    },
  });
}
