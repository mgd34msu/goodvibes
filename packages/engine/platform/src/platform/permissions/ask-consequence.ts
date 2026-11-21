/**
 * The consequence sentence of an ask, from facts only (design 3.3): what the
 * call does, how far it reaches, and whether it can be undone. A part with no
 * fact behind it is left out, never guessed. It describes; whether the call is
 * allowed stays the gate's and Jev's reading's.
 *
 * Facts it reads, in order:
 *  1. What it does: a small table of commands whose effect the shell parser can
 *     state from their arguments (test runners, rm, git reset --hard, git
 *     clean, git push --force); otherwise the plain sentence for the risk
 *     family Jev read; otherwise nothing.
 *  2. Reach: the exec sandbox's own boundary (only the working folder
 *     writable); else Jev's confident `beyondProject` reading; else nothing.
 *  3. Undo: code that recognises an unrecoverable deletion
 *     (gate/unrecoverable-commands.ts) or a tool's declared irreversible
 *     operator act, or Jev's confident `irreversible` reading (an uncertain
 *     reading is never taken as true here, though the gate takes it as true
 *     for its decision). Then "GoodVibes keeps no copy." unless the workspace
 *     checkpoint covers every path the call names.
 *  4. Without a reading, nothing is marked as unable to be undone unless code
 *     recognised it, and the details say it was not checked.
 *
 * Cost: one parse of each command string the call carries; for the undo
 * fact, one stat and read per shell script a command runs (the same reading
 * of commands the gate makes, gate/command-walk.ts).
 */
import { basename } from 'node:path';
import { unrecoverableDeletionIn, fileOperationDestroys } from '../gate/unrecoverable-commands.js';
import { walkCommands } from '../gate/command-walk.js';
import { splitShellCommand, extractCommandArgs } from '../runtime/permissions/rules/prefix.js';
import { execShellCommandsAt } from '../runtime/permissions/exec-command-text.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import type { GateRiskFamily } from '../gate/batteries/risk-family.js';
import type { GateFactName } from '../gate/reading.js';
import type { OwnerOnlyKind } from '../gate/classify.js';
import type { GateReadingRecord } from './types.js';

/** One fact of Jev's reading: `yes` and `no` only when the reading was confident. */
export type ReadingAnswer = 'yes' | 'no' | 'uncertain';

/** A fact of the reading, or undefined when the call was not read. */
export function readingAnswer(reading: GateReadingRecord | undefined, fact: GateFactName): ReadingAnswer | undefined {
  if (!reading) return undefined;
  if (reading.uncertain.includes(fact)) return 'uncertain';
  return reading.facts[fact] ? 'yes' : 'no';
}

/** One plain sentence per risk family Jev reads (gate/batteries/risk-family.ts RISK_FAMILY_OPTIONS). */
export const FAMILY_SENTENCES: Readonly<Record<GateRiskFamily, string | undefined>> = {
  delegation: 'Hands work to an agent that is already running.',
  'shell-read': 'Only reads.',
  'shell-mutation': 'Changes files.',
  'shell-destructive': 'Deletes or overwrites data.',
  'dependency-install': 'Installs packages.',
  'file-mutation': 'Changes files.',
  'config-mutation': 'Changes configuration.',
  'notebook-edit': 'Edits a notebook.',
  'network-egress': 'Reaches the internet.',
  'remote-dispatch': 'Runs work on another machine.',
  'agent-spawn': 'Starts a new agent.',
  'sandbox-policy-change': 'Changes what the sandbox allows.',
  'mcp-escalation': 'Gives a tool server more trust.',
  'plugin-lifecycle': 'Installs or changes a plugin, skill or hook.',
  'hook-execution': 'Sets up something that runs later by itself.',
  // Nothing honest to say about "none of the above".
  generic: undefined,
};

/** Families whose sentence describes work in the folder, so the folder can be named in it ("Changes files in garden-planner."). */
const LOCAL_FAMILIES: ReadonlySet<GateRiskFamily> = new Set(['shell-read', 'shell-mutation', 'file-mutation', 'dependency-install', 'notebook-edit', 'config-mutation']);

/** What one simple command does, stated from its arguments. */
export interface CommandEffect {
  readonly sentence: string;
  /** The ask's question when this command cannot be undone ("Delete files? This can't be undone."). */
  readonly undoQuestion?: string | undefined;
  /** The paths it removes, for the checkpoint check. */
  readonly paths?: readonly string[] | undefined;
  /** Whether the place the command runs in may be folded into the sentence ("Runs your tests in garden-planner."). */
  readonly foldsPlace: boolean;
}

const TEST_RUNNERS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  bun: [['test']], npm: [['test'], ['run', 'test'], ['t']], pnpm: [['test'], ['run', 'test']], yarn: [['test'], ['run', 'test']],
  pytest: [[]], cargo: [['test']], go: [['test']], deno: [['test']], vitest: [[]], jest: [[]],
};

