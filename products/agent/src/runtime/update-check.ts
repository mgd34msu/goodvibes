import { IS_WORKSPACE_DISTRIBUTION, WORKSPACE_REBUILD_COMMAND } from './workspace-update-policy.ts';
/**
 * Pure logic for `/update` and the launch-time self-update: version
 * comparison, the latest-release-tag redirect lookup, and honest install-kind
 * detection.
 *
 * Version comparison and the release-tag lookup are re-exported from the
 * platform's canonical update policy module (platform/runtime/self-update), one
 * mechanism everywhere, the same module the TUI and the daemon's hourly loop
 * consume. Install-kind detection comes from the platform too
 * (platform/runtime/install-kind): the same three-way answer, compiled
 * binary, package-managed vendored binary, or a source run, everywhere. What
 * stays here is this product's own answer to "then what should I run
 * instead", which passes this package's name to the platform's rule.
 *
 * The self-update download/verify/swap orchestration that USES these lives in
 * src/input/commands/update-runtime.ts; this module only decides "is there a
 * newer version" and "can this install be swapped in place".
 */
export {
  compareVersions,
  normalizeVersion,
  parseReleaseTagFromLocation,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from '@goodvibes/engine/platform/platform/runtime/self-update';

export type { InstallKind } from '@goodvibes/engine/platform/platform/runtime/operations';
export { detectInstallKind } from '@goodvibes/engine/platform/platform/runtime/install-kind';

import { fallbackUpdateCommand as platformFallbackUpdateCommand } from '@goodvibes/engine/platform/platform/runtime/install-kind';
import type { InstallKind } from '@goodvibes/engine/platform/platform/runtime/operations';

/** The package name a package-managed install of the Agent is identified by. */
const AGENT_PACKAGE_NAME = '@goodvibes/agent';

/**
 * The exact command to tell the user to run instead of an in-place swap: the
 * workspace rebuild for a run from this repository, otherwise the platform's
 * answer (the suite installer for this product's private package name).
 */
export function fallbackUpdateCommand(kind: Exclude<InstallKind, 'binary'>): string {
  if (IS_WORKSPACE_DISTRIBUTION) return WORKSPACE_REBUILD_COMMAND;
  return platformFallbackUpdateCommand(kind, AGENT_PACKAGE_NAME);
}
