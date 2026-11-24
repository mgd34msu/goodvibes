/**
 * Prefix matching policy rule evaluator.
 *
 * PrefixRule matches tool calls by tool name and optionally the command prefix
 * of the first string argument. Independently testable, no external dependencies.
 */

import type {
  PrefixRule,
  EvaluationStep,
} from '../types.js';
import { resolve } from 'node:path';
import { execShellCommands } from '../exec-command-text.js';

/** Result returned by evaluatePrefixRule. */
export interface PrefixRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesPrefixPattern, Returns true if `toolName` is matched by the rule's
 * `toolPattern` field (which may be a single string, `'*'`, or an array).
 */
function toolMatchesPrefixPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * extractCommandArgs, Extracts EVERY command string from args.
 * Understands the exec tool's real shape (`commands: [{ cmd | cmd_base64 }, ...]`),
 * flat `command`/`cmd` strings and installed commands (a workflow schedule or
 * hook action), all of them at once, so an allow rule must vouch for every
 * command text in the call; falls back to the first string value only for a
 * call that carries no command-bearing field at all.
 */
export function extractCommandArgs(args: Record<string, unknown>): string[] {
  const texts = execShellCommands(args);
  if (texts.length > 0) return texts;
  // A `commands` list that carries no text must not hand rules some other argument (the working directory) to judge.
  if (Array.isArray(args['commands'])) return [];
  for (const v of Object.values(args)) {
    if (typeof v === 'string') return [v];
  }
  return [];
}


/**
 * The shell command split at its top-level control operators (`;`, `&&`, `||`, `|`, `&`, newline).
 * `opaque` is true when the text also carries something that can run or write elsewhere without
 * being a separate segment: a command substitution (backticks, `$(`), a redirection, a subshell,
 * or a quote left open. Quoted text is data, except that backticks and `$(` still run inside double quotes.
 */
export function splitShellCommand(command: string): { readonly segments: readonly string[]; readonly opaque: boolean } {
  const segments: string[] = [];
  let current = '';
  let opaque = false;
  let quote: '' | '\'' | '"' = '';
  const flush = (): void => { segments.push(current.trim()); current = ''; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === '\'') {
      if (ch === '\'') quote = '';
      current += ch;
      continue;
    }
    if (ch === '\\') { current += ch + (command[i + 1] ?? ''); i++; continue; }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) { opaque = true; current += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = '';
      current += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '>') {
      // Joining one output stream to another, or discarding output, runs nothing and writes no file.
      const harmless = /^(?:>&(?:\d+|-)|>>?[ \t]*\/dev\/null)(?=$|[\s;&|])/.exec(command.slice(i));
      if (harmless) { current += harmless[0]; i += harmless[0].length - 1; continue; }
    }
    if (ch === '>' || ch === '<' || ch === '(' || ch === ')') { opaque = true; current += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '\r') { flush(); continue; }
    if (ch === '&' || ch === '|') {
      if (command[i + 1] === ch) i++;
      flush();
      continue;
    }
    current += ch;
  }
  if (quote !== '') opaque = true;
  flush();
  const parts = segments.filter((segment) => segment.length > 0);
  return { segments: parts, opaque };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * What else an exec call fixes besides its command text: where it runs, its environment, whether it
 * detaches, and any file operations run first. An exact rule is bound to this as it was approved.
 */
export function execContextOf(args: Record<string, unknown>): string {
  const commands = Array.isArray(args['commands']) ? args['commands'] as unknown[] : [];
  const perCommand = commands.map((entry) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return { env: record['env'], working_dir: record['working_dir'], background: record['background'], cmd_base64: record['cmd_base64'] };
  });
  const fixed = canonicalJson({ working_dir: args['working_dir'], env: args['env'], file_ops: args['file_ops'], commands: perCommand });
  // A call that fixes none of these is the empty context, however many commands it has.
  return fixed === canonicalJson({ commands: perCommand.map(() => ({})) }) ? '' : fixed;
}

/** Where a project root is unknown, folders are resolved against this stand-in, so `.` and absent still agree. */
const UNKNOWN_ROOT = '/.goodvibes-project-root';

/**
 * A context string from {@link execContextOf} (as a call makes it, or as an exact rule stored it)
 * with every folder resolved against the project root: an absent folder, `.`, `./` and the root's own
 * path are all the root and are left out, a relative folder becomes its absolute path. Two contexts
 * that run in the same place compare equal.
 */
