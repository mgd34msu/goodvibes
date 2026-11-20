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
 * - each command through `sudo`, `env`, `xargs`, `timeout` and the other
 *   wrappers, into `sh -c` / `bash -c` / `eval` strings, `$(...)` and
 *   backticks, `find -exec`, an `alias` definition, and a shell script the
 *   command runs (`sh publish.sh`, `./publish.sh`, `source x.sh`), read from
 *   disk;
 * - quoting removed the way the shell removes it (`g''it`, `"git"`, `g\it`).
 *
 * A command whose program, or whose arguments after a matching program, are
 * built when it runs (`$(printf git) push`, `git $X`, `xargs git`) matches:
 * code cannot rule out that it runs what the owner said never to run. Text a
 * call writes to a running process's input matches when it carries any word of
 * a rule, since a shell can receive a command in pieces. Code handed to an
 * interpreter (`repl`, a script in another language) matches when it names the
 * rule's words in order within a few words.
 *
 * Not seen: what a program does on its own once started (a git alias defined
 * before the rule, a compiled program, a script in another language that
 * assembles the words), tools of MCP servers, and commands the owner types
 * himself.
 *
 * Cost: nothing for a call when no never-run rule exists or the call carries
 * no command; otherwise one parse of each command text the call carries, and
 * one small file read per shell script a command runs.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { collectCommandNodes, type CommandNode } from '../runtime/permissions/normalization/ast.js';
import { parseCommandAST } from '../runtime/permissions/normalization/parser.js';
import { execShellCommands } from '../runtime/permissions/exec-command-text.js';
import { declaredValues } from './classify.js';
import type { ToolDefinition } from '../types/tools.js';

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

/** Programs that run the command after them: `sudo git push` is `git push`. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'env', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'ionice', 'command', 'builtin', 'exec', 'xargs',
  'chronic', 'unbuffer', 'setsid', 'flock', 'watch', 'caffeinate', 'systemd-run', 'script', 'parallel',
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
  watch: new Set(['-n', '-d']),
};
/** Wrappers whose program receives arguments the command line does not show. */
const INPUT_ARGUMENT_WRAPPERS: ReadonlySet<string> = new Set(['xargs', 'parallel']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'busybox']);
const MAX_DEPTH = 6;
/** A script larger than this is not read; running it matches, since code cannot see what it runs. */
const MAX_SCRIPT_BYTES = 256 * 1024;
/** How many words after a program an interpreter's code may put the rule's other words. */
const CODE_WINDOW = 12;
/** A word code cannot read before the command runs. */
const DYNAMIC = '\u0000dynamic';

/** Reads one rule's text (`git push`) into the program and words it matches; undefined for an empty one. */
export function parseNeverRunPattern(text: string): NeverRunPattern | undefined {
  const words = text.trim().split(/\s+/).map(shellWord).filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  return { text: text.trim(), program: baseName(words[0]!), words: words.slice(1) };
}

/** A word as the shell hands it to a program: quotes and escaping backslashes removed. */
function shellWord(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '\\') { index++; if (index < value.length) out += value[index]; continue; }
    if (char === '\'' || char === '"') continue;
    out += char;
  }
  return out;
}

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1).toLowerCase();
const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
/** Whether a raw token is expanded when the command runs: a variable, a substitution or a glob in it. */
const expandsAtRun = (raw: string): boolean => /\$|`/.test(raw.replace(/'[^']*'/g, ''));

interface Walk {
  readonly patterns: readonly NeverRunPattern[];
  readonly directory: string | undefined;
  /** Scripts already read on this walk, so a script that runs itself is read once. */
  readonly seen: Set<string>;
}

/** The words a command node runs with (redirections left out), with what `$(...)` inside it runs. */
function wordsOf(node: CommandNode): { readonly words: string[]; readonly nested: string[] } {
  const words: string[] = [];
  const nested: string[] = [];
  let skipNext = false;
  for (const token of node.tokens) {
    if (skipNext) { skipNext = false; continue; }
    if (token.type === 'redirect') { skipNext = /^[0-9&]*[<>]{1,2}$/.test(token.value); continue; }
    if (token.type === 'subshell') {
      const inner = token.value.startsWith('$(') ? token.value.slice(2, -1) : token.value.startsWith('`') ? token.value.slice(1, -1) : '';
      if (inner.trim()) nested.push(inner);
      words.push(DYNAMIC);
      continue;
    }
    words.push(expandsAtRun(token.value) ? DYNAMIC : shellWord(token.value));
  }
  return { words, nested };
}

/** Whether `wanted` appears in `words` in order (not necessarily side by side). */
function inOrder(wanted: readonly string[], words: readonly string[]): boolean {
  let at = 0;
  for (const word of words) {
    if (at < wanted.length && word === wanted[at]) at++;
  }
  return at === wanted.length;
}

