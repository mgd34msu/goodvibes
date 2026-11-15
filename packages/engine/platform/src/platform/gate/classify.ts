/**
 * Who decides one tool call: a fact code settles, an item only the owner may
 * decide, or a judgment for Jev. Pure: no I/O, no await, no model.
 *
 * The caller gathers the facts it already holds (the tool's declared effects
 * and subjects, the paths classed against the allowed directories, the
 * standing rule that matched, where the instruction came from, whether the
 * turn read untrusted text) and this function applies one order:
 *
 *   1. surface authority (a change asked for on a channel the owner set up is
 *      his to approve; on a surface anyone can write to it is refused), then
 *      the plan posture;
 *   2. yolo runs everything that passed 1;
 *   3. a matching deny or ask rule;
 *   4. the owner-only list;
 *   5. a matching allow rule;
 *   6. the declared-effect defaults: a read inside the allowed directories,
 *      a recoverable write inside them;
 *   7. anything else is a judgment, and only then is a model asked.
 *
 * Untrusted text is never what allows an action: when the turn read some, an
 * allow rule still settles a call that stays on this machine, but a call that
 * can reach outside goes to the judgment (which reads where its content came
 * from) instead.
 */
import { relative, resolve, isAbsolute, sep } from 'node:path';
import type { PermissionCategory, ToolArgumentPath, ToolDecision, ToolDefinition, ToolSideEffect } from '../types/tools.js';
import type { GatePresetName } from './presets.js';
import { effectPermittedForProvenance, surfaceCarriesCommandAuthority, surfaceRequestsReachOwner } from './surface-authority.js';

/**
 * The closed list of what only the owner decides. Jev never approves one, in
 * any mode but yolo; a confident reading cannot move an item off this list.
 */
export type OwnerOnlyKind =
  /** Spending over a limit the owner set. */
  | 'spend-over-limit'
  /** Card entry, CVV, 3-D Secure, CAPTCHA inside a purchase. */
  | 'payment-step'
  /** Deleting work that no undo record, checkpoint or clean git state can bring back. */
  | 'unrecoverable-delete'
  /** Sending as the owner to a recipient not yet allowed. */
  | 'new-recipient'
  /** Sending content derived from untrusted text read this turn. */
  | 'untrusted-derived-send'
  /** Pairing, peer approval, MCP trust or role, channel login or allowlist, a hook, a declared-dangerous tool. */
  | 'grant-access'
  /** A change that loosens a security, judgment or payment setting. */
  | 'loosen-security'
  /** Changing what a contract requires. */
  | 'change-contract'
  /** Killing a session, revoking the shared token, an irreversible cluster operation. */
  | 'irreversible-operator'
  /** The owner's own standing "always ask me" rule matched. */
  | 'standing-ask'
  /** A change asked for on a channel the owner set up, where a message cannot direct one by itself. */
  | 'channel-request';

/** Plain words for each owner-only kind, as the owner and the asking agent read them. */
const OWNER_ONLY_REASONS: Readonly<Record<OwnerOnlyKind, string>> = {
  'spend-over-limit': 'it spends more than a limit you set',
  'payment-step': 'it is a payment step only you can complete',
  'unrecoverable-delete': 'it deletes work that cannot be brought back',
  'new-recipient': 'it sends as you to a recipient not yet allowed',
  'untrusted-derived-send': 'what it sends may come from untrusted text read this turn',
  'grant-access': 'it changes who or what can reach or act for you',
  'loosen-security': 'it loosens a security, judgment or payment setting',
  'change-contract': 'it changes what a contract requires',
  'irreversible-operator': 'it is an operator action that cannot be undone',
  'standing-ask': 'your rule says to ask you about this',
  'channel-request': 'it was asked for in a channel conversation, where a message cannot direct a change by itself',
};

export function ownerOnlyReason(kind: OwnerOnlyKind): string {
  return OWNER_ONLY_REASONS[kind];
}

/** The standing rule, setting or limit that matched the call; a deny or ask is reported over an allow. */
export interface CallRuleFact {
  readonly effect: 'allow' | 'deny' | 'ask';
  /** Where it came from: an owner's remembered answer, this session's answer, managed policy, a per-tool setting, a limit. */
  readonly source: 'user-rule' | 'session' | 'managed-policy' | 'tool-setting' | 'limit';
  /** What it covers, in words: the agent is told this as the limit that decided. */
  readonly description: string;
  readonly id?: string | undefined;
  /** Set when the rule records the owner's answer to this owner-only kind: only such a rule settles one. */
  readonly ownerOnly?: OwnerOnlyKind | undefined;
}

