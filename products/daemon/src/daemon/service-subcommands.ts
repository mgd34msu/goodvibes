/**
 * The names of the service-lifecycle subcommands, with no service code behind
 * them, so the command dispatcher can classify a command without loading the
 * service manager.
 */

export const DAEMON_SERVICE_SUBCOMMANDS = [
  'install-service',
  'refresh-service',
  'uninstall-service',
  'service-status',
  'start-service',
  'stop-service',
  'restart-service',
] as const;

export type DaemonServiceSubcommand = (typeof DAEMON_SERVICE_SUBCOMMANDS)[number];

export function isDaemonServiceSubcommand(value: string | undefined): value is DaemonServiceSubcommand {
  return typeof value === 'string' && (DAEMON_SERVICE_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * The subcommands that write or start the service's launch: each needs the
 * composed runtime and an admitted executable, and is refused for a moved home
 * on a platform that cannot carry it.
 */
export const DAEMON_SERVICE_ACTIVATING_SUBCOMMANDS = [
  'install-service',
  'refresh-service',
  'start-service',
  'restart-service',
] as const satisfies readonly DaemonServiceSubcommand[];

export function isActivatingServiceSubcommand(value: string | undefined): boolean {
  return typeof value === 'string' && (DAEMON_SERVICE_ACTIVATING_SUBCOMMANDS as readonly string[]).includes(value);
}
