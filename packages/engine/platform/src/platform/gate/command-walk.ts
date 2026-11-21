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
 * - a shell script the command runs (`sh tidy.sh`, `./tidy.sh`,
 *   `source x.sh`), read from disk relative to the working directory, and
 *   read as commands when it is shell; a script in another language, and text
 *   the parser cannot read, go to the visitor's `onCode` when it has one;
 * - quoting removed the way the shell removes it (`g''it`, `"git"`, `g\it`),
 *   with each word marked when the shell builds it as the command runs (a
 *   variable or a substitution in it).
 *
 * A command nested deeper than the walk reads answers `tooDeep`, and a script
 * too large to read answers `onScriptTooLarge`, so a visitor that must fail
 * closed can.
 *
 * Cost: one parse of each command text; per shell script a command runs, one
 * stat and one read of at most 256 KiB, each script once per walk.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { collectCommandNodes, type CommandNode } from '../runtime/permissions/normalization/ast.js';
import { parseCommandAST } from '../runtime/permissions/normalization/parser.js';

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
  /** The answer for code that is not shell (a script in another language, text the parser cannot read). */
  readonly onCode?: ((text: string) => T | undefined) | undefined;
  /** Restates an answer found inside a script a command runs. */
  readonly fromScript?: ((path: string, found: T) => T) | undefined;
  /** False to leave scripts unread (the answer is about the command line alone). */
  readonly readScripts?: boolean | undefined;
}

/** One walk: what it reads shares the scripts it has read, so a script that runs itself is read once. */
export interface CommandWalker<T> {
  /** The first answer for a command text a shell reads. */
  command(text: string): T | undefined;
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

/** The words a command node runs with (redirections and their targets left out), with what `$(...)` inside it runs. */
function wordsOf(node: CommandNode): { readonly words: ShellWord[]; readonly nested: string[] } {
  const words: ShellWord[] = [];
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
      words.push({ text: token.value, built: true });
      continue;
    }
    words.push({ text: shellWord(token.value), built: expandsAtRun(token.value) });
  }
  return { words, nested };
}

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

  /** A script's text: undefined when it is no readable text file (or was read on this walk), null when too large to read. */
  const readScript = (path: string): string | null | undefined => {
    const absolute = isAbsolute(path) ? path : options.directory ? resolve(options.directory, path) : undefined;
    if (absolute === undefined || seen.has(absolute)) return undefined;
    seen.add(absolute);
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) return undefined;
      // A compiled program is not a script: what it runs is its own.
      if (headOf(absolute).includes('\u0000')) return undefined;
      if (stat.size > MAX_SCRIPT_BYTES) return null;
      return readFileSync(absolute, 'utf8');
    } catch {
      return undefined;
    }
  };

  const script = (path: string, depth: number): T | undefined => {
    if (options.readScripts === false) return undefined;
    return descend(path, depth, () => {
      const text = readScript(path);
      if (text === undefined) return undefined;
      if (text === null) return options.onScriptTooLarge(path);
      const found = isShellScript(text) ? command(text, depth + 1) : options.onCode?.(text);
      return found !== undefined && options.fromScript ? options.fromScript(path, found) : found;
    });
  };

  const program = (word: ShellWord, argWords: readonly ShellWord[], inputArgs: boolean, depth: number): T | undefined => {
    const name = baseName(word.text);
    const found = visit({
      name, built: word.built, args: argWords.map((arg) => arg.text),
      staticArgs: argWords.filter((arg) => !arg.built).map((arg) => arg.text),
      builtArgs: argWords.some((arg) => arg.built), inputArgs,
    });
    if (found !== undefined || word.built) return found;
    if (name === 'find') {
      const exec = argWords.findIndex((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg.text));
      if (exec >= 0 && argWords[exec + 1] !== undefined) return descend(name, depth, () => words(argWords.slice(exec + 1), depth + 1, true));
    }
    if (name === 'eval') {
      return descend(name, depth, () => command(argWords.filter((arg) => !arg.built).map((arg) => arg.text).join(' '), depth + 1));
    }
    if (name === 'alias') {
      // `alias p='git push'` defines a name for the command; the definition is read as a command.
      const joined = argWords.filter((arg) => !arg.built).map((arg) => arg.text).join(' ');
      const eq = joined.indexOf('=');
      return eq > 0 ? descend(name, depth, () => command(joined.slice(eq + 1), depth + 1)) : undefined;
    }
    if (name === 'source' || name === '.') {
      const file = argWords[0];
      return file !== undefined && !file.built ? script(file.text, depth) : undefined;
    }
    if (SHELLS.has(name)) {
      const flag = argWords.findIndex((arg) => !arg.built && /^-[a-z]*c[a-z]*$/.test(arg.text));
      if (flag >= 0) {
        const text = argWords[flag + 1];
        return text !== undefined && !text.built ? descend(name, depth, () => command(text.text, depth + 1)) : undefined;
      }
      const file = argWords.find((arg) => !arg.text.startsWith('-'));
      return file !== undefined && !file.built ? script(file.text, depth) : undefined;
    }
    // A program named by a path may be a script the model wrote: read what it runs.
    return word.text.includes('/') ? script(word.text, depth) : undefined;
  };

  /** A command's words: past assignments and wrappers to the program they run. */
  const words = (list: readonly ShellWord[], depth: number, inputArgsAtStart: boolean): T | undefined => {
    let index = 0;
    let inputArgs = inputArgsAtStart;
    while (index < list.length) {
      while (index < list.length && isAssignment(list[index]!.text)) index++;
      const word = list[index];
      if (word === undefined) return undefined;
      const spec = word.built ? undefined : WRAPPERS.get(baseName(word.text));
      if (spec === undefined) return program(word, list.slice(index + 1), inputArgs, depth);
      if (spec.inputArgs) inputArgs = true;
      let positionals = spec.positionals ?? 0;
      index++;
      while (index < list.length) {
        const next = list[index]!;
        if (spec.valueFlags?.has(next.text)) { index += 2; continue; }
        if (spec.commandFlags?.has(next.text)) {
          const text = list[index + 1];
          return text !== undefined && !text.built ? descend(baseName(word.text), depth, () => command(text.text, depth + 1)) : undefined;
        }
        if (next.text.startsWith('-') || isAssignment(next.text)) { index++; continue; }
        if (positionals > 0) { positionals--; index++; continue; }
        break;
      }
      if (spec.runsRest === false) return undefined;
    }
    return undefined;
  };

  const node = (parsed: CommandNode, depth: number): T | undefined => {
    const { words: list, nested } = wordsOf(parsed);
    for (const inner of nested) {
      const found = descend('$(...)', depth, () => command(inner, depth + 1));
      if (found !== undefined) return found;
    }
    return words(list, depth, false);
  };

  const command = (text: string, depth: number): T | undefined => {
    let nodes: CommandNode[];
    try { nodes = collectCommandNodes(parseCommandAST(text)); }
    catch { return options.onCode?.(text); }
    for (const parsed of nodes) {
      const found = node(parsed, depth);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return {
    command: (text) => command(text, 0),
    argv: (programName, args) => words([programName, ...args].map((text) => ({ text, built: false })), 0, false),
  };
}

/** The first answer `visit` gives for a program any of the commands runs, in one walk. */
export function walkCommands<T>(commands: readonly string[], visit: ProgramVisitor<T>, options: CommandWalkOptions<T>): T | undefined {
  const walker = commandWalker(visit, options);
  for (const text of commands) {
    const found = walker.command(text);
    if (found !== undefined) return found;
  }
  return undefined;
}
