/**
 * product-commands.ts, a model's command that reaches past the gate through GoodVibes itself: one that runs one of the
 * product's own programs to change something (`goodvibes do`, `goodvibes-agent find`, `goodvibes-daemon` with any
 * subcommand but help and version), or that reads or writes the files under the GoodVibes home (the operator token, the
 * settings, the secret stores, the permission rules). Either can loosen a protection without the owner's yes: the
 * program speaks to the daemon with the owner's own credential, and the files hold that credential and the rules. The
 * gate classes such a command as one that loosens a protection (gate/classify.ts `recognizeOwnerOnly`): put to the
 * owner, opening on No, in every mode, YOLO included (it is the door to the owner's own acts), each time.
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
 *   script file or `source` runs is read in turn, a few levels deep (deeper counts);
 * - an interpreter given a script file it cannot read counts, as an unreadable shell script does;
 * - with no working sandbox (`probe.sandboxed` not true) also what runs code this cannot resolve: an interpreter's script
 *   that reaches the home or runs a program by a name it builds at run time, inline `awk` code that runs or reads
 *   something itself, `make -f`, `go run`, `cargo run`, and a program named by a path that is a compiled file outside
 *   the system's own folders or not there yet (one the same command builds);
 * - a terminal the model can type into (`tmux`, `screen`, ...), `ssh` to this machine, `docker` with a mount of the home
 *   or a GoodVibes home, `git -c` or `git config` of a key that runs a program (hooks path, aliases, filters, ...), a read
 *   of another process's `/proc/<pid>/environ`, `cmdline` or `mem`, and a recursive read of a folder holding a GoodVibes
 *   home (`grep -r ~`, `find ~`, `tar cf - ~`; `rg`, `ag` only when told to read hidden folders), unless it leaves the
 *   GoodVibes home out itself (`grep --exclude-dir=.goodvibes`).
 *
 * Pure: the GoodVibes homes, the person's home and the file-system probe are handed in by the caller (the permission
 * manager), never read from the environment here.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { splitShellCommand } from '../runtime/permissions/rules/prefix.js';
import type { ShellCommandAt } from '../runtime/permissions/exec-command-text.js';
import { pathRunsByItself } from './run-by-itself.js';

/** What the caller lets the classifier read of the file system, and the person's home. Each part optional. */
export interface ProductReachProbe {
  /** Where a path really is (links followed, `/proc/self/root` included); the path itself when it cannot be read. */
  readonly realPath?: ((path: string) => string) | undefined;
  /** A script file's text, bounded; undefined when it cannot be read or is not a file. */
  readonly readText?: ((path: string) => string | undefined) | undefined;
  /** The person's login home: what `~` and `$HOME` expand to. */
  readonly home?: string | undefined;
  /** This machine's own names (its host name), as `ssh` would be given them. */
  readonly hostNames?: readonly string[] | undefined;
  /**
   * The model's commands run inside a working sandbox (the exec sandbox switched on and available here). Absent or
   * false: they run on the host, and code this cannot resolve counts.
   */
  readonly sandboxed?: boolean | undefined;
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
const INTERPRETERS: ReadonlySet<string> = new Set(['python', 'python2', 'python3', 'pypy', 'pypy3', 'node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node', 'perl', 'ruby', 'php', 'lua', 'luajit', 'osascript', 'pwsh', 'powershell', 'tclsh', 'wish', 'Rscript', 'julia', 'groovy', 'elixir', 'erl', 'guile', 'racket', 'swift']);
/** Interpreters whose code is the first word after their options (inline), unless `-f` names a file. */
const AWKS: ReadonlySet<string> = new Set(['awk', 'gawk', 'mawk', 'nawk', 'busybox-awk']);
/** Programs that give the model a terminal another of its commands can type into later. */
const TERMINAL_DRIVERS: ReadonlySet<string> = new Set(['tmux', 'screen', 'byobu', 'zellij', 'dtach', 'abduco', 'reptyr', 'ttyd', 'conspy']);
/** Programs that start a shell on a machine they connect to. */
const REMOTE_SHELLS: ReadonlySet<string> = new Set(['ssh', 'mosh', 'autossh', 'slogin']);
/** ssh's options that take a value. */
const SSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
/** Container programs whose mounts expose a folder of this machine. */
const CONTAINERS: ReadonlySet<string> = new Set(['docker', 'podman', 'nerdctl', 'finch']);
/** Git configuration keys whose value is a program git runs, or a file it loads more configuration from. */
const GIT_RUNNING_KEYS = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy)|alias\..+|filter\..+|diff\..+\.(?:textconv|command)|diff\.external|merge\..+\.driver|credential(?:\..+)?\.helper|include\.path|includeif\..+|sequence\.editor|gpg\.(?:.+\.)?program|uploadpack\.packobjectshook|receive\.procreceiverefs|protocol\..+\.allow|remote\..+\.(?:uploadpack|receivepack|proxy)|pager\..+|interactive\.difffilter|instaweb\..+|web\.browser|browser\..+\.cmd|man\..+\.cmd|sendemail\..+)$/;
/** Programs that read a folder's files all the way down. */
const RECURSIVE_READERS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'tar', 'bsdtar', 'zip', '7z', 'cp', 'rsync', 'scp', 'strings']);
/** Recursive readers that leave hidden folders out unless told otherwise. */
const SKIP_HIDDEN = new Map<string, RegExp>([
  ['rg', /^(?:-[a-zA-Z]*u|--hidden|--unrestricted|--no-ignore-dot)$/],
  ['ag', /^(?:-[a-zA-Z]*u|--hidden|--unrestricted|--all-types)$/],
]);
/** Where the system's own compiled programs live: a compiled file elsewhere is one somebody made here. */
const SYSTEM_PROGRAM_FOLDERS: readonly string[] = ['/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/opt/', '/nix/', '/snap/', '/gnu/', '/System/', '/Applications/', '/Library/'];
/**
 * The product's own marks and the variables its programs read to know who and where they are: the model's command mark
 * (`GOODVIBES_COMMAND_FROM_MODEL`), the homes (`GOODVIBES_HOME`, `GOODVIBES_DAEMON_HOME`, `GOODVIBES_AGENT_HOME`, the
 * `GOODVIBES_*_SURFACE_ROOT` folders, `GOODVIBES_DAEMON_SETTINGS_ROOT`), the credentials (`GOODVIBES_DAEMON_TOKEN`,
 * `GOODVIBES_OPERATOR_TOKEN`, `GOODVIBES_OPERATOR_TOKEN_STORE`, `GOODVIBES_CONNECTED_HOST_TOKEN`, `GOODVIBES_HTTP_TOKEN`,
 * `GOODVIBES_WORKER_TOKEN`), the daemon it talks to (`GOODVIBES_DAEMON_URL`, `GOODVIBES_BASE_URL`) and every other
 * `GOODVIBES_` variable: a command or script that sets, clears or overrides one (an assignment, `export`, `unset`,
 * `env -u`, code naming it) is reaching for what the product decides by, and is asked in every mode. Matched by the
 * prefix, so a variable added later is one too. No daemon decision depends on any of them: a `do` is a command line by
 * the registration it runs under (daemon/program-registrations.ts), whatever its environment says.
 */
