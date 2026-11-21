/**
 * The one reading of what a shell command runs, shared by every gate rule that
 * looks at programs: the owner's never-run rules (never-run.ts), the
 * unrecoverable deletions (unrecoverable-commands.ts), the recipients of a
 * shell send (send-recipients.ts) and the ask's consequence sentence
 * (permissions/ask-consequence.ts). Each of them is a visitor of the programs
 * this walk finds.
 *
 * What is read:
 * - each command through `sudo`, `env`, `xargs`, `timeout`, `setsid`, `flock`,
 *   `watch`, `systemd-run`, `script -c`, `parallel`, `busybox` and the other
 *   wrappers, their options and the values those options take;
 * - into `sh -c` / `bash -c` / `eval` strings, `env -S` strings, `$(...)` and
 *   backticks, `find -exec`, an `alias` definition;
 * - through the shell's own grouping and keywords: `( ... )`, `{ ...; }`,
 *   `if` / `then` / `else` / `do` / `while` / `until` / `!`, a `case` branch
 *   and a function definition;
 * - a shell script the command runs (`sh tidy.sh`, `bash -o pipefail
 *   tidy.sh`, `./tidy.sh`, `source x.sh`, `bash < tidy.sh`), read from disk
 *   and read as commands when it is shell; a script in another language, and
 *   text the parser cannot read, go to the visitor's `onCode` when it has one.
 *   A relative path is resolved against the working directory as the `cd` and
 *   `pushd` earlier in the same command text left it (`cd scripts &&
 *   ./release.sh` reads `scripts/release.sh`), and `~/` against the home
 *   directory;
 * - quoting removed the way the shell removes it (`g''it`, `"git"`, `g\it`),
 *   with each word marked when the shell builds it as the command runs (a
 *   variable or a substitution in it).
 *
 * A command nested deeper than the walk reads answers `tooDeep`, a script too
 * large to read answers `onScriptTooLarge`, and a script the walk cannot read
 * answers `onUnread`: one that does not exist when the call is judged (the
 * command may write it first) or cannot be opened, one a shell reads from its
 * standard input (`echo ... | sh`, a here-document), and a relative one after
 * a `cd` code cannot follow (`cd "$DIR"`, `cd -`, `popd`). A visitor that must
 * fail closed can. A compiled program is not read: what it runs is its own.
 *
 * Command text the shell builds as the command runs (`bash -c "$CMD"`,
 * `eval "$X"`, `flock -c "$C"`) is still read as written, each variable or
 * substitution in it one built word, so `sh -c "cd $DIR && make"` reads `make`
 * and a variable that is only a `cd` target or an argument stays an argument.
 * When such text leaves the program itself to the variable (`bash -c "$CMD"`),
 * and when the script a shell or `source` is handed is a built path
 * (`sh "$F"`), what runs cannot be known when the call is judged: that answers
 * `onUnread`, naming the text as built when the command runs.
 *
 * Cost: one parse of each command text; per shell script a command runs, one
 * stat and one read of at most 256 KiB, each script once per walk.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { CommandNode, ShellNode } from '../runtime/permissions/normalization/ast.js';
import { parseCommandAST } from '../runtime/permissions/normalization/parser.js';
import type { ShellCommandAt } from '../runtime/permissions/exec-command-text.js';

/** How a wrapper program reads the words after it to find the program it runs. */
interface WrapperSpec {
  /** Options that take the next word as their value. */
  readonly valueFlags?: ReadonlySet<string>;
  /** Options whose value is a command string the wrapper runs (`flock -c`, `script -c`, `env -S`). */
  readonly commandFlags?: ReadonlySet<string>;
  /** Words that are not options and come before the program (`timeout`'s duration, `flock`'s lock file). */
  readonly positionals?: number;
  /** False when the words after the options are not a program (`script` runs only what `-c` names). */
  readonly runsRest?: false;
  /** The program receives arguments the command line does not show (`xargs`, `parallel`). */
  readonly inputArgs?: true;
}

