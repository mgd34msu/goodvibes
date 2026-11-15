/**
 * Settings that no longer exist, and settings that now have one spelling.
 *
 * A removed setting is dropped from a settings file with a receipt that says
 * what decides the thing now. A retired spelling moves to the one spelling
 * every reader uses, but only where the value was the one in force: a value
 * that an earlier reader would have skipped because a preferred spelling was
 * set is dropped instead, so nothing that worked before resolves differently
 * afterwards. Idempotent; a file with none of these keys is returned untouched.
 */
import { readDotPath } from './shared-config-tier.js';
import { deleteRawDotPath, writeRawDotPath } from './settings-io.js';

/** A setting with no successor, and the sentence the receipt gives for it. */
interface RetiredSetting {
  readonly key: string;
  readonly instead: string;
}

/**
 * A retired spelling and its successor. `shadowedBy` lists the spellings an
 * earlier reader preferred over `from`: when one of them is set, `from` was
 * never in force and is dropped rather than moved.
 */
interface RetiredSpelling {
  readonly from: string;
  readonly to: string;
  readonly shadowedBy: readonly string[];
}

export const RETIRED_SETTINGS: readonly RetiredSetting[] = [
  {
    key: 'controlPlane.allowRemote',
    instead: 'Nothing read it: whether the control plane can be reached from other machines is decided by controlPlane.hostMode (and controlPlane.host).',
  },
  {
    key: 'google.oauth.refreshToken',
    instead: 'Nothing read it: the Google refresh token is kept only in the secret store, where setup puts it.',
  },
];

/**
 * The daemon's mailbox has one spelling of each setting: `surfaces.email.host`,
 * `.user`, `.from`, `.password`, and `.imap.*` / `.smtp.*` for what differs per
 * protocol. Order matters: `username` before `imapUser`, the order the account
 * name was resolved in.
 */
export const RETIRED_SPELLINGS: readonly RetiredSpelling[] = [
  { from: 'surfaces.email.username', to: 'surfaces.email.user', shadowedBy: [] },
  { from: 'surfaces.email.imapUser', to: 'surfaces.email.user', shadowedBy: [] },
  { from: 'surfaces.email.imapHost', to: 'surfaces.email.imap.host', shadowedBy: ['surfaces.email.host'] },
  { from: 'surfaces.email.imapPort', to: 'surfaces.email.imap.port', shadowedBy: [] },
  { from: 'surfaces.email.imapPassword', to: 'surfaces.email.imap.password', shadowedBy: [] },
];

/** Every key this pass takes out of a file, so the unknown-key screen does not report them first. */
export const RETIRED_SETTING_KEYS: readonly string[] = [
  ...RETIRED_SETTINGS.map((setting) => setting.key),
  ...RETIRED_SPELLINGS.map((spelling) => spelling.from),
];

export interface RetiredSettingsMigrationResult {
  readonly config: Record<string, unknown>;
  readonly migrated: boolean;
  /** Removed settings that were present, in {@link RETIRED_SETTINGS} order. */
  readonly removed: readonly string[];
  /** Retired spellings that were present: moved, or dropped because they were never in force. */
  readonly moves: readonly { readonly from: string; readonly to: string; readonly moved: boolean }[];
}

function isSet(config: Record<string, unknown>, key: string): boolean {
  const found = readDotPath(config, key);
  return found.present && found.value !== '' && found.value !== null && found.value !== undefined;
}

export function migrateRetiredSettings(parsed: Record<string, unknown>): RetiredSettingsMigrationResult {
  if (!RETIRED_SETTING_KEYS.some((key) => readDotPath(parsed, key).present)) {
    return { config: parsed, migrated: false, removed: [], moves: [] };
  }
  const config = structuredClone(parsed);
  const removed: string[] = [];
  for (const { key } of RETIRED_SETTINGS) {
    if (deleteRawDotPath(config, key)) removed.push(key);
  }
  const moves: { from: string; to: string; moved: boolean }[] = [];
  for (const { from, to, shadowedBy } of RETIRED_SPELLINGS) {
    const found = readDotPath(config, from);
    if (!found.present) continue;
    deleteRawDotPath(config, from);
    const inForce = found.value !== '' && found.value !== null && !shadowedBy.some((key) => isSet(config, key));
    const moved = inForce && !isSet(config, to);
    if (moved) writeRawDotPath(config, to, found.value);
    moves.push({ from, to, moved });
  }
  return { config, migrated: true, removed, moves };
}

/** The one-line receipt for a migrated file. */
export function describeRetiredSettingsMigration(result: RetiredSettingsMigrationResult, sourcePath: string): string {
  const parts: string[] = [];
  for (const key of result.removed) {
    const setting = RETIRED_SETTINGS.find((entry) => entry.key === key);
    parts.push(`${key} is gone from ${sourcePath}. ${setting?.instead ?? ''}`.trim());
  }
  const moved = result.moves.filter((move) => move.moved).map((move) => `${move.from} is now ${move.to}`);
  const dropped = result.moves.filter((move) => !move.moved).map((move) => move.from);
  if (moved.length > 0) parts.push(`Mailbox settings now have one spelling: ${moved.join('; ')}. Your values moved unchanged.`);
  if (dropped.length > 0) parts.push(`${dropped.join(', ')} ${dropped.length === 1 ? 'was' : 'were'} dropped: each was empty, or another spelling of the same setting was already in force.`);
  return parts.join(' ');
}
