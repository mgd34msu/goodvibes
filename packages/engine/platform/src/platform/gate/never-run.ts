/**
 * The owner's "never run commands matching" rules, enforced by the gate itself
 * in every permission mode, yolo included, for every tool that can reach a
 * shell. A rule is a program and the words it must carry (`git push`); a call
 * matches when any command it would hand a shell runs that program with those
 * words, read the way a shell reads it, or when a command could run it and
 * code cannot tell which words it will have.
 *
 * What is read, per call:
 * - every shell command a call carries: `exec`'s `commands[].cmd`, the decoded
 *   `cmd_base64`, a flat `command` or `cmd` (the Agent's `terminal` and
 *   `process` start, `agent_harness` processes), the same fields nested in
 *   the call's input (`agent_operator_method`'s `input`), a workflow's
 *   `scheduleCommand` and hook action, a `state` command hook, and the
 *   commands a tool declares (`trigger`'s `spec.command` with its `args`);
 * - each command by the gate's one command walk (command-walk.ts): through
 *   `sudo`, `env`, `xargs`, `timeout`, `setsid`, `flock` and the other
 *   wrappers, into `sh -c` / `bash -c` / `eval` strings, `$(...)` and
 *   backticks, `find -exec`, an `alias` definition, the shell's grouping and
 *   keywords (`( ... )`, `{ ...; }`, `if ...; then ...`), and a shell script
 *   the command runs (`sh publish.sh`, `bash -o pipefail publish.sh`,
 *   `./publish.sh`, `source x.sh`, `bash < publish.sh`), read from disk from
 *   the directory the command runs in (an exec entry's own `cwd`, else the
 *   call's working directory) as the command's own `cd` left it, with quoting
 *   removed the way the shell removes it (`g''it`, `"git"`, `g\it`).
 *
 * A command whose program, or whose arguments after a matching program, are
 * built when it runs (`$(printf git) push`, `git $X`, `xargs git`) matches:
 * code cannot rule out that it runs what the owner said never to run. Text a
 * call writes to a running process's input matches when it carries any word of
 * a rule, since a shell can receive a command in pieces. Code handed to an
 * interpreter (`repl`, a script in another language) matches when it names the
 * rule's words in order within a few words. A command nested too deeply to
 * read, a script too large to read, and a script that cannot be read (one the
 * command writes before it runs it, a missing file, commands a shell reads
 * from its standard input such as `echo 'git push' | sh`, a relative script
 * after a `cd` code cannot follow) match: code cannot see what they run. So
 * does command text built when the command runs where the variable is the
 * program (`bash -c "$CMD"`, `eval "$X"`) and a script path built that way
 * (`sh "$F"`); a built `cd` target or argument (`sh -c "cd $DIR && make"`) is
 * read like any other.
 *
 * Not seen: what a program does on its own once started (a git alias defined
 * before the rule, a compiled program, a script in another language that
 * assembles the words), tools of MCP servers, and commands the owner types
 * in person.
 *
 * Cost: nothing for a call when no never-run rule exists or the call carries
 * no command; otherwise one parse of each command text the call carries, and
 * one small file read per shell script a command runs.
 */
import { baseName, commandWalker, shellWord, type CommandWalker, type ProgramRun } from './command-walk.js';
import { execShellCommandsAt, type ShellCommandAt } from '../runtime/permissions/exec-command-text.js';
import { declaredValues } from './classify.js';
import { callOnlyTightens, type ToolDefinition } from '../types/tools.js';

/** One rule as the gate matches it: the program and the words after it, in order. */
export interface NeverRunPattern {
  /** The rule's text as the owner gave it, for the refusal. */
  readonly text: string;
  readonly program: string;
  readonly words: readonly string[];
}

/** What a call matched: the rule and the command (or text) that carries it. */
export interface NeverRunMatch {
  readonly rule: string;
  readonly command: string;
  /** Why it counts: the command runs it, or may run it and code cannot tell. */
  readonly why: string;
}

/** How many words after a program an interpreter's code may put the rule's other words. */
const CODE_WINDOW = 12;

/** Reads one rule's text (`git push`) into the program and words it matches; undefined for an empty one. */
export function parseNeverRunPattern(text: string): NeverRunPattern | undefined {
  const words = text.trim().split(/\s+/).map(shellWord).filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  return { text: text.trim(), program: baseName(words[0]!), words: words.slice(1) };
}