/** One path the call acts on, classed against the allowed directories. */
export interface CallPathFact {
  /** The absolute path, resolved lexically against the working directory. */
  readonly path: string;
  readonly inside: boolean;
}

/** Everything the classifier reads. Each field is a value the caller already holds. */
export interface CallFacts {
  readonly tool: string;
  /** The call's category: the tool's own, narrowed by what these arguments do. */
  readonly category: PermissionCategory;
  /** Declared effects; undefined when the tool declared none (an MCP or plugin tool). */
  readonly sideEffects: readonly ToolSideEffect[] | undefined;
  /** The surface the turn's instruction came from; undefined when the owner gave it directly. */
  readonly surface?: string | undefined;
  readonly rule?: CallRuleFact | undefined;
  /** The paths the call acts on, from the tool's declared subjects; undefined when it declared none. */
  readonly paths?: readonly CallPathFact[] | undefined;
  /** The tool declared that every change this call makes is recorded for undo. */
  readonly recoverable: boolean;
  /** Recognised from the tool, its mode and its arguments (recognizeOwnerOnly). */
  readonly ownerOnly?: OwnerOnlyKind | undefined;
  /** The turn read text anyone can write (the untrusted-content ledger holds an entry for it). */
  readonly untrustedRead: boolean;
}

/** What settled a fact, for the caller's own records. */
export type FactBasis = 'surface' | 'plan' | 'mode' | 'rule' | 'owner-rule' | 'declared-effect';

export type CallClass =
  | { readonly kind: 'fact'; readonly allow: boolean; readonly basis: FactBasis; readonly decision: ToolDecision; readonly rule?: CallRuleFact | undefined }
  | { readonly kind: 'owner-only'; readonly item: OwnerOnlyKind }
  | { readonly kind: 'judgment' };

const LOCAL_EFFECTS: ReadonlySet<ToolSideEffect> = new Set(['read_fs', 'write_fs']);

/** An undeclared tool, or one that runs commands, reaches the network or hands work on, can reach outside. */
function mayReachOutside(facts: CallFacts): boolean {
  return facts.sideEffects === undefined || facts.sideEffects.some((effect) => !LOCAL_EFFECTS.has(effect) && effect !== 'state');
}

function ruleDecision(rule: CallRuleFact, allow: boolean): ToolDecision {
  const decidedBy = rule.source === 'limit' ? 'limit' : 'rule';
  if (allow) return { state: 'allowed', decidedBy, reason: `allowed by ${rule.description}`, limit: rule.description };
  return {
    state: 'refused', decidedBy,
    reason: `refused by ${rule.description}`,
    limit: rule.description,
    next: ['carry on without this call and report that it was not run', 'choose an action the rule does not cover'],
  };
}

/** Classify one call. The first step that settles it decides; see the module comment for the order. */
export function classifyCall(mode: GatePresetName, facts: CallFacts): CallClass {
  if (facts.surface !== undefined && facts.category !== 'read' && !surfaceCarriesCommandAuthority(facts.surface)) {
    // A channel the owner set up: the request becomes his approval, answered on a command surface.
    // Plan mode still refuses below; yolo does not skip it (the surface, not the mode, lacks authority).
    if (mode !== 'plan' && surfaceRequestsReachOwner(facts.surface)) return { kind: 'owner-only', item: 'channel-request' };
    const verdict = effectPermittedForProvenance(facts.category === 'write' ? 'write' : 'exec', { surfaceId: facts.surface });
    const problem = verdict.allowed ? `The ${facts.surface} surface cannot direct changes.` : verdict.problem;
    return { kind: 'fact', allow: false, basis: 'surface', decision: {
      state: 'refused', decidedBy: 'code', reason: problem,
      next: [verdict.allowed ? 'report what was asked and let the owner decide' : verdict.fix, 'carry on with reading and reporting'],
    } };
  }
  if (mode === 'plan' && facts.category !== 'read') {
    return { kind: 'fact', allow: false, basis: 'plan', decision: {
      state: 'refused', decidedBy: 'mode',
      reason: `plan mode is on and ${facts.tool} would change something`,
      next: ['present the plan of changes and wait for the owner to approve it', 'the owner leaves plan mode to run it'],
    } };
  }
  if (mode === 'yolo') {
    return { kind: 'fact', allow: true, basis: 'mode', decision: { state: 'allowed', decidedBy: 'mode', reason: 'yolo mode runs every call' } };
  }
  const rule = facts.rule;
  if (rule?.effect === 'deny') return { kind: 'fact', allow: false, basis: 'rule', rule, decision: ruleDecision(rule, false) };
  if (rule?.effect === 'ask') return { kind: 'owner-only', item: 'standing-ask' };
  if (facts.ownerOnly !== undefined) {
    if (rule?.effect === 'allow' && rule.ownerOnly === facts.ownerOnly) {
      return { kind: 'fact', allow: true, basis: 'owner-rule', rule, decision: {
        state: 'allowed', decidedBy: 'rule', reason: `you allowed this before (${rule.description})`, limit: rule.description,
      } };
    }
    return { kind: 'owner-only', item: facts.ownerOnly };
  }
  if (rule?.effect === 'allow' && !(facts.untrustedRead && mayReachOutside(facts))) {
    return { kind: 'fact', allow: true, basis: 'rule', rule, decision: ruleDecision(rule, true) };
  }
  const effects = facts.sideEffects;
  const paths = facts.paths;
  if (effects !== undefined && paths !== undefined && paths.every((path) => path.inside)) {
    if (facts.category === 'read' && effects.every((effect) => effect === 'read_fs')) {
      return { kind: 'fact', allow: true, basis: 'declared-effect', decision: {
        state: 'allowed', decidedBy: 'code', reason: 'a read inside the allowed directories',
      } };
    }
    if (facts.category === 'write' && paths.length > 0 && facts.recoverable && effects.every((effect) => LOCAL_EFFECTS.has(effect))) {
      return { kind: 'fact', allow: true, basis: 'declared-effect', decision: {
        state: 'allowed', decidedBy: 'code', reason: 'a recoverable change inside the allowed directories',
      } };
    }
  }
  return { kind: 'judgment' };
}

