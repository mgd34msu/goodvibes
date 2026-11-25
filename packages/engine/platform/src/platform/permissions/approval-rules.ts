import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
/**
 * Approval decisions that persist and generalize, the rule side.
 *
 * An approval prompt can offer remember tiers beyond "this session":
 *   - 'exact'        , this exact command (exec)
 *   - 'command-class', this command class, e.g. every `git ...` (exec)
 *   - 'path'         , edits/writes under the asked path's directory
 *   - 'tool'         , always allow/deny this tool in this project; for `capability_run`,
 *                      this one capability (keyed by its id), never every capability
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
import { execContextOf, extractCommandArgs, splitShellCommand } from '../runtime/permissions/rules/prefix.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import { execShellCommands } from '../runtime/permissions/exec-command-text.js';
import { toolAskWords } from './tool-ask-words.js';

/** How far a remembered approval decision reaches. */
export type RememberTier = 'session' | 'exact' | 'command-class' | 'path' | 'tool';

/** Every remember tier, for reading one off a message. */
export const REMEMBER_TIER_VALUES: readonly RememberTier[] = ['session', 'exact', 'command-class', 'path', 'tool'];

/** One offerable remember tier, rendered by whatever surface shows the ask. */
export interface RememberTierOption {
  readonly tier: RememberTier;
  /** What the person reads, e.g. `Any git command in this project` (ask-presentation.ts shows it). */
  readonly label: string;
  /** What the resulting rule matches, stated concretely: the command, the folder, or how long it lasts. */
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
      label: commands.length === 1 ? 'This exact command' : 'These exact commands',
      detail: commands.join(' ; '),
    });
    const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
    if (classes.length > 0) {
      const classOption: RememberTierOption = {
        tier: 'command-class',
        label: `Any ${classes.join(' or ')} command in this project`,
        detail: classes.map((cls) => `${cls} …`).join(' ; '),
      };
      if (classes.every((cls) => exactAnswersForClass(remembered, toolName, cls) >= REPEATED_EXACT_ANSWERS)) options.unshift(classOption);
      else options.push(classOption);
    }
  }

  if ((toolName === 'edit' || toolName === 'write') && paths.length > 0) {
    const dirs = uniqueSorted(paths.map((path) => dirname(path)));
    options.push({
      tier: 'path',
      // The rule is kept for the project it was made in; the folder may be outside it, so the label says where it applies, not where the folder is.
      label: dirs.length === 1 ? `Edits under ${dirs[0]}, while you work in this project` : 'Edits under these folders, while you work in this project',
      detail: dirs.map((dir) => `everything under ${dir}/`).join(' ; '),
    });
  }

  // This session only sits right after the exact command: it lasts the session, where the others are kept.
  const session = sessionScope(toolName, args);
  const exactAt = options.findIndex((option) => option.tier === 'exact');
  options.splice(exactAt + 1, 0, {
    tier: 'session',
    label: `${session}, this session only`,
    detail: 'forgotten when this session ends',
  });
  // A capability call is remembered for that one capability, named by its label: no tier covers every capability
  // (one answer to an outside caller's call would otherwise let every later one in the project run unasked).
  if (toolName === CAPABILITY_RUN_TOOL_NAME) {
    const capability = capabilityOfCall(args);
    // An outside caller's call (the daemon's gate names who asks, `askedBy`): kept for that caller only, named by its name.
    const from = askedByOf(args) !== undefined ? ` from ${askedByNameOf(args) ?? 'this caller'}` : '';
    if (capability) options.push({
      tier: 'tool',
      label: `Any call to ${capability.name}${from} in this project`,
      detail: from ? 'this capability only, asked by this same caller, whatever its inputs, until you remove the rule'
        : 'this capability only, whatever its inputs, until you remove the rule',
    });
    return options;
  }
  // The broadest tier is always last.
  options.push({
    tier: 'tool',
    label: `Any ${toolNoun(toolName)} in this project`,
    detail: 'whatever it names, until you remove the rule',
  });
  return options;
}