/** Whether `wanted` appears in `words` in order (not necessarily side by side). */
function inOrder(wanted: readonly string[], words: readonly string[]): boolean {
  let at = 0;
  for (const word of words) {
    if (at < wanted.length && word === wanted[at]) at++;
  }
  return at === wanted.length;
}

type RuleMatch = Omit<NeverRunMatch, 'command'>;

/** The rule a program run matches: by its words, or because words it runs with are built when it runs. */
function programMatch(run: ProgramRun, patterns: readonly NeverRunPattern[]): RuleMatch | undefined {
  for (const pattern of patterns) {
    if (run.built) return { rule: pattern.text, why: 'the program it runs is built when the command runs, so it may be the one this rule names' };
    if (run.name !== pattern.program) continue;
    if (inOrder(pattern.words, run.staticArgs)) return { rule: pattern.text, why: 'it runs that command' };
    if (pattern.words.length > 0 && (run.inputArgs || run.builtArgs)) {
      return { rule: pattern.text, why: 'some of its arguments are built when it runs, so they may be the words this rule names' };
    }
  }
  return undefined;
}

/** One walk over a call's commands for these rules; a script read once on the walk is not read again. */
function neverRunWalker(patterns: readonly NeverRunPattern[], directory: string | undefined): CommandWalker<RuleMatch> {
  const first = patterns[0]!.text;
  return commandWalker<RuleMatch>((run) => programMatch(run, patterns), {
    directory,
    tooDeep: (name) => ({ rule: first, why: `${name} runs a command nested too deeply to read, so what it runs cannot be checked` }),
    onScriptTooLarge: (path) => ({ rule: first, why: `it runs the script ${path}, which is too large to read, so what it runs cannot be checked` }),
    onUnread: (what) => ({ rule: first, why: `it runs ${what}, so what it runs cannot be checked` }),
    // Code that is not shell, and text the parser cannot read, still match by their words in order.
    onCode: (text) => codeMatch(text, patterns),
    fromScript: (path, found) => ({ rule: found.rule, why: `the script ${path} it runs ${found.why === 'it runs that command' ? 'runs that command' : found.why}` }),
  });
}

/** The words of code or loose text, in order: names, paths and flags. */
function codeWords(text: string): string[] {
  return text.split(/[^A-Za-z0-9_./+:=@-]+/).filter((word) => word.length > 0).map((word) => word.toLowerCase());
}

/** Code that names a rule's program and then its words in order, within a few words. */
function codeMatch(text: string, patterns: readonly NeverRunPattern[]): RuleMatch | undefined {
  const words = codeWords(text);
  for (const pattern of patterns) {
    for (let index = 0; index < words.length; index++) {
      if (baseName(words[index]!) !== pattern.program) continue;
      if (inOrder(pattern.words.map((word) => word.toLowerCase()), words.slice(index + 1, index + 1 + CODE_WINDOW))) {
        return { rule: pattern.text, why: 'the code names that command' };
      }
    }
  }
  return undefined;
}

/** Text written to a running process's input: any word of a rule matches, since a shell may receive a command in pieces. */
function pieceMatch(text: string, patterns: readonly NeverRunPattern[]): RuleMatch | undefined {
  const words = new Set(codeWords(text).map(baseName));
  for (const pattern of patterns) {
    if ([pattern.program, ...pattern.words.map((word) => word.toLowerCase())].some((word) => words.has(word))) {
      return { rule: pattern.text, why: 'it writes part of that command to a running process, which may be a shell' };
    }
  }
  return undefined;
}

/** Every `{ command, args[] }` pair in a value, as a tool that runs argv names them (bounded walk). */
function argvPairs(value: unknown, out: Array<{ readonly command: string; readonly args: readonly string[] }>, depth = 0): void {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 64)) argvPairs(item, out, depth + 1); return; }
  const record = value as Record<string, unknown>;
  if (typeof record['command'] === 'string' && Array.isArray(record['args']) && record['args'].every((arg) => typeof arg === 'string')) {
    out.push({ command: record['command'], args: record['args'] as string[] });
  }
  for (const child of Object.values(record).slice(0, 64)) argvPairs(child, out, depth + 1);
}

