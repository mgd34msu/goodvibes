import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { detectInstallKind, type InstallKind } from '@goodvibes/engine/platform/platform/runtime/operations';
import { compareVersions, normalizeVersion, type UpdateFetchLike } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { withTimeout } from './service-io.js';
export type LaunchUpdateSkipReason = 'just-updated' | 'disabled' | 'not-swappable-install' | 'already-current' | 'check-skipped';
export interface LaunchUpdateCheck {
  readonly isCurrent: boolean;
  readonly latestTag: string;
}

/** A release lookup younger than this answers the next launch without asking the release host again. `/update check` always asks. */
export const LAUNCH_UPDATE_CHECK_FRESH_MS = 6 * 60 * 60 * 1000;

interface RememberedLaunchCheck { readonly checkedAt: number; readonly latestTag: string }

function readRememberedCheck(file: string, now: number): RememberedLaunchCheck | undefined {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as Partial<RememberedLaunchCheck>;
    if (typeof record.checkedAt !== 'number' || typeof record.latestTag !== 'string' || !record.latestTag) return undefined;
    // A record from the future (clock moved back) is not trusted as fresh.
    return record.checkedAt <= now && now - record.checkedAt < LAUNCH_UPDATE_CHECK_FRESH_MS ? { checkedAt: record.checkedAt, latestTag: record.latestTag } : undefined;
  } catch {
    return undefined; // missing or unreadable: ask the release host
  }
}

function rememberCheck(file: string, record: RememberedLaunchCheck): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`);
    renameSync(temp, file);
  } catch {
    // Not remembering only costs the next launch one lookup.
  }
}

/** A fetch whose requests also end when `signal` aborts, so a lookup launch stopped waiting for is cancelled, not left running. */
function cancellableFetch(fetchImpl: UpdateFetchLike, signal: AbortSignal): UpdateFetchLike {
  return (url, init) => fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
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
    /** Where the last successful lookup is remembered; without it every launch asks the release host. */
    readonly lastCheckFile?: string | undefined;
    readonly now?: (() => number) | undefined;
  },
  policy: {
    readonly updatedFromKey: string;
    readonly defaultCheckTimeoutMs: number;
    readonly check: (fetch: UpdateFetchLike, currentVersion: string) => Promise<LaunchUpdateCheck>;
    readonly unswappable: (kind: Exclude<InstallKind, 'binary'>) => string | undefined;
    readonly repairRequired?: ((tag: string) => boolean) | undefined;
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
  const now = options.now?.() ?? Date.now();
  const remembered = options.lastCheckFile === undefined ? undefined : readRememberedCheck(options.lastCheckFile, now);
  let check: LaunchUpdateCheck;
  if (remembered) {
    check = { latestTag: remembered.latestTag, isCurrent: compareVersions(options.currentVersion, remembered.latestTag) >= 0 };
  } else {
    const budgetMs = options.timeoutMs ?? options.settings.launchCheckTimeoutMs ?? policy.defaultCheckTimeoutMs;
    const lookup = new AbortController();
    let answer: LaunchUpdateCheck | 'timeout';
    try {
      answer = await withTimeout(policy.check(cancellableFetch(options.fetchImpl, lookup.signal), options.currentVersion), budgetMs);
    } catch (error) {
      options.print(`update check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { proceed: false, outcome: { action: 'continue', reason: 'check-skipped' } };
    }
    if (answer === 'timeout') {
      lookup.abort(new Error('launch update check timed out'));
      options.print(`update check skipped: the release host did not answer within ${Math.max(1, Math.round(budgetMs / 1000))}s`);
      return { proceed: false, outcome: { action: 'continue', reason: 'check-skipped' } };
    }
    check = answer;
    if (options.lastCheckFile !== undefined) rememberCheck(options.lastCheckFile, { checkedAt: now, latestTag: check.latestTag });
  }
  if (check.isCurrent && !(compareVersions(options.currentVersion, check.latestTag) === 0 && policy.repairRequired?.(check.latestTag) === true)) return { proceed: false, outcome: { action: 'continue', reason: 'already-current' } };
  return { proceed: true, check };
}
