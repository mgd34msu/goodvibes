/**
 * daemon-version-compat.ts
 *
 * The adopt path (bootstrap-services.ts) verifies that a daemon found on the
 * configured port is a GoodVibes daemon via its `/status` identity probe, which
 * reports the daemon's platform `version`. Identity is not the same as serving
 * every method this program calls: the operator contract grows within a major
 * version (methods and fields are added, not removed), so an OLDER daemon of the
 * same major can lack a method a newer program calls. This module answers "may
 * this program adopt a daemon reporting version X?" once, at start, so the adopt
 * path refuses with a next step instead of attaching and failing per call.
 *
 * Rule:
 *   - Both versions must parse as SemVer (a leading `v` is allowed); anything
 *     else, or a missing version, is incompatible.
 *   - The majors must match (a major release may remove or reshape methods).
 *   - Within a major the daemon must be at least as new as this program on
 *     `major.minor`: an equal or newer daemon serves every method this program
 *     knows; an older one may not. Patch, prerelease and build do not matter.
 */
import { parseSemanticVersion, type ParsedSemanticVersion } from './semantic-version.js';

function parseWireVersion(version: string | undefined | null): ParsedSemanticVersion | null {
  if (typeof version !== 'string') return null;
  return parseSemanticVersion(version.trim().replace(/^v/i, ''));
}

/** Why a daemon of `remoteVersion` cannot be adopted by a program of `localVersion`, or null when it can. */
export type DaemonVersionSkew = 'unreadable' | 'daemon-older' | 'daemon-newer-major' | 'daemon-older-major';

/** The skew between this program and a daemon, or null when the daemon serves everything this program calls. */
export function daemonVersionSkew(
  localVersion: string | undefined | null,
  remoteVersion: string | undefined | null,
): DaemonVersionSkew | null {
  const local = parseWireVersion(localVersion);
  const remote = parseWireVersion(remoteVersion);
  if (local === null || remote === null) return 'unreadable';
  if (remote.major > local.major) return 'daemon-newer-major';
  if (remote.major < local.major) return 'daemon-older-major';
  return remote.minor < local.minor ? 'daemon-older' : null;
}

/**
 * True when a program reporting `localVersion` may adopt a daemon reporting
 * `remoteVersion`: same major, and the daemon at least as new on major.minor.
 */
export function isDaemonVersionCompatible(
  localVersion: string | undefined | null,
  remoteVersion: string | undefined | null,
): boolean {
  return daemonVersionSkew(localVersion, remoteVersion) === null;
}

/**
 * The refusal for an incompatible adoption: both versions, why, and what to do
 * next, so the operator (or an agent reading the status) can act without guessing.
 */
export function describeVersionIncompatibility(
  host: string,
  port: number,
  localVersion: string | undefined | null,
  remoteVersion: string | undefined | null,
): string {
  const found = (typeof remoteVersion === 'string' && remoteVersion.trim()) ? remoteVersion.trim() : 'unknown';
  const mine = (typeof localVersion === 'string' && localVersion.trim()) ? localVersion.trim() : 'unknown';
  const lead = `A GoodVibes daemon (version ${found}) is running on ${host}:${port}, but this program is version ${mine}; it is not adopted, and no second daemon is started on the occupied port.`;
  switch (daemonVersionSkew(localVersion, remoteVersion)) {
    case 'daemon-older':
    case 'daemon-older-major':
      return `${lead} The daemon is older and may not serve methods this program calls. Restart it so the installed version runs (goodvibes-daemon restart-service), or update it.`;
    case 'daemon-newer-major':
      return `${lead} The daemon belongs to a newer major release. Update this program to the daemon's version.`;
    default:
      return `${lead} The daemon's version could not be read. Restart it with goodvibes-daemon restart-service, or update it to this program's version.`;
  }
}
