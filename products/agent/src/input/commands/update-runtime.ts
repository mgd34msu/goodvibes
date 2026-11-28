/** Agent command composition over the platform's complete suite updater. */
import { installedSuiteNeedsRepair, applySuiteUpdate, captureUpdateFileIo, realUpdateFileIo,
  type SuiteUpdateResult, type UpdateFileIo } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { DAEMON_REPO_RELEASES_LATEST_URL, daemonReleaseDownloadBaseUrl } from '@goodvibes/engine/platform/platform/runtime/client';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { checkReleaseUpdate, prepareReleaseUpdate, createSelfUpdateCommand,
  retainSuiteUpdateConfiguration, formatSuiteUpdateReport, restartDaemonAfterSuiteUpdate,
  type DaemonServiceNameSource, type ReleaseUpdateCheck, type RunCommand, type SuiteDaemonRestarter, type SuiteUpdateConfigurationSource,
} from '@goodvibes/engine/terminal-shell/release-update-preflight';
import { recordSwapFailure, type UpdateSwapProgress } from '@goodvibes/engine/terminal-shell/launch-auto-update';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requireShellPaths } from './runtime-services.ts';
import { resolveAgentBinaryAssetName } from '../../runtime/release-artifacts.ts';
import { fallbackUpdateCommand, type UpdateFetchLike } from '../../runtime/update-check.ts';
import { capabilityBinding } from './capability-binding.ts';

const REPO_RELEASES_LATEST_URL = DAEMON_REPO_RELEASES_LATEST_URL;
const releaseDownloadBaseUrl = (tag: string) => daemonReleaseDownloadBaseUrl(tag);
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
  readonly io?: UpdateFileIo;
  /** The suite's update settings, and the daemon service name the restart line names. */
  readonly configManager?: (SuiteUpdateConfigurationSource & DaemonServiceNameSource) | undefined;
  /** Asks the service manager whether the daemon runs as a service; injectable so tests never run systemctl. */
  readonly runCommand?: RunCommand | undefined;
  /** Injectable daemon service restarter for tests; defaults to restarting the running service on real disk swaps. */
  readonly restartDaemon?: SuiteDaemonRestarter | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Original runtime/idle ownership, rechecked by the shared updater before effects. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Lets a launch budget tell a cancelled update from one whose swap had begun (terminal-shell/launch-auto-update.ts). */
  readonly progress?: UpdateSwapProgress | undefined;
}
function assertOwner(check: (() => void) | undefined): void {
  assertSynchronousJudgmentGuard(check, () => new Error('Agent update ownership must complete synchronously'));
}
/** All installed products/native companions/directories are prepared before
 * replacement. The platform owns compensation and version-bound rollback. */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<SuiteUpdateResult | undefined> {
  const realDiskSwap = options.io === undefined;
  options = { ...options, io: captureUpdateFileIo(options.io ?? realUpdateFileIo) };
  const selected = retainSuiteUpdateConfiguration(options.configManager);
  const progress = options.progress;
  const current = () => { options.signal?.throwIfAborted(); selected.assertCurrent(); assertOwner(options.assertCurrent); selected.assertCurrent(); options.signal?.throwIfAborted(); };
  current();
  const prepared = await prepareReleaseUpdate(options, {
    latestUrl: REPO_RELEASES_LATEST_URL, downloadBase: releaseDownloadBaseUrl,
    asset: resolveAgentBinaryAssetName, fallback: fallbackUpdateCommand,
    unsupportedSuffix: '', assertActive: current,
    target: (tag) => { if (progress) progress.targetTag = tag; },
    repairRequired: version => { current(); return installedSuiteNeedsRepair({ ...options, version, webuiDirectory: selected.webuiDirectory }); },
  });
  if (!prepared) return;
  current();
  try {
    const result = await applySuiteUpdate({
      fetchImpl: options.fetchImpl, downloadBaseUrl: prepared.baseUrl,
      execPath: options.execPath, platform: options.platform, arch: options.arch,
      version: prepared.latestTag, io: options.io ?? realUpdateFileIo,
      webuiDirectory: selected.webuiDirectory, assertCurrent: current,
      ...(options.signal ? { signal: options.signal } : {}),
      // Just before the live swap: an abort after this point is reported late instead of racing the swap.
      beforeCommit: () => { if (progress) progress.begun = true; },
    });
    if (progress) { progress.begun = true; progress.committed = true; }
    options.print(formatSuiteUpdateReport(result, 'updated', await restartDaemonAfterSuiteUpdate(result, {
      platform: options.platform,
      configManager: options.configManager ?? {},
      runCommand: options.runCommand,
      restartDaemon: options.restartDaemon,
      attemptRestart: realDiskSwap && options.runCommand === undefined,
    })));
    return result;
  } catch (error) {
    recordSwapFailure(progress, error);
    throw error;
  }
}
export function registerUpdateCommand(registry: CommandRegistry): void { registry.register(selfUpdateCommand); }
// `/update`: the daemon's capabilities (capabilities/builtin/system-updates.ts); typed by a person it opens System on Updates.
const selfUpdateCommand = createSelfUpdateCommand<CommandContext>({
  daemon: (ctx) => createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  capability: capabilityBinding,
});
