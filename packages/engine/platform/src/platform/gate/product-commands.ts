/**
 * product-commands.ts, a model's command that reaches past the gate through GoodVibes itself: one that runs one of the
 * product's own programs to change something (`goodvibes do`, `goodvibes-agent find`, `goodvibes-daemon` with any
 * subcommand but help and version), or that reads or writes the files under the GoodVibes home (the operator token, the
 * settings, the secret stores, the permission rules). Either can loosen a protection without the owner's yes: the
 * program speaks to the daemon with the owner's own credential, and the files hold that credential and the rules. The
 * gate classes such a command as one that loosens a protection (gate/classify.ts `recognizeOwnerOnly`): put to the
 * owner, opening on No, in every mode but YOLO.
 *
 * Decided by what a command RESOLVES to, not by its words:
 * - every path-like word is read as the shell would expand it (`~`, `~user`, `$HOME`, `${HOME}`, quotes joined, a
 *   relative path after an earlier `cd`) and then where it really is (a link, `/proc/self/root`), through the probe the
 *   caller hands in; a glob whose fixed part holds a GoodVibes home counts;
 * - the program in command position is resolved the same way (a link named `gv` to `goodvibes` is `goodvibes`);
 * - a command it cannot resolve because of indirection reaching it counts, when in doubt: a variable or substitution in
 *   command position, `eval`, a shell handed a script on standard input, `at`/`batch`/`crontab`/`systemd-run`, unsetting
 *   the model's mark (`env -u`, `unset`), inline interpreter code (`python -c`, `node -e`), a script file it cannot
 *   read; and what `xargs`, `find -exec`, `sh -c`, `script -c`, a launcher (`nohup`, `setsid`, `timeout`, ...), a shell
 *   script file or `source` runs is read in turn, a few levels deep (deeper counts).
 *
 * Pure: the GoodVibes homes, the person's home and the file-system probe are handed in by the caller (the permission
 * manager), never read from the environment here.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { splitShellCommand } from '../runtime/permissions/rules/prefix.js';
import type { ShellCommandAt } from '../runtime/permissions/exec-command-text.js';

/** What the caller lets the classifier read of the file system, and the person's home. Each part optional. */
export interface ProductReachProbe {
  /** Where a path really is (links followed, `/proc/self/root` included); the path itself when it cannot be read. */
  readonly realPath?: ((path: string) => string) | undefined;
  /** A script file's text, bounded; undefined when it cannot be read or is not a file. */
  readonly readText?: ((path: string) => string | undefined) | undefined;
  /** The person's login home: what `~` and `$HOME` expand to. */
  readonly home?: string | undefined;
}

/** The product's own programs, by the names they are installed under. */
const PRODUCT_PROGRAMS: ReadonlySet<string> = new Set(['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']);
/** The only words after a product program that change nothing. */
const READ_ONLY_WORDS: ReadonlySet<string> = new Set(['help', '--help', '-h', 'version', '--version', '-v', '-V']);
/** Words that start another program in front of the one that runs (their options skipped). */
const LAUNCHERS: ReadonlySet<string> = new Set(['env', 'exec', 'nohup', 'command', 'time', 'nice', 'ionice', 'sudo', 'doas', 'setsid', 'stdbuf', 'timeout', 'chrt', 'taskset', 'unbuffer', 'builtin', 'then', 'do', 'else', '!']);
/** Programs that run a command later or elsewhere by themselves: what they run is never read here. */
const SCHEDULERS: ReadonlySet<string> = new Set(['at', 'batch', 'crontab', 'systemd-run', 'launchctl', 'schtasks', 'eval', 'expect']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'ash', 'busybox']);
const INTERPRETERS: ReadonlySet<string> = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'bun', 'deno', 'perl', 'ruby', 'php', 'lua', 'osascript', 'pwsh', 'powershell', 'tclsh', 'Rscript', 'julia', 'awk', 'gawk']);
/** The model's command mark (tools/exec/model-command-mark.ts): a command that clears it is reaching for the person's claim. */
const MODEL_MARK = 'GOODVIBES_COMMAND_FROM_MODEL';
/** How a command may name the GoodVibes home without spelling its directory. */
const HOME_VARIABLES = /\$\{?GOODVIBES_(?:DAEMON_)?HOME\}?/;
/** Deeper than this, a command that runs another is taken as reaching (fails closed). */
const MAX_DEPTH = 4;

