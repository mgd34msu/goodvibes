/**
 * settings-carry-forward.ts: what an earlier release left in a settings file
 * that this release keeps elsewhere or no longer has.
 *
 * Two kinds of stale key are carried forward once, by the manager that owns
 * the file (ConfigManager.load), and the owner is told once what moved or went:
 *
 * - a key only the daemon's settings file sets (config-ownership.ts), found in
 *   a program's own settings file: moved to the daemon's file when that file
 *   does not set it, and removed from the program's file either way;
 * - a key a release since 3.0.0 declared and this release does not
 *   (RETIRED_SETTING_KEYS, read from the settings schema of every release):
 *   removed from the file.
 *
 * Any other key this build does not know was typed by someone (a misspelling,
 * a key from a newer version): it is left in the file and reported once
 * (manager-ingestion.ts), never rewritten here.
 */
import { homedir } from 'node:os';
import { collectDaemonOwnedEntries, persistDaemonKey, readDaemonTierFile } from './daemon-config-tier.js';
import { readDotPath } from './shared-config-tier.js';
import { deleteRawDotPath } from './settings-io.js';

/**
 * Settings keys a release from 3.0.0 to 3.4.2 declared that this release does
 * not, so a file can only hold them because an earlier release wrote them or
 * its owner set them then. Read from the `key:` rows of every release's
 * settings schema (platform/config/schema-domain-*.ts and the programs' host
 * settings) against this release's. The daemon-owned paths that are not
 * settings rows (`email.passwordRef`, `email.smtpPasswordRef`,
 * `google.oauth.refreshToken`) are still read and are not on this list.
 */
export const RETIRED_SETTING_KEYS: readonly string[] = [
  'behavior.suggestAlternativeOnProviderFail',
  'behavior.terminalNotifyTurnEnd',
  'controlPlane.allowRemote',
  'email.draftsMailbox',
  'email.enabled',
  'email.fromAddress',
  'email.imapHost',
  'email.imapPort',
  'email.imapSecurity',
  'email.mailbox',
  'email.smtpHost',
  'email.smtpPort',
  'email.smtpSecurity',
  'email.username',
  'google.credentials.migratedFrom',
  'judgment.decisionDeadlineMs',
  'notifications.burstCooldownMs',
  'notifications.burstWindowMs',
  'permissions.backgroundAgents',
  'push.subscriptions.sweepIntervalMinutes',
  'release.channel',
  'sandbox.replIsolation',
  'sandbox.vmBackend',
  'sandbox.windowsMode',
  'surfaces.email.imapHost',
  'surfaces.email.imapPassword',
  'surfaces.email.imapPort',
  'surfaces.email.imapUser',
  'surfaces.email.username',
  'tools.contractVerification',
];

/**
 * The `judgment.policy` values 3.5.0 and earlier stored for "no decision model is
 * used" (`Classic - Off` is its 3.2.0 name). This release does not have it: a
 * home that holds one is carried once to the mode Ask me (ConfigManager,
 * decision models off).
 */
export const RETIRED_NO_DECISION_MODEL_POLICIES: readonly string[] = ['No Decision Model', 'Classic - Off'];

/**
 * The settings folders of the programs on this machine (the terminal app's,
 * which the daemon's own settings also use, and the Agent's), under the
 * GoodVibes home: where the daemon sets the mode Ask me when it carries
 * decision models switched off forward.
 */
export const PROGRAM_SETTINGS_ROOTS: readonly string[] = ['tui', 'agent'];

/** What carrying one file forward did, for the one line the owner reads. */
export interface SettingsCarryForward {
  /** Daemon keys written to the daemon's settings file. */
  readonly moved: readonly string[];
  /** Daemon keys the daemon's file already set: its value stays, the copy went. */
  readonly superseded: readonly string[];
  /** Keys this release no longer has, removed. */
  readonly removed: readonly string[];
}

/**
 * The stale keys of `document` (a program's own settings file, parsed). With
 * `daemonTierPath`, daemon keys are moved there; without it (the daemon's own
 * file, or a daemon on another machine) only retired keys are taken out.
 * Changes `document` in place and returns what it did; the caller writes the
 * file. Throws when the daemon's file cannot be read or written, before
 * `document` is changed.
 */
export function carrySettingsForward(document: Record<string, unknown>, daemonTierPath: string | null): SettingsCarryForward {
  const daemonEntries = daemonTierPath === null ? [] : collectDaemonOwnedEntries(document);
  const retired = RETIRED_SETTING_KEYS.filter((key) => readDotPath(document, key).present);
  const moved: string[] = [];
  const superseded: string[] = [];
  if (daemonTierPath !== null && daemonEntries.length > 0) {
    const tier = readDaemonTierFile(daemonTierPath);
    for (const { key, value } of daemonEntries) {
      if (readDotPath(tier, key).present) superseded.push(key);
      else { persistDaemonKey(daemonTierPath, key, value); moved.push(key); }
    }
  }
  for (const { key } of daemonEntries) deleteRawDotPath(document, key);
  for (const key of retired) deleteRawDotPath(document, key);
  return { moved, superseded, removed: retired };
}

/** Whether carrying forward changed anything. */
export function carriedAnything(result: SettingsCarryForward): boolean {
  return result.moved.length + result.superseded.length + result.removed.length > 0;
}

/** A path under the home directory written from `~`, as a person reads it. */
function shortPath(file: string): string {
  const home = homedir();
  return home && (file === home || file.startsWith(`${home}/`)) ? `~${file.slice(home.length)}` : file;
}

/** The one line the owner is told, naming every key, where it went and where the file as it was is kept. */
export function describeSettingsCarryForward(file: string, daemonFile: string | null, result: SettingsCarryForward, keptAs?: string): string {
  const parts: string[] = [];
  if (result.moved.length > 0) parts.push(`moved to the daemon's settings (${daemonFile === null ? 'its own file' : shortPath(daemonFile)}): ${result.moved.join(', ')}`);
  if (result.superseded.length > 0) parts.push(`removed because the daemon's settings already set them: ${result.superseded.join(', ')}`);
  if (result.removed.length > 0) parts.push(`removed because this version no longer has them: ${result.removed.join(', ')}`);
  const kept = keptAs === undefined ? '' : ` The file as it was is kept as ${shortPath(keptAs)}.`;
  return `Settings an earlier version left in ${shortPath(file)} were carried forward; ${parts.join('; ')}.${kept}`;
}
