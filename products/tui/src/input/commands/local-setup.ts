import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { atomicWriteFileSync } from '@goodvibes/engine/platform/platform/config';
import type { CommandContext } from '../command-registry.ts';
import { defineCommand, type ActionDescription, type ActionValues, type InputDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { listHookPointContracts } from '@goodvibes/engine/platform/platform/hooks';
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
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { setupReviewLines } from '@goodvibes/engine/terminal-shell/setup-review';
import { requireShellPaths } from './runtime-services.ts';
import { DEEP_LINK_SURFACES, buildDeepLink, openDeepLink, parseDeepLink } from './deep-link.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { assertTarget, targetRef, TargetChangedError, type TargetRef } from '@goodvibes/engine/platform/platform/utils/target-ref';

/** The bundle file a setup import shows, by the digest of what it holds: the import applies only that content. */
function setupImportRef(pathArg: string, parsed: unknown): TargetRef<'setup-import'> {
  // Each setting is a fact of its own, so a rewritten file is refused naming the settings that differ.
  const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { config?: unknown }).config : undefined;
  const settings = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {};
  const rest = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>), config: undefined } : parsed;
  const facts: Record<string, unknown> = { bundle: rest };
  const shown: Record<string, string> = { bundle: `the rest of ${pathArg}` };
  for (const [key, value] of Object.entries(settings)) {
    facts[`setting ${key}`] = value;
    shown[`setting ${key}`] = JSON.stringify(value)?.slice(0, 80) ?? String(value);
  }
  return targetRef('setup-import', pathArg, facts, shown);
}

type SetupSnapshot = Awaited<ReturnType<typeof buildSetupReviewSnapshot>>;

/** The files a setup transfer import replaces whole. */
function setupTransferReplacedFiles(bundle: SetupTransferBundle): string[] {
  return [
    bundle.services ? 'services.json' : undefined,
    bundle.ecosystem?.plugins ? 'ecosystem/plugins.json' : undefined,
    bundle.ecosystem?.skills ? 'ecosystem/skills.json' : undefined,
  ].filter((name): name is string => name !== undefined);
}

/**
 * `/startup`: the setup checks and transfers. Each action runs one branch of
 * `runStartupTool` with the words it was given. (`/setup` holds the setup
 * topics, terminal-shell/setup-command.ts.)
 */
const OVERWRITE: InputDescription = {
  id: 'overwrite', label: 'If it is already there', help: 'What happens when something is already at that place', kind: 'choice',
  choices: [{ value: 'keep', label: 'Leave it and stop' }, { value: 'replace', label: 'Replace it', risk: 'cannot-be-undone' }],
  required: { default: 'keep', defaultMeans: 'leave it and stop' }, typed: { flag: '--overwrite', switchOn: 'replace' },
};
const placeInput = (id: string, label: string, help: string): InputDescription =>
  textInput({ id, label, help, why: 'A file or folder on this computer, typed as a path.', kind: 'path', typed: { position: 1 } });
const withOverwrite = (values: ActionValues): string[] => values.overwrite === 'replace' ? ['--overwrite'] : [];

function startupRead(id: string, label: string, sentence: string, sub: string): ActionDescription<CommandContext> {
  return readAction<CommandContext>({ id, label, word: id, sentence, async run(_values, ctx) { await runStartupTool([sub], ctx); } });
}

