/**
 * manager-ingestion.ts, ConfigManager's side of the settings-ingestion rule.
 *
 * The rule itself, and the reasoning for skip-versus-refuse per key class, is
 * in settings-ingestion.ts. This is the two-function seam that connects it to a
 * manager: where a notice is recorded, and how a failed file becomes the
 * ConfigError the manager's callers already expect. Split out of manager.ts
 * because that file is at its line cap, and cohesive on its own terms, both
 * functions exist only to route a notice to the places an operator can see it.
 */

import { ConfigError } from '../types/errors.js';
import { summarizeError } from '../utils/error-display.js';
import { unknownSettingNotices } from './settings-unknown-forms.js';
import { DAEMON_KEYS_KEPT_FOR_ROLLBACK, MERGED_DAEMON_LISTS, MERGED_DAEMON_RECORDS } from './settings-carry-forward.js';
import { CONFIG_SCHEMA } from './schema.js';
import { configKeyFacts } from './config-key-facts.js';
import {
  SettingsIngestionRefusal,
  announceIngestionNotice,
  describeIngestionNotice,
  ingestSettingsFile,
  unreadableSettingsFileNotice,
  type SettingsIngestionNotice,
} from './settings-ingestion.js';

export type { SettingsIngestionNotice };

/** Where a manager files an ingestion notice so an operator can find it. */
export interface IngestionNoticeSink {
  /** Publication policy for unreadable-file errors, selected before the manager loads settings. */
  readonly diagnosticMode?: 'default' | 'structural' | undefined;
  /** Kept for `ConfigManager.getIngestionQuarantine()`. */
  record(entry: SettingsIngestionNotice): void;
  /**
   * Announce-once startup receipt. The daemon serves these from /status, so a
   * skipped setting reaches a surface rather than dead-ending in a log file.
   */
  receipt(id: string, text: string): void;
  /** Withdraws announce-once receipts the predicate selects, so a setting fixed and then broken again is announced again. */
  forgetReceipts?(selects: (id: string) => boolean): void;
}

/**
 * Screen one parsed settings file before it is merged: refuse what must not be
 * silently dropped, skip what can be, and say either loudly.
 */
export function ingestManagerSettings(
  parsed: Record<string, unknown>,
  file: string,
  sink: IngestionNoticeSink,
  knownHostKeys?: ReadonlySet<string>,
  daemonOwned?: ((key: string) => boolean) | undefined,
  projectFile = false,
): Record<string, unknown> {
  const noticedKeys = new Set<string>();
  const result = ingestSettingsFile(parsed, file, {
    diagnosticMode: sink.diagnosticMode, ...(knownHostKeys ? { hostKeys: knownHostKeys } : {}),
    onNotice: (entry) => { noticedKeys.add(entry.key); noticeTo(sink, entry); },
  });
  for (const entry of result.unknownKeys) noticedKeys.add(entry.key);
  const config = daemonOwned ? omitDaemonOwnedLeaves(result.config, file, daemonOwned, projectFile) : { layer: result.config, notices: [] };
  for (const entry of config.notices) noticedKeys.add(entry.key);
  forgetFixedKeyReceipts(sink, file, noticedKeys);
  for (const entry of [...unknownSettingNotices(file, result.unknownKeys, knownHostKeys), ...config.notices]) {
    announceIngestionNotice(entry);
    noticeTo(sink, entry);
  }
  return config.layer;
}

/**
 * A surface's or project's settings file read beside a daemon's: a key only
 * the daemon's file sets (the domains and keys config-ownership.ts gives the
 * daemon) is left out of this layer, so the app never shows a value the
 * daemon does not read as in effect. One notice per key says where to set it;
 * the file itself is left as it is.
 */