const flags = (...values: string[]): ReadonlySet<string> => new Set(values);

/** Programs that run the command after them: `sudo rm -rf x` is `rm -rf x`. */
const WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map<string, WrapperSpec>([
  ['sudo', { valueFlags: flags('-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D', '-R', '--user', '--group', '--chdir', '--prompt') }],
  ['doas', { valueFlags: flags('-u', '-C') }],
  ['env', { valueFlags: flags('-u', '-C', '--unset', '--chdir'), commandFlags: flags('-S', '--split-string') }],
  ['nice', { valueFlags: flags('-n', '--adjustment') }],
  ['nohup', {}],
  ['time', { valueFlags: flags('-f', '--format', '-o', '--output') }],
  ['timeout', { valueFlags: flags('-s', '-k', '--signal', '--kill-after'), positionals: 1 }],
  ['stdbuf', { valueFlags: flags('-i', '-o', '-e') }],
  ['ionice', { valueFlags: flags('-c', '-n', '-p', '--class', '--classdata') }],
  ['command', {}],
  ['builtin', {}],
  ['exec', { valueFlags: flags('-a') }],
  ['xargs', { valueFlags: flags('-I', '-n', '-P', '-L', '-d', '-a', '-E', '-s', '-i'), inputArgs: true }],
  ['chronic', {}],
  ['unbuffer', {}],
  ['setsid', {}],
  ['flock', { valueFlags: flags('-w', '--wait', '--timeout', '-E', '--conflict-exit-code'), commandFlags: flags('-c', '--command'), positionals: 1 }],
  ['watch', { valueFlags: flags('-n', '--interval') }],
  ['caffeinate', { valueFlags: flags('-w', '-t') }],
  ['systemd-run', {
    valueFlags: flags('-u', '--unit', '-p', '--property', '-M', '--machine', '-H', '--host', '--description', '--slice', '-E', '--setenv',
      '--uid', '--gid', '--nice', '--working-directory', '--on-active', '--on-boot', '--on-startup', '--on-unit-active', '--on-unit-inactive',
      '--on-calendar', '--timer-property', '--path-property', '--socket-property'),
  }],
  ['script', {
    valueFlags: flags('-T', '--log-timing', '-I', '--log-in', '-O', '--log-out', '-B', '--log-io', '-E', '--echo', '-m', '--logging-format', '-o', '--output-limit'),
    commandFlags: flags('-c', '--command'), positionals: 1, runsRest: false,
  }],
  ['parallel', { valueFlags: flags('-j', '--jobs', '-S', '--sshlogin', '--joblog', '-a', '--arg-file'), inputArgs: true }],
  ['busybox', {}],
]);

/** Shells: their `-c` string is a command, and a file they are handed is a script. */
export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);
/** How deeply nested commands are read (`bash -c "bash -c ..."`, scripts that run scripts). */
const MAX_DEPTH = 6;
/** A script larger than this is not read: what it runs cannot be checked. */
const MAX_SCRIPT_BYTES = 256 * 1024;
/** How much of a file is read to tell a script from a compiled program. */
const HEAD_BYTES = 1024;

/** One word of a command as the shell hands it to the program. */
export interface ShellWord {
  /** Its text with quoting removed; a built word keeps what is written (`$X`, `$(printf git)`). */
  readonly text: string;
  /** The shell builds it as the command runs: a variable or a substitution in it. */
  readonly built: boolean;
}

/** One program a command runs, as a visitor sees it. */
export interface ProgramRun {
  /** The program's base name, lowercased (`rm` for `/bin/rm`). */
  readonly name: string;
  /** The program's name is built when the command runs (`$(printf git) push`, `$CMD`). */
  readonly built: boolean;
  /** Its arguments; a built argument keeps its written text. */
  readonly args: readonly string[];
  /** The arguments whose text is known before the command runs, in order. */
  readonly staticArgs: readonly string[];
  /** Some argument is built when the command runs. */
  readonly builtArgs: boolean;
  /** The program receives arguments the command line does not show (under `xargs`, `parallel`, `find -exec`). */
  readonly inputArgs: boolean;
}