/**
 * Class each path against the allowed directories, lexically. The tools that
 * act on paths resolve links themselves and refuse a landing outside their
 * root (utils/path-safety.ts), so the gate needs no file-system call.
 */
export function classifyPaths(paths: readonly string[], workingDirectory: string | null | undefined,
  directories: readonly string[] = workingDirectory ? [workingDirectory] : []): CallPathFact[] {
  return paths.map((raw) => {
    const path = workingDirectory ? resolve(workingDirectory, raw) : resolve(raw);
    const inside = directories.some((directory) => {
      const rel = relative(resolve(directory), path);
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    });
    return { path, inside };
  });
}

/**
 * The values at one argument path. `undefined` when something sits there that
 * is not a string (the call cannot be read by its declaration); an absent
 * value contributes nothing.
 */
export function argumentValues(args: unknown, path: ToolArgumentPath): string[] | undefined {
  let level: unknown[] = [args];
  for (const segment of path.split('.')) {
    const each = segment.endsWith('[]');
    const key = each ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of level) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) return undefined;
      const child = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
      if (!each) { next.push(child); continue; }
      if (child === undefined) continue;
      if (!Array.isArray(child)) return undefined;
      next.push(...child);
    }
    level = next;
  }
  const values: string[] = [];
  for (const value of level) {
    if (value === undefined) continue;
    if (typeof value !== 'string') return undefined;
    values.push(value);
  }
  return values;
}

/** The values at every declared path; `undefined` when the tool declared none or one cannot be read. */
export function declaredValues(args: Record<string, unknown>, paths: readonly ToolArgumentPath[] | undefined): string[] | undefined {
  if (paths === undefined) return undefined;
  const values: string[] = [];
  for (const path of paths) {
    const found = argumentValues(args, path);
    if (found === undefined) return undefined;
    values.push(...found);
  }
  return values;
}

/** The definition declares the call recoverable and the call carries none of the arguments that would make it not. */
export function declaredRecoverable(definition: Pick<ToolDefinition, 'recoverable'> | undefined, args: Record<string, unknown>): boolean {
  const recoverable = definition?.recoverable;
  if (recoverable === undefined) return false;
  return (recoverable.unless ?? []).every((path) => {
    const found = argumentValues(args, path);
    return found !== undefined && found.length === 0;
  });
}

/** MCP modes that change what a server may do. */
export function changesMcpTrust(toolName: string, args: Record<string, unknown>): boolean {
  return toolName === 'mcp' && (args.mode === 'set-trust' || args.mode === 'set-role' || args.mode === 'approve-quarantine');
}

/** The owner-only kind a call is, from its tool, mode and arguments; undefined when it is none. */
export function recognizeOwnerOnly(toolName: string, args: Record<string, unknown>,
  definition?: Pick<ToolDefinition, 'dangerous'> | undefined): OwnerOnlyKind | undefined {
  if (definition?.dangerous === true || changesMcpTrust(toolName, args)) return 'grant-access';
  return undefined;
}
