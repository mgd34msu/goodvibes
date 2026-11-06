import { detectInstallKind, type InstallKind } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { normalizeVersion, type UpdateFetchLike } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { withTimeout } from './service-io.js';
export type LaunchUpdateSkipReason = 'just-updated' | 'disabled' | 'not-swappable-install' | 'already-current' | 'check-skipped';
export interface LaunchUpdateCheck {
  readonly isCurrent: boolean;
  readonly latestTag: string;
}
/** One launch receipt/eligibility/check lifecycle; each product retains its actual swap protocol. */
export async function runLaunchUpdatePreflight(
  options: {
    readonly fetchImpl: UpdateFetchLike;
    readonly execPath: string;
    readonly currentVersion: string;
    readonly settings: { readonly autoUpdateAtLaunch?: boolean | undefined; readonly launchCheckTimeoutMs?: number | undefined };
    readonly env: NodeJS.ProcessEnv;
    readonly print: (line: string) => void;
    readonly timeoutMs?: number | undefined;
  },
  policy: {
    readonly updatedFromKey: string;
    readonly defaultCheckTimeoutMs: number;
    readonly check: (fetch: UpdateFetchLike, currentVersion: string) => Promise<LaunchUpdateCheck>;
    readonly skipped: string;
    readonly unswappable: (kind: Exclude<InstallKind, 'binary'>) => string | undefined;
  },
): Promise<
  | { readonly proceed: false; readonly outcome: { readonly action: 'continue'; readonly reason: LaunchUpdateSkipReason } }
  | { readonly proceed: true; readonly check: LaunchUpdateCheck }
> {
  const updatedFrom = options.env[policy.updatedFromKey];
  if (typeof updatedFrom === 'string' && updatedFrom.length) {
    delete options.env[policy.updatedFromKey];
    options.print(`auto-update: updated from v${normalizeVersion(updatedFrom)} to v${normalizeVersion(options.currentVersion)} at launch`);
    return { proceed: false, outcome: { action: 'continue', reason: 'just-updated' } };
  }
  if (!(options.settings.autoUpdateAtLaunch ?? true)) return { proceed: false, outcome: { action: 'continue', reason: 'disabled' } };
  const kind = detectInstallKind(options.execPath);
  if (kind !== 'binary') {
    const message = policy.unswappable(kind);
    if (message !== undefined) options.print(message);
    return { proceed: false, outcome: { action: 'continue', reason: 'not-swappable-install' } };
  }
  let check: LaunchUpdateCheck | 'timeout';
  try {
    check = await withTimeout(
      policy.check(options.fetchImpl, options.currentVersion),
      options.timeoutMs ?? options.settings.launchCheckTimeoutMs ?? policy.defaultCheckTimeoutMs,
    );
  } catch {
    check = 'timeout';
  }
  if (check === 'timeout') {
    options.print(policy.skipped);
    return { proceed: false, outcome: { action: 'continue', reason: 'check-skipped' } };
  }
  if (check.isCurrent) return { proceed: false, outcome: { action: 'continue', reason: 'already-current' } };
  return { proceed: true, check };
}
