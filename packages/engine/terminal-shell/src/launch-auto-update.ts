/**
 * Launch-time self-update, one sequence for the terminal app and the Agent.
 *
 * Each product supplies what is its own (which binary it swaps, its release
 * check, its restart marker, what an unswappable install says, a receipt it
 * keeps); the decision and its budgets are this one function: the release
 * check (launch-update-preflight.ts), then the download, verification and swap
 * bounded by `update.applyTimeoutMs`. Running out of the budget is reported
 * for what happened: before the swap began the work is cancelled through a
 * real AbortSignal and deferred to the next launch; once the swap has begun it
 * is never interrupted, and its own outcome is printed when it settles. The two
 * are told apart by the swap progress the install reports, never by guessing.
 */
import {
  SuiteUpdateRecoveryError,
  UpdateTransactionError,
  normalizeVersion,
  suiteUpdateRequiresRecovery,
  type SuiteUpdateResult,
  type UpdateFetchLike,
} from '@goodvibes/engine/platform/platform/runtime/self-update';
import type { InstallKind } from '@goodvibes/engine/platform/platform/runtime/operations';
import { runLaunchUpdatePreflight, type LaunchUpdateCheck } from './launch-update-preflight.js';
import { withTimeout } from './service-io.js';

/** Default budget for the launch-time version check; `update.launchCheckTimeoutMs`. */
export const LAUNCH_UPDATE_CHECK_TIMEOUT_MS = 2500;
/** Default budget for the launch-time download, verification and swap; `update.applyTimeoutMs`. */
export const LAUNCH_APPLY_TIMEOUT_MS = 45_000;

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

/** Record on `progress` what a failed suite update had already done to the disk; rethrow the failure after. */
export function recordSwapFailure(progress: UpdateSwapProgress | undefined, error: unknown): void {
  if (!progress) return;
  if (error instanceof UpdateTransactionError) {
    progress.begun = error.receipt.committed || error.receipt.recoveryRequired;
    progress.committed = error.receipt.committed;
  } else if (error instanceof SuiteUpdateRecoveryError) {
    progress.begun = true;
    progress.committed = error.committed;
  }
}

export type LaunchAutoUpdateOutcome =
  | {
      readonly action: 'continue';
      readonly reason:
        | 'just-updated'
        | 'disabled'
        | 'not-swappable-install'
        | 'already-current'
        | 'check-skipped'
        | 'update-failed'
        /** The budget ran out before anything was written, and the work was cancelled. */
        | 'update-deferred'
        /** The budget ran out after the swap had begun; it is left to finish and report its own outcome. */
        | 'update-in-background';
    }
  | { readonly action: 'restart'; readonly latestTag: string }
  | { readonly action: 'halt'; readonly error: unknown };

/** What one launch installs with: the product's own installer, given the budget's signal and the progress it reports. */
export interface LaunchApplyRequest {
  readonly signal: AbortSignal;
  readonly progress: UpdateSwapProgress;
}

export interface LaunchAutoUpdateInput {
  readonly fetchImpl: UpdateFetchLike;
  readonly execPath: string;
  readonly currentVersion: string;
  readonly settings: {
    readonly autoUpdateAtLaunch?: boolean | undefined;
    readonly launchCheckTimeoutMs?: number | undefined;
    readonly applyTimeoutMs?: number | undefined;
  };
  readonly env: NodeJS.ProcessEnv;
  readonly print: (line: string) => void;
  readonly timeoutMs?: number | undefined;
  /** Overrides the download+verify+swap budget; defaults to settings.applyTimeoutMs, then LAUNCH_APPLY_TIMEOUT_MS. */
  readonly applyTimeoutMs?: number | undefined;
  /** Where the last successful release lookup is remembered, so a launch within a few hours of it does not ask again. */
  readonly lastCheckFile?: string | undefined;
}

