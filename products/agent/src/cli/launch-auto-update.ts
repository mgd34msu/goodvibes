import { retainSuiteUpdateConfiguration, type SuiteUpdateConfigurationSource } from '@goodvibes/engine/terminal-shell/release-update-preflight';
import { installedSuiteNeedsRepair, type SuiteUpdateResult } from '@goodvibes/engine/platform/platform/runtime/self-update';
import {
  runLaunchAutoUpdate as runSharedLaunchAutoUpdate,
  type LaunchAutoUpdateInput,
  type LaunchAutoUpdateOutcome,
} from '@goodvibes/engine/terminal-shell/launch-auto-update';
import { restartOntoUpdatedBinary as restart, type RestartOntoUpdatedBinaryOptions } from '@goodvibes/engine/terminal-shell/service-io';
export type { RestartOntoUpdatedBinaryOptions } from '@goodvibes/engine/terminal-shell/service-io';
import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_UPDATE_GUIDANCE } from '../runtime/workspace-update-policy.ts';
/**
 * Launch-time self-update, the agent lands on the newest release at startup
 * so an installed binary never drifts behind. At interactive launch (before
 * any runtime bootstrap or terminal mode change) this runs a quick version
 * check and, when a newer release exists, installs it through the SAME
 * checksum-verified download/verify/swap path `/update apply` uses
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
 *   - the launch waits `update.applyTimeoutMs` for the download, verification
 *     and swap, as in the terminal app (one sequence,
 *     terminal-shell/launch-auto-update.ts); past it the current version
 *     starts and the update keeps running in the background and reports itself.
 *   - every swap keeps the outgoing file at `<path>.previous`; rollback is
 *     one command (`/update rollback`).
 *
 * The feature is a real configurable setting (`update.autoUpdateAtLaunch` in
 * settings.json, read via readUpdateSettings): default ON, off with an
 * explicit false. That false is the off switch for this install replacing its
 * own binary at all, it also stops the while-running updater unless
 * `update.auto` is set explicitly (see runtime/periodic-update.ts), because a
 * switch that stopped only this path left the binary being swapped half a
 * minute later anyway. Only binary installs self-update, a package-managed
 * install or a from-source dev checkout skips with one honest line naming
 * why (a swap there would fight the package manager, or there is no compiled
 * file to swap; see detectInstallKind).
 *
 * Everything effectful is injectable; tests drive the decision logic with a
 * stubbed fetch, a stubbed apply, and pinned fixture versions, never the
 * live build VERSION and never the real network.
 */
import { fallbackUpdateCommand, normalizeVersion, type UpdateFetchLike } from '../runtime/update-check.ts';
import { applyUpdate, checkForUpdate, type ApplyUpdateOptions } from '../input/commands/update-runtime.ts';
import { readUpdateSettings, type UpdateSettings } from '../config/update-settings.ts';
import { recordSelfUpdate } from '../runtime/self-update-receipt.ts';
import type { ConfigManager } from '../config/index.ts';
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
export const LAUNCH_UPDATED_FROM_ENV = 'GOODVIBES_AGENT_LAUNCH_UPDATED_FROM';

export { LAUNCH_UPDATE_CHECK_TIMEOUT_MS, LAUNCH_APPLY_TIMEOUT_MS, type LaunchAutoUpdateOutcome } from '@goodvibes/engine/terminal-shell/launch-auto-update';

export class AgentUpdateRecoveryRequiredError extends Error {
  constructor() { super('Agent startup stopped: the suite update requires recovery before this installation can run'); this.name = 'AgentUpdateRecoveryRequiredError'; }
}

export interface RunLaunchAutoUpdateOptions extends LaunchAutoUpdateInput {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly settings: UpdateSettings;
  readonly configManager?: SuiteUpdateConfigurationSource | undefined;
  /** Injectable so tests observe the install step instead of swapping real files. */
  readonly apply?: (options: ApplyUpdateOptions) => Promise<SuiteUpdateResult | void>;
  readonly repairRequired?: ((version: string) => boolean) | undefined;
  /** Injectable so tests observe the durable receipt without writing beside a real executable. */
  readonly recordReceipt?: (entry: {
    readonly execPath: string;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly trigger: 'launch';
  }) => void;
}

