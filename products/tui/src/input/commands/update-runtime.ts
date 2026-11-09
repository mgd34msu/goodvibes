import { applySuiteUpdate, installedSuiteNeedsRepair, rollbackSuiteUpdate, SuiteUpdateRecoveryError, type SuiteUpdateResult } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { createSelfUpdateCommand, retainSuiteUpdateConfiguration, formatSuiteUpdateReport } from '@goodvibes-jev/engine/terminal-shell/release-update-preflight';
import {
  checkReleaseUpdate,
  prepareReleaseUpdate,
  requireBinaryUpdateInstall,
  type ReleaseUpdateCheck,
} from '@goodvibes-jev/engine/terminal-shell/release-update-preflight';
import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_UPDATE_GUIDANCE } from '../../runtime/workspace-update-policy.ts';
/** `/update` uses the platform's shared suite transaction. Every installed
 * sibling product and its native/browser companions comes from the same
 * release; an explicitly configured installer-owned WebUI keeps its served
 * path. Apply/rollback preserve earlier programs and check saved-data readers
 * before changing live files. Running programs use the replacement on restart.
 * `/update review` and `bundle` inspect/export this installation's posture.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  captureUpdateFileIo,
  UpdateTransactionError,
  realUpdateFileIo,
  type UpdateFileIo,
} from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveArtifactNames } from '../../runtime/release-artifacts.ts';
import { detectInstallKind, fallbackUpdateCommand, type InstallKind, type UpdateFetchLike } from '../../runtime/update-check.ts';
import { resolveConfiguredServiceName } from '../../runtime/legacy-daemon-migration.ts';
import { requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';

const REPO_RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes/releases/latest';

function releaseDownloadBaseUrl(tag: string): string {
  return `https://github.com/mgd34msu/goodvibes/releases/download/${tag}`;
}

/**
 * External progress for launch-time budgets. Preparation is cancellable until
 * the synchronous live commit; a compensated failure is not an installation.
 * A completed commit or explicit recovery fence must never be called a clean
 * deferral when a launch caller is deciding what happened on disk.
 */
export interface UpdateSwapProgress {
  /** The disk update committed or requires recovery; it cannot be called a clean deferral. */
  begun: boolean;
  /** True once every target file has been swapped into place and the update is fully installed. */
  committed: boolean;
  /** The release tag being installed, set as soon as the target is resolved (before any download). */
  targetTag: string | null;
}

export function createUpdateSwapProgress(): UpdateSwapProgress {
  return { begun: false, committed: false, targetTag: null };
}

/** The failure an aborted update ends with, raised only while nothing has been written yet. */
export const UPDATE_ABORTED_MESSAGE = 'update cancelled before any file was replaced';

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error(UPDATE_ABORTED_MESSAGE);
  }
}

/** Preserve the core's owned deadline signal; use the caller signal for pre-reads. */
type AbortableFetchInit = NonNullable<Parameters<UpdateFetchLike>[1]> & { signal?: AbortSignal };

function abortableFetch(fetchImpl: UpdateFetchLike, signal: AbortSignal | undefined): UpdateFetchLike {
  if (!signal) return fetchImpl;
  const withSignal = fetchImpl as (url: string, init?: AbortableFetchInit) => ReturnType<UpdateFetchLike>;
  return async (url, init) => {
    throwIfAborted(signal);
    return await withSignal(url, { ...init, signal: init?.signal ?? signal });
  };
}

/**
 * Suffix under which every swap keeps the file it replaced, re-exported
 * from the SDK's canonical update policy module so rollback and swap share
 * one definition everywhere.
 */
export { PREVIOUS_FILE_SUFFIX } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';

export interface DaemonServiceRestartInfo {
  readonly managed: boolean;
  readonly unitName: string;
  readonly restartCommand: string;
}

/** Injectable so tests never shell out to a real systemctl. */
export type RunCommand = (command: string, args: string[]) => { readonly status: number | null; readonly stdout: string };