function startsWith(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, index) => args[index] === word);
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The effect of one program run, from the table; undefined when the table does not name it. */
function programEffect(name: string, args: readonly string[]): CommandEffect | undefined {
  const runner = TEST_RUNNERS[name];
  if (runner && runner.some((prefix) => startsWith(args, prefix))) return { sentence: 'Runs your tests.', foldsPlace: true };
  if (name === 'rm') {
    const flags = args.filter((word) => word.startsWith('-') && word !== '--');
    const targets = args.filter((word) => !word.startsWith('-') || word === '-');
    if (targets.length === 0) return undefined;
    const recursive = flags.some((flag) => flag === '--recursive' || (/^-[A-Za-z]+$/.test(flag) && /[rR]/.test(flag)));
    const names = listWords(targets);
    return recursive
      ? { sentence: targets.length === 1 ? `Removes the folder ${names} and everything in it.` : `Removes the folders ${names} and everything in them.`,
        undoQuestion: 'Delete files?', paths: targets, foldsPlace: false }
      : { sentence: `Removes ${names}.`, undoQuestion: 'Delete files?', paths: targets, foldsPlace: false };
  }
  if (name === 'git') {
    let index = 0;
    while (index < args.length && args[index]!.startsWith('-')) index += args[index] === '-C' || args[index] === '-c' ? 2 : 1;
    const sub = args[index];
    const rest = args.slice(index + 1);
    const has = (...flags: string[]): boolean => rest.some((word) => flags.includes(word));
    const shortFlag = (letter: string): boolean => rest.some((word) => /^-[A-Za-z]+$/.test(word) && word.includes(letter));
    if (sub === 'reset' && has('--hard')) return { sentence: 'Throws away your uncommitted changes.', foldsPlace: false };
    if (sub === 'clean' && (has('--force') || shortFlag('f')) && !has('-n', '--dry-run')) return { sentence: 'Deletes files Git doesn\'t track.', foldsPlace: false };
    if (sub === 'push' && (has('--force', '--force-with-lease') || shortFlag('f'))) {
      const remote = rest.find((word) => !word.startsWith('-'));
      return { sentence: `Replaces the branch on ${remote ?? 'the remote'} with yours.`, foldsPlace: false };
    }
  }
  return undefined;
}

/**
 * The table's effect of a command the shell parser reads as one program (no
 * pipe, list or substitution), read through wrappers like `sudo` and `env`;
 * undefined for anything else.
 */
export function commandEffect(command: string): CommandEffect | undefined {
  const split = splitShellCommand(command);
  if (split.opaque || split.segments.length !== 1) return undefined;
  // The sentence is about the command line itself: a script it runs is not read for it.
  return walkCommands<CommandEffect>([{ text: command }], (run) => programEffect(run.name, run.args), {
    directory: undefined, tooDeep: () => undefined, onScriptTooLarge: () => undefined, readScripts: false,
  });
}

/**
 * Why code alone says a call cannot be undone, or undefined. Never an unread or
 * uncertain guess. `directory` is where a relative script path is read from.
 */
export function codeUndoFact(toolName: string, args: Record<string, unknown>, ownerOnly: OwnerOnlyKind | undefined,
  directory: string | undefined): string | undefined {
  // A tool that declares the operator act irreversible is the tool's own fact.
  if (ownerOnly === 'irreversible-operator') return 'the tool declares this cannot be undone';
  const listed = execShellCommandsAt(args);
  const commands = listed.length > 0 ? listed : extractCommandArgs(args).map((text) => ({ text }));
  const destroys = commands.length > 0 ? unrecoverableDeletionIn(commands, directory) : undefined;
  // What code could not read is not known to destroy anything; the gate asks, but nothing is claimed.
  if (destroys !== undefined && !destroys.unread) return destroys.reason;
  return toolName === 'exec' ? fileOperationDestroys(args) : undefined;
}

/** Whether the call cannot be undone, and how that is known. */
export type UndoFact =
  | { readonly cannotUndo: true; readonly by: 'code' | 'reading'; readonly paths: readonly string[] }
  | { readonly cannotUndo: false; readonly checked: boolean };

/**
 * Whether a call cannot be undone, from code or a confident reading. The gate
 * offers no remembering for such a call (permissions/manager.ts askOwner) and
 * every surface marks it red; nothing else is.
 */
