import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
/**
 * Approval decisions that persist and generalize, the rule side.
 *
 * An approval prompt can offer remember tiers beyond "this session":
 *   - 'exact'        , this exact command (exec)
 *   - 'command-class', this command class, e.g. every `git ...` (exec)
 *   - 'path'         , edits/writes under the asked path's directory
 *   - 'tool'         , always allow/deny this tool in this project
 *   - 'session'      , the classic in-memory session cache only
 *
 * A tiered decision becomes a durable user-origin PolicyRule (the same shape
 * evaluateRuntimePolicy consults), stored with the project root it was made in
 * and matched live only in that project. The
 * session approval map holds only session-tier decisions. The tier options
 * ride on the broker's ask payload so ANY surface can offer them.
 */

import { dirname } from 'node:path';
import type { CallSubjects, PolicyRule } from '../runtime/permissions/types.js';
import type { OwnerOnlyKind } from '../gate/classify.js';
import {
  evaluateArgShapeRule,
  evaluateArgShapeRuleAsync,
  evaluateNetworkScopeRule,
  evaluatePathScopeRule,
  evaluatePrefixRule,
} from '../runtime/permissions/rules/index.js';
import { evaluatePrefixRule, execContextOf, extractCommandArgs, splitShellCommand } from '../runtime/permissions/rules/prefix.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import { execShellCommands } from '../runtime/permissions/exec-command-text.js';

/** How far a remembered approval decision reaches. */
export type RememberTier = 'session' | 'exact' | 'command-class' | 'path' | 'tool';

/** One offerable remember tier, rendered by whatever surface shows the ask. */
export interface RememberTierOption {
  readonly tier: RememberTier;
  /** Human-readable option label, e.g. `Always allow git commands`. */
  readonly label: string;
  /** What the resulting durable rule will match, stated concretely. */
  readonly detail: string;
}

