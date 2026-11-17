/**
 * What an approval asks the owner to allow: the complete subject of a call,
 * read the way the tool itself reads its arguments. The request analysis, the
 * approval brief and both terminal cards take it from here, so every surface
 * shows the same commands, paths, URLs or tasks, uncut.
 *
 * Only the built-in tools whose argument shape is known name a subject; for
 * any other tool (every MCP tool among them) the subject is the whole argument
 * object, so the model cannot choose what the owner sees by ordering its
 * arguments.
 */
import { execShellCommands } from '../runtime/permissions/exec-command-text.js';
import type { PermissionAnalysisTargetKind } from './types.js';

export interface PermissionSubject {
  readonly kind: PermissionAnalysisTargetKind;
  /** The card label: Command, Path, URL, Task, or Arguments for the whole argument object. */
  readonly label: string;
  /** Every value, in argument order, never cut. */
  readonly values: readonly string[];
}

const LABELS: Readonly<Record<PermissionAnalysisTargetKind, string>> = {
  command: 'Command', path: 'Path', url: 'URL', task: 'Task', generic: 'Arguments',
};

type Args = Record<string, unknown>;

function strings(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const value = entry && typeof entry === 'object' ? (entry as Args)[field] : undefined;
    return typeof value === 'string' ? [value] : [];
  });
}

function keys(args: Args, names: readonly string[]): string[] {
  return names.flatMap((name) => (typeof args[name] === 'string' ? [args[name] as string] : []));
}

const commands = (args: Args): string[] => execShellCommands(args);

function paths(args: Args): string[] {
  const notebook = args['notebook_operations'];
  return [...new Set([
    ...strings(args['files'], 'path'),
    ...strings(args['edits'], 'path'),
    ...(notebook && typeof notebook === 'object' ? keys(notebook as Args, ['path']) : []),
    ...keys(args, ['path', 'file', 'file_path']),
  ])];
}

const urls = (args: Args): string[] => [...strings(args['urls'], 'url'), ...keys(args, ['url', 'endpoint'])];
const tasks = (args: Args): string[] => [...keys(args, ['task']), ...strings(args['tasks'], 'task')];

/** A hook change (the state tool's `hooks` mode, see hook-change-prompt.ts): the command, script, URL or prompt the hook runs. */
function hookChange(args: Args): [PermissionAnalysisTargetKind, string[]] {
  switch (args['hookType']) {
    case 'command': return ['command', keys(args, ['command'])];
    case 'ts': return ['path', keys(args, ['path'])];
    case 'http': return ['url', keys(args, ['url'])];
    default: return ['task', keys(args, ['prompt'])];
  }
}

/** The argument shapes of the built-in tools that carry a subject. */
const SHAPES: Readonly<Record<string, (args: Args) => [PermissionAnalysisTargetKind, string[]] | undefined>> = {
  exec: (args) => ['command', commands(args)],
  read: (args) => ['path', paths(args)],
  write: (args) => ['path', paths(args)],
  edit: (args) => ['path', paths(args)],
  fetch: (args) => ['url', urls(args)],
  agent: (args) => ['task', tasks(args)],
  delegate: (args) => ['task', tasks(args)],
  state: (args) => (args['mode'] === 'hooks' ? hookChange(args) : undefined),
};

/** The complete subject of a call: what the owner is asked to allow. */
export function permissionSubject(tool: string, args: Record<string, unknown> | undefined): PermissionSubject {
  const input = args ?? {};
  const shaped = SHAPES[tool]?.(input);
  if (shaped && shaped[1].length > 0) return { kind: shaped[0], label: LABELS[shaped[0]], values: shaped[1] };
  return { kind: 'generic', label: LABELS.generic, values: [JSON.stringify(input)] };
}

/** Where an exec call runs and what environment it adds, read the way the exec tool reads its input. */
export interface ExecRunPlace {
  /**
   * The directory the call names for itself: the top-level `working_dir`, or
   * a single command's own `working_dir`/`cwd`, which the exec tool promotes.
   * Undefined when the call names none and runs in the session's directory.
   */
  readonly workingDirectory: string | undefined;
  /**
   * One line per command that runs somewhere else (its `cwd` or `working_dir`,
   * relative to the call's directory) or adds environment variables. Only the
   * variable names are given: a value can be a secret.
   */
  readonly commandLines: readonly string[];
}

/** The directories and environment variables of an exec call, so an owner approves the place a command runs, not only its text. */
export function execRunPlace(args: Record<string, unknown> | undefined): ExecRunPlace {
  const input = args ?? {};
  const list: unknown[] = Array.isArray(input['commands']) ? input['commands'] : [];
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const top = text(input['working_dir']);
  const only = list.length === 1 && list[0] && typeof list[0] === 'object' ? list[0] as Args : undefined;
  const promoted = top === undefined && only ? text(only['working_dir']) ?? text(only['cwd']) : undefined;
  const commandLines = list.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const command = entry as Args;
    // A command's own `cwd` wins over its `working_dir`; a single command's directory promoted to the call's is not repeated.
    const own = text(command['cwd']) ?? text(command['working_dir']);
    const directory = own !== undefined && !(command === only && own === promoted) ? own : undefined;
    const env = command['env'];
    const names = env && typeof env === 'object' && !Array.isArray(env) ? Object.keys(env as Args) : [];
    const parts = [...(directory ? [`runs in ${directory}`] : []), ...(names.length > 0 ? [`sets ${names.join(', ')}`] : [])];
    return parts.length > 0 ? [`command ${index + 1}: ${parts.join('; ')}`] : [];
  });
  return { workingDirectory: top ?? promoted, commandLines };
}

/** One line per host-side file operation of an exec call (`file_ops`): what will be copied, moved or deleted. */
export function execFileOperationLines(args: Record<string, unknown> | undefined): string[] {
  const ops = args?.['file_ops'];
  if (!Array.isArray(ops)) return [];
  return ops.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const op = entry as Args;
    const source = typeof op['source'] === 'string' ? op['source'] : '?';
    const destination = typeof op['destination'] === 'string' ? ` -> ${op['destination']}` : '';
    const flags = [op['recursive'] === true ? 'recursive' : '', op['overwrite'] === true ? 'overwrite' : ''].filter(Boolean).join(', ');
    return [`${typeof op['op'] === 'string' ? op['op'] : 'file operation'} ${source}${destination}${flags ? ` (${flags})` : ''}`];
  });
}
