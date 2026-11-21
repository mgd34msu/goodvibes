import { DAEMON_REPO_RELEASES_LATEST_URL, daemonReleaseDownloadBaseUrl } from '@goodvibes/engine/platform/platform/runtime/client';
import { applySuiteUpdate, installedSuiteNeedsRepair, rollbackSuiteUpdate, type SuiteUpdateResult } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { createSelfUpdateCommand, daemonRestartFooter, retainSuiteUpdateConfiguration, formatSuiteUpdateReport, type RunCommand } from '@goodvibes/engine/terminal-shell/release-update-preflight';
import {
  checkReleaseUpdate,
  prepareReleaseUpdate,
  requireBinaryUpdateInstall,
  type ReleaseUpdateCheck,
} from '@goodvibes/engine/terminal-shell/release-update-preflight';
import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_UPDATE_GUIDANCE } from '../../runtime/workspace-update-policy.ts';
import { recordSwapFailure, type UpdateSwapProgress } from '@goodvibes/engine/terminal-shell/launch-auto-update';
/** `/update` uses the platform's shared suite transaction. Every installed
 * sibling product and its native/browser companions comes from the same
 * release; an explicitly configured installer-owned WebUI keeps its served
 * path. Apply/rollback preserve earlier programs and check saved-data readers
 * before changing live files. Running programs use the replacement on restart.
 * `/update review` prints this install's update state (installed and latest
 * version, install kind, rollback copy) and `/update save-review` saves it to a
 * file; both are built in terminal-shell/release-update-preflight.ts from the
 * facts this app supplies.
 */
import {
  captureUpdateFileIo,
  realUpdateFileIo,
  type UpdateFileIo,
} from '@goodvibes/engine/platform/platform/runtime/self-update';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import { resolveArtifactNames } from '../../runtime/release-artifacts.ts';
import { fallbackUpdateCommand, type UpdateFetchLike } from '../../runtime/update-check.ts';
import type { CliServiceNameSource } from '../../cli/service-posture.ts';
import { requireProfileManager, requireSecretsManager, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

const REPO_RELEASES_LATEST_URL = DAEMON_REPO_RELEASES_LATEST_URL;

function releaseDownloadBaseUrl(tag: string): string {
  return daemonReleaseDownloadBaseUrl(tag);
}

/** External progress for launch-time budgets: one record, shared with the Agent (terminal-shell/launch-auto-update.ts). */
export { createUpdateSwapProgress, type UpdateSwapProgress } from '@goodvibes/engine/terminal-shell/launch-auto-update';

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
export { PREVIOUS_FILE_SUFFIX } from '@goodvibes/engine/platform/platform/runtime/self-update';

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
    options.print(formatSuiteUpdateReport(result, 'updated', await daemonRestartFooter(result, options.platform, options.configManager, options.runCommand)));
    return result;
  } catch (error) {
    recordSwapFailure(progress, error);
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
export async function rollbackUpdate(options: RollbackUpdateOptions): Promise<void> {
  if (!requireBinaryUpdateInstall(options.execPath, options.print, fallbackUpdateCommand, true)) return;

  const configuration = retainSuiteUpdateConfiguration(options.configManager);
  const result = rollbackSuiteUpdate({ ...options, currentVersion: VERSION,
    webuiDirectory: configuration.webuiDirectory, assertCurrent: configuration.assertCurrent });
  options.print(formatSuiteUpdateReport(result, 'restored', await daemonRestartFooter(result, options.platform, options.configManager, options.runCommand)));
}

export function registerUpdateCommand(registry: CommandRegistry): void {
  registry.register(selfUpdateCommand);
}

const selfUpdateCommand = createSelfUpdateCommand<CommandContext>({
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
  install: {
    channel: REPO_RELEASES_LATEST_URL,
    resolvePath: (ctx, path) => requireShellPaths(ctx).resolveWorkspacePath(path),
    settings: (ctx) => ctx.platform.configManager,
    subscriptionProviders: (ctx) => requireSubscriptionManager(ctx).list().map((entry) => entry.provider),
    savedProfiles: (ctx) => requireProfileManager(ctx).list().length,
    storedSecrets: async (ctx) => (await requireSecretsManager(ctx).list()).length,
  },
});