/** Answers for one program run; `undefined` lets the walk go on. */
export type ProgramVisitor<T> = (run: ProgramRun) => T | undefined;

export interface CommandWalkOptions<T> {
  /** Where a relative script path is read from; without one only absolute script paths are read. */
  readonly directory: string | undefined;
  /** The answer for a command nested deeper than the walk reads. */
  readonly tooDeep: (name: string) => T | undefined;
  /** The answer for a shell script too large to read. */
  readonly onScriptTooLarge: (path: string) => T | undefined;
  /**
   * The answer for a script a command runs that the walk cannot read, `what`
   * naming it (`the script ./release.sh, which ...`): missing or unreadable when
   * the call is judged, read from a shell's standard input, or relative to a
   * directory only known when the command runs.
   */
  readonly onUnread?: ((what: string) => T | undefined) | undefined;
  /** The answer for code that is not shell (a script in another language, text the parser cannot read). */
  readonly onCode?: ((text: string) => T | undefined) | undefined;
  /** Restates an answer found inside a script a command runs. */
  readonly fromScript?: ((path: string, found: T) => T) | undefined;
  /** False to leave scripts unread (the answer is about the command line alone). */
  readonly readScripts?: boolean | undefined;
}

/** One walk: what it reads shares the scripts it has read, so a script that runs itself is read once. */
export interface CommandWalker<T> {
  /**
   * The first answer for a command text a shell reads, run in `cwd` when the
   * command names its own directory (an exec entry's `cwd`, relative to the
   * walk's directory or absolute), else in the walk's directory.
   */
  command(text: string, cwd?: string | undefined): T | undefined;
  /** The first answer for a program started with this argv, no shell reading it. */
  argv(program: string, args: readonly string[]): T | undefined;
}

/** A word as the shell hands it to a program: quotes and escaping backslashes removed. */
export function shellWord(value: string): string {
  let out = '';
  let quote: '"' | '\'' | undefined;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote === '\'') {
      if (char === '\'') quote = undefined; else out += char;
      continue;
    }
    if (char === '\\') {
      const next = value[index + 1];
      if (next === undefined) { out += char; continue; }
      // Inside double quotes a backslash escapes only `$`, a backtick, `"`, `\` and a newline.
      if (quote === '"' && !'$`"\\\n'.includes(next)) { out += char; continue; }
      index++;
      if (next !== '\n') out += next;
      continue;
    }
    if (char === '"') { quote = quote === '"' ? undefined : '"'; continue; }
    if (char === '\'' && quote === undefined) { quote = '\''; continue; }
    out += char;
  }
  return out;
}

export const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1).toLowerCase();
const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
/** Whether a raw token is expanded when the command runs: a variable or a substitution in it. */
const expandsAtRun = (raw: string): boolean => /\$|`/.test(raw.replace(/'[^']*'/g, ''));

/**
 * The words a command node runs with (redirections and their targets left
 * out), with what `$(...)` inside it runs and the file a `<` redirection hands
 * it as standard input.
 */
function wordsOf(node: CommandNode): { readonly words: ShellWord[]; readonly nested: string[]; readonly input: ShellWord | undefined } {
  const words: ShellWord[] = [];
  const nested: string[] = [];
  let input: ShellWord | undefined;
  let skipNext = false;
  let inputNext = false;
  for (const token of node.tokens) {
    // An unquoted `#` that begins a word starts a comment, which runs to the end of the line (a script's `#!` line too).
    if (!skipNext && token.value.startsWith('#')) break;
    if (skipNext) {
      skipNext = false;
      if (inputNext) input = { text: shellWord(token.value), built: expandsAtRun(token.value) };
      inputNext = false;
      continue;
    }
    if (token.type === 'redirect') {
      // `>`, `2>` take the next token as their target; `2>&1` and `>file` carry it themselves.
      skipNext = /^[0-9&]*[<>]{1,2}$/.test(token.value);
      inputNext = skipNext && /^0?<$/.test(token.value);
      const inline = /^0?<([^<>&].*)$/.exec(token.value)?.[1];
      if (inline !== undefined) input = { text: shellWord(inline), built: expandsAtRun(inline) };
      continue;
    }
    if (token.type === 'subshell') {
      const inner = token.value.startsWith('$(') ? token.value.slice(2, -1) : token.value.startsWith('`') ? token.value.slice(1, -1) : '';
      if (inner.trim()) nested.push(inner);
      words.push({ text: token.value, built: true });
      continue;
    }
    words.push({ text: shellWord(token.value), built: expandsAtRun(token.value) });
  }
  return { words, nested, input };
}

