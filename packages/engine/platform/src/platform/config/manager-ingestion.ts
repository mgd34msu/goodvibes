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
import { CONFIG_SCHEMA } from './schema.js';
import {
  SettingsIngestionRefusal,
  announceIngestionNotice,
  describeIngestionNotice,
  ingestSettingsFile,
  unreadableSettingsFileNotice,
  type SettingsIngestionNotice,
  type UnknownSettingKey,
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
  /**
   * Unused: unknown keys are announced at load by {@link ingestManagerSettings}.
   * @deprecated Kept only until ConfigManager stops passing it.
   */
  unknown?(file: string, keys: readonly UnknownSettingKey[]): void;
}

/**
 * Screen one parsed settings file before it is merged: refuse what must not be
 * silently dropped, skip what can be, and say either loudly.
 */
export function ingestManagerSettings(
  parsed: Record<string, unknown>,
  file: string,
  sink: IngestionNoticeSink,
  /** The manager's load-time migrations; run before the screen. See IngestSettingsOptions.migrate. */
  migrate?: ((raw: Record<string, unknown>) => Record<string, unknown>) | undefined,
  knownHostKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  const noticedKeys = new Set<string>();
  const result = ingestSettingsFile(parsed, file, {
    diagnosticMode: sink.diagnosticMode, ...(migrate ? { migrate } : {}), ...(knownHostKeys ? { hostKeys: knownHostKeys } : {}),
    onNotice: (entry) => { noticedKeys.add(entry.key); noticeTo(sink, entry); },
  });
  for (const entry of result.unknownKeys) noticedKeys.add(entry.key);
  forgetFixedKeyReceipts(sink, file, noticedKeys);
  for (const entry of unknownSettingNotices(file, result.unknownKeys, knownHostKeys)) {
    announceIngestionNotice(entry);
    noticeTo(sink, entry);
  }
  return result.config;
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
 * Unknown keys are announced at load by {@link ingestManagerSettings}; nothing
 * waits for a judgment port any more.
 * @deprecated Kept only until ConfigManager stops constructing it.
 */
export class UnknownSettingFormsQueue {
  keep(_file: string, _keys: readonly UnknownSettingKey[], _sink: IngestionNoticeSink): void { /* announced at load */ }
  start(_sink: IngestionNoticeSink): Promise<void> { return Promise.resolve(); }
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