export const STARTUP_TOOL_ACTIONS: readonly ActionDescription<CommandContext>[] = [
  startupRead('review', 'See what this setup has', 'Shows the providers, services, plugins, hooks and servers this setup has.', 'review'),
  startupRead('doctor', 'Check this setup for problems', 'Checks this setup and lists what is not working.', 'doctor'),
  startupRead('services', 'See the services and sign-ins', 'Shows the configured services, provider sign-ins and their problems.', 'services'),
  startupRead('hooks', 'See the hooks', 'Shows how many hooks and hook chains this setup manages.', 'hooks'),
  startupRead('remote', 'See the remote runners', 'Shows the remote runners this setup can hand work to.', 'remote'),
  startupRead('sandbox', 'See the sandbox', 'Shows how commands are contained on this computer.', 'sandbox'),
  doAction<CommandContext>({
    id: 'support-bundle', label: 'Save a support bundle', word: 'support-bundle',
    inputs: [placeInput('dir', 'Folder', 'The folder the support bundle is written to'), OVERWRITE],
    sentence: 'A support bundle about this setup is written to {dir}; credentials in it are masked.',
    example: { dir: 'support' },
    async run(values, ctx) { await runStartupTool(['support-bundle', values.dir!, ...withOverwrite(values)], ctx); },
  }),
  readAction<CommandContext>({
    id: 'support-bundle-inspect', label: 'Read a support bundle', word: 'support-bundle-inspect',
    inputs: [placeInput('dir', 'Folder', 'The folder that holds the support bundle')],
    sentence: 'Shows what the support bundle in {dir} says about its setup.',
    example: { dir: 'support' },
    async run(values, ctx) { await runStartupTool(['support-bundle', 'inspect', values.dir!], ctx); },
  }),
  doAction<CommandContext>({
    id: 'export', label: 'Save the setup review to a file', word: 'export',
    inputs: [placeInput('path', 'File', 'The file the setup review is written to'), OVERWRITE],
    sentence: 'The setup review is written as JSON to {path}.',
    example: { path: 'setup-review.json' },
    async run(values, ctx) { await runStartupTool(['export', values.path!, ...withOverwrite(values)], ctx); },
  }),
  doAction<CommandContext>({
    id: 'transfer-export', label: 'Save this setup to move it', word: 'transfer-export',
    inputs: [placeInput('path', 'File', 'The file the setup is written to'), OVERWRITE],
    sentence: 'Settings, services, plugins and skills are written to {path} for another computer; literal credentials are left out.',
    example: { path: 'setup-transfer.json' },
    async run(values, ctx) { await runStartupTool(['transfer', 'export', values.path!, ...withOverwrite(values)], ctx); },
  }),
  readAction<CommandContext>({
    id: 'transfer-inspect', label: 'Read a moved setup', word: 'transfer-inspect',
    inputs: [placeInput('path', 'File', 'The setup file to read')],
    sentence: 'Shows what the setup file {path} holds.',
    example: { path: 'setup-transfer.json' },
    async run(values, ctx) { await runStartupTool(['transfer', 'inspect', values.path!], ctx); },
  }),
  doAction<CommandContext>({
    id: 'transfer-import', label: 'Bring in a moved setup', word: 'transfer-import',
    inputs: [placeInput('path', 'File', 'The setup file to bring in')],
    sentence: 'The settings and files in {path} replace the ones here, after you see the plan.',
    example: { path: 'setup-transfer.json' },
    async run(values, ctx) {
      const pathArg = values.path!;
      // The owner sees the plan, every changed setting and replaced file, and the import applies exactly that content.
      let parsed: unknown;
      let plan: ReturnType<typeof planSetupTransferImport>;
      try {
        parsed = JSON.parse(readFileSync(requireShellPaths(ctx).resolveWorkspacePath(pathArg), 'utf-8'));
        plan = planSetupTransferImport(ctx.platform.configManager, parsed);
      } catch {
        await runStartupTool(['transfer', 'import', pathArg], ctx); // reports the unreadable bundle
        return;
      }
      if (plan.ok && ctx.confirm) {
        const { bundle, changes, ignoredKeys, skippedParts } = plan;
        const replacedFiles = setupTransferReplacedFiles(bundle);
        const go = await ctx.confirm({
          title: `Bring in the setup from ${pathArg}?`,
          body: [
            ...describeSetupTransferChanges(changes),
            `Files replaced: ${replacedFiles.length > 0 ? replacedFiles.join(', ') : 'none'}.`,
            ...(skippedParts.length > 0 ? [`Kept as they are here (the bundle masked credentials in them): ${skippedParts.join(', ')}.`] : []),
            ...(ignoredKeys.length > 0 ? [`Unknown settings skipped: ${ignoredKeys.join(', ')}.`] : []),
            'The replaced files are not kept.',
          ].join('\n'),
          confirmLabel: 'Import',
          tone: 'danger',
        });
        if (!go) { ctx.print('Nothing was imported.'); return; }
      }
      await runStartupTool(['transfer', 'import', pathArg], ctx, setupImportRef(pathArg, parsed));
    },
  }),
  readAction<CommandContext>({
    id: 'link', label: 'Make a link to a view', word: 'link',
    inputs: [
      textInput({ id: 'surface', label: 'View', help: `The view the link opens: ${DEEP_LINK_SURFACES.join(', ')}`, why: 'A view name, as /deeplink review lists them.', typed: { position: 1 } }),
      textInput({ id: 'target', label: 'Item', help: 'One item in that view, by its id', why: 'An id inside the view, typed as it is shown there.', typed: { position: 2 }, optional: { default: '', means: 'the view itself' } }),
    ],
    sentence: 'Shows a goodvibes:// link that opens {surface}.',
    example: { surface: DEEP_LINK_SURFACES[0]! },
    async run(values, ctx) { await runStartupTool(['link', values.surface!, ...(values.target ? [values.target] : [])], ctx); },
  }),
  doAction<CommandContext>({
    id: 'open-link', label: 'Open a goodvibes:// link', word: 'open-link', touches: 'reads',
    inputs: [textInput({ id: 'uri', label: 'Link', help: 'A goodvibes://open/… link', why: 'A link someone gave you, pasted as it is.', typed: { position: 1 } })],
    sentence: 'Opens the view the link {uri} names.',
    example: { uri: 'goodvibes://open/settings' },
    async run(values, ctx) { await runStartupTool(['open-link', values.uri!], ctx); },
  }),
];