/** The rule a program run matches: by its words, or because words it runs with are built when it runs. */
function programMatch(name: string, args: readonly string[], inputArgs: boolean, walk: Walk): Omit<NeverRunMatch, 'command'> | undefined {
  for (const pattern of walk.patterns) {
    if (name === DYNAMIC) return { rule: pattern.text, why: 'the program it runs is built when the command runs, so it may be the one this rule names' };
    if (name !== pattern.program) continue;
    const staticArgs = args.filter((word) => word !== DYNAMIC);
    if (inOrder(pattern.words, staticArgs)) return { rule: pattern.text, why: 'it runs that command' };
    if (pattern.words.length > 0 && (inputArgs || staticArgs.length !== args.length)) {
      return { rule: pattern.text, why: 'some of its arguments are built when it runs, so they may be the words this rule names' };
    }
  }
  return undefined;
}

/** A shell script a command runs, read to see what it runs; undefined when it is not a readable small file. */
function readScript(path: string, walk: Walk): string | null | undefined {
  const absolute = isAbsolute(path) ? path : walk.directory ? resolve(walk.directory, path) : undefined;
  if (absolute === undefined || walk.seen.has(absolute)) return undefined;
  walk.seen.add(absolute);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return undefined;
    // A script too large to read here may run anything.
    if (stat.size > MAX_SCRIPT_BYTES) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether a script reads as shell: a shell shebang, or none. */
function isShellScript(text: string): boolean {
  const first = text.slice(0, 200).split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) return true;
  return [...SHELLS].some((shell) => new RegExp(`(^|[/\\s])${shell}(\\s|$)`).test(first));
}

/** What a script's text runs: as shell commands when it is shell, else as code. */
function scriptMatch(path: string, walk: Walk, depth: number): Omit<NeverRunMatch, 'command'> | undefined {
  const text = readScript(path, walk);
  if (text === undefined) return undefined;
  if (text === null) return walk.patterns.length > 0
    ? { rule: walk.patterns[0]!.text, why: `it runs the script ${path}, which is too large to read, so what it runs cannot be checked` } : undefined;
  const found = isShellScript(text) ? walkCommand(text, depth + 1, walk) : codeMatch(text, walk.patterns);
  return found === undefined ? undefined : { rule: found.rule, why: `the script ${path} it runs ${found.why === 'it runs that command' ? 'runs that command' : found.why}` };
}

function walkProgram(name: string, args: readonly string[], inputArgs: boolean, depth: number, walk: Walk): Omit<NeverRunMatch, 'command'> | undefined {
  const found = programMatch(name, args, inputArgs, walk);
  if (found !== undefined) return found;
  if (depth >= MAX_DEPTH) return undefined;
  if (name === 'find') {
    const exec = args.findIndex((word) => word === '-exec' || word === '-execdir' || word === '-ok' || word === '-okdir');
    if (exec >= 0 && args[exec + 1] !== undefined) return walkProgram(baseName(args[exec + 1]!), args.slice(exec + 2), true, depth + 1, walk);
  }
  if (name === 'eval') return walkCommand(args.filter((word) => word !== DYNAMIC).join(' '), depth + 1, walk);
  if (name === 'alias') {
    // `alias p='git push'` defines a name for the command; the definition is read as a command.
    const joined = args.filter((word) => word !== DYNAMIC).join(' ');
    const eq = joined.indexOf('=');
    return eq > 0 ? walkCommand(joined.slice(eq + 1), depth + 1, walk) : undefined;
  }
  if (name === 'source' || name === '.') return args[0] !== undefined && args[0] !== DYNAMIC ? scriptMatch(args[0], walk, depth) : undefined;
  if (SHELLS.has(name)) {
    const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
    if (flag >= 0) {
      const script = args[flag + 1];
      return script !== undefined && script !== DYNAMIC ? walkCommand(script, depth + 1, walk) : undefined;
    }
    const file = args.find((word) => !word.startsWith('-'));
    return file !== undefined && file !== DYNAMIC ? scriptMatch(file, walk, depth) : undefined;
  }
  return undefined;
}

function walkNode(node: CommandNode, depth: number, walk: Walk): Omit<NeverRunMatch, 'command'> | undefined {
  const { words, nested } = wordsOf(node);
  for (const inner of nested) {
    const found = depth < MAX_DEPTH ? walkCommand(inner, depth + 1, walk) : undefined;
    if (found !== undefined) return found;
  }
  let index = 0;
  let inputArgs = false;
  while (index < words.length) {
    while (index < words.length && isAssignment(words[index]!)) index++;
    const word = words[index];
    if (word === undefined) return undefined;
    const name = word === DYNAMIC ? DYNAMIC : baseName(word);
    if (!WRAPPERS.has(name)) {
      const found = walkProgram(name, words.slice(index + 1), inputArgs, depth, walk);
      if (found !== undefined) return found;
      // A program named by a path may be a script the model wrote: read what it runs.
      return word !== DYNAMIC && word.includes('/') ? scriptMatch(word, walk, depth) : undefined;
    }
    if (INPUT_ARGUMENT_WRAPPERS.has(name)) inputArgs = true;
    const valued = WRAPPER_VALUE_FLAGS[name];
    index++;
    while (index < words.length) {
      const next = words[index]!;
      if (valued?.has(next)) { index += 2; continue; }
      if (next.startsWith('-') || isAssignment(next) || (name === 'timeout' && /^[0-9.]+[smhd]?$/.test(next))
        || (name === 'watch' && /^[0-9.]+$/.test(next))) { index++; continue; }
      break;
    }
  }
  return undefined;
}