interface Reach {
  readonly homes: readonly string[];
  readonly probe: ProductReachProbe;
}

/** A word as the shell would hand it over: quotes joined and removed, backslashes taken off. */
function shellWord(word: string): string {
  return word.replace(/\\(.)/g, '$1').replace(/'([^']*)'/g, '$1').replace(/"([^"]*)"/g, '$1');
}

/** The words of one shell segment: split on blanks, quoted runs kept together, then joined and unquoted. */
function wordsOf(segment: string): string[] {
  return (segment.match(/(?:"[^"]*"|'[^']*'|\\.|[^\s'"\\])+/g) ?? []).map(shellWord);
}

function inside(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** A word as a path, the way the shell expands it: `~`, `~user`, `$HOME`, `${HOME}`, then against `cwd`. */
function expandedPaths(raw: string, cwd: string | undefined, probe: ProductReachProbe): string[] {
  // A redirection's target is a path too.
  const word = raw.replace(/^\d*[<>]+&?/, '');
  if (word === '') return [];
  const home = probe.home;
  let text = word.replace(/\$\{HOME\}|\$HOME\b/g, home ?? '\u0000');
  if (text.includes('\u0000')) return [];
  const candidates: string[] = [];
  const tilde = /^~([A-Za-z0-9._-]*)(\/.*)?$/.exec(text);
  if (tilde) {
    const user = tilde[1]!;
    const rest = tilde[2] ?? '';
    if (user === '') { if (home) candidates.push(`${home}${rest}`); }
    else {
      // Someone's home: where home folders are kept here, and the usual places.
      for (const base of [home ? dirname(home) : undefined, '/home', '/Users', '/var/home'].filter((entry): entry is string => !!entry)) {
        candidates.push(join(base, user) + rest);
      }
      if (user === 'root') candidates.push(`/root${rest}`);
    }
    return candidates;
  }
  if (isAbsolute(text)) return [text];
  if (cwd === undefined) return [];
  text = resolve(cwd, text);
  return [text];
}

/** Whether a path, as given and as it really is, is a GoodVibes home or inside one, or a glob over one. */
function pathReaches(path: string, reach: Reach): boolean {
  const glob = /[*?[]/.exec(path);
  if (glob) {
    // The fixed part before the glob: a home inside it can be matched.
    const fixed = path.slice(0, glob.index);
    const base = fixed.endsWith(sep) ? fixed.slice(0, -1) : dirname(fixed);
    if (reach.homes.some((home) => inside(home, base || sep) || inside(base || sep, home))) return true;
    return false;
  }
  const real = reach.probe.realPath ? reach.probe.realPath(path) : path;
  return reach.homes.some((home) => inside(path, home) || inside(real, home));
}

function wordReaches(word: string, cwd: string | undefined, reach: Reach): boolean {
  if (HOME_VARIABLES.test(word)) return true;
  // Where a relative path lands is not known (after a `cd` this could not follow): one naming a GoodVibes folder counts.
  if (cwd === undefined && /\.goodvibe/i.test(word) && !isAbsolute(word)) return true;
  for (const part of word.split(/[=:,]/)) {
    for (const path of expandedPaths(part, cwd, reach.probe)) if (pathReaches(path, reach)) return true;
  }
  return false;
}

/** The program a path in command position really is: its real path's name when it can be read. */
function programName(word: string, cwd: string | undefined, reach: Reach): { readonly name: string; readonly path: string | undefined } {
  if (!word.includes('/') && !word.startsWith('~')) return { name: word, path: undefined };
  const path = expandedPaths(word, cwd, reach.probe)[0];
  if (path === undefined) return { name: basename(word), path: undefined };
  const real = reach.probe.realPath ? reach.probe.realPath(path) : path;
  return { name: PRODUCT_PROGRAMS.has(basename(real)) ? basename(real) : basename(path), path };
}

/** Whether a script file's text, run as a shell script or by an interpreter, reaches. */
function scriptReaches(path: string, shell: boolean, cwd: string | undefined, reach: Reach, depth: number): boolean {
  const text = reach.probe.readText?.(path);
  // A script that cannot be read is not known not to reach: it counts.
  if (text === undefined) return true;
  const firstLine = text.split('\n', 1)[0] ?? '';
  const isShell = shell || !firstLine.startsWith('#!') || /\b(?:ba|z|da|k|mk|fi|a)?sh\b/.test(firstLine);
  if (isShell) return textReaches(text, cwd, reach, depth + 1);
  return mentionsProduct(text, reach);
}

/**
 * Whether code of another language starts a product program (its name alone in quotes, or followed by one of its
 * verbs), names a GoodVibes home's directory, its variables or the model's mark. Code that merely mentions the product
 * (a project that is GoodVibes itself imports `@goodvibes/...`) does not count.
 */
function mentionsProduct(text: string, reach: Reach): boolean {
  return /(['"`])goodvibes(?:-agent|-daemon)?\1/.test(text)
    || /\bgoodvibes(?:-agent|-daemon)?\s+(?:do|find|run|serve|pair|secrets|config|permissions|capabilities)\b/.test(text)
    || HOME_VARIABLES.test(text) || /\bGOODVIBES_(?:DAEMON_)?HOME\b/.test(text) || text.includes(MODEL_MARK)
    || reach.homes.some((home) => text.includes(home));
}

/** The words of one command after the program's own options: `skipArgs` options that take a value. */
function afterOptions(words: readonly string[], start: number, takesValue: ReadonlySet<string>): number {
  let index = start;
  while (index < words.length && words[index]!.startsWith('-') && words[index] !== '-') {
    if (takesValue.has(words[index]!)) index += 1;
    index += 1;
  }
  return index;
}

/** Whether one segment's words reach, starting at the program position `start`. */
function commandReaches(words: readonly string[], start: number, cwd: string | undefined, reach: Reach, depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  let index = start;
  // Assignments and launchers in front of the program, with their options.
  while (index < words.length) {
    const word = words[index]!;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
    if (assignment) {
      // Clearing or setting the model's mark, or pointing PATH elsewhere, is reaching for the person's claim.
      if (assignment[1] === MODEL_MARK || assignment[1] === 'PATH') return true;
      index += 1;
      continue;
    }
    if (LAUNCHERS.has(basename(word))) {
      if (basename(word) === 'env' && words.slice(index + 1).some((option) => option === '-u' || option.startsWith('--unset') || option === '-i' || option === '-')) return true;
      index += 1;
      // A launcher's options, and the duration or priority some take.
      while (index < words.length && (words[index]!.startsWith('-') || /^\d+[smhd]?$/.test(words[index]!))) {
        if (['-u', '-g', '-n', '-p', '-s', '-k', '-C', '-o', '-e', '-i', '--signal', '--kill-after'].includes(words[index]!)) index += 1;
        index += 1;
      }
      continue;
    }
    break;
  }
  if (index >= words.length) return false;
  const first = words[index]!;
  // A variable or substitution where the program is named: what runs is not known here.
  if (/[$`]/.test(first) || first === '{}' || first.startsWith('(')) return true;
  if (first === 'unset' && words.slice(index + 1).includes(MODEL_MARK)) return true;
  if (first === 'cd' || first === 'pushd') return false;
  const { name, path } = programName(first, cwd, reach);
  if (PRODUCT_PROGRAMS.has(name)) {
    const next = words.slice(index + 1).find((word) => word.length > 0);
    return next === undefined ? true : !READ_ONLY_WORDS.has(next);
  }
  if (SCHEDULERS.has(name)) return true;
  if (name === 'source' || name === '.') {
    const file = words[index + 1];
    const at = file === undefined ? undefined : expandedPaths(file, cwd, reach.probe)[0];
    return at === undefined ? true : scriptReaches(at, true, cwd, reach, depth);
  }
  if (name === 'xargs') {
    const at = afterOptions(words, index + 1, new Set(['-I', '-i', '-n', '-P', '-d', '-E', '-L', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs']));
    const replace = words.includes('-I') ? words[words.indexOf('-I') + 1] : undefined;
    if (at >= words.length) return false;
    if (replace !== undefined && words.slice(at).some((word) => word.includes(replace) && word === words[at])) return true;
    return commandReaches(words, at, cwd, reach, depth + 1);
  }
  if (name === 'find') {
    for (let at = index + 1; at < words.length; at += 1) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[at]!)) continue;
      const end = words.findIndex((word, position) => position > at && (word === ';' || word === '+'));
      const run = words.slice(at + 1, end < 0 ? undefined : end);
      if (run.length === 0 || commandReaches(run, 0, cwd, reach, depth + 1)) return true;
    }
  }
  if (name === 'script') {
    for (let at = index + 1; at < words.length; at += 1) {
      const option = words[at]!;
      if (option === '--command' || (/^-[a-zA-Z]+$/.test(option) && option.includes('c'))) {
        const inner = words[at + 1];
        return inner === undefined ? true : textReaches(inner, cwd, reach, depth + 1);
      }
      if (option.startsWith('--command=')) return textReaches(option.slice('--command='.length), cwd, reach, depth + 1);
    }
    // A shell of its own, with a terminal: what is typed into it is not known here.
    return true;
  }
  if (SHELLS.has(name)) {
    let at = index + 1;
    if (name === 'busybox') at += 1;
    for (; at < words.length; at += 1) {
      const option = words[at]!;
      if (option === '-c' || (/^-[a-zA-Z]+$/.test(option) && option.includes('c'))) {
        const inner = words[at + 1];
        return inner === undefined ? true : textReaches(inner, cwd, reach, depth + 1);
      }
      if (option === '-s' || option === '-') return true;
      if (option.startsWith('-') || option.startsWith('+')) continue;
      const file = expandedPaths(option, cwd, reach.probe)[0];
      return file === undefined ? true : scriptReaches(file, true, cwd, reach, depth);
    }
    // A shell reading its script from standard input.
    return true;
  }
  if (INTERPRETERS.has(name)) {
    const rest = words.slice(index + 1);
    // Inline code, or code read from standard input: what it runs is not known here.
    if (rest.some((word) => ['-c', '-e', '-r', '-p', '--eval', '--print', '-'].includes(word) || /^-[A-Za-z]*[ce]$/.test(word))) return true;
    const fileWord = rest.find((word) => !word.startsWith('-') && !['run', 'x', 'exec'].includes(word));
    if (fileWord === undefined) return false;
    const file = expandedPaths(fileWord, cwd, reach.probe)[0];
    const text = file === undefined ? undefined : reach.probe.readText?.(file);
    return text === undefined ? false : mentionsProduct(text, reach);
  }
  // A program named by a path: a script file of the project is read and judged in turn.
  if (path !== undefined) {
    const text = reach.probe.readText?.(path);
    if (text !== undefined && !text.startsWith('\u007fELF') && !text.includes('\u0000')) {
      const firstLine = text.split('\n', 1)[0] ?? '';
      return scriptReaches(path, !firstLine.startsWith('#!') || /\b(?:ba|z|da|k|mk|fi|a)?sh\b/.test(firstLine), cwd, reach, depth);
    }
  }
  return false;
}

/**
 * Whether a command's text reaches: any segment runs a product program, names a GoodVibes home, clears the model's mark
 * or runs something this cannot resolve; a `cd` moves where the next segments' relative paths are read from.
 */
function textReaches(text: string, directory: string | undefined, reach: Reach, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (text.includes(MODEL_MARK)) return true;
  let cwd = directory;
  for (const segment of splitShellCommand(text).segments) {
    const words = wordsOf(segment);
    if (words.length === 0) continue;
    // A substitution runs first: what it runs is read in turn.
    for (const inner of segment.match(/\$\(([^()]*)\)|`([^`]*)`/g) ?? []) {
      if (textReaches(inner.replace(/^\$\(|^`|\)$|`$/g, ''), cwd, reach, depth + 1)) return true;
    }
    if (words.some((word) => wordReaches(word, cwd, reach))) return true;
    if (commandReaches(words, 0, cwd, reach, depth)) return true;
    const head = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (head === 'cd' || head === 'pushd') {
      const target = words[words.indexOf(head) + 1];
      cwd = target === undefined || target === '-' ? reach.probe.home : expandedPaths(target, cwd, reach.probe)[0];
    }
  }
  return false;
}

/**
 * Whether any of a call's commands runs one of the product's own programs to change something, reads or writes the
 * files under the GoodVibes home, or runs something whose reach this cannot resolve (when in doubt, it counts).
 * `directory` is where a relative path is read from when the command names none; `homes` are the GoodVibes home
 * directories as the caller resolved them (`<home>/.goodvibes` and the daemon's home); `probe` how it may read the file
 * system and the person's home. None given, only the words count.
 */
export function reachesPastTheGate(commands: readonly ShellCommandAt[], directory: string | undefined, homes: readonly string[] = [], probe: ProductReachProbe = {}): boolean {
  if (commands.length === 0) return false;
  const reach: Reach = { homes: homes.map((home) => resolve(home)), probe };
  for (const command of commands) {
    const at = command.cwd === undefined ? directory : directory ? resolve(directory, command.cwd) : command.cwd;
    if (textReaches(command.text, at, reach)) return true;
  }
  return false;
}

/** File names a program runs by itself later: shell start-up files, a folder's environment, the project's own runners. */
const RUN_BY_ITSELF_NAMES: ReadonlySet<string> = new Set([
  '.envrc', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout',
  'config.fish', '.xprofile', '.xinitrc', '.xsession', 'package.json', 'Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile',
  'Taskfile.yml', 'Rakefile', '.pre-commit-config.yaml', 'hooks.json', 'mcp.json', '.mcp.json', 'tasks.json', 'crontab',
]);
/** Folders whose files run by themselves later. */
const RUN_BY_ITSELF_FOLDERS: readonly string[] = [
  `.git${sep}hooks`, '.husky', `.config${sep}autostart`, `.config${sep}systemd`, `.config${sep}fish${sep}conf.d`, `.goodvibes${sep}hooks`,
  `Library${sep}LaunchAgents`,
];

/**
 * Whether a file a call writes is one that runs by itself later: a git hook, a folder's `.envrc`, a package's scripts,
 * a shell start-up file, a project's hooks or tool-server file, anything under a folder on the program search path.
 * Writing it installs something that runs by itself, without this gate seeing what it runs then.
 */
export function writesRunByItself(paths: readonly string[], directory: string | undefined, searchPath: readonly string[] = []): boolean {
  for (const raw of paths) {
    const path = directory ? resolve(directory, raw) : resolve(raw);
    if (RUN_BY_ITSELF_NAMES.has(basename(path))) return true;
    if (RUN_BY_ITSELF_FOLDERS.some((folder) => path.includes(`${sep}${folder}${sep}`))) return true;
    if (searchPath.some((folder) => isAbsolute(folder) && inside(path, resolve(folder)))) return true;
  }
  return false;
}
