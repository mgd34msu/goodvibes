/** Original startup maintenance, scoped to the admitted CLI owner. */
import { explicitPublicBaseUrl, isLoopbackHost, publicBaseUrlIsOwnOrigin, pruneStaleOperatorTokens } from '@goodvibes/engine/platform/platform/pairing';
import { formatWorktreeStartupReport, WorktreeRegistry } from '@goodvibes/engine/platform/platform/runtime/shell';
import { workspaceOperatorTokenCandidates } from '@goodvibes/engine/platform/platform/runtime/operations';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { DaemonCliConfiguration } from './configuration.js';

export function pruneDaemonStartupTokens(configuration: DaemonCliConfiguration): number {
  return pruneStaleOperatorTokens({
    daemonHomeDir: configuration.daemonHomeDirectory,
    candidatePaths: workspaceOperatorTokenCandidates(configuration.workingDirectory, GOODVIBES_DAEMON_SURFACE_ROOT),
  }).failedPaths.length;
}

/**
 * `web.publicBaseUrl` holds only what a person set; empty means every link is
 * derived live from the settings. Releases up to 3.3.4 (and their installers)
 * stored the daemon's own derived origin or a placeholder there, which froze
 * every link at that address. At start, a saved value that is the old
 * placeholder, names a loopback host (never a public address for another
 * device), or is this daemon's own origin (once that answer is settled) is
 * cleared. Returns the value cleared, or null when nothing changed.
 */
export function clearDerivedPublicBaseUrl(
  configuration: DaemonCliConfiguration,
  bound: { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' },
): string | null {
  const { config } = configuration;
  const stored = String(config.get('web.publicBaseUrl') ?? '').trim();
  if (!stored) return null;
  // A value set for this one run (a flag or an environment override) is not the saved setting.
  const origin = config.describeConfigKeySource('web.publicBaseUrl').effectiveOrigin ?? '';
  if (origin === 'runtime' || origin === 'runtime-default') return null;
  const placeholder = explicitPublicBaseUrl(config) === '';
  let loopback = false;
  try { loopback = isLoopbackHost(new URL(stored).hostname); } catch { loopback = false; }
  const own = publicBaseUrlIsOwnOrigin(config, bound);
  if (!placeholder && !loopback && !(own.own && own.settled)) return null;
  config.setDynamic('web.publicBaseUrl', '');
  return stored;
}

/**
 * Apply the worktree retention policy to leftovers from earlier runs, then
 * return what to print: each worktree removed, each kept for the owner's
 * decision with the next steps, each removal that did not complete, and the
 * disk-use line (null when there is nothing to say). Never throws: a failure
 * here must not stop the daemon starting.
 */
export async function sweepDaemonWorktrees(configuration: DaemonCliConfiguration): Promise<string | null> {
  try {
    const report = await new WorktreeRegistry(configuration.workingDirectory).startupSweep();
    return report ? formatWorktreeStartupReport(report, configuration.workingDirectory) : null;
  } catch {
    return null;
  }
}
