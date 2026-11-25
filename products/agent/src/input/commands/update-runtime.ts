/** Agent command composition over the platform's complete suite updater. */
import { installedSuiteNeedsRepair, applySuiteUpdate, rollbackSuiteUpdate, captureUpdateFileIo, realUpdateFileIo,
  type SuiteUpdateResult, type UpdateFileIo } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { DAEMON_REPO_RELEASES_LATEST_URL, daemonReleaseDownloadBaseUrl } from '@goodvibes/engine/platform/platform/runtime/client';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { checkReleaseUpdate, prepareReleaseUpdate, requireBinaryUpdateInstall, createSelfUpdateCommand,
  retainSuiteUpdateConfiguration, formatSuiteUpdateReport, daemonRestartFooter,
  type DaemonServiceNameSource, type ReleaseUpdateCheck, type RunCommand, type SuiteUpdateConfigurationSource,
} from '@goodvibes/engine/terminal-shell/release-update-preflight';
import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_UPDATE_GUIDANCE } from '../../runtime/workspace-update-policy.ts';
import { recordSwapFailure, type UpdateSwapProgress } from '@goodvibes/engine/terminal-shell/launch-auto-update';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requireProfileManager, requireSecretsManager, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { VERSION } from '../../version.ts';
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
    options.print(formatSuiteUpdateReport(result, 'updated', await daemonRestartFooter(result, options.platform, options.configManager ?? {}, options.runCommand)));
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
  readonly currentVersion?: string;
  readonly print: (line: string) => void;
  readonly io?: UpdateFileIo;
  /** The suite's update settings, and the daemon service name the restart line names. */
  readonly configManager?: (SuiteUpdateConfigurationSource & DaemonServiceNameSource) | undefined;
  /** Asks the service manager whether the daemon runs as a service; injectable so tests never run systemctl. */
  readonly runCommand?: RunCommand | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export async function rollbackUpdate(options: RollbackUpdateOptions): Promise<void> {
  if (!requireBinaryUpdateInstall(options.execPath, options.print, fallbackUpdateCommand, true)) return;
  const selected = retainSuiteUpdateConfiguration(options.configManager);
  const current = () => { selected.assertCurrent(); assertOwner(options.assertCurrent); selected.assertCurrent(); };
  current();
  const result = rollbackSuiteUpdate({ ...options, currentVersion: options.currentVersion ?? VERSION,
    webuiDirectory: selected.webuiDirectory, assertCurrent: current });
  options.print(formatSuiteUpdateReport(result, 'restored', await daemonRestartFooter(result, options.platform, options.configManager ?? {}, options.runCommand)));
}
export function registerUpdateCommand(registry: CommandRegistry): void { registry.register(selfUpdateCommand); }
const selfUpdateCommand = createSelfUpdateCommand<CommandContext>({
  version: VERSION,
  workspaceDistribution: IS_WORKSPACE_DISTRIBUTION, workspaceGuidance: WORKSPACE_UPDATE_GUIDANCE,
  repairRequired: (version, ctx) => installedSuiteNeedsRepair({ execPath: process.execPath, platform: process.platform, arch: process.arch, version,
    webuiDirectory: retainSuiteUpdateConfiguration(ctx.platform.configManager).webuiDirectory }),
  check: checkForUpdate, onRecovery: (_error, ctx) => ctx.exit(),
  apply: async (options, ctx) => { await applyUpdate({ ...options, configManager: ctx.platform.configManager }); },
  rollback: (options, ctx) => rollbackUpdate({ ...options, configManager: ctx.platform.configManager }),
  daemon: (ctx) => createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  capability: capabilityBinding,
  install: {
    channel: REPO_RELEASES_LATEST_URL,
    resolvePath: (ctx, path) => requireShellPaths(ctx).resolveWorkspacePath(path),
    settings: (ctx) => ctx.platform.configManager,
    subscriptionProviders: (ctx) => requireSubscriptionManager(ctx).list().map((entry) => entry.provider),
    savedProfiles: (ctx) => requireProfileManager(ctx).list().length,
    storedSecrets: async (ctx) => (await requireSecretsManager(ctx).list()).length,
  },
});
