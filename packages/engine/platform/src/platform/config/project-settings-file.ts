/**
 * project-settings-file.ts, the ONE settings file a project keeps for every program and the daemon:
 * `<project>/.goodvibes/settings.json`.
 *
 * Until this version each program kept its own project file (`.goodvibes/tui/settings.json` for the terminal app,
 * `.goodvibes/agent/settings.json` for the Agent, `.goodvibes/daemon-host/settings.json` for the daemon's turns), so a
 * setting made in one program did not reach a turn of another in the same project. Now every program's settings manager
 * (config/manager.ts) and the daemon's per-project view (config/project-view.ts) read and write the one file.
 *
 * The old files are carried into it once, the first time any program or the daemon reads the project with no one file
 * there yet: only the keys a project file may hold (config-key-facts.ts `projectSettable`, the same admission the
 * project layer applies); a person-level setting written in an old project file stays where it is and was never applied
 * from there. Where two programs' files set one key differently, the stricter value of a protection is kept (the key's
 * own loosening rule, config-key-facts.ts), otherwise the terminal app's; the owner is told once which keys differed.
 * The old files are left untouched, so a 3.5.0 program after going back reads its own file as it was at the carry
 * (a change made after the carry is in the one file only).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { configKeyFacts, listProjectUnsettableConfigKeys } from './config-key-facts.js';
import { collectLeaves, isForeignSecretRef, settingFor } from './project-layer-restrictions.js';
import { readDotPath } from './shared-config-tier.js';
import { writeRawDotPath } from './settings-io.js';

/** The programs' own project settings folders until this version, the terminal app's first (its value wins a tie). */
export const PROGRAM_PROJECT_SETTINGS_ROOTS: readonly string[] = ['tui', 'agent', 'daemon-host'];

/** `<project>/.goodvibes/settings.json` for a folder in that project (workspace/project-identity.ts). */
export function projectSettingsFileOf(folder: string): string {
  return join(projectIdentityOf(folder), '.goodvibes', 'settings.json');
}

/** One key the programs' files set differently, and what the one file holds now. */
export interface ProjectSettingsDifference {
  readonly key: string;
  /** Each program's value, by its folder name (`tui`, `agent`, `daemon-host`). */
  readonly held: Readonly<Record<string, unknown>>;
  readonly kept: unknown;
  /** True when the kept value is the stricter of a protection; false when it is the terminal app's. */
  readonly stricter: boolean;
}

/** What carrying the old files into the one file did. */
export interface ProjectSettingsCarry {
  readonly file: string;
  readonly carriedFrom: readonly string[];
  readonly keys: readonly string[];
  readonly differed: readonly ProjectSettingsDifference[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The project-settable settings of one old file, by setting key, as written. */
function projectHeld(document: Record<string, unknown>): Map<string, unknown> {
  const unsettable = new Set(listProjectUnsettableConfigKeys());
  const leaves: Array<{ path: string; value: unknown }> = [];
  collectLeaves(document, '', leaves);
  const held = new Map<string, unknown>();
  for (const leaf of leaves) {
    if (!leaf.path) continue;
    const key = settingFor(leaf.path);
    if (held.has(key) || unsettable.has(key) || key === 'worktree.setup.commands') continue;
    // A key this build does not know is left in the old file, where a program that knows it still reads it.
    const facts = configKeyFacts(key);
    if (!facts.inSchema || !facts.projectSettable || isForeignSecretRef(leaf.value)) continue;
    const found = readDotPath(document, key);
    if (found.present) held.set(key, structuredClone(found.value));
  }
  return held;
}

/** Of two programs' values of one key: the stricter of a protection, else the first (the terminal app's). */
function keep(key: string, first: unknown, second: unknown): { readonly value: unknown; readonly stricter: boolean } {
  const loosens = configKeyFacts(key).loosens;
  if (loosens) {
    const secondLooser = loosens(first, second);
    const firstLooser = loosens(second, first);
    if (secondLooser && !firstLooser) return { value: first, stricter: true };
    if (firstLooser && !secondLooser) return { value: second, stricter: true };
  }
  return { value: first, stricter: false };
}

/**
 * Carries the programs' old project files into the one file, once (see the module header). Nothing happens when the
 * one file exists, or when no old file holds a project setting. Returns what was carried, or undefined. Throws when an
 * old file cannot be read as JSON or the one file cannot be written; the caller reports it and reads what is there.
 */
export function carryProjectSettingsOnce(folder: string): ProjectSettingsCarry | undefined {
  const project = projectIdentityOf(folder);
  const file = join(project, '.goodvibes', 'settings.json');
  if (existsSync(file)) return undefined;
  const byProgram = new Map<string, Map<string, unknown>>();
  for (const root of PROGRAM_PROJECT_SETTINGS_ROOTS) {
    const old = join(project, '.goodvibes', root, 'settings.json');
    if (!existsSync(old)) continue;
    const parsed: unknown = JSON.parse(readFileSync(old, 'utf-8'));
    if (!isPlainObject(parsed)) continue;
    const held = projectHeld(parsed);
    if (held.size > 0) byProgram.set(root, held);
  }
  if (byProgram.size === 0) return undefined;
  const merged: Record<string, unknown> = {};
  const keys = new Set<string>();
  for (const held of byProgram.values()) for (const key of held.keys()) keys.add(key);
  const differed: ProjectSettingsDifference[] = [];
  for (const key of [...keys].sort()) {
    const holders = [...byProgram.entries()].filter(([, held]) => held.has(key)).map(([program, held]) => [program, held.get(key)] as const);
    let kept = holders[0]![1];
    let stricter = false;
    for (const [, value] of holders.slice(1)) {
      const chosen = keep(key, kept, value);
      kept = chosen.value;
      stricter ||= chosen.stricter;
    }
    writeRawDotPath(merged, key, structuredClone(kept));
    if (new Set(holders.map(([, value]) => JSON.stringify(value))).size > 1) {
      differed.push({ key, held: Object.fromEntries(holders), kept, stricter });
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  // `wx`: a program carrying at the same moment wrote it first, and its copy is the same carry.
  try { writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; }
  return { file: resolve(file), carriedFrom: [...byProgram.keys()], keys: [...keys].sort(), differed };
}

const PROGRAM_NAMES: Readonly<Record<string, string>> = { tui: 'the terminal app', agent: 'the Agent', 'daemon-host': 'the daemon' };

/** The one notice the owner reads when the programs' project files set a key differently. */
export function describeProjectSettingsCarry(carry: ProjectSettingsCarry): string {
  const name = (program: string): string => PROGRAM_NAMES[program] ?? program;
  const each = carry.differed.map((difference) => {
    const values = Object.entries(difference.held).map(([program, value]) => `${name(program)} ${JSON.stringify(value)}`).join(', ');
    return `${difference.key} (${values}; kept ${JSON.stringify(difference.kept)}, ${difference.stricter ? 'the stricter' : 'the terminal app\'s'})`;
  });
  return `This project now keeps one settings file for every program, ${carry.file}. Its programs' own files set some keys differently: ${each.join('; ')}. `
    + 'The old files are left as they were.';
}