/** The tool through which a model, an outside caller or a script runs a capability (tools/capability/definitions.ts). */
const CAPABILITY_RUN_TOOL_NAME = 'capability_run';

/**
 * Who asked for a `capability_run` call, when the daemon's gate decides an outside caller's call (daemon/
 * capability-owner-gate.ts adds it: the kind of door and the principal). A remembered answer to such a call is kept
 * for that caller only, and never settles another's.
 */
function askedByOf(args: Record<string, unknown>): string | undefined {
  const value = args['askedBy'];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * That caller as the owner reads it (`the paired device "build bot"`, `you, on this machine`), which the daemon's gate
 * adds beside `askedBy`: a rule kept for the caller is described by it, never by the key it is matched on.
 */
function askedByNameOf(args: Record<string, unknown>): string | undefined {
  const value = args['askedByName'];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The capability a `capability_run` call is to: its id (what a remembered answer is keyed by) and its label. */
function capabilityOfCall(args: Record<string, unknown>): { readonly id: string; readonly name: string } | undefined {
  const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
  if (!id) return undefined;
  return { id, name: toolAskWords(CAPABILITY_RUN_TOOL_NAME, args)?.subject ?? id };
}

/** What one call of a tool is, as a person names it: never the tool's id ("the exec tool"). */
const TOOL_NOUNS: Readonly<Record<string, string>> = {
  exec: 'command', write: 'file change', edit: 'file change', fetch: 'web request', web_search: 'web search',
  read: 'file read', find: 'file search', analyze: 'code analysis', inspect: 'project inspection',
  agent: 'agent', delegate: 'hand-off', workflow: 'workflow step', mcp: 'tool server call', state: 'saved-state change',
  goodvibes_settings: 'settings change', query: 'question',
};

/** "command", "file change", "web request"; a tool with no noun of its own: "call to <its name>". */
export function toolNoun(toolName: string): string {
  if (Object.hasOwn(TOOL_NOUNS, toolName)) return TOOL_NOUNS[toolName]!;
  const short = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  return `call to ${short}`;
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
  if (toolName === CAPABILITY_RUN_TOOL_NAME) return `Any call to ${capabilityOfCall(args)?.name ?? 'this capability'}${askedByOf(args) !== undefined ? ` from ${askedByNameOf(args) ?? 'this caller'}` : ''}`;
  const commands = extractCommandArgs(args);
  if (toolName === 'exec' && commands.length > 0) {
    if (commands.some(isCompound)) return commands.length === 1 ? 'This exact command' : 'These exact commands';
    const classes = uniqueSorted(commands.map(commandClassOf).filter((cls) => cls.length > 0));
    if (classes.length > 0) return `Any ${classes.join(' or ')} command`;
  }
  const paths = extractPathArgs(args);
  if (execShellCommands(args).length > 0) return 'This exact command';
  const noun = toolNoun(toolName);
  if (paths.length > 0) {
    const lead = noun === 'file change' ? 'Changes to' : noun === 'file read' ? 'Reads of' : `${noun.charAt(0).toUpperCase()}${noun.slice(1)}s on`;
    return `${lead} ${uniqueSorted(paths).join(', ')}`;
  }
  return `Any ${noun}`;
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
  // One capability's calls, never every capability_run call.
  if (toolName === CAPABILITY_RUN_TOOL_NAME) {
    const askedBy = askedByOf(args);
    return `${toolName}:capability:${capabilityOfCall(args)?.id ?? ''}${askedBy !== undefined ? `:asked-by:${askedBy}` : ''}`;
  }
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
    case 'tool': {
      if (toolName === CAPABILITY_RUN_TOOL_NAME) {
        // Keyed by the capability's id: every call to that one capability, whatever its inputs; no rule covers them all.
        const capability = capabilityOfCall(args);
        if (!capability) return null;
        // An outside caller's answer names that caller: it never matches another's call (nor the owner's model's).
        const askedBy = askedByOf(args);
        return {
          type: 'arg-shape',
          id,
          origin: 'user',
          effect,
          toolPattern: toolName,
          argMatchers: { id: capability.id, ...(askedBy !== undefined ? { askedBy } : {}) },
          description: `${effect} every call to ${capability.name}${askedBy !== undefined ? ` from ${askedByNameOf(args) ?? 'one outside caller'}` : ''} in this project`,
        };
      }
      return {
        type: 'prefix',
        id,
        origin: 'user',
        effect,
        toolPattern: toolName,
        description: `${effect} every ${toolName} call in this project`,
      };
    }
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
/** @deprecated Synchronous compatibility; production callers match through compileRules. */
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
        matched = evaluatePrefixRule(rule, toolName, args, undefined, options.projectRoot).matched;
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
      case 'never-run':
        // The gate matches never-run rules itself, before this matcher and in every mode.
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

/** A durable match with the rule that made it. */
export interface CompiledRuleMatch extends DurableRuleMatch {
  readonly rule: PolicyRule;
}

export type CompiledRuleOptions = JudgmentReadingOptions & { readonly projectRoot?: string | undefined; readonly subjects?: CallSubjects | undefined };

/**
 * A rule list compiled once for matching, kept by its owner (the rule store)
 * until a rule changes and handed to each check by reference. A call is matched
 * only against the rules that name its tool or every tool, in list order; that
 * list is built on a tool's first call. Matching is matchDurableRules': a deny
 * wins, then an ask, then an allow.
 */
export interface CompiledRules {
  readonly rules: readonly PolicyRule[];
  match(toolName: string, args: Record<string, unknown>, options?: CompiledRuleOptions): Promise<CompiledRuleMatch | null>;
}

export function compileRules(rules: readonly PolicyRule[]): CompiledRules {
  const list = Object.freeze([...rules]);
  const byTool = new Map<string, readonly PolicyRule[]>();
  const candidates = (toolName: string): readonly PolicyRule[] => {
    let found = byTool.get(toolName);
    if (!found) {
      found = Object.freeze(list.filter((rule) => {
        const pattern = rule.toolPattern;
        return Array.isArray(pattern) ? pattern.includes('*') || pattern.includes(toolName) : pattern === '*' || pattern === toolName;
      }));
      byTool.set(toolName, found);
    }
    return found;
  };
  return Object.freeze({
    rules: list,
    match: (toolName: string, args: Record<string, unknown>, options: CompiledRuleOptions = {}) => matchRuleList(candidates(toolName), toolName, args, options),
  });
}

/**
 * The rules and arguments are the caller's owned copies, so nothing between
 * two synchronous rule checks can change them; the caller's check runs only
 * after an arg-shape rule's await, the one point another writer can run.
 */
async function matchRuleList(
  rules: readonly PolicyRule[],
  toolName: string,
  args: Record<string, unknown>,
  options: CompiledRuleOptions,
): Promise<CompiledRuleMatch | null> {
  const current = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  current();
  const subjects = options.subjects;
  let firstAllow: CompiledRuleMatch | null = null;
  let firstAsk: CompiledRuleMatch | null = null;
  for (const rule of rules) {
    let matched = false;
    switch (rule.type) {
      case 'prefix':
        matched = evaluatePrefixRule(rule, toolName, args, subjects?.commands, options.projectRoot).matched;
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
      case 'never-run':
        // The gate matches never-run rules itself, before this matcher and in every mode.
        matched = false;
        break;
    }
    if (matched) {
      if (rule.effect === 'deny') return { effect: 'deny', ruleId: rule.id, rule };
      if (rule.effect === 'ask') firstAsk ??= { effect: 'ask', ruleId: rule.id, rule };
      else firstAllow ??= { effect: 'allow', ruleId: rule.id, rule };
    }
  }
  return firstAsk ?? firstAllow;
}