/** First whitespace token of a command, its class (git, npm, bun, ...). */
export function commandClassOf(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * The remember tiers that make sense for this call, most specific first.
 * 'session' is always offered; surfaces may also offer plain one-time
 * approve/deny (a decision with no remember at all).
 */
export function buildRememberOptions(toolName: string, args: Record<string, unknown>,
  /** The rules already remembered in this project; three exact answers for one command class put the class tier first. */
  remembered: readonly PolicyRule[] = []): RememberTierOption[] {
  const options: RememberTierOption[] = [];
  const commands = extractCommandArgs(args);
  const paths = extractPathArgs(args);

  if (toolName === 'exec' && commands.length > 0) {
    options.push({
      tier: 'exact',
      label: commands.length === 1 ? 'this exact command' : 'these exact commands',
      detail: commands.join(' ; '),
    });
    const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
    if (classes.length > 0) {
      const classOption: RememberTierOption = {
        tier: 'command-class',
        label: `every ${classes.join(' / ')} command`,
        detail: classes.map((cls) => `${cls} ...`).join(' ; '),
      };
      if (classes.every((cls) => exactAnswersForClass(remembered, toolName, cls) >= REPEATED_EXACT_ANSWERS)) options.unshift(classOption);
      else options.push(classOption);
    }
  }

  if ((toolName === 'edit' || toolName === 'write') && paths.length > 0) {
    const dirs = uniqueSorted(paths.map((path) => dirname(path)));
    options.push({
      tier: 'path',
      label: dirs.length === 1 ? `edits under ${dirs[0]}` : 'edits under these directories',
      detail: dirs.map((dir) => `${dir}/**`).join(' ; '),
    });
  }

  options.push({
    tier: 'tool',
    label: `always for the ${toolName} tool in this project`,
    detail: `every ${toolName} call, any arguments`,
  });
  const session = sessionScope(toolName, args);
  options.push({
    tier: 'session',
    label: `${session} this session`,
    detail: 'in-memory only; forgotten when the session ends',
  });
  return options;
}

/** Exact answers for one command class after which the class tier is offered first. */
const REPEATED_EXACT_ANSWERS = 3;

/** How many remembered exact-command rules of this tool name a command of this class. */
function exactAnswersForClass(remembered: readonly PolicyRule[], toolName: string, cls: string): number {
  return remembered.filter((rule) => rule.type === 'prefix' && rule.toolPattern === toolName
    && rule.exactCommandMatch === undefined && rule.commandPrefixes === undefined
    && (rule.exactCommands ?? []).some((command) => commandClassOf(command) === cls)).length;
}

/** The tools a rule names, or null for a wildcard. */
function ruleTools(rule: PolicyRule): readonly string[] | null {
  const pattern = rule.toolPattern;
  const tools = Array.isArray(pattern) ? pattern : [pattern];
  return tools.includes('*') ? null : tools;
}

/**
 * Whether `broader`, a remembered rule, already decides every call `narrower`
 * decides, the same way: same effect and owner-only marker, and a whole-tool
 * rule over the same tools, a command class over exact commands it matches,
 * or a directory over paths inside it. Used when an answer is remembered, so the
 * store neither keeps rules a newer one covers nor writes one already covered.
 */
export function ruleCovers(broader: PolicyRule, narrower: PolicyRule): boolean {
  if (broader.effect !== narrower.effect || broader.ownerOnly !== narrower.ownerOnly) return false;
  if (broader.origin !== 'user' || narrower.origin !== 'user') return false;
  const broadTools = ruleTools(broader), narrowTools = ruleTools(narrower);
  if (broadTools !== null && (narrowTools === null || !narrowTools.every((tool) => broadTools.includes(tool)))) return false;
  if (broader.type === 'prefix' && (broader.commandPrefixes?.length ?? 0) === 0 && (broader.exactCommands?.length ?? 0) === 0) {
    return narrower.type === 'prefix' || narrower.type === 'path-scope';
  }
  if (broader.type === 'prefix' && broader.exactCommandMatch === 'command-class' && narrower.type === 'prefix') {
    const exact = narrower.exactCommands ?? [];
    // Covered only when the class rule itself decides each exact command: a class allow does not
    // reach a command with a pipe, a second command of another class, a redirection or a
    // substitution, so the exact answer for `npm test 2>&1 | tee log` stays. One match per stored
    // exact command, at answer time only.
    const tools = narrowTools ?? ['*'];
    return narrower.exactCommandMatch === undefined && narrower.commandPrefixes === undefined && exact.length > 0
      && exact.every((command) => tools.every((tool) => evaluatePrefixRule(broader, tool, {}, [command]).matched));
  }
  if (broader.type === 'path-scope' && narrower.type === 'path-scope') {
    const dirs = broader.pathPatterns.filter((pattern) => pattern.endsWith('/**')).map((pattern) => pattern.slice(0, -3));
    return narrower.pathPatterns.every((pattern) => pattern.endsWith('/**')
      && dirs.some((dir) => pattern.slice(0, -3) === dir || pattern.startsWith(`${dir}/`)));
  }
  if (broader.type === 'prefix' && narrower.type === 'prefix' && broader.exactCommandMatch === undefined
    && broader.commandPrefixes === undefined && narrower.commandPrefixes === undefined && narrower.exactCommandMatch === undefined) {
    const exact = broader.exactCommands ?? [];
    return (narrower.exactCommands ?? []).length > 0 && (narrower.exactCommands ?? []).every((command) => exact.includes(command))
      && (broader.exactContext ?? null) === (narrower.exactContext ?? null);
  }
  return false;
}

/**
 * What a session-tier answer covers, in words, exactly as `sessionApprovalKey` keys it: the command
 * class, the touched paths, one command, or the whole tool.
 */
function sessionScope(toolName: string, args: Record<string, unknown>): string {
  const commands = extractCommandArgs(args);
  if (toolName === 'exec' && commands.length > 0) {
    if (commands.some(isCompound)) return commands.length === 1 ? 'this exact command' : 'these exact commands';
    const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
    if (classes.length > 0) return `every ${classes.join(' / ')} command`;
  }
  const paths = extractPathArgs(args);
  if (execShellCommands(args).length > 0) return `this exact ${toolName} command`;
  if (paths.length > 0) return `${toolName} on ${uniqueSorted(paths).join(', ')}`;
  return `every ${toolName} call`;
}

/** A command with a control operator, substitution or redirection is more than its first word. */
function isCompound(command: string): boolean {
  const split = splitShellCommand(command);
  return split.opaque || split.segments.length > 1;
}

/**
 * The key a session-tier answer is stored and looked up under. A command class covers every simple
 * command of the class; a compound command is keyed exactly, so `git status; rm -rf ~` is never
 * covered by an answer about `git status`.
 */
export function sessionApprovalKey(toolName: string, args: Record<string, unknown>): string {
  const commands = extractCommandArgs(args);
  if (toolName === 'exec' && commands.length > 0) {
    if (commands.some(isCompound)) return `${toolName}:exact:${JSON.stringify(commands)}`;
    const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
    if (classes.length > 0) return `${toolName}:class:${classes.join('+')}`;
  }
  const paths = extractPathArgs(args);
  // Every command the call carries (a workflow schedule's or hook action's installed command
  // included) is in the key, so an answer about one command never covers a call that carries another.
  const shell = execShellCommands(args);
  if (shell.length > 0) return `${toolName}:command:${JSON.stringify({ commands: shell, paths: uniqueSorted(paths) })}`;
  if (paths.length > 0) return `${toolName}:path:${JSON.stringify(uniqueSorted(paths))}`;
  return toolName;
}

/**
 * Build the durable user-origin rule a tiered decision persists.
 * Returns null for 'session' (cache-only) or when the tier cannot be
 * derived from the call's arguments (e.g. 'path' with no path args).
 */
export function buildDurableRuleForDecision(input: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly tier: RememberTier;
  readonly effect: PolicyRule['effect'];
  readonly now?: number | undefined;
  /** The owner-only kind the owner answered; the rule then settles that kind too. */
  readonly ownerOnly?: OwnerOnlyKind | undefined;
}): PolicyRule | null {
  const rule = durableRuleFor(input);
  return rule && input.ownerOnly !== undefined ? { ...rule, ownerOnly: input.ownerOnly } : rule;
}

