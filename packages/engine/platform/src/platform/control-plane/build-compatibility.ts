/**
 * Build compatibility between a daemon and its clients: the one version
 * comparator, the floor a daemon announces to its clients, and the verdicts
 * both directions read.
 *
 * This module imports nothing, so the web UI bundle uses it as it is and the
 * terminal apps, the agent and the daemon read the same rule.
 *
 * Every package ships under one version. A daemon therefore accepts a client
 * of its own release line (same major and minor) and newer: a client from the
 * previous release keeps the old rules, so after an update it stops taking
 * shared-session work and asks to be restarted. The floor is derived from the
 * daemon's own version, never kept by hand.
 */

/** Response header carrying the daemon's minimum acceptable client build. */
export const CLIENT_COMPATIBILITY_FLOOR_HEADER = 'X-Goodvibes-Client-Floor';

function splitVersion(raw: string): { release: number[]; prerelease: string } {
  const trimmed = String(raw ?? '').trim().replace(/^v/i, '');
  const buildStripped = trimmed.split('+')[0] ?? '';
  const dashIndex = buildStripped.indexOf('-');
  const core = dashIndex === -1 ? buildStripped : buildStripped.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? '' : buildStripped.slice(dashIndex + 1);
  const release = core
    .split('.')
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    });
  return { release, prerelease };
}

/**
 * Semver precedence for two different prerelease tags: dot-separated parts are
 * compared one by one, numeric parts by value (so `rc.10` is above `rc.9`),
 * numeric parts below text parts, and a tag that is a prefix of the other below it.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta > 0 ? 1 : -1;
      continue;
    }
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Compare two dotted versions: 1 when `a` is newer, -1 when `b` is, 0 when
 * equal. Missing components read as 0, so `1.2` and `1.2.0` are the same
 * version. A prerelease (`1.2.0-rc.1`) is ordered below the same release, as
 * in semver, so a release candidate never preempts its release.
 */
export function compareBuildVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const length = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left.release[index] ?? 0) - (right.release[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  // Equal release cores: a build WITHOUT a prerelease tag outranks one with.
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === '') return 1;
  if (right.prerelease === '') return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Whether `version` is on or after the release line `floor` names. A floor is
 * a release line, so a release candidate of that line carries its behavior and
 * meets it: only the release numbers are compared.
 */
function meetsFloor(version: string, floor: string): boolean {
  return compareBuildVersions(splitVersion(version).release.join('.'), floor) >= 0;
}

/** The oldest client build a daemon of `daemonVersion` accepts: its own major and minor. */
export function clientCompatibilityFloorFor(daemonVersion: string): string {
  const [major = 0, minor = 0] = splitVersion(daemonVersion).release;
  return `${major}.${minor}.0`;
}

export type ClientCompatibilityStatus = 'ok' | 'restart-required' | 'unknown';

export interface ClientCompatibilityVerdict {
  readonly status: ClientCompatibilityStatus;
  /** One plain line naming the real situation, for a log or a notice. */
  readonly message: string;
  readonly clientVersion: string | undefined;
  readonly floor: string | undefined;
}

/** How a surface words its own restart; the terminal apps restart a process, the web UI reloads a page. */
export interface ClientRestartWording {
  /** Names this client in the below-floor sentence, e.g. "This process". */
  readonly subject: string;
  /** The action that picks up the current build, e.g. "restart it to rejoin". */
  readonly restart: string;
  /** The action for a build that reports no version, e.g. "Restart it from the current install". */
  readonly reinstall: string;
}

const PROCESS_WORDING: ClientRestartWording = {
  subject: 'This process',
  restart: 'restart it to rejoin',
  reinstall: 'Restart it from the current install',
};

/**
 * Judge a client build against a floor.
 *
 * An unparseable or absent client version is 'unknown', NOT 'ok': the point of
 * the floor is that a build which cannot prove it carries a required behavior
 * is treated as one that does not. An absent FLOOR is a different thing, a
 * daemon too old to publish one, and yields 'ok', because that daemon is not
 * asking for anything.
 */
export function evaluateClientCompatibility(input: {
  readonly clientVersion: string | undefined;
  readonly floor: string | undefined;
  readonly wording?: ClientRestartWording | undefined;
}): ClientCompatibilityVerdict {
  const floor = input.floor?.trim();
  const clientVersion = input.clientVersion?.trim();
  const wording = input.wording ?? PROCESS_WORDING;
  if (!floor) {
    return {
      status: 'ok',
      message: 'The daemon publishes no client build floor; nothing to check.',
      clientVersion,
      floor: undefined,
    };
  }
  if (!clientVersion || !/\d/.test(clientVersion)) {
    return {
      status: 'unknown',
      message: `This build does not report a version, so it cannot be checked against the daemon's floor of ${floor}. ${wording.reinstall} to be sure it is current.`,
      clientVersion,
      floor,
    };
  }
  if (!meetsFloor(clientVersion, floor)) {
    return {
      status: 'restart-required',
      message: `${wording.subject} is running build ${clientVersion}; the daemon requires ${floor} or newer. It has stopped taking shared-session work, ${wording.restart}.`,
      clientVersion,
      floor,
    };
  }
  return {
    status: 'ok',
    message: `Build ${clientVersion} meets the daemon's floor of ${floor}.`,
    clientVersion,
    floor,
  };
}

/** Read the floor a daemon announced, from any `/status` response headers. */
export function readClientCompatibilityFloor(
  headers: { get(name: string): string | null } | undefined,
): string | undefined {
  const value = headers?.get(CLIENT_COMPATIBILITY_FLOOR_HEADER)
    ?? headers?.get(CLIENT_COMPATIBILITY_FLOOR_HEADER.toLowerCase());
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Whether `version` meets `floor`, by the same release-line rule as the client check. */
export function versionMeetsFloor(version: string, floor: string): boolean {
  return meetsFloor(version, floor);
}
