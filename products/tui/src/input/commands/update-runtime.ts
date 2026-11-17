import { DAEMON_REPO_RELEASES_LATEST_URL, daemonReleaseDownloadBaseUrl } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { applySuiteUpdate, installedSuiteNeedsRepair, rollbackSuiteUpdate, SuiteUpdateRecoveryError, type SuiteUpdateResult } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
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
 * `/update review` prints this install's update state (installed and latest
 * version, install kind, rollback copy) and `bundle export` saves it to a file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  captureUpdateFileIo,
  PREVIOUS_FILE_SUFFIX,
  UpdateTransactionError,
  realUpdateFileIo,
  type UpdateFileIo,
} from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveArtifactNames } from '../../runtime/release-artifacts.ts';
import { detectInstallKind, fallbackUpdateCommand, type InstallKind, type UpdateFetchLike } from '../../runtime/update-check.ts';
import { resolveCliServiceName, type CliServiceNameSource } from '../../cli/service-posture.ts';
import { requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

const REPO_RELEASES_LATEST_URL = DAEMON_REPO_RELEASES_LATEST_URL;

function releaseDownloadBaseUrl(tag: string): string {
  return daemonReleaseDownloadBaseUrl(tag);
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
 * from the platform's canonical update policy module so rollback and swap share
 * one definition everywhere.
 */
export { PREVIOUS_FILE_SUFFIX } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';

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
  configManager: CliServiceNameSource,
  runCommand: RunCommand = defaultRunCommand,
): DaemonServiceRestartInfo {
  const unitName = resolveCliServiceName(configManager);
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
  readonly configManager: CliServiceNameSource;
  readonly runCommand?: RunCommand;
  /** Injectable filesystem seam (the platform's UpdateFileIo) so tests observe swaps in memory. */
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
    configManager: {
      get: options.configManager.get.bind(options.configManager),
      ...(options.configManager.describeConfigKeySource
        ? { describeConfigKeySource: options.configManager.describeConfigKeySource.bind(options.configManager) }
        : {}),
    },
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
      // Runs just before the live swap, so an abort after this point is reported late instead of racing the swap.
      beforeCommit: () => { if (progress) progress.begun = true; },
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
  readonly configManager: CliServiceNameSource;
  readonly runCommand?: RunCommand;
  /** Injectable filesystem seam (the platform's UpdateFileIo) so tests observe renames in memory. */
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

/** What `/update review` prints and `/update bundle export` saves, built once for both. */
interface UpdateReview {
  readonly version: 2;
  readonly exportedAt: number;
  readonly appVersion: string;
  readonly installKind: InstallKind;
  /** The newest published release, or why it could not be read. */
  readonly latest: { readonly tag: string; readonly isCurrent: boolean } | { readonly unknown: string };
  /** Where updates come from: the project's published releases. */
  readonly channel: string;
  /** True when a previous program is kept beside this one, so /update rollback has something to restore. */
  readonly rollbackRetained: boolean;
  readonly subscriptionProviders: readonly string[];
  readonly sandboxProfile: string;
}

function buildUpdateReview(ctx: CommandContext, latest: UpdateReview['latest']): UpdateReview {
  const subscriptions = requireSubscriptionManager(ctx);
  const builtinProviders = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
  const config = ctx.platform.configManager;
  return {
    version: 2,
    exportedAt: Date.now(),
    appVersion: VERSION,
    installKind: detectInstallKind(process.execPath),
    latest,
    channel: REPO_RELEASES_LATEST_URL,
    rollbackRetained: existsSync(`${process.execPath}${PREVIOUS_FILE_SUFFIX}`),
    subscriptionProviders: [...new Set([...builtinProviders, ...subscriptions.list().map((entry) => entry.provider)])],
    sandboxProfile: `commands ${config.get('sandbox.enabled') === false ? 'host' : 'contained'}/mcp ${String(config.get('sandbox.mcpIsolation'))}`,
  };
}

/** The newest published release, read once; a failed read is named, not guessed. */
async function readLatestRelease(): Promise<UpdateReview['latest']> {
  try {
    const result = await checkForUpdate(fetch as UpdateFetchLike, VERSION);
    return { tag: result.latestTag, isCurrent: result.isCurrent };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

function formatUpdateReview(review: UpdateReview, title: string): string {
  const latest = 'tag' in review.latest
    ? `${review.latest.tag}${review.latest.isCurrent ? ' (this is current)' : ' (newer than this one: /update apply installs it)'}`
    : `unknown (${review.latest.unknown})`;
  return [
    title,
    `  installed version: ${review.appVersion}`,
    `  latest release: ${latest}`,
    `  channel: ${review.channel}`,
    `  install kind: ${review.installKind}`,
    `  rollback copy: ${review.rollbackRetained ? 'kept beside this program; /update rollback restores it' : 'none kept (an /update apply keeps one)'}`,
    `  subscription providers: ${review.subscriptionProviders.length}${review.subscriptionProviders.length > 0 ? ` (${review.subscriptionProviders.join(', ')})` : ''}; sign-ins survive an update`,
    `  sandbox profile: ${review.sandboxProfile}`,
  ].join('\n');
}

/** Parse a saved update review, refusing anything that is not one rather than printing "undefined" fields. */
function parseUpdateReview(text: string): UpdateReview {
  const value: unknown = JSON.parse(text);
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  const latest = record?.latest as Record<string, unknown> | undefined;
  if (
    !record
    || record.version !== 2
    || typeof record.appVersion !== 'string'
    || typeof record.installKind !== 'string'
    || typeof record.channel !== 'string'
    || typeof record.rollbackRetained !== 'boolean'
    || typeof record.sandboxProfile !== 'string'
    || !Array.isArray(record.subscriptionProviders)
    || !latest || (typeof latest.tag !== 'string' && typeof latest.unknown !== 'string')
  ) {
    throw new Error('the file is not an update review saved by /update bundle export');
  }
  return record as unknown as UpdateReview;
}

/** `/update bundle export|inspect <path>`: save this install's update review to a file, or read one back. */
export async function handleUpdateBundleSubcommand(args: readonly string[], ctx: CommandContext): Promise<true> {
  const shellPaths = requireShellPaths(ctx);
  const mode = args[1];
  const pathArg = args.slice(2).find((arg) => arg !== '--yes');
  if (mode !== 'export' && mode !== 'inspect') {
    ctx.print('Usage: /update bundle export <path> [--yes] | /update bundle inspect <path>');
    return true;
  }
  if (!pathArg) {
    ctx.print(`Usage: /update bundle ${mode} <path>${mode === 'export' ? ' [--yes]' : ''}`);
    return true;
  }
  const targetPath = shellPaths.resolveWorkspacePath(pathArg);
  if (mode === 'export') {
    // The review holds no secret; --yes guards only against replacing a file that is already there.
    if (existsSync(targetPath) && !args.includes('--yes')) {
      ctx.print(`Not saved: ${targetPath} already exists. Nothing was changed; run /update bundle export ${pathArg} --yes to replace it.`);
      return true;
    }
    const review = buildUpdateReview(ctx, await readLatestRelease());
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify(review, null, 2) + '\n', 'utf-8');
    ctx.print(`Update review saved to ${targetPath}. It records this install's update state for support or before an upgrade; it is not an update and nothing applies it.`);
    return true;
  }
  try {
    ctx.print(formatUpdateReview(parseUpdateReview(readFileSync(targetPath, 'utf-8')), `Update Review (saved ${targetPath})`));
  } catch (error) {
    ctx.print(`Cannot inspect ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

export function registerUpdateCommand(registry: CommandRegistry): void {
  registry.register(selfUpdateCommand);
}

const selfUpdateCommand = createSelfUpdateCommand<CommandContext>({
  description:
    'Check for a newer GoodVibes release and, for binary installs, download/verify/apply it or roll back to the kept previous version',
  usage: '[check|apply|rollback|review|daemon [check]|bundle export <path> [--yes]|bundle inspect <path>]',
  help: 'Usage: /update [check|apply|rollback|review|daemon [check]|bundle export <path> [--yes]|bundle inspect <path>]',
  version: VERSION,
  workspaceDistribution: IS_WORKSPACE_DISTRIBUTION,
  workspaceGuidance: WORKSPACE_UPDATE_GUIDANCE,
  check: checkForUpdate,
  repairRequired: (version, ctx) => installedSuiteNeedsRepair({ execPath: process.execPath, platform: process.platform, arch: process.arch, version,
    webuiDirectory: retainSuiteUpdateConfiguration(ctx.platform.configManager).webuiDirectory }),
  onRecovery: (_error, ctx) => ctx.exit(),
  apply: async (options, ctx) => { await applyUpdate({ ...options, configManager: ctx.platform.configManager }); },
  rollback: (options, ctx) => rollbackUpdate({ ...options, configManager: ctx.platform.configManager }),
  daemon: (ctx) => createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  extra: async (args, ctx) => {
    const sub = args[0] ?? 'check';
    if (sub === 'review') {
      ctx.print([
        formatUpdateReview(buildUpdateReview(ctx, await readLatestRelease()), 'Update Review'),
        '  use /update check to look for a newer release, /update apply to install it, /update rollback to return to the kept previous version',
      ].join('\n'));
      return true;
    }
    if (sub === 'bundle') return handleUpdateBundleSubcommand(args, ctx);
    return false;
  },
});