/**
 * The Agent's launch update: the shared sequence
 * (terminal-shell/launch-auto-update.ts), with the same budget on the
 * download, verification and swap as the terminal app, and this program's
 * installer, release check, restart marker and durable receipt. Never throws.
 */
export async function runLaunchAutoUpdate(options: RunLaunchAutoUpdateOptions): Promise<LaunchAutoUpdateOutcome> {
  let configuration: ReturnType<typeof retainSuiteUpdateConfiguration>;
  try { configuration = retainSuiteUpdateConfiguration(options.configManager); }
  catch (error) {
    options.print(`auto-update failed: ${error instanceof Error ? error.message : String(error)}; starting the current version v${normalizeVersion(options.currentVersion)}`);
    return { action: 'continue', reason: 'update-failed' };
  }
  return runSharedLaunchAutoUpdate(options, {
    updatedFromKey: LAUNCH_UPDATED_FROM_ENV,
    check: checkForUpdate,
    repairRequired: version => options.repairRequired?.(version) ?? (options.apply === undefined && installedSuiteNeedsRepair({
      execPath: options.execPath, platform: options.platform, arch: options.arch, version, webuiDirectory: configuration.webuiDirectory,
    })),
    unswappable: (kind) =>
      kind === 'source'
        ? 'auto-update skipped: running from source (dev checkout)'
        : `auto-update skipped: package-managed install, update with: ${fallbackUpdateCommand(kind)}`,
    apply: ({ signal, progress }) => {
      configuration.assertCurrent();
      return (options.apply ?? applyUpdate)({
        fetchImpl: options.fetchImpl,
        execPath: options.execPath,
        platform: options.platform,
        arch: options.arch,
        currentVersion: options.currentVersion,
        configManager: options.configManager, assertCurrent: configuration.assertCurrent,
        print: options.print,
        signal,
        progress,
      });
    },
    applyReportsInstalled: options.apply === undefined,
    // Durable before the restart: the printed line is wiped by the alternate
    // screen a moment later, and this receipt is the only trace that the binary
    // running is not the one that was installed.
    installed: (installedTag) => (options.recordReceipt ?? recordSelfUpdate)({
      execPath: options.execPath,
      fromVersion: options.currentVersion,
      toVersion: installedTag,
      trigger: 'launch',
    }),
    command: 'goodvibes-agent',
  });
}

export interface SelfUpdateAtLaunchParams {
  readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'getControlPlaneConfigDir'>>;
  readonly stdout: { write(chunk: string): unknown };
}

/**
 * The complete launch wiring for main(), with real host inputs: run the
 * decision above; when an update was installed, restart onto the swapped
 * binary and EXIT THIS PROCESS with the new instance's exit code (this call
 * never returns in that case); otherwise return the honest lines that were
 * printed (receipt / skipped check / failed update) so the caller can
 * re-surface them through the system message router once it exists, the
 * stdout copies written here are wiped by the agent's alternate screen.
 */
export async function selfUpdateAtLaunch(params: SelfUpdateAtLaunchParams): Promise<readonly string[]> {
  if (IS_WORKSPACE_DISTRIBUTION) return [WORKSPACE_UPDATE_GUIDANCE];
  const lines: string[] = [];
  const outcome = await runLaunchAutoUpdate({
    fetchImpl: fetch as UpdateFetchLike,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    currentVersion: VERSION,
    settings: readUpdateSettings(params.configManager),
    configManager: params.configManager,
    env: process.env,
    lastCheckFile: launchCheckFile(params.configManager),
    print: (line) => {
      lines.push(line);
      params.stdout.write(`${line}\n`);
    },
  });
  if (outcome.action === 'halt') throw new AgentUpdateRecoveryRequiredError();
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
  return lines;
}

/**
 * Replaces this process with the (just-swapped) binary at execPath and the
 * given CLI arguments on the same terminal; where the platform cannot replace
 * a process (Windows), runs it on this console, waits for it and returns its
 * exit status for the caller to exit with. The receipt marker travels in the
 * environment, never on the command line.
 */
export function restartOntoUpdatedBinary(options: RestartOntoUpdatedBinaryOptions): number {
  return restart(options, LAUNCH_UPDATED_FROM_ENV);
}