/** `/startup`: check, export or move this setup. */
export const STARTUP_COMMAND = defineCommand<CommandContext>({
  name: 'startup',
  title: 'Check, export or move your setup',
  summary: 'Check this setup, or save and bring in a setup',
  group: 'Settings',
  report: 'review',
  firstScreenRows: [
    { label: 'See what this setup has…', actions: ['review', 'doctor', 'services', 'hooks', 'remote', 'sandbox'] },
    { label: 'Save or read a support bundle…', actions: ['support-bundle', 'support-bundle-inspect', 'export'] },
    { label: 'Move this setup to another computer…', actions: ['transfer-export', 'transfer-inspect', 'transfer-import'] },
    { label: 'Links to views…', actions: ['link', 'open-link'] },
  ],
  actions: STARTUP_TOOL_ACTIONS,
});

/** One setup check or transfer, by its words (`review`, `transfer import <path>`, …). */
async function runStartupTool(args: readonly string[], ctx: CommandContext, reviewed?: unknown): Promise<void> {
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

    if (sub === 'support-bundle' && args[1] === 'inspect') {
      // Reads a bundle back: the install, storage, helper and sandbox facts it carries.
      if (!args[2]) throw commandRefusal('Usage: /startup support-bundle-inspect <dir>', 'Save one first with /startup support-bundle <dir>');
      const bundleDir = getShellPaths().resolveWorkspacePath(args[2]);
      let text: string;
      try {
        text = inspectSetupSupportBundle(bundleDir);
      } catch (error) {
        throw commandRefusal(`Could not read the support bundle in ${bundleDir}: ${summarizeError(error)}`, 'Save one with /startup support-bundle <dir>', 'BUNDLE_UNREADABLE');
      }
      ctx.print(text);
      return;
    }

    if (sub === 'support-bundle') {
      const snapshot = await getSnapshot();
      const dirArg = args[1];
      if (!dirArg) {
        ctx.print('Usage: /startup support-bundle <dir>');
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
        ctx.print('Usage: /startup export <path>');
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
        ctx.print('Usage: /startup transfer-export|transfer-inspect|transfer-import <path>');
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
          const parsed: unknown = JSON.parse(readFileSync(targetPath, 'utf-8'));
          const shown = reviewed as TargetRef<'setup-import'> | undefined;
          if (shown) assertTarget(shown, setupImportRef(shown.id, parsed), `/startup transfer-import ${shown.id}`);
          const plan = planSetupTransferImport(ctx.platform.configManager, parsed);
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
          // A rewritten bundle goes back to the confirmation, which shows it again.
          if (error instanceof TargetChangedError) throw error;
          ctx.print(`Failed to import setup transfer bundle (settings written before the failure were restored): ${summarizeError(error)}`);
        }
        return;
      }
      ctx.print('Usage: /startup transfer-export|transfer-inspect|transfer-import <path>');
      return;
    }

    if (sub === 'link') {
      const surface = args[1];
      const target = args[2];
      if (!surface) {
        ctx.print(`Usage: /startup link <${DEEP_LINK_SURFACES.join('|')}> [target]`);
        return;
      }
      ctx.print(buildDeepLink(surface, target));
      return;
    }

    if (sub === 'open-link') {
      const link = args[1];
      if (!link) {
        ctx.print('Usage: /startup open-link <goodvibes://open/...>');
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

    ctx.print('Usage: /startup');
}
