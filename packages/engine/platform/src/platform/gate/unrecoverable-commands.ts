/**
 * Shell commands that delete or overwrite something nothing on this machine
 * keeps a copy of, recognised by code from the parsed command, before and
 * regardless of any reading. Pure: no I/O, no model.
 *
 * The exec tool records no undo for what a command does, so a command that
 * removes files, discards uncommitted work, rewrites shared history, wipes a
 * device or drops a database table is a deletion only the owner decides
 * (gate/classify.ts `unrecoverable-delete`). Each rule below names one program
 * and the arguments with which it destroys; a program run under `sudo`, `env`,
 * `xargs`, `nice`, `timeout` and the like is read as itself, and a command
 * string handed to `sh -c`, `bash -c` or `eval`, or written inside `$(...)`,
 * is read as a command too. What these rules do not name stays a judgment,
 * where a confident reading still puts it on the owner's list.
 *
 * Cost per call: one parse of each command string the call carries (the same
 * parser the exec tool uses), only for calls that carry a command.
 */
import { collectCommandNodes, type CommandNode } from '../runtime/permissions/normalization/ast.js';
import { parseCommandAST } from '../runtime/permissions/normalization/parser.js';

/** Programs that run the command after them: `sudo rm -rf x` is `rm -rf x`. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'env', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'ionice', 'command', 'builtin', 'exec', 'xargs', 'chronic', 'unbuffer',
]);
/** The options of a wrapper that take the next word as their value. */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D', '-R']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-a', '-E', '-s', '-i']),
};
/** Shells and `eval`: their command-string argument is itself a command. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Programs whose every run removes or destroys what it names. */
const REMOVERS: ReadonlySet<string> = new Set(['rm', 'unlink', 'shred', 'srm', 'wipe', 'wipefs', 'mkswap', 'blkdiscard']);
/** Database clients whose statement text is read for a drop or truncate. */
const DATABASE_CLIENTS: ReadonlySet<string> = new Set([
  'psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'clickhouse-client', 'cockroach', 'mongo', 'mongosh', 'redis-cli', 'duckdb',
]);
const DATABASE_DESTRUCTION = /\b(?:drop\s+(?:table|database|schema|collection|index|view)|truncate\s+(?:table\s+)?[`"\w]|flushall|flushdb|dropdatabase\s*\(|\.drop\s*\()/i;

const MAX_DEPTH = 4;

/** A token's text as the shell hands it to the program: outer quotes removed. */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

/** The words a command node runs with, redirections and their targets left out. */
function wordsOf(node: CommandNode): { readonly words: string[]; readonly nested: string[] } {
  const words: string[] = [];
  const nested: string[] = [];
  let skipNext = false;
  for (const token of node.tokens) {
    if (skipNext) { skipNext = false; continue; }
    if (token.type === 'redirect') {
      // `>`, `2>` take the next token as their target; `2>&1` and `>file` carry it themselves.
      skipNext = /^[0-9&]*[<>]{1,2}$/.test(token.value);
      continue;
    }
    if (token.type === 'subshell') {
      const inner = token.value.startsWith('$(') ? token.value.slice(2, -1) : token.value.startsWith('`') ? token.value.slice(1, -1) : '';
      if (inner.trim()) nested.push(inner);
      continue;
    }
    words.push(unquote(token.value));
  }
  return { words, nested };
}

const baseName = (word: string): string => (word.slice(word.lastIndexOf('/') + 1)).toLowerCase();
const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** What `git <subcommand> ...` destroys, or undefined. */
function gitDestroys(args: readonly string[]): string | undefined {
  // Global options before the subcommand; -C and -c take a value.
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += args[index] === '-C' || args[index] === '-c' ? 2 : 1;
  const sub = args[index];
  const rest = args.slice(index + 1);
  const has = (...flags: string[]) => rest.some((word) => flags.includes(word));
  const shortFlag = (letter: string) => rest.some((word) => /^-[A-Za-z]+$/.test(word) && word.includes(letter));
  switch (sub) {
    case 'clean':
      return has('-n', '--dry-run') ? undefined : 'git clean deletes untracked files, which git keeps no copy of';
    case 'reset':
      return has('--hard', '--merge', '--keep') ? 'git reset --hard discards uncommitted changes' : undefined;
    case 'checkout':
      return rest.includes('--') || rest.includes('.') || has('-f', '--force') ? 'git checkout over files discards their uncommitted changes' : undefined;
    case 'restore':
      return rest.length > 0 && !(has('--staged', '-S') && !has('--worktree', '-W')) ? 'git restore discards uncommitted changes' : undefined;
    case 'push':
      return has('--force', '-f', '--force-with-lease', '--mirror', '--delete', '-d', '--prune') || shortFlag('f')
        || rest.some((word) => (word.startsWith('+') || word.startsWith(':')) && word.length > 1)
        ? 'a forced or deleting git push overwrites or removes history on the remote' : undefined;
    case 'branch':
      return has('-D') || (has('--delete', '-d') && has('--force', '-f')) ? 'git branch -D deletes a branch whether or not it was merged' : undefined;
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? 'git stash drop or clear deletes stashed changes' : undefined;
    case 'worktree':
      return rest[0] === 'remove' && rest.some((word) => word === '--force' || word === '-f') ? 'git worktree remove --force deletes a worktree with its uncommitted changes' : undefined;
    default:
      return undefined;
  }
}