function omitDaemonOwnedLeaves(
  layer: Record<string, unknown>,
  file: string,
  daemonOwned: (key: string) => boolean,
  projectFile: boolean,
): { readonly layer: Record<string, unknown>; readonly notices: readonly SettingsIngestionNotice[] } {
  const notices: SettingsIngestionNotice[] = [];
  const visit = (node: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${name}` : name;
      if (daemonOwned(key)) {
        // A project may make a protection the daemon sets stricter (Ask me under the daemon's YOLO): such a key stays in
        // the project's layer, is judged as every project key is (only stricter, project-layer-restrictions.ts), and is
        // laid again over the daemon's value where it is stricter (manager.ts `#keepProjectStricter`).
        const facts = projectFile ? configKeyFacts(key) : undefined;
        if (facts?.projectSettable === true && facts.loosens !== undefined) {
          kept[name] = value;
          continue;
        }
        // Left in a program's file for an earlier version (settings-carry-forward.ts): not read here, and nothing to say.
        if (DAEMON_KEYS_KEPT_FOR_ROLLBACK.includes(key) || MERGED_DAEMON_LISTS.includes(key) || MERGED_DAEMON_RECORDS.includes(key)) continue;
        // A project's worktree settings are read by the daemon itself when it sets up that project's worktrees
        // (runtime/worktree/project-setup-settings.ts), and what it does not use is said there, once: nothing here.
        if (projectFile && (key === 'worktree' || key.startsWith('worktree.'))) continue;
        notices.push({
          file, key, action: 'skipped',
          reason: "only the daemon's settings file sets this, so the value here is not used",
          remedy: `Set it with: goodvibes-daemon config set ${key} <value>, or in the settings screen`,
        });
        continue;
      }
      kept[name] = value !== null && typeof value === 'object' && !Array.isArray(value) ? visit(value as Record<string, unknown>, key) : value;
    }
    return kept;
  };
  return { layer: visit(layer, ''), notices };
}

/**
 * The receipt store announces each id once. A key that no longer draws a notice
 * in this file has been fixed, so its receipts are withdrawn: breaking it again
 * is a new problem the operator must hear about, while a file that stays bad
 * keeps its receipts and is not announced again.
 */
function forgetFixedKeyReceipts(sink: IngestionNoticeSink, file: string, stillNoticed: ReadonlySet<string>): void {
  if (!sink.forgetReceipts) return;
  const prefix = `settings-ingestion:${file}:`;
  try {
    sink.forgetReceipts((id) => id.startsWith(prefix) && ![...stillNoticed].some((key) => id.startsWith(`${prefix}${key}:`)));
  } catch {
    // Same rule as noticeTo: a receipt store that cannot be written never fails a load.
  }
}

function noticeTo(sink: IngestionNoticeSink, entry: SettingsIngestionNotice): void {
  sink.record(entry);
  try {
    // Keyed by file and reason as well as key and action: the store is
    // announce-once, so a bare key id would hide the same key going bad in a
    // second file (project, other tier) or for a different reason.
    sink.receipt(`settings-ingestion:${entry.file}:${entry.key}:${entry.action}:${entry.reason}`, describeIngestionNotice(entry));
  } catch {
    // A receipt store that cannot be written must never escalate a skipped
    // setting into a failed construction. It was already said on stderr and
    // in the activity log, which is where the guarantee actually lives.
  }
}

/**
 * Turn a settings-file failure into the ConfigError callers expect, having
 * first said what happened.
 *
 * A refusal announced itself already. Anything else reaching here is a file
 * that could not be parsed at all, also a refusal, because the reader cannot
 * know whether the unreadable bytes held a safety-gate key, and so cannot know
 * that carrying on without them is safe.
 */
export function toConfigLoadFailure(
  label: string,
  file: string,
  err: unknown,
  sink: IngestionNoticeSink,
): ConfigError {
  let refusedKey: string | undefined;
  if (err instanceof SettingsIngestionRefusal) {
    const notice = Object.getOwnPropertyDescriptor(err, 'notice');
    const value: unknown = notice && 'value' in notice ? notice.value : undefined;
    if (value !== null && typeof value === 'object') {
      const key = Object.getOwnPropertyDescriptor(value, 'key');
      const candidate: unknown = key && 'value' in key ? key.value : undefined;
      if (typeof candidate === 'string' && CONFIG_SCHEMA.some(setting => setting.key === candidate)) refusedKey = candidate;
    }
  }
  if (!(err instanceof SettingsIngestionRefusal)) {
    const entry = unreadableSettingsFileNotice(file, summarizeError(err), sink.diagnosticMode);
    announceIngestionNotice(entry);
    sink.record(entry);
  }
  return new ConfigError(`${label} config load failed for ${file}${refusedKey ? ` at ${refusedKey}` : ''}: ${summarizeError(err)}`, { cause: err });
}
