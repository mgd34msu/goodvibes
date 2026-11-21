/**
 * Shell commands that delete or overwrite something nothing on this machine
 * keeps a copy of, recognised by code from the parsed command, before and
 * regardless of any reading. No model.
 *
 * The exec tool records no undo for what a command does, so a command that
 * removes files, discards uncommitted work, rewrites shared history, wipes a
 * device or drops a database table is a deletion only the owner decides
 * (gate/classify.ts `unrecoverable-delete`). Each rule below names one program
 * and the arguments with which it destroys. The programs are found by the
 * gate's one command walk (command-walk.ts): through `sudo`, `env`, `xargs`,
 * `setsid`, `flock` and the other wrappers, into `sh -c` / `eval` strings,
 * `$(...)`, `find -exec`, and the shell scripts a command runs. A command
 * nested too deeply to read, or a script too large to read, counts as a
 * deletion, so what code cannot see fails closed. What these rules do not
 * name stays a judgment, where a confident reading still puts it on the
 * owner's list.
 *
 * Cost per call: one parse of each command string the call carries (the same
 * parser the exec tool uses), only for calls that carry a command; per shell
 * script a command runs, one stat and one read of at most 256 KiB.
 */
import { walkCommands } from './command-walk.js';

/** What a call destroys, in words. */
export interface Destruction {
  readonly reason: string;
  /** Code could not read what the command runs (nested too deeply, a script too large); held as a deletion so it fails closed. */
  readonly unread: boolean;
}

/** Programs whose every run removes or destroys what it names. */
const REMOVERS: ReadonlySet<string> = new Set(['rm', 'unlink', 'shred', 'srm', 'wipe', 'wipefs', 'mkswap', 'blkdiscard']);
/** Database clients whose statement text is read for a drop or truncate. */
const DATABASE_CLIENTS: ReadonlySet<string> = new Set([
  'psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'clickhouse-client', 'cockroach', 'mongo', 'mongosh', 'redis-cli', 'duckdb',
]);
const DATABASE_DESTRUCTION = /\b(?:drop\s+(?:table|database|schema|collection|index|view)|truncate\s+(?:table\s+)?[`"\w]|flushall|flushdb|dropdatabase\s*\(|\.drop\s*\()/i;

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

/** What one program run with these arguments destroys, or undefined. Wrappers, shells, scripts and `find -exec` are read by the walk. */
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
 * The first destruction the commands carry (`git clean deletes untracked
 * files, which git keeps no copy of`); undefined when none of them is one
 * these rules recognise. `directory` is where a relative script path is read
 * from.
 */
export function unrecoverableDeletionIn(commands: readonly string[], directory: string | undefined): Destruction | undefined {
  return walkCommands<Destruction>(commands, (run) => {
    const reason = programDestroys(run.name, run.args);
    return reason === undefined ? undefined : { reason, unread: false };
  }, {
    directory,
    tooDeep: (name) => ({ reason: `${name} runs a command nested too deeply to read`, unread: true }),
    onScriptTooLarge: (path) => ({ reason: `it runs the script ${path}, which is too large to read`, unread: true }),
    fromScript: (path, found) => found.unread ? found : { reason: `the script ${path} it runs: ${found.reason}`, unread: false },
  });
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
