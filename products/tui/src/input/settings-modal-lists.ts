/**
 * settings-modal-lists.ts, the one edit codec for every list-valued row the
 * settings screen edits on one line (worktree.setup.*, the two sandbox lists,
 * permissions.execEnvScrubAllowlist). The editor starts from text that parses
 * back to the same list, so opening a row and pressing Enter never changes it,
 * and an entry with a comma (a brace glob, a command line) stays whole.
 */
import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { formatListEditText, parseListEditText } from '@goodvibes/engine/terminal-shell/settings-behavior';
import { formatWorktreeSetupEditText, isWorktreeSetupListConfigKey, parseWorktreeSetupEditText } from './worktree-setup-config.ts';
import { isSandboxExecListConfigKey } from './sandbox-exec-config.ts';
import { isExecEnvScrubAllowlistConfigKey } from './exec-env-scrub-config.ts';

/** True for a row whose stored value is a list edited through this codec. */
export function isListSettingKey(key: ConfigKey): boolean {
  return isWorktreeSetupListConfigKey(key) || isSandboxExecListConfigKey(key) || isExecEnvScrubAllowlistConfigKey(key);
}

/** The editor's starting text for a list row, or null for any other row. */
export function listSettingEditText(key: ConfigKey, value: unknown): string | null {
  if (!isListSettingKey(key)) return null;
  // A row may already hold its edit text (the worktree rows show their mode that way).
  if (typeof value === 'string') return value;
  if (isWorktreeSetupListConfigKey(key)) return formatWorktreeSetupEditText(value);
  return formatListEditText(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
}

/** The value to store for a list row's edit text, the refusal reason, or null for any other row. */
export function parseListSettingEdit(key: ConfigKey, text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } | null {
  if (isWorktreeSetupListConfigKey(key)) return parseWorktreeSetupEditText(text);
  if (!isListSettingKey(key)) return null;
  const parsed = parseListEditText(text);
  return parsed.ok ? { ok: true, value: parsed.values } : parsed;
}