/** What one program run with these arguments destroys, or undefined. Wrappers, shells and `find -exec` are read by the walker. */
function programDestroys(name: string, args: readonly string[]): string | undefined {
  if (REMOVERS.has(name)) return `${name} deletes what it names, and nothing keeps a copy`;
  if (name.startsWith('mkfs')) return `${name} formats a device, erasing it`;
  if (name === 'dd' && args.some((word) => word.startsWith('of='))) return 'dd writes over its output file or device';
  if (name === 'truncate') return 'truncate cuts a file\'s contents away';
  if (name === 'find' && args.some((word) => word === '-delete')) return 'find -delete deletes every file it matches';
  if (name === 'git') return gitDestroys(args);
  if (name === 'docker' || name === 'podman') {
    if (args[0] === 'volume' && (args[1] === 'rm' || args[1] === 'prune')) return `${name} volume ${args[1]} deletes stored volume data`;
    if (args[0] === 'system' && args[1] === 'prune' && args.includes('--volumes')) return `${name} system prune --volumes deletes stored volume data`;
  }
  if (DATABASE_CLIENTS.has(name) && args.some((word) => DATABASE_DESTRUCTION.test(word))) return `${name} drops or truncates stored data`;
  return undefined;
}

/**
 * Reads one program run by the walker: `visit` answers for the program
 * itself; then the command `find -exec` runs, and the command string a shell
 * or `eval` is handed, are read as commands of their own.
 */
type ProgramVisitor<T> = (name: string, args: readonly string[]) => T | undefined;
/** What the walker answers for a command nested deeper than it reads (`bash -c "bash -c ..."` past the limit). */
type TooDeep<T> = (name: string) => T | undefined;

function walkProgram<T>(name: string, args: readonly string[], depth: number, visit: ProgramVisitor<T>, tooDeep: TooDeep<T>): T | undefined {
  const found = visit(name, args);
  if (found !== undefined) return found;
  if (name === 'find') {
    const exec = args.findIndex((word) => word === '-exec' || word === '-execdir' || word === '-ok' || word === '-okdir');
    if (exec >= 0 && args[exec + 1] !== undefined) return walkProgram(baseName(args[exec + 1]!), args.slice(exec + 2), depth, visit, tooDeep);
  }
  if (SHELLS.has(name) || name === 'eval') {
    const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
    const script = name === 'eval' ? args.join(' ') : flag >= 0 ? args[flag + 1] : undefined;
    if (script !== undefined && script.trim().length > 0) {
      return depth < MAX_DEPTH ? walkCommand(script, depth + 1, visit, tooDeep) : tooDeep(name);
    }
  }
  return undefined;
}

/** One parsed command node: what `$(...)` inside it runs, then its program, read through wrappers. */
function walkNode<T>(node: CommandNode, depth: number, visit: ProgramVisitor<T>, tooDeep: TooDeep<T>): T | undefined {
  const { words, nested } = wordsOf(node);
  for (const inner of nested) {
    const found = depth < MAX_DEPTH ? walkCommand(inner, depth + 1, visit, tooDeep) : undefined;
    if (found !== undefined) return found;
  }
  let index = 0;
  while (index < words.length) {
    while (index < words.length && isAssignment(words[index]!)) index++;
    const name = baseName(words[index] ?? '');
    if (!name) return undefined;
    if (!WRAPPERS.has(name)) return walkProgram(name, words.slice(index + 1), depth, visit, tooDeep);
    // Past the wrapper's own options, their values (and `timeout`'s duration) to the program it runs.
    const valued = WRAPPER_VALUE_FLAGS[name];
    index++;
    while (index < words.length) {
      const word = words[index]!;
      if (valued?.has(word)) { index += 2; continue; }
      if (word.startsWith('-') || isAssignment(word) || (name === 'timeout' && /^[0-9.]+[smhd]?$/.test(word))) { index++; continue; }
      break;
    }
  }
  return undefined;
}

function walkCommand<T>(command: string, depth: number, visit: ProgramVisitor<T>, tooDeep: TooDeep<T>): T | undefined {
  let nodes: CommandNode[];
  try { nodes = collectCommandNodes(parseCommandAST(command)); }
  catch { return undefined; }
  for (const node of nodes) {
    const found = walkNode(node, depth, visit, tooDeep);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The first answer `visit` gives for a program the commands run, read the way
 * the deletion rules read them: through `sudo`, `env`, `xargs`, `timeout` and
 * the other wrappers, into `sh -c` / `eval` command strings, `$(...)` and
 * `find -exec`. `tooDeep` answers for a shell command string nested past the
 * depth the walker reads. One parse of each command string.
 */
export function firstProgramAnswer<T>(commands: readonly string[], visit: ProgramVisitor<T>, tooDeep: TooDeep<T>): T | undefined {
  for (const command of commands) {
    const found = walkCommand(command, 0, visit, tooDeep);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The first destruction the commands carry, in words (`git clean deletes
 * untracked files, which git keeps no copy of`); undefined when none of them
 * is one these rules recognise.
 */
export function unrecoverableDeletionIn(commands: readonly string[]): string | undefined {
  return firstProgramAnswer(commands, programDestroys, (name) => `${name} runs a command nested too deeply to read`);
}

/** An exec file operation that deletes, or overwrites its destination, is a deletion too. */
export function fileOperationDestroys(args: Record<string, unknown>): string | undefined {
  const ops = args['file_ops'];
  if (!Array.isArray(ops)) return undefined;
  for (const op of ops as unknown[]) {
    if (!op || typeof op !== 'object') continue;
    const entry = op as Record<string, unknown>;
    if (entry['op'] === 'delete' && entry['dry_run'] !== true) return 'a file_ops delete removes files with no undo record';
    if ((entry['op'] === 'move' || entry['op'] === 'copy') && entry['overwrite'] === true) return `a file_ops ${String(entry['op'])} with overwrite replaces the destination with no undo record`;
  }
  return undefined;
}