export function resolvedExecContext(context: string, projectRoot?: string): string {
  if (context === '') return '';
  let parsed: unknown;
  try { parsed = JSON.parse(context); } catch { return context; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return context;
  const root = resolve(projectRoot ?? UNKNOWN_ROOT);
  const folder = (value: unknown): unknown => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return value;
    const absolute = value.trim() === '' ? root : resolve(root, value);
    return absolute === root ? undefined : absolute;
  };
  const record = parsed as Record<string, unknown>;
  const commands = Array.isArray(record['commands']) ? record['commands'].map((entry) => {
    const command = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return { ...command, working_dir: folder(command['working_dir']) };
  }) : [];
  return execContextOf({ ...record, working_dir: folder(record['working_dir']), commands });
}

/**
 * evaluatePrefixRule, Evaluates a single PrefixRule against a tool call.
 *
 * Returns `matched: true` only when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. Either no command constraint is specified, OR the call's command
 *      string(s) match the rule's exactCommands / commandPrefixes
 *      (exact commands are literal; prefixes are case-insensitive; allow rules
 *      need EVERY command to match, deny rules need ANY).
 *
 * @param rule    , The PrefixRule to evaluate.
 * @param toolName, Name of the tool being called.
 * @param args    , Arguments passed to the tool.
 */
export function evaluatePrefixRule(
  rule: PrefixRule,
  toolName: string,
  args: Record<string, unknown>,
  /** The commands the tool declares this call runs; read in place of probing argument names. */
  declaredCommands?: readonly string[],
  /** The project the call runs in: an exact rule's folder and the call's are compared resolved against it. */
  projectRoot?: string,
): PrefixRuleResult {
  const toolMatches = toolMatchesPrefixPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  const hasPrefixes = (rule.commandPrefixes?.length ?? 0) > 0;
  const hasExact = (rule.exactCommands?.length ?? 0) > 0;

  // No command constraint, tool name match alone is sufficient
  if (!hasPrefixes && !hasExact) {
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: true,
        detail: `tool "${toolName}" matched (no prefix constraint)`,
      },
    };
  }

  const commandArgs = declaredCommands ? [...declaredCommands] : extractCommandArgs(args);
  if (commandArgs.length === 0) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: false,
        detail: 'no string argument found to match prefix against',
      },
    };
  }

  const classRule = rule.exactCommandMatch === 'command-class';
  const exactLiteral = (command: string): boolean => rule.exactCommands?.some((exact) => command === exact) ?? false;
  // An exact allow holds only for the environment, folder and detachment it was approved with; the
  // folder is compared resolved on both sides, so `.` and no folder are the same place.
  // A deny or ask rule protects: it holds in any context, and any matching command or segment triggers it.
  const contextHolds = rule.effect !== 'allow' || classRule
    || resolvedExecContext(execContextOf(args), projectRoot) === resolvedExecContext(rule.exactContext ?? '', projectRoot);

  const segmentMatches = (command: string, whole = false): boolean => {
    if (whole && exactLiteral(command)) return contextHolds;
    const normalized = command.trim().toLowerCase();
    // Only an explicitly broad class rule may normalize a bare executable.
    // Never lowercase or trim an exact command's arguments or target path.
    if (classRule && normalized.length > 0 && !/\s/.test(normalized)
      && rule.exactCommands?.some((exact) => normalized === exact.trim().toLowerCase())) return true;
    return rule.commandPrefixes?.some((prefix) => normalized.startsWith(prefix.toLowerCase())) ?? false;
  };

  // A prefix or class cannot vouch for what follows a control operator: `git status; rm -rf ~` is not
  // "a git command". An allow needs every segment to match on its own and nothing opaque such as a
  // substitution or redirection; a deny matches when any segment does. A literal exact command is
  // matched whole, as approved.
  const commandMatches = (command: string): boolean => {
    if (exactLiteral(command) && contextHolds) return true;
    const split = splitShellCommand(command);
    if (!split.opaque && split.segments.length <= 1) return segmentMatches(command, true);
    if (rule.effect !== 'allow') return segmentMatches(command, true) || split.segments.some((segment) => segmentMatches(segment));
    return !split.opaque && split.segments.every((segment) => segmentMatches(segment));
  };

  // Effect-aware batch semantics: an allow rule only matches when EVERY
  // command in the call matches (a mixed batch must not ride in on a partial
  // grant); a deny rule matches when ANY command does.
  const matched = rule.effect !== 'allow'
    ? commandArgs.some(commandMatches)
    : commandArgs.every(commandMatches);

  return {
    matched,
    step: {
      layer: 'policy',
      check: `prefix-rule:${rule.id}`,
      matched,
      detail: matched
        ? `command(s) matched rule "${rule.id}" (${rule.effect})`
        : `command(s) did not match [${[...(rule.exactCommands ?? []), ...(rule.commandPrefixes ?? [])].join(', ')}]`,
    },
  };
}