/** Shell words that open or continue a compound command: the words after them are the command that runs. */
const LEADING_KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
/** Shell words that close a compound command: nothing runs. */
const CLOSING_KEYWORDS: ReadonlySet<string> = new Set(['fi', 'done', 'esac', '}']);
/** Loop and case headers: the words after them are not a program (what `$(...)` in them runs is still read). */
const HEADER_KEYWORDS: ReadonlySet<string> = new Set(['for', 'select', 'case']);
/** A `case` branch's pattern (`a)`, `*)`) or a function's name (`f()`) in front of the command it runs. */
const isPatternWord = (text: string): boolean => text.endsWith(')') && !text.includes('/');
/** Shell options that take the next word as their value. */
const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--rcfile', '--init-file']);

/** Where one command text stands while the walk reads it. */
interface Place {
  /** The directory relative paths resolve against; undefined when none was given or a `cd` went where code cannot follow. */
  dir: string | undefined;
  /** For each `( ... )` group the walk is inside, the directory to return to when it ends. */
  readonly groups: Array<string | undefined>;
  /** The text is built when the command runs (a `-c` or `eval` string holding a variable): a built program in it is unknown content. */
  readonly built: boolean;
}

/** What `onUnread` is told for command text built as the command runs. */
const BUILT_COMMAND = 'a command whose text is built when the command runs';

/** What one command runs in. */
interface RunContext {
  readonly place: Place;
  /** A `cd` here does not carry to the commands after it in the same way (a pipeline element, `$(...)`). */
  readonly piped: boolean;
  /** The file a `<` redirection hands the command as standard input. */
  readonly input: ShellWord | undefined;
}

/** A path as the shell resolves it from `dir`: `~/` is the home directory; undefined when it depends on what code cannot know. */
function resolvedPath(path: string, dir: string | undefined): string | undefined {
  if (isAbsolute(path)) return path;
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (path.startsWith('~')) return undefined;
  return dir === undefined ? undefined : resolve(dir, path);
}

/** Where `cd` or `pushd` with these words leaves the shell, or undefined when code cannot follow it. */
function movedTo(name: string, args: readonly ShellWord[], dir: string | undefined): string | undefined {
  const target = args.find((arg) => arg.built || !arg.text.startsWith('-') || arg.text === '-');
  if (target === undefined) return name === 'cd' ? homedir() : undefined;
  if (target.built || target.text === '-' || /^[+-]\d+$/.test(target.text)) return undefined;
  return resolvedPath(target.text, dir);
}

/**
 * Takes the `(` that opens a group off the front of a command's words and the
 * `)` that closes one off its end, recording where each group started. Returns
 * the words and how many groups end with this command.
 */
function ungroup(list: readonly ShellWord[], place: Place): { readonly list: ShellWord[]; readonly closes: number } {
  const out = [...list];
  while (out.length > 0 && !out[0]!.built && out[0]!.text.startsWith('(')) {
    place.groups.push(place.dir);
    const rest = out[0]!.text.slice(1);
    if (rest) out[0] = { text: rest, built: false }; else out.shift();
  }
  let closes = 0;
  while (place.groups.length > closes && out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.built || !last.text.endsWith(')')) break;
    const rest = last.text.slice(0, -1);
    if (rest) out[out.length - 1] = { text: rest, built: false }; else out.pop();
    closes++;
  }
  return { list: out, closes };
}