export function undoFactOf(toolName: string, args: Record<string, unknown>, reading: GateReadingRecord | undefined,
  ownerOnly: OwnerOnlyKind | undefined, directory: string | undefined): UndoFact {
  const commands = extractCommandArgs(args);
  const effectPaths = commands.length === 1 ? commandEffect(commands[0]!)?.paths : undefined;
  const paths = effectPaths ?? extractPathArgs(args);
  if (codeUndoFact(toolName, args, ownerOnly, directory) !== undefined) return { cannotUndo: true, by: 'code', paths };
  if (readingAnswer(reading, 'irreversible') === 'yes') return { cannotUndo: true, by: 'reading', paths };
  return { cannotUndo: false, checked: reading !== undefined };
}

/** The sandbox an exec call runs in, as the exec sandbox reports it. */
export interface SandboxFact {
  readonly enforced: boolean;
  readonly writableRoots: readonly string[];
  readonly network: boolean;
}

export interface ConsequenceInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly reading: GateReadingRecord | undefined;
  readonly undo: UndoFact;
  readonly workingDirectory?: string | undefined;
  /** The folder's short name, folded into the web form ("in garden-planner"). */
  readonly placeShort?: string | undefined;
  readonly sandbox?: SandboxFact | undefined;
  readonly checkpointCovers?: ((path: string) => boolean) | undefined;
  /** For a fetch: the hosts it reaches. */
  readonly hosts?: readonly string[] | undefined;
  /** The reading says the call weakens a safety setting (a settings change). */
  readonly weakensSetting?: boolean | undefined;
}

/** The consequence: the terminal's sentence, the web form with the place folded in, and its tone. */
export interface Consequence {
  readonly text: string;
  readonly withPlace: string;
  readonly tone: 'plain' | 'cannot-undo';
}

function inside(path: string, root: string): boolean {
  const normal = root.endsWith('/') ? root : `${root}/`;
  return path === root || path.startsWith(normal);
}

/** The consequence of a call, or undefined when no fact gives one. */
export function composeConsequence(input: ConsequenceInput): Consequence | undefined {
  const commands = input.toolName === 'exec' ? extractCommandArgs(input.args) : [];
  const effect = commands.length === 1 ? commandEffect(commands[0]!) : undefined;
  const what = effect?.sentence
    ?? (input.weakensSetting ? 'This weakens a safety setting.' : undefined)
    ?? (input.reading ? FAMILY_SENTENCES[input.reading.family] : undefined);
  const beyond = readingAnswer(input.reading, 'beyondProject');
  // The folder is named in the first sentence only for work in it, never beside a reach beyond it.
  const folds = what !== undefined && input.placeShort !== undefined && beyond !== 'yes'
    && (effect !== undefined ? effect.foldsPlace : !input.weakensSetting && input.reading !== undefined && LOCAL_FAMILIES.has(input.reading.family));
  const target = folds ? 'it' : input.placeShort ?? 'this folder';

  // Reach.
  let reach: string | undefined;
  let reachWeb: string | undefined;
  if (input.hosts && input.hosts.length > 0) {
    reach = reachWeb = `Sends a request to ${listWords(input.hosts)}.`;
  } else if (input.toolName === 'exec') {
    const sandbox = input.sandbox;
    const folder = input.workingDirectory;
    const contained = sandbox?.enforced === true && folder !== undefined && sandbox.writableRoots.length > 0
      && sandbox.writableRoots.every((root) => inside(root, folder));
    if (contained) { reach = 'Changes no files outside this folder.'; reachWeb = `Changes no files outside ${target}.`; }
    else if (beyond === 'no') { reach = 'Should change nothing outside this folder.'; reachWeb = `Should change nothing outside ${target}.`; }
    else if (beyond === 'yes') { reach = 'Reaches beyond this folder.'; reachWeb = `Reaches beyond ${target}.`; }
  } else if (beyond === 'yes') {
    reach = 'Reaches beyond this folder.'; reachWeb = `Reaches beyond ${target}.`;
  }

  // Undo.
  let undo: string | undefined;
  if (input.undo.cannotUndo) {
    const covered = input.undo.paths.length > 0 && input.checkpointCovers !== undefined
      && input.undo.paths.every((path) => input.checkpointCovers!(path));
    undo = covered ? 'You can get it back with /checkpoint restore.' : 'GoodVibes keeps no copy.';
  }

  const terminal = [what, reach, undo].filter((part): part is string => part !== undefined);
  if (terminal.length === 0) return undefined;
  const webWhat = what !== undefined && folds ? what.replace(/\.$/, ` in ${input.placeShort}.`) : what;
  const web = [webWhat, reachWeb, undo].filter((part): part is string => part !== undefined);
  return { text: terminal.join(' '), withPlace: web.join(' '), tone: input.undo.cannotUndo ? 'cannot-undo' : 'plain' };
}

/** "sample-app" for /home/sam/projects/sample-app. */
export function folderName(path: string): string {
  return basename(path.replace(/\/+$/, '')) || path;
}