const PRODUCT_MARK = /\bGOODVIBES_[A-Z0-9_]+\b/;
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

/** Another process's environment, command line or memory (its own, `self`, is the command's). */
const OTHER_PROCESS = /(?:^|[<>=:,]|\/\/)\/proc\/(?!self\/|thread-self\/)[^/\s]+\/(?:environ|cmdline|mem)\b/;

function wordReaches(word: string, cwd: string | undefined, reach: Reach): boolean {
  if (HOME_VARIABLES.test(word)) return true;
  if (OTHER_PROCESS.test(word)) return true;
  // Where a relative path lands is not known (after a `cd` this could not follow): one naming a GoodVibes folder counts.
  if (cwd === undefined && /\.goodvibe/i.test(word) && !isAbsolute(word)) return true;
  for (const part of word.split(/[=:,]/)) {
    for (const path of expandedPaths(part, cwd, reach.probe)) if (pathReaches(path, reach) || OTHER_PROCESS.test(resolve(path))) return true;
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
  // With no way to read files handed in, only the words count (see reachesPastTheGate).
  if (reach.probe.readText === undefined) return false;
  const text = reach.probe.readText(path);
  // A script that cannot be read is not known not to reach: it counts.
  if (text === undefined) return true;
  const firstLine = text.split('\n', 1)[0] ?? '';
  const isShell = shell || !firstLine.startsWith('#!') || /\b(?:ba|z|da|k|mk|fi|a)?sh\b/.test(firstLine);
  if (isShell) return textReaches(text, cwd, reach, depth + 1);
  return codeReaches(text, reach);
}

/** Whether commands run on the host: no working sandbox, so code this cannot resolve counts. */
function unsandboxed(reach: Reach): boolean {
  return reach.probe.sandboxed !== true;
}

/** Code of another language, read whole: it names the product or its home, or (with no sandbox) does what this cannot follow. */
function codeReaches(text: string, reach: Reach): boolean {
  return mentionsProduct(text, reach) || (unsandboxed(reach) && codeBuildsReach(text));
}

/** Code reaching the person's home by a path it builds (expanduser, HOME, `~/`), whatever it joins to it. */
const CODE_HOME = /expanduser\s*\(|\bhomedir\s*\(|Path\.home\s*\(|Dir\.home\b|getpwuid|expand_path\s*\(\s*['"]~|['"`]~\/|getenv\s*\(\s*['"]HOME['"]|environ(?:\.get)?\s*[[(]\s*['"]HOME['"]|process\.env\.HOME\b|process\.env\[\s*['"]HOME['"]|Bun\.env\.HOME\b|Deno\.env\.get\s*\(\s*['"]HOME|ENV\[\s*['"]HOME['"]|\$ENV\{\s*['"]?HOME|UserHomeDir|\$HOME\b/;
/** Code reading another process's environment, command line or memory. */
const CODE_PROC = /\/proc\/[^'"`\s]*(?:environ|cmdline|\/mem\b)|['"`]\/proc\/?['"`]/;
/** Code that starts another program. */
const CODE_RUNS = /\b(?:os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|subprocess\b|pty\.spawn|commands\.getoutput|child_process|execSync|spawnSync|execFile\w*|Bun\.spawn\w*|Bun\.\$|Deno\.(?:run|Command)|IO\.popen|Open3\b|Process\.spawn|Kernel\.(?:system|exec|spawn)|shell_exec|passthru|proc_open|Runtime\.getRuntime)\b|\bsystem\s*\(|\bpopen\s*\(|\bexec[lv]?p?e?\s*\(|%x[({[]|\bqx\s*[({[/]/;
/** Code that builds a name or a text at run time: joined pieces, decoded or reversed text, a format, an evaluation. */
const CODE_BUILT = /(['"])[^'"\n]*\1\s*(?:\+|\.\.?|,)\s*(['"])|\.join\s*\(|\bchr\s*\(|fromCharCode|\bb64decode|base64|\batob\s*\(|\.decode\s*\(|fromhex|unhexlify|\[::-1\]|\.reverse\s*\(|\bcodecs\b|rot13|\bpack\s*\(|\$\{|%\s*\(|\bf['"]|\.format\s*\(|\bsprintf\b|\bconcat\s*\(|\beval\s*\(|new Function\s*\(|\bcompile\s*\(/;

/**
 * Whether code of another language does what this classifier cannot follow, with no sandbox around it: reaches the
 * home by a path it builds, reads another process's environment, or starts a program whose name it builds at run time.
 */
function codeBuildsReach(text: string): boolean {
  if (CODE_HOME.test(text) || CODE_PROC.test(text)) return true;
  return CODE_RUNS.test(text) && CODE_BUILT.test(text);
}

/** Whether awk code runs a program, reads a file it names itself, or writes one (what its input files are not). */
function awkCodeReaches(code: string): boolean {
  return /\bsystem\s*\(|\|\s*getline|\bgetline\s*</.test(code) || /\bprint[f]?\b[^;}]*[|>]/.test(code) || /@load\b|\bclose\s*\(/.test(code);
}

/** A path as it really is, through the probe. */
function realOf(path: string, reach: Reach): string {
  return reach.probe.realPath ? reach.probe.realPath(path) : path;
}

/** Whether a folder holds a GoodVibes home (that home is inside it, or it is inside that home). */
function holdsAHome(folder: string, reach: Reach, skipHidden = false): boolean {
  const real = realOf(folder, reach);
  return reach.homes.some((home) => {
    if (inside(folder, home) || inside(real, home)) return true;
    for (const base of [folder, real]) {
      if (!inside(home, base)) continue;
      // A reader that leaves hidden folders out never gets to a home behind one.
      if (skipHidden && relative(base, home).split(sep).some((segment) => segment.startsWith('.'))) continue;
      return true;
    }
    return false;
  });
}

/** Whether a mount's source is the person's home, a folder above it, or a folder holding a GoodVibes home. */
function mountExposes(source: string, cwd: string | undefined, reach: Reach): boolean {
  if (/[$`]/.test(source)) return true;
  const path = expandedPaths(source, cwd, reach.probe)[0];
  if (path === undefined) return false;
  const home = reach.probe.home;
  return holdsAHome(path, reach) || (home !== undefined && (inside(home, path) || inside(home, realOf(path, reach))));
}

/** Whether a host `ssh` is given is this machine, or one this cannot name. */
function hostIsThisMachine(host: string, reach: Reach): boolean {
  if (/[$`]/.test(host)) return true;
  const bare = host.replace(/^.*@/, '').replace(/^\[|\]$/g, '').replace(/:\d+$/, '').toLowerCase();
  if (bare === '' ) return false;
  if (bare === 'localhost' || bare.startsWith('localhost.') || bare === '::1' || bare === '0.0.0.0' || /^127\./.test(bare) || bare === '0') return true;
  return (reach.probe.hostNames ?? []).some((name) => name.toLowerCase() === bare || name.toLowerCase().split('.')[0] === bare);
}

/** A glob pattern as a test of one name (`*`, `?`, `[...]`). */
function globMatches(pattern: string, name: string): boolean {
  const source = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try { return new RegExp(`^${source}$`).test(name); } catch { return false; }
}

/** Whether a recursive reader's own options leave the GoodVibes home folders out (`grep --exclude-dir=.goodvibes`). */
function leavesHomesOut(words: readonly string[], reach: Reach): boolean {
  const names = new Set(reach.homes.map((home) => basename(home)).concat(['.goodvibes']));
  const excluded = words.flatMap((word, at) => word.startsWith('--exclude-dir=') ? [word.slice('--exclude-dir='.length)]
    : word === '--exclude-dir' && words[at + 1] !== undefined ? [words[at + 1]!] : []);
  return [...names].every((name) => excluded.some((pattern) => globMatches(pattern.replace(/^\{|\}$/g, ''), name)));
}

/** Whether a reader of folders reads all the way down, by its own options. */
function readsRecursively(name: string, rest: readonly string[]): boolean {
  if (['rg', 'ag', 'ack', 'find'].includes(name)) return true;
  if (['grep', 'egrep', 'fgrep'].includes(name)) {
    return rest.some((word) => /^-[a-zA-Z]*[rR]/.test(word) || word === '--recursive' || word === '--dereference-recursive' || /^--directories=recurse$/.test(word))
      || rest.some((word, at) => word === '-d' && rest[at + 1] === 'recurse');
  }
  if (name === 'tar' || name === 'bsdtar') {
    const first = rest[0] ?? '';
    return /^-?[a-zA-Z]*[cru]/.test(first) || rest.some((word) => ['--create', '--append', '--update', '-c', '-r', '-u'].includes(word));
  }
  if (name === '7z') return rest[0] === 'a' || rest[0] === 'u';
  if (name === 'zip' || name === 'scp') return rest.some((word) => /^-[a-zA-Z]*r/.test(word) || word === '--recurse-paths');
  if (name === 'cp' || name === 'rsync') return rest.some((word) => /^-[a-zA-Z]*[rRa]/.test(word) || ['--recursive', '--archive'].includes(word));
  return false;
}

/**
 * Whether a recursive read crosses a GoodVibes home: a folder it reads holds one (the person's home itself, `/`), or no
 * folder is named and the one it starts in does. Leaving the home out by its own options does not count.
 */
function recursiveReadCrosses(name: string, rest: readonly string[], cwd: string | undefined, reach: Reach): boolean {
  if (!readsRecursively(name, rest)) return false;
  if (leavesHomesOut(rest, reach)) return false;
  const skipHidden = SKIP_HIDDEN.get(name);
  const hiddenSkipped = skipHidden !== undefined && !rest.some((word) => skipHidden.test(word));
  const named = rest.filter((word) => !word.startsWith('-') && word !== '');
  const folders = named.flatMap((word) => expandedPaths(word, cwd, reach.probe));
  if (folders.length === 0 && cwd !== undefined) folders.push(cwd);
  return folders.some((folder) => holdsAHome(folder, reach, hiddenSkipped));
}

/** Whether a `git` command sets or uses, for this run or for good, a configuration key whose value git runs. */
function gitRunsConfigured(rest: readonly string[]): boolean {
  let at = 0;
  for (; at < rest.length; at += 1) {
    const word = rest[at]!;
    const pair = word === '-c' || word === '--config-env' ? rest[++at] : word.startsWith('--config-env=') ? word.slice('--config-env='.length) : /^-c./.test(word) ? word.slice(2) : undefined;
    if (pair !== undefined) {
      if (GIT_RUNNING_KEYS.test((pair.split('=')[0] ?? '').trim().toLowerCase())) return true;
      continue;
    }
    if (word === '--exec-path' || word.startsWith('--exec-path=')) return word !== '--exec-path' || rest[at + 1] !== undefined;
    if (['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--list-cmds'].includes(word)) { at += 1; continue; }
    if (word.startsWith('-')) continue;
    break;
  }
  if (rest[at] !== 'config') return false;
  const args = rest.slice(at + 1);
  if (args.some((word) => word === '-e' || word === '--edit' || word === 'edit')) return true;
  const valued = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);
  const plain: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (valued.has(word)) { index += 1; continue; }
    if (word.startsWith('-')) continue;
    plain.push(word);
  }
  const reads = args.some((word) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--unset', '--unset-all', '--remove-section'].includes(word));
  const words = ['set', 'get', 'unset', 'list'].includes(plain[0] ?? '') ? plain.slice(1) : plain;
  const sets = plain[0] === 'set' || (!reads && plain[0] !== 'get' && plain[0] !== 'list' && plain[0] !== 'unset' && words.length >= 2);
  return sets && GIT_RUNNING_KEYS.test((words[0] ?? '').toLowerCase());
}

/** Environment a command is started with that makes any program run more code (a preloaded library, git's own config). */
const RUNS_MORE_CODE = /^(?:LD_PRELOAD|LD_AUDIT|DYLD_INSERT_LIBRARIES|BASH_ENV|ENV|PROMPT_COMMAND|PERL5OPT|PYTHONSTARTUP|RUBYOPT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_PAGER|GIT_EDITOR|GIT_ASKPASS|GIT_PROXY_COMMAND|GIT_EXTERNAL_DIFF|GIT_TEMPLATE_DIR)$/;

/**
 * Whether code of another language starts a product program (its name alone in quotes, or followed by one of its
 * verbs), names a GoodVibes home's directory, its variables or the model's mark. Code that merely mentions the product
 * (a project that is GoodVibes itself imports `@goodvibes/...`) does not count.
 */
function mentionsProduct(text: string, reach: Reach): boolean {
  return /(['"`])goodvibes(?:-agent|-daemon)?\1/.test(text)
    || /\bgoodvibes(?:-agent|-daemon)?\s+(?:do|find|run|serve|pair|secrets|config|permissions|capabilities)\b/.test(text)
    || HOME_VARIABLES.test(text) || PRODUCT_MARK.test(text)
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
      if (PRODUCT_MARK.test(assignment[1]!) || assignment[1] === 'PATH') return true;
      // A preloaded library, git's configuration from the environment: more code runs than the command names.
      if (RUNS_MORE_CODE.test(assignment[1]!)) return true;
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
  if (first === 'unset' && words.slice(index + 1).some((word) => PRODUCT_MARK.test(word))) return true;
  if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(first)
    && words.slice(index + 1).some((word) => { const named = /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(word)?.[1]; return named !== undefined && (RUNS_MORE_CODE.test(named) || PRODUCT_MARK.test(named)); })) return true;
  if (first === 'cd' || first === 'pushd') return false;
  const { name, path } = programName(first, cwd, reach);
  if (PRODUCT_PROGRAMS.has(name)) {
    const next = words.slice(index + 1).find((word) => word.length > 0);
    return next === undefined ? true : !READ_ONLY_WORDS.has(next);
  }
  if (SCHEDULERS.has(name)) return true;
  const rest = words.slice(index + 1);
  // A terminal the model can type into later (the person's own multiplexer server among them): what it types there is
  // not a command this gate sees.
  if (TERMINAL_DRIVERS.has(name)) return true;
  if (REMOTE_SHELLS.has(name)) {
    // Options that run a command on this machine itself, or read a configuration that can.
    if (rest.some((word, at) => /^-o/.test(word) && /(?:ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand|Match)/i.test(word === '-o' ? rest[at + 1] ?? '' : word))) return true;
    if (rest.includes('-F')) return true;
    const host = rest[afterOptions(rest, 0, SSH_VALUE_OPTIONS)];
    return host !== undefined && hostIsThisMachine(host, reach);
  }
  if (CONTAINERS.has(name)) {
    for (let at = 0; at < rest.length; at += 1) {
      const word = rest[at]!;
      const volume = word === '-v' || word === '--volume' ? rest[at + 1] : /^--volume=/.test(word) ? word.slice('--volume='.length) : /^-v./.test(word) ? word.slice(2) : undefined;
      if (volume !== undefined && mountExposes(volume.split(':')[0] ?? '', cwd, reach)) return true;
      const mount = word === '--mount' ? rest[at + 1] : /^--mount=/.test(word) ? word.slice('--mount='.length) : undefined;
      const source = mount === undefined ? undefined : /(?:^|,)(?:source|src)=([^,]*)/.exec(mount)?.[1];
      if (source !== undefined && mountExposes(source, cwd, reach)) return true;
    }
  }
  if (name === 'git' && gitRunsConfigured(rest)) return true;
  if (RECURSIVE_READERS.has(name) && recursiveReadCrosses(name, rest, cwd, reach)) return true;
  // With no sandbox: a make file named by the call, and a compiler that runs what it builds.
  if (unsandboxed(reach)) {
    if (['make', 'gmake', 'bmake'].includes(name) && rest.some((word) => word === '-f' || word === '--file' || word === '--makefile' || /^-f./.test(word) || /^--(?:make)?file=/.test(word))) return true;
    if ((name === 'go' || name === 'cargo') && rest.includes('run')) return true;
  }
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
  if (AWKS.has(name)) {
    // A program file (`-f`): read and judged like inline code; one that cannot be read counts.
    const fileAt = rest.findIndex((word) => word === '-f' || word === '--file');
    const fileWord = fileAt >= 0 ? rest[fileAt + 1] : rest.find((word) => /^-f./.test(word))?.slice(2);
    if (fileWord !== undefined) {
      const file = expandedPaths(fileWord, cwd, reach.probe)[0];
      if (reach.probe.readText === undefined) return false;
      const text = file === undefined ? undefined : reach.probe.readText(file);
      return text === undefined ? true : codeReaches(text, reach) || (unsandboxed(reach) && awkCodeReaches(text));
    }
    // Inline code: the first word after the options (-F and -v take a value).
    const codeAt = afterOptions(rest, 0, new Set(['-F', '-v', '--field-separator', '--assign']));
    const code = rest[codeAt] ?? '';
    return mentionsProduct(code, reach) || (unsandboxed(reach) && awkCodeReaches(code));
  }
  if (INTERPRETERS.has(name) || /^python\d+(?:\.\d+)?$/.test(name) || /^ruby\d/.test(name) || /^perl\d/.test(name)) {
    // Inline code, or code read from standard input: what it runs is not known here.
    if (rest.some((word) => ['-c', '-e', '-r', '-p', '--eval', '--print', '-', '--require', '--import', '--loader', '--experimental-loader'].includes(word) || /^-[A-Za-z]*[ce]$/.test(word))) return true;
    // A module run by name (`python -m pytest`): what it runs is not read here; with no sandbox around it, it counts.
    if (rest.some((word) => word === '-m' || /^-m./.test(word) || /^-M/.test(word))) return unsandboxed(reach);
    // A package runner's own commands (`bun test`, `bun install`, `deno task`) run no file named here.
    let fileWords = rest;
    if (name === 'bun' || name === 'deno') {
      const verb = rest.find((word) => !word.startsWith('-'));
      if (verb === undefined) return false;
      const afterVerb = rest.slice(rest.indexOf(verb) + 1);
      if (['run', 'x', 'exec'].includes(verb)) {
        const target = afterVerb.find((word) => !word.startsWith('-'));
        // A script of the package's own (`bun run build`) is its package file's, whose writes are asked.
        if (target === undefined || (!target.includes('/') && !/\.[cm]?[jt]sx?$/.test(target))) return false;
        fileWords = [target];
      } else if (!verb.includes('/') && !/\.[cm]?[jt]sx?$/.test(verb)) return false;
    }
    // The first word that is not an option or an option's value (`-W ignore`, `-X dev`, `-I lib`).
    const valued = new Set(['-W', '-X', '-I', '-C', '--title', '--conditions', '-O', '--inspect-port']);
    let fileWord: string | undefined;
    for (let at = 0; at < fileWords.length; at += 1) {
      const word = fileWords[at]!;
      if (valued.has(word)) { at += 1; continue; }
      if (word.startsWith('-') || ['run', 'x', 'exec'].includes(word)) continue;
      fileWord = word;
      break;
    }
    if (fileWord === undefined) return false;
    if (reach.probe.readText === undefined) return false;
    const file = expandedPaths(fileWord, cwd, reach.probe)[0];
    const text = file === undefined ? undefined : reach.probe.readText(file);
    // A script file that cannot be read (not there yet, written by this same command, too large) is not known not to
    // reach: it counts, as an unreadable shell script does.
    return text === undefined ? true : codeReaches(text, reach);
  }
  // A program named by a path: a script file of the project is read and judged in turn; a compiled file that is not one
  // of the system's own, or one that is not there yet (built by this same command), runs code this cannot read, which
  // with no sandbox around it counts.
  if (path !== undefined && reach.probe.readText !== undefined) {
    const text = reach.probe.readText(path);
    if (text !== undefined && !text.startsWith('\u007fELF') && !text.includes('\u0000')) {
      const firstLine = text.split('\n', 1)[0] ?? '';
      return scriptReaches(path, !firstLine.startsWith('#!') || /\b(?:ba|z|da|k|mk|fi|a)?sh\b/.test(firstLine), cwd, reach, depth);
    }
    if (unsandboxed(reach)) {
      const real = realOf(path, reach);
      return !SYSTEM_PROGRAM_FOLDERS.some((folder) => real.startsWith(folder) || path.startsWith(folder));
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
  // Any of the product's own marks named (set, cleared, overridden, or handed to a program): see PRODUCT_MARK.
  if (PRODUCT_MARK.test(text)) return true;
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

/**
 * Whether a file a call writes is one that runs by itself later (gate/run-by-itself.ts: a git hook or a repository's
 * configuration, a folder's `.envrc`, a package's scripts, a project's runners and test set-up, a shell start-up file,
 * the login's ssh and git configuration, a service or timer folder, anything GoodVibes loads from a `.goodvibes`
 * folder), or a file put on the program search path. Writing it installs something that runs by itself, without this
 * gate seeing what it runs then.
 */
export function writesRunByItself(paths: readonly string[], directory: string | undefined, searchPath: readonly string[] = []): boolean {
  const folders = searchPath.filter((folder) => isAbsolute(folder)).map((folder) => resolve(folder));
  for (const raw of paths) {
    const path = directory ? resolve(directory, raw) : resolve(raw);
    if (pathRunsByItself(path, folders)) return true;
  }
  return false;
}
