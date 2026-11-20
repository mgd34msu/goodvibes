/**
 * worktree-setup-config.ts, the settings-screen editor for
 * worktree.setup.commands / worktree.setup.carryOverGlobs.
 *
 * Both are rows of the platform's settings schema (schema-domain-lists.ts),
 * read by the one resolver every provisioning path uses
 * (resolveEffectiveWorktreeSetup). Each has three stated modes: `auto` (derive
 * from the repository, the default), `none`, or a list. This screen edits them
 * on one line: `auto`, `none`, or the list in the shared list codec (comma
 * separated, or a JSON list when an entry holds a comma), and its row says what
 * `auto` runs or copies for this repository, from the same derivation.
 */
import type { ConfigKey, ConfigManager, ConfigSetting } from '@goodvibes/engine/platform/platform/config';
import {
  deriveWorktreeSetup,
  readWorktreeSetupChoice,
  worktreeSetupSettingValue,
  type WorktreeSetupChoice,
  type WorktreeSetupListSetting,
} from '@goodvibes/engine/platform/platform/runtime/shell';
import { formatListEditText, parseListEditText } from '@goodvibes/engine/terminal-shell/settings-behavior';
import type { SettingEntry } from './settings-modal-types.ts';

export const WORKTREE_SETUP_COMMANDS_CONFIG_KEY: ConfigKey = 'worktree.setup.commands';
export const WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY: ConfigKey = 'worktree.setup.carryOverGlobs';

const WORKTREE_SETUP_LIST_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set([
  WORKTREE_SETUP_COMMANDS_CONFIG_KEY,
  WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY,
]);

/** True for the two worktree-setup keys, edited as `auto`, `none` or a list. */
export function isWorktreeSetupListConfigKey(key: ConfigKey): boolean {
  return WORKTREE_SETUP_LIST_CONFIG_KEYS.has(key);
}

/** The stated mode of one worktree setup key; a missing section reads as `auto`. */
export function readWorktreeSetupSetting(configManager: Pick<ConfigManager, 'get'>, key: ConfigKey): WorktreeSetupChoice {
  try {
    return readWorktreeSetupChoice(configManager.get(key));
  } catch {
    return { mode: 'auto' };
  }
}

/** The one-line text of a mode: what the row shows and the editor starts from. */
export function formatWorktreeSetupEditText(value: unknown): string {
  const choice = readWorktreeSetupChoice(value);
  if (choice.mode !== 'list') return choice.mode;
  // A one-entry list that reads like a mode word is written as JSON so it stays a list.
  if (choice.values.length === 1 && (choice.values[0] === 'auto' || choice.values[0] === 'none')) return JSON.stringify(choice.values);
  return formatListEditText(choice.values);
}

/** Parse the editor's text: empty or `auto`, `none`, or a list. */
export function parseWorktreeSetupEditText(text: string): { readonly ok: true; readonly value: WorktreeSetupListSetting } | { readonly ok: false; readonly reason: string } {
  const word = text.trim().toLowerCase();
  if (word === '' || word === 'auto') return { ok: true, value: worktreeSetupSettingValue({ mode: 'auto' }) };
  if (word === 'none') return { ok: true, value: worktreeSetupSettingValue({ mode: 'none' }) };
  const parsed = parseListEditText(text);
  if (!parsed.ok) return parsed;
  return { ok: true, value: worktreeSetupSettingValue(parsed.values.length > 0 ? { mode: 'list', values: parsed.values } : { mode: 'auto' }) };
}

/** What `auto` does for the repository at `sourceRoot`, from the derivation setup itself uses. */
function describeAuto(key: ConfigKey, sourceRoot: string): string {
  const derived = deriveWorktreeSetup(sourceRoot);
  if (key === WORKTREE_SETUP_COMMANDS_CONFIG_KEY) {
    return derived.commands.length > 0
      ? `Here, auto runs: ${derived.commands.join('; ')}.`
      : 'Here, auto runs nothing (no lockfile it knows at the repository root).';
  }
  return derived.carryOverGlobs.length > 0
    ? `Here, auto copies: ${derived.carryOverGlobs.join(', ')}.`
    : 'Here, auto copies nothing (no .env file at the repository root).';
}

const EDIT_HELP = 'Type auto, none, or a list (comma separated, or a JSON list such as [".env.{local,dev}"] when an entry has a comma).';

function schemaDescription(configManager: Pick<ConfigManager, 'getSchema'>, key: ConfigKey): string {
  return configManager.getSchema().find((setting) => setting.key === key)?.description ?? '';
}

function buildWorktreeSetupSetting(configManager: Pick<ConfigManager, 'getSchema'>, key: ConfigKey, sourceRoot: string): ConfigSetting {
  return {
    key,
    label: configManager.getSchema().find((setting) => setting.key === key)?.label ?? key,
    type: 'string',
    // The stored default (an empty list, which reads as auto), so a reset writes what the schema holds.
    default: [],
    description: [schemaDescription(configManager, key), describeAuto(key, sourceRoot), EDIT_HELP].filter((part) => part.length > 0).join(' '),
  };
}

function buildWorktreeSetupListEntry(configManager: Pick<ConfigManager, 'get' | 'getSchema'>, key: ConfigKey, sourceRoot: string): SettingEntry {
  const choice = readWorktreeSetupSetting(configManager, key);
  return {
    setting: buildWorktreeSetupSetting(configManager, key, sourceRoot),
    currentValue: formatWorktreeSetupEditText(worktreeSetupSettingValue(choice)),
    isDefault: choice.mode === 'auto',
  };
}

export function buildWorktreeSetupCommandsSyntheticEntry(configManager: Pick<ConfigManager, 'get' | 'getSchema'>, sourceRoot: string = process.cwd()): SettingEntry {
  return buildWorktreeSetupListEntry(configManager, WORKTREE_SETUP_COMMANDS_CONFIG_KEY, sourceRoot);
}

export function buildWorktreeSetupCarryOverGlobsSyntheticEntry(configManager: Pick<ConfigManager, 'get' | 'getSchema'>, sourceRoot: string = process.cwd()): SettingEntry {
  return buildWorktreeSetupListEntry(configManager, WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY, sourceRoot);
}
