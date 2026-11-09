/** Agent command composition over the platform's complete suite updater. */
import { installedSuiteNeedsRepair, applySuiteUpdate, rollbackSuiteUpdate, captureUpdateFileIo, realUpdateFileIo,
  type SuiteUpdateResult, type UpdateFileIo } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { checkReleaseUpdate, prepareReleaseUpdate, requireBinaryUpdateInstall, createSelfUpdateCommand,
  retainSuiteUpdateConfiguration, formatSuiteUpdateReport,
  type ReleaseUpdateCheck, type SuiteUpdateConfigurationSource,
} from '@goodvibes-jev/engine/terminal-shell/release-update-preflight';
import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_UPDATE_GUIDANCE } from '../../runtime/workspace-update-policy.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import { resolveAgentBinaryAssetName } from '../../runtime/release-artifacts.ts';
import { fallbackUpdateCommand, type UpdateFetchLike } from '../../runtime/update-check.ts';

const REPO_RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes/releases/latest';
const releaseDownloadBaseUrl = (tag: string) => `https://github.com/mgd34msu/goodvibes/releases/download/${tag}`;
export { PREVIOUS_FILE_SUFFIX } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
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
  readonly configManager?: SuiteUpdateConfigurationSource | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Original runtime/idle ownership, rechecked by the shared updater before effects. */
  readonly assertCurrent?: (() => void) | undefined;
}
function assertOwner(check: (() => void) | undefined): void {
  const result: unknown = check?.();
  if (result !== undefined) { drainOwned(result); throw new Error('Agent update ownership must complete synchronously'); }
}
/** All installed products/native companions/directories are prepared before
 * replacement. The platform owns compensation and version-bound rollback. */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<SuiteUpdateResult | undefined> {
  options = { ...options, io: captureUpdateFileIo(options.io ?? realUpdateFileIo) };
  const selected = retainSuiteUpdateConfiguration(options.configManager);
  const current = () => { options.signal?.throwIfAborted(); selected.assertCurrent(); assertOwner(options.assertCurrent); selected.assertCurrent(); options.signal?.throwIfAborted(); };
  current();
  const prepared = await prepareReleaseUpdate(options, {
    latestUrl: REPO_RELEASES_LATEST_URL, downloadBase: releaseDownloadBaseUrl,
    asset: resolveAgentBinaryAssetName, fallback: fallbackUpdateCommand,
    unsupportedSuffix: '', assertActive: current,
    repairRequired: version => { current(); return installedSuiteNeedsRepair({ ...options, version, webuiDirectory: selected.webuiDirectory }); },
  });
  if (!prepared) return;
  current();
  const result = await applySuiteUpdate({
    fetchImpl: options.fetchImpl, downloadBaseUrl: prepared.baseUrl,
    execPath: options.execPath, platform: options.platform, arch: options.arch,
    version: prepared.latestTag, io: options.io ?? realUpdateFileIo,
    webuiDirectory: selected.webuiDirectory, assertCurrent: current,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  options.print(formatSuiteUpdateReport(result, 'updated'));
  return result;
}
export interface RollbackUpdateOptions {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion?: string;
  readonly print: (line: string) => void;
  readonly io?: UpdateFileIo;
  readonly configManager?: SuiteUpdateConfigurationSource | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export function rollbackUpdate(options: RollbackUpdateOptions): void {
  if (!requireBinaryUpdateInstall(options.execPath, options.print, fallbackUpdateCommand, true)) return;
  const selected = retainSuiteUpdateConfiguration(options.configManager);
  const current = () => { selected.assertCurrent(); assertOwner(options.assertCurrent); selected.assertCurrent(); };
  current();
  const result = rollbackSuiteUpdate({ ...options, currentVersion: options.currentVersion ?? VERSION,
    webuiDirectory: selected.webuiDirectory, assertCurrent: current });
  options.print(formatSuiteUpdateReport(result, 'restored'));
}
export function registerUpdateCommand(registry: CommandRegistry): void { registry.register(selfUpdateCommand); }
const selfUpdateCommand = createSelfUpdateCommand<CommandContext>({
  description: 'Check for a newer GoodVibes release and update or restore the installed suite',
  usage: '[check|apply|rollback]', help: 'Usage: /update [check|apply|rollback]', version: VERSION,
  workspaceDistribution: IS_WORKSPACE_DISTRIBUTION, workspaceGuidance: WORKSPACE_UPDATE_GUIDANCE,
  repairRequired: (version, ctx) => installedSuiteNeedsRepair({ execPath: process.execPath, platform: process.platform, arch: process.arch, version,
    webuiDirectory: retainSuiteUpdateConfiguration(ctx.platform.configManager).webuiDirectory }),
  check: checkForUpdate, onRecovery: (_error, ctx) => ctx.exit(),
  apply: async (options, ctx) => { await applyUpdate({ ...options, configManager: ctx.platform.configManager }); },
  rollback: (options, ctx) => rollbackUpdate({ ...options, configManager: ctx.platform.configManager }),
});
