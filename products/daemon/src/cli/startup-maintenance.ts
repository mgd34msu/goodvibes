/** Original startup maintenance, scoped to the admitted CLI owner. */
import { controlPlaneScheme, ensurePublicBaseUrl, pruneStaleOperatorTokens } from '@goodvibes-jev/engine/platform/platform/pairing';
import { WorktreeRegistry } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { workspaceOperatorTokenCandidates } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { hasReadableWebuiBundle } from '../config/webui-bundle.js';
import type { DaemonCliConfiguration } from './configuration.js';

export function pruneDaemonStartupTokens(configuration: DaemonCliConfiguration): number {
  return pruneStaleOperatorTokens({
    daemonHomeDir: configuration.daemonHomeDirectory,
    candidatePaths: workspaceOperatorTokenCandidates(configuration.workingDirectory, GOODVIBES_DAEMON_SURFACE_ROOT),
  }).failedPaths.length;
}

export function persistDaemonStartupPublicUrl(
  configuration: DaemonCliConfiguration,
  bound: { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' },
): void {
  const { config } = configuration;
  // Preserve the original empty-only rule. The shipped placeholder and every
  // explicit public URL remain untouched; webui enable owns its separate rule.
  if (String(config.get('web.publicBaseUrl') ?? '').trim() || !config.get('controlPlane.webui.serve')) return;
  // A one-invocation override (including an ephemeral port) cannot become a
  // durable URL. The settled binding must still match the declared endpoint.
  const originKeys = ['web.publicBaseUrl', 'controlPlane.webui.serve', 'controlPlane.webui.bundleDir',
    'web.staticAssetsDir', 'controlPlane.hostMode', 'controlPlane.host', 'controlPlane.port', 'controlPlane.tls.mode'] as const;
  if (originKeys.some((key) => ['runtime', 'runtime-default'].includes(config.describeConfigKeySource(key).effectiveOrigin ?? ''))) return;
  const declared = resolveRuntimeEndpointBinding(config, 'controlPlane');
  if (!declared.recognized || declared.host !== bound.host || declared.port !== bound.port
    || controlPlaneScheme(config) !== bound.scheme) return;
  if (!hasReadableWebuiBundle(config)) return;
  ensurePublicBaseUrl(config, undefined, bound);
}

/**
 * Apply the worktree retention policy to leftovers from earlier runs, then
 * return the one line to print when kept worktrees hold a lot of disk (null
 * otherwise). Never throws: a failure here must not stop the daemon starting.
 */
export async function sweepDaemonWorktrees(configuration: DaemonCliConfiguration): Promise<string | null> {
  try {
    return await new WorktreeRegistry(configuration.workingDirectory).startupSweep();
  } catch {
    return null;
  }
}
