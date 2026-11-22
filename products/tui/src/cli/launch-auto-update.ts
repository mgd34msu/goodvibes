import {
  runLaunchAutoUpdate as runSharedLaunchAutoUpdate,
  type LaunchAutoUpdateInput,
  type LaunchAutoUpdateOutcome,
} from '@goodvibes/engine/terminal-shell/launch-auto-update';
import {
  restartOntoUpdatedBinary as restart,
  type RestartOntoUpdatedBinaryOptions,
} from '@goodvibes/engine/terminal-shell/service-io';
export type { RestartOntoUpdatedBinaryOptions } from '@goodvibes/engine/terminal-shell/service-io';
import { IS_WORKSPACE_DISTRIBUTION } from '../runtime/workspace-update-policy.ts';
/**
 * Launch-time self-update, clients land on the newest release at startup so
 * an installed binary never drifts behind. At TUI launch (before any runtime
 * bootstrap or terminal mode change) this runs a quick version check and, when
 * a newer release exists, installs it through the SAME checksum-verified
 * download/verify/swap path `/update apply` and the suite installer use
 * (src/input/commands/update-runtime.ts, there is deliberately no second
 * updater), then asks the caller to restart onto the new binary.
 *
 * Honesty rules, in both directions:
 *   - a lookup that succeeded in the last six hours answers the next launch
 *     with no network request (`/update check` always asks); otherwise the
 *     check gets a short timeout, an abandoned lookup is cancelled, and when
 *     it cannot complete the CURRENT version starts with exactly one line
 *     saying the check was skipped and why (no answer in time, or the release
 *     host's own failure), launch is never held hostage by the network.
 *   - a successful update restarts into the new binary and the restarted
 *     process prints a receipt naming both versions, so the swap is never
 *     silent.
 *   - the launch waits `update.applyTimeoutMs` for the install, then starts
 *     the current version. The install is not cancelled by that wait: a slow
 *     download is not a failed one. It keeps running in the background, says
 *     it is still downloading or finishing, and its eventual success or
 *     failure is printed when it settles.
 *   - every swap keeps the outgoing file at `<path>.previous`; rollback is
 *     one command (`/update rollback`).
 *
 * The feature is a real configurable setting (`update.autoUpdateAtLaunch` in
 * settings.json, read via readUpdateSettings): default ON, off with an
 * explicit false. Only binary installs self-update, package-manager and
 * from-source runs are skipped silently because a swap there would fight the
 * package manager (see detectInstallKind).
 *
 * Everything effectful is injectable; tests drive the decision logic with a
 * stubbed fetch, a stubbed apply, and pinned fixture versions, never the
 * live build VERSION and never the real network.
 */
import { detectInstallKind, type UpdateFetchLike } from '../runtime/update-check.ts';
import { applyUpdate, checkForUpdate, type ApplyUpdateOptions } from '../input/commands/update-runtime.ts';
import { configuredSuiteWebuiDirectory, installedSuiteNeedsRepair, type SuiteUpdateResult } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { readUpdateSettings, type UpdateSettings } from '../config/tui-extension-settings.ts';
import { runDaemonHandover, type DaemonHandoverOutcome } from '@goodvibes/engine/platform/platform/runtime/client';
import { resolveGoodVibesDaemonExecutable } from './service-posture.ts';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { VERSION } from '../version.ts';
import { join } from 'node:path';

/** The launch's remembered release lookup, beside this product's settings. */
function launchCheckFile(configManager: Partial<Pick<ConfigManager, 'getControlPlaneConfigDir'>>): string | undefined {
  const directory = configManager.getControlPlaneConfigDir?.();
  return directory ? join(directory, 'launch-update-check.json') : undefined;
}

/**
 * Set on the restarted process by restartOntoUpdatedBinary, carrying the
 * version that performed the update. Its presence means "an update already
 * happened this launch": the restarted process prints the receipt and skips
 * its own check, which also makes an update-that-didn't-change-the-version
 * structurally unable to restart-loop.
 */
export const LAUNCH_UPDATED_FROM_ENV = 'GOODVIBES_LAUNCH_UPDATED_FROM';

export { LAUNCH_UPDATE_CHECK_TIMEOUT_MS, LAUNCH_APPLY_TIMEOUT_MS, type LaunchAutoUpdateOutcome } from '@goodvibes/engine/terminal-shell/launch-auto-update';

export interface RunLaunchAutoUpdateOptions extends LaunchAutoUpdateInput {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly settings: UpdateSettings;
  readonly configManager: { get(key: string): unknown };
  /** Injectable so tests observe the install step instead of swapping real files. */
  readonly apply?: (options: ApplyUpdateOptions) => Promise<SuiteUpdateResult | void>;
  readonly repairRequired?: ((version: string) => boolean) | undefined;
}

/**
 * The terminal app's launch update: the shared sequence
 * (terminal-shell/launch-auto-update.ts) with this program's installer,
 * release check and restart marker. Never throws.
 */
