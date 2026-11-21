/**
 * What to tell someone whose browser driver is not there, matched to how they
 * actually installed the agent.
 *
 * The Agent's package is private and is not published, so every install kind
 * other than a source checkout is brought up to date by the suite installer;
 * no message here tells anyone to install a package.
 *
 * The wording now lives in the platform, because every surface that drives a browser
 * needs the same answer. What stayed here is what the platform cannot know: which
 * install kinds THIS build has, what its release calls the driver asset, where
 * that asset is published, and the two commands that reinstall it. The install
 * kind comes from the same detector `/update` uses (runtime/update-check.ts),
 * so a message here can never disagree with what `/update apply` would do on
 * the same machine.
 */
import {
  driverRemediation as renderDriverRemediation,
  shippedDriverPath as renderShippedDriverPath,
  type BrowserDriverInstallKind,
  type BrowserDriverInstallProfile,
  type DriverRemediationOptions,
} from '@goodvibes/engine/platform/platform/browser';
import { DAEMON_REPO_RELEASES_LATEST_URL } from '@goodvibes/engine/platform/platform/runtime/client';
import { BINARY_INSTALL_COMMAND, detectInstallKind } from '@goodvibes/engine/platform/platform/runtime/install-kind';
import { BROWSER_DRIVER_ARCHIVE_NAME, BROWSER_DRIVER_DIR_NAME } from './release-artifacts.ts';

export const RELEASES_LATEST_URL = DAEMON_REPO_RELEASES_LATEST_URL;

export type { DriverRemediationOptions };

/**
 * This repo's particulars, as the platform's remediation renderer asks for them.
 *
 * `detectInstallKind` reports `bun-global-package` where the platform's vocabulary
 * says `global-package`; the two name the same install method, and that
 * mapping is the only translation in this file.
 */
export const AGENT_BROWSER_DRIVER_PROFILE: BrowserDriverInstallProfile = {
  detectInstallKind: (execPath: string): BrowserDriverInstallKind => {
    const kind = detectInstallKind(execPath);
    return kind === 'bun-global-package' ? 'global-package' : kind;
  },
  archiveName: BROWSER_DRIVER_ARCHIVE_NAME,
  directoryName: BROWSER_DRIVER_DIR_NAME,
  releasesUrl: RELEASES_LATEST_URL,
  installerCommand: BINARY_INSTALL_COMMAND,
  globalPackageCommand: BINARY_INSTALL_COMMAND,
  sourceInstallCommand: 'bun install',
  // The agent's own voice, restored: the hoist's neutral default said
  // "the driver is then installed automatically", which tells the reader
  // less than naming who does it.
  packageManagerFallbackAdvice:
    'Installing bun or npm also works: the agent then installs the driver for itself on the next browser call.',
};

/**
 * The one sentence to print when the driver could not be found AND could not be
 * provisioned. Provisioning is tried first everywhere this is used, so reaching
 * this text means the automatic path is genuinely unavailable (no network, no
 * package manager, nowhere writable) and the person has to do something.
 */
export function driverRemediation(options: DriverRemediationOptions = {}): string {
  return renderDriverRemediation(AGENT_BROWSER_DRIVER_PROFILE, options);
}

/**
 * Where the driver would go if the person followed the advice above, for
 * messages that want to name the exact path rather than the whole recipe.
 */
export function shippedDriverPath(options: DriverRemediationOptions = {}): string {
  return renderShippedDriverPath(AGENT_BROWSER_DRIVER_PROFILE, options);
}
