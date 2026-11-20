/**
 * schema-domain-update.ts, the shared daemon and terminal self-update config domain.
 *
 * The daemon checks for a new release hourly, downloads and
 * checksum-verifies it, swaps binaries at a no-active-work moment (never
 * mid-turn), keeps the previous binary at `<path>.previous` for one-command
 * rollback, and restarts via the service manager. Default-on per the owner
 * directive; `update.auto` turns it off.
 *
 * `releasesUrl` names the authorized GoodVibes monorepo release line: the
 * product's own GitHub repository, or a feed served on this machine. Exact
 * historical default feeds migrate. Release availability is independent of
 * source readiness.
 *
 * `update` is a top-level config section: GoodVibesConfig (schema-types.ts)
 * imports UpdateConfig, and its keys and value types are read off it.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
export const DAEMON_RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes/releases/latest';
/** The one repository whose releases may replace the installed programs. */
const RELEASES_PATH_PREFIX = '/mgd34msu/goodvibes/releases';

/** Daemon self-update: hourly check, verify, idle-moment swap, auto-restart. */
export interface UpdateConfig {
  auto: boolean;
  autoUpdateAtLaunch: boolean;
  launchCheckTimeoutMs: number;
  applyTimeoutMs: number;
  intervalMinutes: number;
  firstCheckSeconds: number;
  releasesUrl: string;
  rollbackAfterFailedStarts: number;
  alertAfterFailedChecks: number;
}


export const updateConfigDefaults = {
  update: {
    auto: true,
    autoUpdateAtLaunch: true,
    launchCheckTimeoutMs: 2500,
    applyTimeoutMs: 45_000,
    intervalMinutes: 60,
    firstCheckSeconds: 30,
    releasesUrl: DAEMON_RELEASES_LATEST_URL,
    rollbackAfterFailedStarts: 3,
    alertAfterFailedChecks: 3,
  },
} as const;

export const updateConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'update.auto',
    label: 'Update while running',
    appliesWhen: 'now',
    type: 'boolean',
    description: 'While-running self-update of this installation (the daemon, and the Agent): check for a new release hourly, download and checksum-verify it, swap at a no-active-work moment, and restart (the previous binary is kept for one-command rollback). A daemon setting: one value for every program on this machine, kept in the daemon\'s settings file; a project settings file cannot set it. The release installer\'s --no-auto-update sets it false',
  },
  {
    key: 'update.autoUpdateAtLaunch',
    label: 'Update when an app starts',
    type: 'boolean',
    description: 'The terminal app and the Agent check for and install a newer release at launch. Set false to disable launch updates; the Agent\'s while-running updates also stop unless update.auto is explicitly set. A daemon setting: one value for every program on this machine, kept in the daemon\'s settings file; a project settings file cannot set it. The release installer\'s --no-auto-update sets it false',
  },
  {
    key: 'update.launchCheckTimeoutMs',
    label: 'Longest the start-up update check may take (ms)',
    type: 'number',
    description: 'Maximum milliseconds spent checking for a terminal update at launch; the installed version starts if the check cannot complete',
    ...intRange(250, 30_000),
  },
  {
    key: 'update.applyTimeoutMs',
    label: 'Longest the start-up update may take (ms)',
    type: 'number',
    description: 'Maximum milliseconds the terminal app and the Agent spend downloading, verifying and swapping in a new release at launch. Past it, an update that has not started replacing files is cancelled and tried at the next launch; one already replacing files finishes in the background and says so when it is done',
    ...intRange(5_000, 300_000),
  },
  {
    key: 'update.intervalMinutes',
    label: 'Check for updates every (minutes)',
    type: 'number',
    description: 'Minutes between daemon update checks',
    ...intRange(5, 24 * 60),
  },
  {
    key: 'update.firstCheckSeconds',
    label: 'First update check after start (seconds)',
    type: 'number',
    description: 'Seconds after daemon start before the FIRST update check (a boot-settle delay, so a daemon that was down while releases shipped does not stay stale for a whole interval). Capped at one check interval',
    ...intRange(0, 60 * 60),
  },
  {
    key: 'update.releasesUrl',
    label: 'Where updates come from',
    type: 'string',
    description: 'GitHub releases/latest URL for a complete GoodVibes monorepo suite. Exact historical default feeds migrate to goodvibes. Native suite updates replace installed sibling programs and configured release WebUI/browser support together. Must be a release URL of the GoodVibes repository itself (https://github.com/mgd34msu/goodvibes/releases/...), or an http URL on this machine (loopback address) (empty turns the update loop off): the binaries and checksums are downloaded from this origin and are not signed, so any other repository or remote host would let a config write replace the installed programs',
    validate: (v) => {
      if (typeof v !== 'string') return false;
      if (v.trim() === '') return true;
      try {
        const url = new URL(v.trim());
        if (url.username !== '' || url.password !== '') return false;
        // The binaries and checksums are not signed, so only the product's own repository is accepted.
        if (url.protocol === 'https:') {
          return url.hostname === 'github.com' && (url.pathname === RELEASES_PATH_PREFIX || url.pathname.startsWith(`${RELEASES_PATH_PREFIX}/`));
        }
        // A feed on this machine cannot be reached by another host, so plain http is safe there (the acceptance runs serve one).
        return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
      } catch {
        return false;
      }
    },
    validationHint: 'https://github.com/mgd34msu/goodvibes/releases/... (or http on 127.0.0.1, localhost or [::1]) without credentials, or empty to turn the update loop off',
  },
  {
    key: 'update.rollbackAfterFailedStarts',
    label: 'Go back to the previous version after this many failed starts',
    type: 'number',
    description: 'Consecutive rapid boots that fail to reach a fully-started daemon before the startup path automatically restores the kept previous binary and restarts onto it. 0 leaves a bad update in place for a hand-run rollback',
    ...intRange(0, 10),
  },
  {
    key: 'update.alertAfterFailedChecks',
    label: 'Tell you after this many failed update checks',
    type: 'number',
    description: 'Consecutive failed update checks before the daemon tells the owner over a channel that still works that it can no longer update itself. Lower is louder; 1 reports the first failure. A repeat is held back for 12 hours so an ongoing outage is one message rather than one an hour',
    ...intRange(1, 100),
  },
];