function durableRuleFor(input: Parameters<typeof buildDurableRuleForDecision>[0]): PolicyRule | null {
  const { toolName, args, tier, effect } = input;
  const at = input.now ?? Date.now();
  const id = `user-${tier}-${toolName}-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const commands = extractCommandArgs(args);
  const paths = extractPathArgs(args);

  switch (tier) {
    case 'session':
      return null;
    case 'exact': {
      if (commands.length === 0) return null;
      return {
        type: 'prefix',
        id,
        origin: 'user',
        effect,
        toolPattern: toolName,
        exactCommands: uniqueSorted(commands),
        exactContext: execContextOf(args),
        description: `${effect} exactly: ${commands.join(' ; ')}`,
      };
    }
    case 'command-class': {
      const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
      if (classes.length === 0) return null;
      return {
        type: 'prefix',
        id,
        origin: 'user',
        effect,
        toolPattern: toolName,
        // Token boundary: `git ` prefixes match every git invocation with
        // arguments; the bare class name is matched exactly so `git` alone is
        // covered but `gitfoo ...` never is.
        commandPrefixes: classes.map((cls) => `${cls} `),
        exactCommands: classes,
        exactCommandMatch: 'command-class',
        description: `${effect} the ${classes.join('/')} command class`,
      };
    }
    case 'path': {
      if (paths.length === 0) return null;
      const dirs = uniqueSorted(paths.map((path) => dirname(path)));
      return {
        type: 'path-scope',
        id,
        origin: 'user',
        effect,
        toolPattern: ['edit', 'write'],
        pathPatterns: dirs.map((dir) => `${dir}/**`),
        description: `${effect} edits under ${dirs.join(', ')}`,
      };
    }
    case 'tool':
      return {
        type: 'prefix',
        id,
        origin: 'user',
        effect,
        toolPattern: toolName,
        description: `${effect} every ${toolName} call in this project`,
      };
    default:
      return null;
  }
}

export interface DurableRuleMatch {
  readonly effect: PolicyRule['effect'];
  readonly ruleId: string;
}

/**
 * Evaluation of durable user rules against a call, the lightweight matcher
 * alongside explicit session decisions (it must work with the policy engine
 * flag on OR off, so it does not go through the full layered evaluator).
 * A matching deny wins over any matching ask or allow, and an ask over an
 * allow, whatever their order, so a later "deny always" or "always ask me" is
 * enforced even under an older, broader allow; among rules of one effect the
 * first match is reported.
 */
/** @deprecated Synchronous compatibility; production callers use matchDurableRulesAsync. */
export function matchDurableRules(
  rules: readonly PolicyRule[],
  toolName: string,
  args: Record<string, unknown>,
  options: { readonly projectRoot?: string | undefined } = {},
): DurableRuleMatch | null {
  let firstAllow: DurableRuleMatch | null = null;
  let firstAsk: DurableRuleMatch | null = null;
  for (const rule of rules) {
    let matched = false;
    switch (rule.type) {
      case 'prefix':
        matched = evaluatePrefixRule(rule, toolName, args).matched;
        break;
      case 'arg-shape':
        matched = evaluateArgShapeRule(rule, toolName, args).matched;
        break;
      case 'path-scope':
        matched = evaluatePathScopeRule(rule, toolName, args, options.projectRoot).matched;
        break;
      case 'network-scope':
        matched = evaluateNetworkScopeRule(rule, toolName, args).matched;
        break;
      case 'mode-constraint':
        // Mode-constraint rules are mode-layer policy, not approval-derived,
        // no remember tier produces one, and mode handling already lives in
        // checkDetailed before this matcher runs.
        matched = false;
        break;
    }
    if (matched) {
      if (rule.effect === 'deny') return { effect: 'deny', ruleId: rule.id };
      if (rule.effect === 'ask') firstAsk ??= { effect: 'ask', ruleId: rule.id };
      else firstAllow ??= { effect: 'allow', ruleId: rule.id };
    }
  }
  return firstAsk ?? firstAllow;
}

/**
 * The rules and arguments are the caller's owned copies, so nothing between
 * two synchronous rule checks can change them; the caller's check runs only
 * after an arg-shape rule's await, the one point another writer can run.
 */
export async function matchDurableRulesAsync(
  rules: readonly PolicyRule[],
  toolName: string,
  args: Record<string, unknown>,
  options: JudgmentReadingOptions & { readonly projectRoot?: string | undefined; readonly subjects?: CallSubjects | undefined } = {},
): Promise<DurableRuleMatch | null> {
  const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  current();
  const subjects = options.subjects;
  let firstAllow: DurableRuleMatch | null = null;
  let firstAsk: DurableRuleMatch | null = null;
  for (const rule of rules) {
    let matched = false;
    switch (rule.type) {
      case 'prefix':
        matched = evaluatePrefixRule(rule, toolName, args, subjects?.commands).matched;
        break;
      case 'arg-shape':
        matched = (await evaluateArgShapeRuleAsync(rule, toolName, args, { signal: options.signal, assertCurrent: current })).matched;
        current();
        break;
      case 'path-scope':
        matched = evaluatePathScopeRule(rule, toolName, args, options.projectRoot, subjects?.paths).matched;
        break;
      case 'network-scope':
        matched = evaluateNetworkScopeRule(rule, toolName, args, subjects?.hosts).matched;
        break;
      case 'mode-constraint':
        // Mode-constraint rules are mode-layer policy, not approval-derived,
        // no remember tier produces one, and mode handling already lives in
        // checkDetailed before this matcher runs.
        matched = false;
        break;
    }
    if (matched) {
      if (rule.effect === 'deny') return { effect: 'deny', ruleId: rule.id };
      if (rule.effect === 'ask') firstAsk ??= { effect: 'ask', ruleId: rule.id };
      else firstAllow ??= { effect: 'allow', ruleId: rule.id };
    }
  }
  return firstAsk ?? firstAllow;
}
