import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { MemoryClass, MemoryReviewState, MemoryScope } from '@goodvibes-jev/engine/platform/platform/state';
import { memoryRecordTemporalStatus } from '@goodvibes-jev/engine/platform/platform/state';
import { splitCommandOption } from './cli-arguments.js';

/**
 * How a `/recall` flag takes its value: `word` one word, `text` every word up
 * to the next flag this command knows (so a detail or reason stays whole),
 * `words` the same run kept as separate values, `switch` no value.
 */
export type RecallFlagKind = 'word' | 'text' | 'words' | 'switch';

export interface RecallFlags {
  /** The words that belong to no flag, in order. */
  readonly positional: readonly string[];
  /** Each flag given, by its name (`--detail`), with its value ('' for a switch). */
  readonly values: ReadonlyMap<string, string>;
  /** `words` flags, by name, with their separate values. */
  readonly lists: ReadonlyMap<string, readonly string[]>;
}

/**
 * Read a `/recall` command's words with the one flag grammar of
 * cli-arguments.ts (`--name value` or `--name=value`). A flag the command does
 * not know, or a valued flag with no value, is refused with the reason, never
 * dropped or taken as part of another field.
 */
export function readRecallFlags(
  args: readonly string[],
  spec: Readonly<Record<string, RecallFlagKind>>,
): RecallFlags | { readonly refusal: string } {
  const known = (token: string): boolean => token.startsWith('--') && Object.hasOwn(spec, splitCommandOption(token).name);
  const positional: string[] = [];
  const values = new Map<string, string>();
  const lists = new Map<string, readonly string[]>();
  const options = Object.keys(spec).join(', ');
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const { name, value: inline } = splitCommandOption(token);
    if (!Object.hasOwn(spec, name)) {
      return { refusal: `${name} is not an option of this command (it takes ${options || 'no options'}). Nothing was changed.` };
    }
    const kind = spec[name]!;
    if (kind === 'switch') {
      if (inline !== undefined) return { refusal: `${name} takes no value. Nothing was changed.` };
      values.set(name, '');
      continue;
    }
    const taken: string[] = inline !== undefined ? [inline] : [];
    if (kind === 'word') {
      if (inline === undefined && index + 1 < args.length && !args[index + 1]!.startsWith('--')) taken.push(args[++index]!);
    } else {
      while (index + 1 < args.length && !known(args[index + 1]!)) taken.push(args[++index]!);
    }
    if (taken.join('').trim() === '') {
      return { refusal: `${name} needs a value. Nothing was changed.` };
    }
    if (kind === 'words') {
      const all = [...(lists.get(name) ?? []), ...taken.filter((word) => word.trim() !== '')];
      lists.set(name, all);
      values.set(name, all.join(' '));
      continue;
    }
    if (values.has(name)) return { refusal: `${name} was given twice. Nothing was changed.` };
    values.set(name, taken.join(' '));
  }
  return { positional, values, lists };
}

export const VALID_CLASSES: MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership'];
export const VALID_SCOPES: MemoryScope[] = ['session', 'project', 'team'];
export const VALID_REVIEW_STATES: MemoryReviewState[] = ['fresh', 'reviewed', 'stale', 'contradicted'];

export function isValidClass(s: string): s is MemoryClass {
  return VALID_CLASSES.includes(s as MemoryClass);
}

export function isValidScope(s: string): s is MemoryScope {
  return VALID_SCOPES.includes(s as MemoryScope);
}

export function isValidReviewState(s: string): s is MemoryReviewState {
  return VALID_REVIEW_STATES.includes(s as MemoryReviewState);
}

export function resolveBundlePath(pathArg: string, shellPaths: Pick<ShellPathService, 'resolveWorkspacePath'>): string {
  return shellPaths.resolveWorkspacePath(pathArg);
}

/**
 * The bundle path for a model-run command stays inside the workspace: a model
 * (or text that persuaded it) must not choose where a file is written or read.
 * An owner-typed command may name any path. Undefined means refused.
 */
export function resolveConfinedBundlePath(
  pathArg: string,
  shellPaths: Pick<ShellPathService, 'resolveWorkspacePath' | 'isWithinWorkingDirectory'>,
  invokedByModel: boolean | undefined,
): string | undefined {
  const resolved = resolveBundlePath(pathArg, shellPaths);
  if (invokedByModel === true && !shellPaths.isWithinWorkingDirectory(resolved)) return undefined;
  return resolved;
}

/**
 * Compact inline label for a record's temporal validity window, appended
 * wherever `/recall` lists records, so an out-of-window record is visibly
 * `[pending]`/`[expired]` rather than silently indistinguishable from an
 * always-valid one. Empty string for 'active' (the common case; no window,
 * or currently inside it) so normal listings stay unnoisy.
 */
export function temporalStatusLabel(record: { validFrom?: number | undefined; validUntil?: number | undefined }, now?: number): string {
  const status = memoryRecordTemporalStatus(record, now);
  return status === 'active' ? '' : ` [${status}]`;
}