export function runLaunchAutoUpdate(options: RunLaunchAutoUpdateOptions): Promise<LaunchAutoUpdateOutcome> {
  return runSharedLaunchAutoUpdate(options, {
    updatedFromKey: LAUNCH_UPDATED_FROM_ENV,
    check: checkForUpdate,
    unswappable: () => undefined,
    repairRequired: version => options.repairRequired?.(version) ?? (options.apply === undefined && installedSuiteNeedsRepair({ execPath: options.execPath, platform: options.platform, arch: options.arch, version,
      webuiDirectory: configuredSuiteWebuiDirectory(options.configManager) })),
    apply: ({ signal, progress }) => (options.apply ?? applyUpdate)({
      fetchImpl: options.fetchImpl,
      execPath: options.execPath,
      platform: options.platform,
      arch: options.arch,
      currentVersion: options.currentVersion,
      print: options.print,
      configManager: options.configManager,
      signal,
      progress,
    }),
    applyReportsInstalled: options.apply === undefined,
    command: 'goodvibes',
  });
}

export interface SelfUpdateAtLaunchParams {
  readonly configManager: Pick<ConfigManager, 'get' | 'getRaw'> & Partial<Pick<ConfigManager, 'getControlPlaneConfigDir'>>;
  readonly stdout: { write(chunk: string): unknown };
}

/**
 * The complete launch wiring for main(), with real host inputs: run the
 * decision above; when an update was installed, restart onto the swapped
 * binary and EXIT THIS PROCESS with the new instance's exit code (this call
 * never returns in that case); otherwise return the honest lines that were
 * printed (receipt / skipped check / failed update) so the caller can
 * re-surface them through the system message router once it exists, the
 * stdout copies written here are wiped by the TUI's alternate screen.
 */
export async function selfUpdateAtLaunch(params: SelfUpdateAtLaunchParams): Promise<readonly string[]> {
  // A copy run from its source folder does not update itself; /update says how to update it. Launch says nothing.
  if (IS_WORKSPACE_DISTRIBUTION) return [];
  const lines: string[] = [];
  const print = (line: string): void => {
    lines.push(line);
    params.stdout.write(`${line}\n`);
  };
  const settings = readUpdateSettings(params.configManager);
  const outcome = await runLaunchAutoUpdate({
    fetchImpl: fetch as UpdateFetchLike,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    currentVersion: VERSION,
    settings,
    env: process.env,
    configManager: params.configManager,
    print,
    lastCheckFile: launchCheckFile(params.configManager),
  });
  if (outcome.action === 'halt') throw outcome.error;
  if (outcome.action === 'restart') {
    process.exit(
      restartOntoUpdatedBinary({
        execPath: process.execPath,
        argv: process.argv.slice(2),
        env: process.env,
        fromVersion: VERSION,
      }),
    );
  }
  // Runs AFTER the restart branch, so on a launch that updated this binary the
  // handover happens in the restarted process rather than in one that is about
  // to be replaced.
  await handDaemonOverAtLaunch({ configManager: params.configManager, settings, print });
  return lines;
}

export interface HandDaemonOverAtLaunchParams {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly settings: UpdateSettings;
  readonly print: (line: string) => void;
}

/**
 * The launch wiring for the old→new daemon handover (src/runtime/daemon-handover.ts).
 *
 * A daemon binary from before the split cannot update itself onto its own
 * release line, the releases URL baked into it names this repository, which no
 * longer builds daemons, and pointing it at the daemon's repository instead
 * still fails because its shipped updater insists on downloading the terminal
 * binary beside it, which that repository does not publish. So the terminal
 * hands it over directly, once, and the path goes quiet afterwards.
 *
 * Gated on the SAME `update.autoUpdateAtLaunch` setting as this binary's own
 * launch update: that setting is the operator's "do not swap binaries while I
 * am starting up" answer, and it means the same thing for the daemon installed
 * beside this one. No second switch is introduced for one migration.
 *
 * Only a binary install acts. A source or package-managed terminal has no
 * business replacing a daemon binary on the host it happens to be running on.
 */
export async function handDaemonOverAtLaunch(params: HandDaemonOverAtLaunchParams): Promise<DaemonHandoverOutcome> {
  if (!(params.settings.autoUpdateAtLaunch ?? true)) {
    return { action: 'skipped', reason: 'disabled' };
  }
  if (detectInstallKind(process.execPath) !== 'binary') {
    return { action: 'skipped', reason: 'not-swappable-install' };
  }
  const resolved = resolveGoodVibesDaemonExecutable();
  return await runDaemonHandover({
    fetchImpl: fetch as UpdateFetchLike,
    binaryPath: resolved.absolute ? resolved.command : null,
    platform: process.platform,
    arch: process.arch,
    configManager: params.configManager,
    print: params.print,
  });
}

/**
 * Replaces this process with the (just-swapped) binary at execPath and the
 * original CLI arguments on the same terminal; where the platform cannot
 * replace a process (Windows), runs it on this console, waits for it and
 * returns its exit status for the caller to process.exit with. The receipt
 * marker travels in the environment, never on the command line.
 */

export function restartOntoUpdatedBinary(options: RestartOntoUpdatedBinaryOptions): number {
  return restart(options, LAUNCH_UPDATED_FROM_ENV);
}
