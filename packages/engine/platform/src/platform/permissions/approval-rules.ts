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
import type { PolicyRule } from '../runtime/permissions/types.js';
import type { OwnerOnlyKind } from '../gate/classify.js';
import {
  evaluateArgShapeRule,
  evaluateArgShapeRuleAsync,
  evaluateNetworkScopeRule,
  evaluatePathScopeRule,
  evaluatePrefixRule,
} from '../runtime/permissions/rules/index.js';
import { execContextOf, extractCommandArgs, splitShellCommand } from '../runtime/permissions/rules/prefix.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';

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
export function buildRememberOptions(toolName: string, args: Record<string, unknown>): RememberTierOption[] {
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
      options.push({
        tier: 'command-class',
        label: `every ${classes.join(' / ')} command`,
        detail: classes.map((cls) => `${cls} ...`).join(' ; '),
      });
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
  if (paths.length > 0) return `${toolName} on ${uniqueSorted(paths).join(', ')}`;
  if (typeof args['command'] === 'string') return `this exact ${toolName} command`;
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
  if (paths.length > 0) return `${toolName}:path:${JSON.stringify(uniqueSorted(paths))}`;
  if (typeof args['command'] === 'string') return `${toolName}:${args['command']}`;
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
  readonly effect: 'allow' | 'deny';
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
  readonly effect: 'allow' | 'deny';
  readonly ruleId: string;
}

/**
 * Evaluation of durable user rules against a call, the lightweight matcher
 * alongside explicit session decisions (it must work with the policy engine
 * flag on OR off, so it does not go through the full layered evaluator).
 * A matching deny wins over any matching allow, whatever their order, so a
 * later "deny always" is enforced even under an older, broader allow; among
 * rules of one effect the first match is reported.
 */
/** @deprecated Synchronous compatibility; production callers use matchDurableRulesAsync. */
export function matchDurableRules(
  rules: readonly PolicyRule[],
  toolName: string,
  args: Record<string, unknown>,
  options: { readonly projectRoot?: string | undefined } = {},
): DurableRuleMatch | null {
  let firstAllow: DurableRuleMatch | null = null;
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
      firstAllow ??= { effect: 'allow', ruleId: rule.id };
    }
  }
  return firstAllow;
}

export async function matchDurableRulesAsync(
  rules: readonly PolicyRule[],
  toolName: string,
  args: Record<string, unknown>,
  options: JudgmentReadingOptions & { readonly projectRoot?: string | undefined } = {},
): Promise<DurableRuleMatch | null> {
  const before = JSON.stringify([rules, args, options.projectRoot]);
  const current = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (JSON.stringify([rules, args, options.projectRoot]) !== before) throw new Error('Durable permission rules changed while reading');
  };
  current();
  let firstAllow: DurableRuleMatch | null = null;
  for (const rule of rules) {
    let matched = false;
    switch (rule.type) {
      case 'prefix':
        matched = evaluatePrefixRule(rule, toolName, args).matched;
        break;
      case 'arg-shape':
        matched = (await evaluateArgShapeRuleAsync(rule, toolName, args, { signal: options.signal, assertCurrent: current })).matched;
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
    current();
    if (matched) {
      if (rule.effect === 'deny') return { effect: 'deny', ruleId: rule.id };
      firstAllow ??= { effect: 'allow', ruleId: rule.id };
    }
  }
  return firstAllow;
}