function walkCommand(command: string, depth: number, walk: Walk): Omit<NeverRunMatch, 'command'> | undefined {
  let nodes: CommandNode[];
  try { nodes = collectCommandNodes(parseCommandAST(command)); }
  catch {
    // Text the parser cannot read is read as code: its words in order still match.
    return codeMatch(command, walk.patterns);
  }
  for (const node of nodes) {
    const found = walkNode(node, depth, walk);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The words of code or loose text, in order: names, paths and flags. */
function codeWords(text: string): string[] {
  return text.split(/[^A-Za-z0-9_./+:=@-]+/).filter((word) => word.length > 0).map((word) => word.toLowerCase());
}

/** Code that names a rule's program and then its words in order, within a few words. */
function codeMatch(text: string, patterns: readonly NeverRunPattern[]): Omit<NeverRunMatch, 'command'> | undefined {
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
function pieceMatch(text: string, patterns: readonly NeverRunPattern[]): Omit<NeverRunMatch, 'command'> | undefined {
  const words = new Set(codeWords(text).map(baseName));
  for (const pattern of patterns) {
    if ([pattern.program, ...pattern.words.map((word) => word.toLowerCase())].some((word) => words.has(word))) {
      return { rule: pattern.text, why: 'it writes part of that command to a running process, which may be a shell' };
    }
  }
  return undefined;
}

/** A program and its argv (`trigger`'s `command` with `args`): no shell reads it, so its words are the argv. */
function argvMatch(command: string, args: readonly string[], walk: Walk): Omit<NeverRunMatch, 'command'> | undefined {
  return walkProgram(baseName(command), args, false, 0, walk) ?? (command.includes('/') ? scriptMatch(command, walk, 0) : undefined);
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
function nestedCommandTexts(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 64)) nestedCommandTexts(item, out, depth + 1); return; }
  const record = value as Record<string, unknown>;
  if (depth > 0) for (const text of execShellCommands(record)) out.add(text);
  for (const [key, child] of Object.entries(record).slice(0, 64)) {
    // A `commands` list is read whole by execShellCommands; its entries are not walked again.
    if (key !== 'commands') nestedCommandTexts(child, out, depth + 1);
  }
}

/** Field names under which a tool that runs code takes the code. */
const CODE_FIELDS: readonly string[] = ['expression', 'code', 'script', 'source'];

/** The texts one call hands a shell, an interpreter or a running process. */
export interface CallShellTexts {
  readonly commands: readonly string[];
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
  definition?: Pick<ToolDefinition, 'subjects' | 'sideEffects'> | undefined): CallShellTexts {
  const commands = new Set(execShellCommands(args));
  // Commands nested in a call's input (an operator method's `input`, a remote run's payload) are read the same way.
  nestedCommandTexts(args, commands);
  for (const declared of declaredValues(args, definition?.subjects?.commands) ?? []) commands.add(declared);
  const hook = args['hookDefinition'];
  if (hook && typeof hook === 'object' && typeof (hook as Record<string, unknown>)['command'] === 'string') commands.add((hook as Record<string, unknown>)['command'] as string);
  const argv: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  argvPairs(args, argv);
  const runsCode = toolName === 'repl' || definition?.sideEffects?.includes('exec') === true;
  const code = runsCode ? CODE_FIELDS.map((field) => args[field]).filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
  const action = typeof args['action'] === 'string' ? args['action'] : typeof args['processAction'] === 'string' ? args['processAction'] : undefined;
  const pieces = action?.toLowerCase() === 'write' && typeof args['data'] === 'string' ? [args['data']] : [];
  return { commands: [...commands], argv, code, pieces };
}

/**
 * The first never-run rule a call matches, or undefined. `patterns` empty
 * costs nothing; `directory` is where a relative script path is read from.
 */
export function neverRunMatchIn(texts: CallShellTexts, patterns: readonly NeverRunPattern[], directory: string | undefined): NeverRunMatch | undefined {
  if (patterns.length === 0) return undefined;
  const walk: Walk = { patterns, directory, seen: new Set() };
  for (const command of texts.commands) {
    const found = walkCommand(command, 0, walk);
    if (found) return { ...found, command };
  }
  for (const entry of texts.argv) {
    const found = argvMatch(entry.command, entry.args, walk);
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
