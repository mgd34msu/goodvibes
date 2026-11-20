/**
 * The one definition of the daemon's service (systemd unit, LaunchAgent,
 * Windows task). Every writer builds it here: `goodvibes-daemon
 * install-service` and `refresh-service`, `goodvibes service install`, the
 * terminal apps' onboarding, the release and checkout installers (through the
 * daemon), and the daemon itself (boot promotion, update adoption, the web
 * UI's install). So whichever path writes the file, it holds the same launch.
 *
 * It never carries a token: the daemon reads its operator token from its own
 * home (`operator-tokens.json`) at every start, and a service definition is a
 * file other tools print and copy. A token set in the shell that ran the
 * install stays in that shell.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface ManagedServiceDefinitionShape {
  readonly name: string;
  readonly description: string;
  readonly workingDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly restartOnFailure: boolean;
}

/** The description every GoodVibes-written definition carries; `readManagedDefinitionOwner` recognises the file by it. */
export const MANAGED_SERVICE_DESCRIPTION = 'GoodVibes daemon (shared session broker + companion host)';

export interface ManagedDaemonServiceDefinitionInput {
  readonly name: string;
  /** The daemon executable the service runs. */
  readonly command: string;
  /** The GoodVibes tree root (`GOODVIBES_HOME`, else the login home). */
  readonly homeDirectory: string;
  /** The daemon home when one was selected; `<tree root>/.goodvibes/daemon` otherwise. */
  readonly daemonHomeDirectory?: string | undefined;
  /** The login home the service manager reads the definition from. */
  readonly unitHomeDirectory: string;
  readonly workingDirectory: string;
  readonly restartOnFailure: boolean;
}

/**
 * The launcher a checkout installation (scripts/install-from-checkout.sh) runs
 * its programs through: `<prefix>/commands/goodvibes-daemon` for an executable
 * at `<prefix>/releases/<release>/daemon/goodvibes-daemon-<target>`, when that
 * prefix carries the installation's receipt. The launcher pins the release,
 * loads the installation's private environment file and sets its homes, so the
 * service runs what the installed command runs and survives an update. Any
 * other executable is its own launcher.
 */
export function resolveServiceLauncher(command: string): string {
  const name = basename(command);
  if (!name.startsWith('goodvibes-daemon-')) return command;
  const productDirectory = dirname(command);
  const releasesDirectory = dirname(dirname(productDirectory));
  if (basename(productDirectory) !== 'daemon' || basename(releasesDirectory) !== 'releases') return command;
  const prefix = dirname(releasesDirectory);
  const launcher = join(prefix, 'commands', 'goodvibes-daemon');
  return existsSync(join(prefix, 'installation.json')) && existsSync(launcher) ? launcher : command;
}

/**
 * The definition. No endpoint flags: the daemon reads `controlPlane.*` from
 * its settings at every start. `--daemon-home` only for a selected daemon home,
 * `GOODVIBES_HOME` only for a moved tree (a service manager does not inherit
 * the installing shell's environment). Nothing else is put in the environment.
 */
export function buildManagedDaemonServiceDefinition(input: ManagedDaemonServiceDefinitionInput): ManagedServiceDefinitionShape {
  const defaultDaemonHome = join(input.homeDirectory, '.goodvibes', 'daemon');
  const daemonHome = input.daemonHomeDirectory ?? defaultDaemonHome;
  return {
    name: input.name,
    description: MANAGED_SERVICE_DESCRIPTION,
    workingDirectory: input.workingDirectory,
    command: resolveServiceLauncher(input.command),
    args: daemonHome === defaultDaemonHome ? [] : ['--daemon-home', daemonHome],
    env: input.homeDirectory === input.unitHomeDirectory ? {} : { GOODVIBES_HOME: input.homeDirectory },
    restartOnFailure: input.restartOnFailure,
  };
}
