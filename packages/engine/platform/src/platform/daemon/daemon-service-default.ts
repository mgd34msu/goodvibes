import { homedir } from 'node:os';

/**
 * The login home a service manager registers the daemon's unit under
 * (`~/.config/systemd/user`, `~/Library/LaunchAgents`) and the service keeps
 * its pid file and log under. Never the GOODVIBES_HOME tree: a service manager
 * does not read a relocated tree, and every process that manages the one
 * service (the daemon, the terminal apps, autostart) must name the same
 * directory.
 */
export function resolveServiceUnitHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.HOME?.trim() || homedir();
}

/** The daemon's unit name on Linux and other non-Darwin hosts (`goodvibes.service` under systemd). */
export const DAEMON_SERVICE_NAME = 'goodvibes';
/** The LaunchAgent label on Darwin. */
export const DARWIN_DAEMON_SERVICE_LABEL = 'sh.goodvibes.daemon';

/**
 * The daemon's service unit name when the owner configured none: the one name
 * every installer and service command uses (the release installer through the
 * daemon, the daemon CLI, the terminal apps' `service` commands, autostart,
 * onboarding, the daemon's own promotion). Selecting a name grants no service
 * mutation authority.
 */
export function resolveDaemonServiceDefault(platform: string = process.platform): string {
  return platform === 'darwin' ? DARWIN_DAEMON_SERVICE_LABEL : DAEMON_SERVICE_NAME;
}