/** What is the product's own: its restart marker, release check, installer and the lines only it says. */
export interface LaunchAutoUpdateProduct {
  /** The environment key the restarted process finds (restartOntoUpdatedBinary sets it). */
  readonly updatedFromKey: string;
  readonly check: (fetch: UpdateFetchLike, currentVersion: string) => Promise<LaunchUpdateCheck>;
  /** The one line an install that cannot be swapped says, or nothing. */
  readonly unswappable: (kind: Exclude<InstallKind, 'binary'>) => string | undefined;
  readonly repairRequired?: ((version: string) => boolean) | undefined;
  /** Install the release; resolves the suite actually installed, or nothing when there was nothing newer after all. */
  readonly apply: (request: LaunchApplyRequest) => Promise<SuiteUpdateResult | void>;
  /** True when `apply` is the product's own suite installer, whose empty result means "nothing to install". */
  readonly applyReportsInstalled: boolean;
  /** Runs once an install is in place, before the restart (a durable receipt). */
  readonly installed?: ((installedTag: string) => void) | undefined;
  /** The product's command name, for the recovery line ("restart `goodvibes`…"). */
  readonly command: string;
}

/**
 * The launch-time decision: receipt-and-continue (restarted process), skip
 * (disabled / unswappable / current / unreachable), install-and-restart,
 * defer, or fail-and-continue on the current version. Never throws.
 */
export async function runLaunchAutoUpdate(input: LaunchAutoUpdateInput, product: LaunchAutoUpdateProduct): Promise<LaunchAutoUpdateOutcome> {
  const preflight = await runLaunchUpdatePreflight(input, {
    updatedFromKey: product.updatedFromKey,
    defaultCheckTimeoutMs: LAUNCH_UPDATE_CHECK_TIMEOUT_MS,
    check: product.check,
    unswappable: product.unswappable,
    ...(product.repairRequired ? { repairRequired: product.repairRequired } : {}),
  });
  if (!preflight.proceed) return preflight.outcome;
  const check = preflight.check;

  const applyTimeoutMs = input.applyTimeoutMs ?? input.settings.applyTimeoutMs ?? LAUNCH_APPLY_TIMEOUT_MS;
  input.print(`downloading ${check.latestTag}…`);
  const controller = new AbortController();
  const progress = createUpdateSwapProgress();
  try {
    const applyPromise = product.apply({ signal: controller.signal, progress });
    // Losing the race abandons this promise. A cancelled download rejects
    // shortly after and that is the expected end of the work, so it stays
    // quiet. A swap that was already running is different: its late outcome is
    // reported, because the launch has already told the user to expect it.
    let reportLateOutcome = false;
    applyPromise.then(
      (late) => {
        if (reportLateOutcome && late) input.print(`background update finished: v${late.version} is installed; restart to use it`);
      },
      (error) => {
        if (!reportLateOutcome) return;
        const detail = error instanceof Error ? error.message : String(error);
        input.print(
          suiteUpdateRequiresRecovery(error)
            ? `background update requires recovery: ${detail}; restart \`${product.command}\` to run the recovery before using this install`
            : `background update failed: ${detail}; the installed version may be unchanged, check with \`${product.command} status\``,
        );
      },
    );
    const applyResult = await withTimeout(applyPromise, applyTimeoutMs);
    if (applyResult === 'timeout') {
      if (!progress.begun) {
        // Nothing has been written yet, so the work can genuinely be called off.
        controller.abort();
        input.print('update deferred: will retry next launch');
        return { action: 'continue', reason: 'update-deferred' };
      }
      // The swap had already started when the budget ran out. A swap is never
      // interrupted; say it is still running and let its own outcome be reported.
      reportLateOutcome = true;
      input.print(`update still finishing in background; restart to use v${normalizeVersion(progress.targetTag ?? check.latestTag)} once it completes`);
      return { action: 'continue', reason: 'update-in-background' };
    }
    // The release may move between preflight and apply: report only what the suite transaction installed.
    if (applyResult === undefined && product.applyReportsInstalled) return { action: 'continue', reason: 'already-current' };
    const installedTag = applyResult ? `v${normalizeVersion(applyResult.version)}` : check.latestTag;
    product.installed?.(installedTag);
    input.print(`auto-update: ${installedTag} installed; restarting onto the new version`);
    return { action: 'restart', latestTag: installedTag };
  } catch (error) {
    if (suiteUpdateRequiresRecovery(error)) {
      input.print(`auto-update requires recovery: ${error instanceof Error ? error.message : String(error)}; startup stopped before loading installed companions`);
      return { action: 'halt', error };
    }
    input.print(
      `auto-update failed: ${error instanceof Error ? error.message : String(error)}; starting the current version v${normalizeVersion(input.currentVersion)}`,
    );
    return { action: 'continue', reason: 'update-failed' };
  }
}
