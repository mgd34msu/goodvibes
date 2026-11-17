import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** The unit name the release installer (scripts/install.ts) registers on Linux and other non-Darwin hosts. */
export const DAEMON_SERVICE_NAME = 'goodvibes-jev';
/** The LaunchAgent label on Darwin. */
export const DARWIN_DAEMON_SERVICE_LABEL = 'sh.goodvibes.daemon';

/**
 * The daemon's service unit name when the owner configured none: the one
 * definition every installer and service command uses (the daemon CLI, the
 * terminal apps' `service` commands, onboarding, the daemon's own promotion).
 * A unit an earlier build registered under its old name (`goodvibes`) keeps
 * that name while no unit holds the current one, so it is managed rather than
 * duplicated. Selecting a name grants no service mutation authority.
 */
export function resolveDaemonServiceDefault(homeDirectory: string, platform: string = process.platform): string {
  const occupied = (path: string): boolean => {
    // lstat sees every occupied slot, including a dangling alias.
    try { return lstatSync(path, { throwIfNoEntry: false }) !== undefined; } catch { return false; }
  };
  const ownedFile = (path: string): boolean => {
    try {
      const entry = lstatSync(path, { throwIfNoEntry: false });
      return entry !== undefined && entry.isFile() && !entry.isSymbolicLink();
    } catch { return false; }
  };
  if (platform === 'darwin') {
    const directory = join(homeDirectory, 'Library', 'LaunchAgents');
    if (occupied(join(directory, DARWIN_DAEMON_SERVICE_LABEL + '.plist'))) return DARWIN_DAEMON_SERVICE_LABEL;
    return ownedFile(join(directory, 'goodvibes.plist')) ? 'goodvibes' : DARWIN_DAEMON_SERVICE_LABEL;
  }
  if (platform === 'linux') {
    const directory = join(homeDirectory, '.config', 'systemd', 'user');
    if (occupied(join(directory, DAEMON_SERVICE_NAME + '.service'))) return DAEMON_SERVICE_NAME;
    if (ownedFile(join(directory, 'goodvibes.service'))) return 'goodvibes';
  }
  return DAEMON_SERVICE_NAME;
}
