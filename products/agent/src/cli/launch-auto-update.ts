import { retainSuiteUpdateConfiguration, type SuiteUpdateConfigurationSource } from '@goodvibes-jev/engine/terminal-shell/release-update-preflight';
import { installedSuiteNeedsRepair, suiteUpdateRequiresRecovery, type SuiteUpdateResult } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { runLaunchUpdatePreflight } from '@goodvibes-jev/engine/terminal-shell/launch-update-preflight';
import { restartOntoUpdatedBinary as restart, type RestartOntoUpdatedBinaryOptions } from '@goodvibes-jev/engine/terminal-shell/service-io';
export type { RestartOntoUpdatedBinaryOptions } from '@goodvibes-jev/engine/terminal-shell/service-io';
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
 *   - the check gets a short timeout; when it cannot complete (offline, slow
 *     network) the CURRENT version starts with exactly one line saying the
 *     check was skipped, launch is never held hostage by the network.
 *   - a successful update restarts into the new binary and the restarted
 *     process prints a receipt naming both versions, so the swap is never
 *     silent.
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
import { normalizeVersion, type UpdateFetchLike } from '../runtime/update-check.ts';
import { applyUpdate, checkForUpdate, type ApplyUpdateOptions } from '../input/commands/update-runtime.ts';
import { readUpdateSettings, type UpdateSettings } from '../config/update-settings.ts';
import { recordSelfUpdate } from '../runtime/self-update-receipt.ts';
import type { ConfigManager } from '../config/index.ts';
import { VERSION } from '../version.ts';

/**
 * Set on the restarted process by restartOntoUpdatedBinary, carrying the
 * version that performed the update. Its presence means "an update already
 * happened this launch": the restarted process prints the receipt and skips
 * its own check, which also makes an update-that-didn't-change-the-version
 * structurally unable to restart-loop.
 */
export const LAUNCH_UPDATED_FROM_ENV = 'GOODVIBES_AGENT_LAUNCH_UPDATED_FROM';

/** Default budget for the launch-time version check; user-tunable via update.launchCheckTimeoutMs. */
export const LAUNCH_UPDATE_CHECK_TIMEOUT_MS = 2500;

export type LaunchAutoUpdateOutcome =
  | {
      readonly action: 'continue';
      readonly reason: 'just-updated' | 'disabled' | 'not-swappable-install' | 'already-current' | 'check-skipped' | 'update-failed';
    }
  | { readonly action: 'restart'; readonly latestTag: string }
  | { readonly action: 'halt'; readonly reason: 'update-recovery-required' };
export class AgentUpdateRecoveryRequiredError extends Error {
  constructor() { super('Agent startup stopped: the suite update requires recovery before this installation can run'); this.name = 'AgentUpdateRecoveryRequiredError'; }
}

export interface RunLaunchAutoUpdateOptions {
  readonly fetchImpl: UpdateFetchLike;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly settings: UpdateSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly print: (line: string) => void;
  /** Injectable so tests observe the install step instead of swapping real files. */
  readonly configManager?: SuiteUpdateConfigurationSource | undefined;
  /** Explicit injected installers may retain their existing void completion contract. */
  readonly apply?: (options: ApplyUpdateOptions) => Promise<SuiteUpdateResult | void>;
  readonly timeoutMs?: number;
  readonly repairRequired?: ((version: string) => boolean) | undefined;
  /** Injectable so tests observe the durable receipt without writing beside a real executable. */
  readonly recordReceipt?: (entry: {
    readonly execPath: string;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly trigger: 'launch';
  }) => void;
}

/** Resolves to 'timeout' when `promise` does not settle within `ms`; the timer never keeps the process alive. */

/**
 * The launch-time decision: receipt-and-continue (restarted process), skip
 * (disabled / unswappable / current / unreachable), install-and-restart, or
 * fail-and-continue on the current version. Never throws.
 */
export async function runLaunchAutoUpdate(options: RunLaunchAutoUpdateOptions): Promise<LaunchAutoUpdateOutcome> {
  let configuration: ReturnType<typeof retainSuiteUpdateConfiguration>;
  try { configuration = retainSuiteUpdateConfiguration(options.configManager); }
  catch (error) {
    options.print(`auto-update failed: ${error instanceof Error ? error.message : String(error)}, starting the current version v${normalizeVersion(options.currentVersion)}`);
    return { action: 'continue', reason: 'update-failed' };
  }
  const preflight = await runLaunchUpdatePreflight(options, {
    updatedFromKey: LAUNCH_UPDATED_FROM_ENV,
    defaultCheckTimeoutMs: LAUNCH_UPDATE_CHECK_TIMEOUT_MS,
    check: checkForUpdate,
    repairRequired: version => options.repairRequired?.(version) ?? (options.apply === undefined && installedSuiteNeedsRepair({
      execPath: options.execPath, platform: options.platform, arch: options.arch, version, webuiDirectory: configuration.webuiDirectory,
    })),
    skipped: 'update check skipped: offline',
    unswappable: (kind) =>
      kind === 'source'
        ? 'auto-update skipped: running from source (dev checkout)'
        : 'auto-update skipped: package-managed install, update with: bun add -g @goodvibes-jev/agent',
  });
  if (!preflight.proceed) return preflight.outcome;
  const check = preflight.check;

  try {
    const apply = options.apply ?? applyUpdate;
    configuration.assertCurrent();
    const installed = await apply({
      fetchImpl: options.fetchImpl,
      execPath: options.execPath,
      platform: options.platform,
      arch: options.arch,
      currentVersion: options.currentVersion,
      configManager: options.configManager, assertCurrent: configuration.assertCurrent,
      print: options.print,
    });
    // The default suite installer reports the actual committed release. Its
    // no-op result cannot become a fabricated update receipt or restart.
    if (!installed && apply === applyUpdate) return { action: 'continue', reason: 'already-current' };
    const installedTag = installed ? `v${normalizeVersion(installed.version)}` : check.latestTag;
    // Durable before the restart, not after: this process is about to hand over
    // and the line printed below is wiped by the alternate screen a moment
    // later. The receipt is the only trace that survives to tell someone the
    // binary they are looking at is not the one they installed.
    (options.recordReceipt ?? recordSelfUpdate)({
      execPath: options.execPath,
      fromVersion: options.currentVersion,
      toVersion: installedTag,
      trigger: 'launch',
    });
    options.print(`auto-update: ${installedTag} installed, restarting onto the new version`);
    return { action: 'restart', latestTag: installedTag };
  } catch (error) {
    if (suiteUpdateRequiresRecovery(error)) {
      options.print(`auto-update requires recovery: ${error instanceof Error ? error.message : String(error)}; startup stopped`);
      return { action: 'halt', reason: 'update-recovery-required' };
    }
    options.print(
      `auto-update failed: ${error instanceof Error ? error.message : String(error)}, starting the current version v${normalizeVersion(options.currentVersion)}`,
    );
    return { action: 'continue', reason: 'update-failed' };
  }
}

export interface SelfUpdateAtLaunchParams {
  readonly configManager: Pick<ConfigManager, 'getRaw'> & Partial<Pick<ConfigManager, 'get'>>;
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
 * Runs the (just-swapped) binary at execPath with the original CLI arguments
 * and an inherited terminal, blocking until it exits, and returns its exit
 * code for the caller to process.exit with. The receipt marker travels in the
 * child's environment, never on the command line.
 */

export function restartOntoUpdatedBinary(options: RestartOntoUpdatedBinaryOptions): number {
  return restart(options, LAUNCH_UPDATED_FROM_ENV);
}