/** Every exec-style command field (`command`, `cmd`, `commands[]`) in the objects nested in a call's arguments (bounded walk). */
function nestedCommandTexts(value: unknown, out: ShellCommandAt[], depth = 0): void {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 64)) nestedCommandTexts(item, out, depth + 1); return; }
  const record = value as Record<string, unknown>;
  if (depth > 0) out.push(...execShellCommandsAt(record));
  for (const [key, child] of Object.entries(record).slice(0, 64)) {
    // A `commands` list is read whole by execShellCommandsAt; its entries are not walked again.
    if (key !== 'commands') nestedCommandTexts(child, out, depth + 1);
  }
}

/** Field names under which a tool that runs code takes the code. */
const CODE_FIELDS: readonly string[] = ['expression', 'code', 'script', 'source'];

/** The texts one call hands a shell, an interpreter or a running process. */
export interface CallShellTexts {
  /** Each with the directory it names for itself (an exec entry's `cwd`), where a script it runs is read from. */
  readonly commands: readonly ShellCommandAt[];
  readonly argv: readonly { readonly command: string; readonly args: readonly string[] }[];
  readonly code: readonly string[];
  readonly pieces: readonly string[];
}

/**
 * What one call could hand a shell: its shell commands (exec-style fields,
 * installed commands, a command hook, declared command subjects), argv pairs,
 * code for an interpreter (for a tool that runs code), and text written to a
 * running process. No I/O.
 */
export function callShellTexts(toolName: string, args: Record<string, unknown>,
  definition?: Pick<ToolDefinition, 'subjects' | 'sideEffects' | 'tightens'> | undefined): CallShellTexts {
  // A call that only tightens a protection (a never-run rule's own command among its values) runs nothing: a
  // never-run rule never refuses the owner a stricter rule.
  if (definition?.tightens && callOnlyTightens(definition.tightens, args)) return { commands: [], argv: [], code: [], pieces: [] };
  const found: ShellCommandAt[] = execShellCommandsAt(args);
  // Commands nested in a call's input (an operator method's `input`, a remote run's payload) are read the same way.
  nestedCommandTexts(args, found);
  for (const declared of declaredValues(args, definition?.subjects?.commands) ?? []) found.push({ text: declared });
  const hook = args['hookDefinition'];
  if (hook && typeof hook === 'object' && typeof (hook as Record<string, unknown>)['command'] === 'string') found.push({ text: (hook as Record<string, unknown>)['command'] as string });
  const commands = new Map<string, ShellCommandAt>();
  for (const entry of found) commands.set(`${entry.cwd ?? ''}\u0000${entry.text}`, entry);
  const argv: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  argvPairs(args, argv);
  const runsCode = toolName === 'repl' || definition?.sideEffects?.includes('exec') === true;
  const code = runsCode ? CODE_FIELDS.map((field) => args[field]).filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
  const action = typeof args['action'] === 'string' ? args['action'] : typeof args['processAction'] === 'string' ? args['processAction'] : undefined;
  const pieces = action?.toLowerCase() === 'write' && typeof args['data'] === 'string' ? [args['data']] : [];
  return { commands: [...commands.values()], argv, code, pieces };
}

/**
 * The first never-run rule a call matches, or undefined. `patterns` empty
 * costs nothing; `directory` is where a relative script path is read from.
 */
export function neverRunMatchIn(texts: CallShellTexts, patterns: readonly NeverRunPattern[], directory: string | undefined): NeverRunMatch | undefined {
  if (patterns.length === 0) return undefined;
  const walker = neverRunWalker(patterns, directory);
  for (const entry of texts.commands) {
    const found = walker.command(entry.text, entry.cwd);
    if (found) return { ...found, command: entry.text };
  }
  // A program and its argv (`trigger`'s `command` with `args`): no shell reads it, so its words are the argv.
  for (const entry of texts.argv) {
    const found = walker.argv(entry.command, entry.args);
    if (found) return { ...found, command: [entry.command, ...entry.args].join(' ') };
  }
  for (const code of texts.code) {
    const found = codeMatch(code, patterns);
    if (found) return { ...found, command: code.length > 200 ? `${code.slice(0, 200)}...` : code };
  }
  for (const piece of texts.pieces) {
    const found = pieceMatch(piece, patterns);
    if (found) return { ...found, command: piece };
  }
  return undefined;
}