/** What reading one script found: its text, or why there is none. */
type ScriptRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'seen' | 'program' | 'not-a-file' | 'missing' | 'too-large' };

/** Whether a script reads as shell: a shell shebang, or none. */
function isShellScript(text: string): boolean {
  const first = text.slice(0, 200).split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) return true;
  return [...SHELLS].some((shell) => new RegExp(`(^|[/\\s])${shell}(\\s|$)`).test(first));
}

/** The first bytes of a file, to tell text from a compiled program. */
function headOf(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('latin1');
  } finally {
    closeSync(fd);
  }
}

/** Starts one walk with its own record of the scripts it has read. */
export function commandWalker<T>(visit: ProgramVisitor<T>, options: CommandWalkOptions<T>): CommandWalker<T> {
  const seen = new Set<string>();

  const descend = (name: string, depth: number, next: () => T | undefined): T | undefined =>
    depth >= MAX_DEPTH ? options.tooDeep(name) : next();

  /** Reads one script once per walk; a compiled program, and what is no file, are not scripts. */
  const readScript = (absolute: string): ScriptRead => {
    if (seen.has(absolute)) return { kind: 'seen' };
    seen.add(absolute);
    let size: number;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) return { kind: 'not-a-file' };
      size = stat.size;
    } catch {
      return { kind: 'missing' };
    }
    try {
      // A compiled program is not a script: what it runs is its own.
      if (headOf(absolute).includes('\u0000')) return { kind: 'program' };
      if (size > MAX_SCRIPT_BYTES) return { kind: 'too-large' };
      return { kind: 'text', text: readFileSync(absolute, 'utf8') };
    } catch {
      return { kind: 'missing' };
    }
  };

  /** What a script run from `place` runs; `shared` when it runs in the same shell (`source`), so its `cd` carries on. */
  const script = (path: string, depth: number, place: Place, shared = false): T | undefined => {
    if (options.readScripts === false) return undefined;
    return descend(path, depth, () => {
      const absolute = resolvedPath(path, place.dir);
      if (absolute === undefined) return options.onUnread?.(`the script ${path}, in a directory only known when the command runs`);
      const read = readScript(absolute);
      if (read.kind === 'missing') return options.onUnread?.(`the script ${path}, which could not be read (it may not exist until the command runs)`);
      if (read.kind === 'too-large') return options.onScriptTooLarge(path);
      if (read.kind !== 'text') return undefined;
      const found = isShellScript(read.text)
        ? (shared ? commandIn(read.text, depth + 1, place) : command(read.text, depth + 1, place.dir))
        : options.onCode?.(read.text);
      return found !== undefined && options.fromScript ? options.fromScript(path, found) : found;
    });
  };

  /** A shell started with these words: its `-c` string, the script it is handed, or what it reads from standard input. */
  const shell = (name: string, argWords: readonly ShellWord[], depth: number, ctx: RunContext): T | undefined => {
    let index = 0;
    let commandString = false;
    let stdin = false;
    while (index < argWords.length) {
      const arg = argWords[index]!;
      if (arg.built) break;
      if (arg.text === '--' || arg.text === '-') { stdin ||= arg.text === '-'; index++; break; }
      if (SHELL_VALUE_OPTIONS.has(arg.text)) { index += 2; continue; }
      if (arg.text.startsWith('--')) {
        if (arg.text === '--version' || arg.text === '--help') return undefined;
        index++;
        continue;
      }
      if (/^[-+][A-Za-z]+$/.test(arg.text)) {
        if (arg.text.startsWith('-') && arg.text.includes('c')) commandString = true;
        if (arg.text.startsWith('-') && arg.text.includes('s')) stdin = true;
        // `-o pipefail`, `+O extglob`: the option's value is the next word.
        index += /[oO]$/.test(arg.text) ? 2 : 1;
        continue;
      }
      break;
    }
    const operand = argWords[index];
    if (commandString) {
      return operand !== undefined ? descend(name, depth, () => command(operand.text, depth + 1, ctx.place.dir, operand.built)) : undefined;
    }
    if (stdin || operand === undefined) {
      // No script named: the shell reads its commands from standard input.
      if (ctx.input !== undefined && !ctx.input.built) return script(ctx.input.text, depth, ctx.place);
      return options.onUnread?.('commands a shell reads from its standard input');
    }
    return operand.built ? builtScript(operand.text) : script(operand.text, depth, ctx.place);
  };

  /** A script whose path is built when the command runs: what it runs cannot be known when the call is judged. */
  const builtScript = (path: string): T | undefined =>
    options.readScripts === false ? undefined : options.onUnread?.(`the script ${path}, whose path is built when the command runs`);

  const program = (word: ShellWord, argWords: readonly ShellWord[], inputArgs: boolean, depth: number, ctx: RunContext): T | undefined => {
    const name = baseName(word.text);
    // Inside text built when the command runs, a built program is whatever the variable holds: unknown content.
    if (word.built && ctx.place.built) return options.onUnread?.(BUILT_COMMAND);
    const found = visit({
      name, built: word.built, args: argWords.map((arg) => arg.text),
      staticArgs: argWords.filter((arg) => !arg.built).map((arg) => arg.text),
      builtArgs: argWords.some((arg) => arg.built), inputArgs,
    });
    if (found !== undefined || word.built) return found;
    if (name === 'cd' || name === 'pushd') {
      ctx.place.dir = ctx.piped ? undefined : movedTo(name, argWords, ctx.place.dir);
      return undefined;
    }
    if (name === 'popd') {
      ctx.place.dir = undefined;
      return undefined;
    }
    if (name === 'find') {
      const exec = argWords.findIndex((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg.text));
      if (exec >= 0 && argWords[exec + 1] !== undefined) {
        return descend(name, depth, () => words(argWords.slice(exec + 1), depth + 1, true, { place: ctx.place, piped: true, input: undefined }));
      }
    }
    if (name === 'eval') {
      const text = argWords.map((arg) => arg.text).join(' ');
      if (!argWords.some((arg) => arg.built)) return descend(name, depth, () => commandIn(text, depth + 1, ctx.place));
      // Built text runs in this shell too, so where its `cd` leaves the shell cannot be followed after it.
      const found = descend(name, depth, () => commandIn(text, depth + 1, { dir: ctx.place.dir, groups: [], built: true }));
      ctx.place.dir = undefined;
      return found;
    }
    if (name === 'alias') {
      // `alias p='git push'` defines a name for the command; the definition is read as a command.
      const joined = argWords.filter((arg) => !arg.built).map((arg) => arg.text).join(' ');
      const eq = joined.indexOf('=');
      return eq > 0 ? descend(name, depth, () => command(joined.slice(eq + 1), depth + 1, ctx.place.dir)) : undefined;
    }
    if (name === 'source' || name === '.') {
      const file = argWords[0];
      if (file === undefined) return undefined;
      return file.built ? builtScript(file.text) : script(file.text, depth, ctx.place, true);
    }
    if (SHELLS.has(name)) return shell(name, argWords, depth, ctx);
    // A program named by a path may be a script the model wrote: read what it runs.
    return word.text.includes('/') ? script(word.text, depth, ctx.place) : undefined;
  };

  /** A command's words: past assignments, shell keywords and wrappers to the program they run. */
  const words = (list: readonly ShellWord[], depth: number, inputArgsAtStart: boolean, ctx: RunContext): T | undefined => {
    let index = 0;
    let inputArgs = inputArgsAtStart;
    while (index < list.length) {
      while (index < list.length && isAssignment(list[index]!.text)) index++;
      const word = list[index];
      if (word === undefined) return undefined;
      if (!word.built) {
        if (LEADING_KEYWORDS.has(word.text) || isPatternWord(word.text)) { index++; continue; }
        if (word.text === 'function') { index += 2; continue; }
        if (CLOSING_KEYWORDS.has(word.text) || HEADER_KEYWORDS.has(word.text)) return undefined;
      }
      const spec = word.built ? undefined : WRAPPERS.get(baseName(word.text));
      if (spec === undefined) return program(word, list.slice(index + 1), inputArgs, depth, ctx);
      if (spec.inputArgs) inputArgs = true;
      let positionals = spec.positionals ?? 0;
      index++;
      while (index < list.length) {
        const next = list[index]!;
        if (spec.valueFlags?.has(next.text)) { index += 2; continue; }
        if (spec.commandFlags?.has(next.text)) {
          const text = list[index + 1];
          return text !== undefined ? descend(baseName(word.text), depth, () => command(text.text, depth + 1, ctx.place.dir, text.built)) : undefined;
        }
        if (next.text.startsWith('-') || isAssignment(next.text)) { index++; continue; }
        if (positionals > 0) { positionals--; index++; continue; }
        break;
      }
      if (spec.runsRest === false) return undefined;
    }
    return undefined;
  };

  const node = (parsed: CommandNode, depth: number, place: Place, piped: boolean): T | undefined => {
    const { words: raw, nested, input } = wordsOf(parsed);
    for (const inner of nested) {
      const found = descend('$(...)', depth, () => command(inner, depth + 1, place.dir));
      if (found !== undefined) return found;
    }
    const { list, closes } = ungroup(raw, place);
    const found = words(list, depth, false, { place, piped, input });
    for (let closed = 0; closed < closes; closed++) place.dir = place.groups.pop();
    return found;
  };

  /** The commands of a parsed text in the order the shell runs them, each from where the ones before it left the shell. */
  const tree = (parsed: ShellNode, depth: number, place: Place, piped: boolean): T | undefined => {
    switch (parsed.kind) {
      case 'command': return node(parsed, depth, place, piped);
      case 'pipe': return tree(parsed.left, depth, place, true) ?? tree(parsed.right, depth, place, true);
      case 'sequence': return tree(parsed.left, depth, place, piped) ?? tree(parsed.right, depth, place, piped);
      case 'subshell': return parsed.inner ? tree(parsed.inner, depth, place, true) : undefined;
    }
  };

  /** A command text run in the shell that `place` describes, so its `cd` carries on there. */
  const commandIn = (text: string, depth: number, place: Place): T | undefined => {
    let parsed: ShellNode;
    try { parsed = parseCommandAST(text); }
    catch { return options.onCode?.(text); }
    return tree(parsed, depth, place, false);
  };

  /** A command text run in a shell of its own, starting in `dir`; `built` when the text is built as the command runs. */
  const command = (text: string, depth: number, dir: string | undefined, built = false): T | undefined =>
    commandIn(text, depth, { dir, groups: [], built });

  return {
    command: (text, cwd) => command(text, 0, entryDirectory(cwd, options.directory)),
    argv: (programName, args) => words([programName, ...args].map((text) => ({ text, built: false })), 0, false,
      { place: { dir: options.directory, groups: [], built: false }, piped: false, input: undefined }),
  };
}

/**
 * The directory a command with its own `cwd` runs in, resolved the way the
 * exec tool resolves it: an absolute one as it is, a relative one against the
 * call's directory (unknown when that is), none at all the call's directory.
 */
function entryDirectory(cwd: string | undefined, directory: string | undefined): string | undefined {
  if (cwd === undefined) return directory;
  if (isAbsolute(cwd)) return cwd;
  return directory === undefined ? undefined : resolve(directory, cwd);
}

/** The first answer `visit` gives for a program any of the commands runs, in one walk. */
export function walkCommands<T>(commands: readonly ShellCommandAt[], visit: ProgramVisitor<T>, options: CommandWalkOptions<T>): T | undefined {
  const walker = commandWalker(visit, options);
  for (const entry of commands) {
    const found = walker.command(entry.text, entry.cwd);
    if (found !== undefined) return found;
  }
  return undefined;
}