const defaultRunCommand: RunCommand = (command, args) => {
  try {
    const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8' });
    return { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

/**
 * Detects, honestly, whether the daemon is currently running as a systemd
 * user service, so the post-update message can tell the user the real
 * restart command instead of assuming one. Only Linux/systemd is checked
 * (this repo's PlatformServiceManager also supports launchd on macOS and
 * Scheduled Tasks on Windows, but those aren't restarted with `systemctl`,
 * so on those platforms this honestly reports "not managed here" rather
 * than printing a command that would not work).
 */
export function detectDaemonServiceManaged(
  platform: NodeJS.Platform,
  configManager: { get(key: string): unknown },
  runCommand: RunCommand = defaultRunCommand,
): DaemonServiceRestartInfo {
  const unitName = resolveConfiguredServiceName(configManager);
  if (platform !== 'linux') {
    return { managed: false, unitName, restartCommand: '' };
  }
  const result = runCommand('systemctl', ['--user', 'is-active', `${unitName}.service`]);
  const managed = result.status === 0 && result.stdout.trim() === 'active';
  return { managed, unitName, restartCommand: `systemctl --user restart ${unitName}.service` };
}

export type CheckForUpdateResult = ReleaseUpdateCheck;

export async function checkForUpdate(fetchImpl: UpdateFetchLike, currentVersion: string): Promise<CheckForUpdateResult> {
  return checkReleaseUpdate(fetchImpl, currentVersion, REPO_RELEASES_LATEST_URL);
}

export interface ApplyUpdateOptions {
  readonly fetchImpl: UpdateFetchLike;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly print: (line: string) => void;
  readonly configManager: { get(key: string): unknown };
  readonly runCommand?: RunCommand;
  /** Injectable filesystem seam (the SDK's UpdateFileIo) so tests observe swaps in memory. */
  readonly io?: UpdateFileIo;
  /**
   * Cancels the update, for real: it is passed to every fetch in the path and
   * re-checked at every await boundary, so an abort stops the download instead
   * of leaving it running unwatched. Honoured only up to the moment before the
   * live commit begins; staged files are cleaned if it aborts before that point.
   */
  readonly signal?: AbortSignal;
  /** Shared record letting the caller tell a cancelled update apart from one whose swap had already started. */
  readonly progress?: UpdateSwapProgress;
}

/** Prepare the selected release and apply the platform's complete installed
 * suite. Progress distinguishes clean refusal from committed/recovery state. */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<SuiteUpdateResult | undefined> {
  options = {
    ...options,
    io: captureUpdateFileIo(options.io ?? realUpdateFileIo),
    configManager: { get: options.configManager.get.bind(options.configManager) },
  };
  const signal = options.signal,
    progress = options.progress;
  const configuration = retainSuiteUpdateConfiguration(options.configManager);
  const fetchImpl = abortableFetch(options.fetchImpl, signal);
  const prepared = await prepareReleaseUpdate(
    { ...options, fetchImpl },
    {
      latestUrl: REPO_RELEASES_LATEST_URL,
      downloadBase: releaseDownloadBaseUrl,
      asset: resolveArtifactNames,
      fallback: fallbackUpdateCommand,
      unsupportedSuffix: ' Update with: ' + fallbackUpdateCommand('source'),
      assertActive: () => { throwIfAborted(signal); configuration.assertCurrent(); },
      target: (tag) => {
        if (progress) progress.targetTag = tag;
      },
      repairRequired: version => installedSuiteNeedsRepair({ ...options, version, webuiDirectory: configuration.webuiDirectory }),
    },
  );
  if (!prepared) return;
  const { latestTag, baseUrl } = prepared;
  try {
    const result = await applySuiteUpdate({
      fetchImpl, downloadBaseUrl: baseUrl, execPath: options.execPath, platform: options.platform, arch: options.arch,
      version: latestTag, io: options.io ?? realUpdateFileIo,
      webuiDirectory: configuration.webuiDirectory, assertCurrent: configuration.assertCurrent,
      ...(signal ? { signal } : {}),
    });
    if (progress) { progress.begun = true; progress.committed = true; }
    const service = detectDaemonServiceManaged(options.platform, options.configManager, options.runCommand);
    options.print(formatSuiteUpdateReport(result, 'updated', result.programs.includes('goodvibes-daemon') && service.managed ? [`Daemon restart: ${service.restartCommand}`] : []));
    return result;
  } catch (error) {
    if (progress && error instanceof UpdateTransactionError) {
      progress.begun = error.receipt.committed || error.receipt.recoveryRequired;
      progress.committed = error.receipt.committed;
    } else if (progress && error instanceof SuiteUpdateRecoveryError) { progress.begun = true; progress.committed = error.committed; }
    throw error;
  }
}

export interface RollbackUpdateOptions {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly print: (line: string) => void;
  readonly configManager: { get(key: string): unknown };
  readonly runCommand?: RunCommand;
  /** Injectable filesystem seam (the SDK's UpdateFileIo) so tests observe renames in memory. */
  readonly io?: UpdateFileIo;
}

/** Restore the selected suite and its directory assets together. */
export function rollbackUpdate(options: RollbackUpdateOptions): void {
  if (!requireBinaryUpdateInstall(options.execPath, options.print, fallbackUpdateCommand, true)) return;

  const configuration = retainSuiteUpdateConfiguration(options.configManager);
  const result = rollbackSuiteUpdate({ ...options, currentVersion: VERSION,
    webuiDirectory: configuration.webuiDirectory, assertCurrent: configuration.assertCurrent });
  const service = detectDaemonServiceManaged(options.platform, options.configManager, options.runCommand);
  options.print(formatSuiteUpdateReport(result, 'restored', result.programs.includes('goodvibes-daemon') && service.managed ? [`Daemon restart: ${service.restartCommand}`] : []));
}

interface UpdateBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly appVersion: string;
  readonly installKind: InstallKind;
  readonly subscriptionProviders: readonly string[];
  readonly sandboxProfile: string;
  readonly notes: readonly string[];
}

function inspectUpdateBundle(bundle: UpdateBundle): string {
  return [
    'Update Bundle Review',
    `  appVersion: ${bundle.appVersion}`,
    `  installKind: ${bundle.installKind}`,
    `  subscriptionProviders: ${bundle.subscriptionProviders.length}`,
    `  sandboxProfile: ${bundle.sandboxProfile}`,
    `  notes: ${bundle.notes.length}`,
  ].join('\n');
}

export function registerUpdateCommand(registry: CommandRegistry): void {
  registry.register(selfUpdateCommand);
}

const selfUpdateCommand = createSelfUpdateCommand<CommandContext>({
  description:
    'Check for a newer GoodVibes release and, for binary installs, download/verify/apply it or roll back to the kept previous version',
  usage: '[check|apply|rollback|review|bundle export <path>|bundle inspect <path>]',
  help: 'Usage: /update [check|apply|rollback|review|bundle export <path>|bundle inspect <path>]',
  version: VERSION,
  workspaceDistribution: IS_WORKSPACE_DISTRIBUTION,
  workspaceGuidance: WORKSPACE_UPDATE_GUIDANCE,
  check: checkForUpdate,
  repairRequired: (version, ctx) => installedSuiteNeedsRepair({ execPath: process.execPath, platform: process.platform, arch: process.arch, version,
    webuiDirectory: retainSuiteUpdateConfiguration(ctx.platform.configManager).webuiDirectory }),
  onRecovery: (_error, ctx) => ctx.exit(),
  apply: async (options, ctx) => { await applyUpdate({ ...options, configManager: ctx.platform.configManager }); },
  rollback: (options, ctx) => rollbackUpdate({ ...options, configManager: ctx.platform.configManager }),
  extra: async (args, ctx) => {
    const sub = args[0] ?? 'check';
    if (sub === 'review') {
      const installKind = detectInstallKind(process.execPath);
      const subscriptions = requireSubscriptionManager(ctx);
      const builtinProviders = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
      const activeSubscriptions = subscriptions.list().map((entry) => entry.provider);
      const sandboxProfile = [
        `${ctx.platform.configManager.get('sandbox.replIsolation')}`,
        `${ctx.platform.configManager.get('sandbox.mcpIsolation')}`,
        `${ctx.platform.configManager.get('sandbox.vmBackend')}`,
      ].join('/');
      ctx.print(
        [
          'Update Review',
          `  version: ${VERSION}`,
          `  install kind: ${installKind}`,
          `  built-in subscription providers: ${builtinProviders.length}${builtinProviders.length > 0 ? ` (${builtinProviders.join(', ')})` : ''}`,
          `  active subscriptions: ${activeSubscriptions.length}${activeSubscriptions.length > 0 ? ` (${activeSubscriptions.join(', ')})` : ''}`,
          `  sandbox profile: ${sandboxProfile}`,
          '  use /update check to look for a newer release, /update apply to install it, /update rollback to return to the kept previous version',
        ].join('\n'),
      );
      return true;
    }
    if (sub === 'bundle') {
      const shellPaths = requireShellPaths(ctx);
      const mode = args[1];
      const pathArg = args[2];
      if ((mode === 'export' || mode === 'inspect') && !pathArg) {
        ctx.print(`Usage: /update bundle ${mode} <path>`);
        return true;
      }
      const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
      if (mode === 'export') {
        const subscriptions = requireSubscriptionManager(ctx);
        const builtinProviders = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
        const activeSubscriptions = subscriptions.list().map((entry) => entry.provider);
        const sandboxProfile = [
          `${ctx.platform.configManager.get('sandbox.replIsolation')}`,
          `${ctx.platform.configManager.get('sandbox.mcpIsolation')}`,
          `${ctx.platform.configManager.get('sandbox.vmBackend')}`,
        ].join('/');
        const bundle: UpdateBundle = {
          version: 1,
          exportedAt: Date.now(),
          appVersion: VERSION,
          installKind: detectInstallKind(process.execPath),
          subscriptionProviders: [...new Set([...builtinProviders, ...activeSubscriptions])],
          sandboxProfile,
          notes: [
            'installKind reflects how THIS running process was launched, detected from process.execPath.',
            'OAuth-backed provider subscriptions survive updates and continue to apply to supported provider surfaces.',
          ],
        };
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
        ctx.print(`Update bundle exported to ${targetPath}`);
        return true;
      }
      if (mode === 'inspect') {
        const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as UpdateBundle;
        ctx.print(inspectUpdateBundle(bundle));
        return true;
      }
    }
    return false;
  },
});
