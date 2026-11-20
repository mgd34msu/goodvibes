/**
 * Who decides one tool call: a fact code settles, an item only the owner may
 * decide, or a judgment for Jev. Pure: no I/O, no await, no model.
 *
 * The caller gathers the facts it already holds (the tool's declared effects
 * and subjects, the paths classed against the allowed directories, the
 * standing rule that matched, where the instruction came from, whether the
 * turn read untrusted text) and this function applies one order:
 *
 *   0. an act only the owner performs himself (answering an approval put to
 *      him, granting access through an operator method) is refused to a
 *      model's call in every mode, yolo included: whoever approved the call,
 *      the daemon refuses it from a model;
 *   1. surface authority (a change asked for on a channel the owner set up is
 *      his to approve; on a surface anyone can write to it is refused; a turn
 *      a channel's guest started runs only plain reads without him), then
 *      the plan posture;
 *   2. yolo runs everything that passed 1;
 *   3. a matching deny or ask rule;
 *   4. the owner-only list, recognised by code from the call and the facts
 *      the caller holds (recognizeOwnerOnly), never from a model;
 *   5. a matching allow rule;
 *   6. the declared-effect defaults: a read inside the allowed directories,
 *      a read of the app's own state, a call its registration declared
 *      read-only, a recoverable write inside the directories;
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
import { effectPermittedForProvenance, isGuestSurfaceId, surfaceCarriesCommandAuthority, surfaceRequestsReachOwner } from './surface-authority.js';
import { execShellCommands } from '../runtime/permissions/exec-command-text.js';
import { fileOperationDestroys, unrecoverableDeletionIn } from './unrecoverable-commands.js';

/**
 * The closed list of what only the owner decides. Jev never approves one, in
 * any mode but yolo; a confident reading cannot move an item off this list.
 */
export type OwnerOnlyKind =
  /**
   * Spending over a limit the owner set. Recognised by the payments layer once
   * it has read the checkout's total (payments/decide.ts): the gate cannot know
   * a total before the page is read. The purchase window puts it to the owner
   * in every mode; answering it is an owner act a model is refused.
   */
  | 'spend-over-limit'
  /**
   * Card security code, 3-D Secure, CAPTCHA inside a purchase. Recognised by
   * the payments layer as the checkout reaches it (a security-code request, a
   * challenge pause); the owner completes it, a model is refused.
   */
  | 'payment-step'
  /**
   * Deleting or overwriting what no undo record keeps: a command the exec
   * rules recognise (gate/unrecoverable-commands.ts), an exec file operation
   * that deletes or overwrites, or a confident reading that a call destroys
   * something that cannot be brought back.
   */
  | 'unrecoverable-delete'
  /**
   * Sending as the owner to a recipient that is neither one of his configured
   * destinations nor one he allowed: the tool declares where its recipients
   * sit (`subjects.recipients`, `ownerDecisions.recipients`), or code reads
   * them from a call no declaration covers (gate/send-recipients.ts: a shell
   * command that mails or posts to a messaging service, a `fetch` to one, an
   * MCP or plugin tool's `to`/`cc`/`bcc`/`recipients`/`attendees` arguments).
   */
  | 'new-recipient'
  /** Sending content derived from untrusted text read this turn. */
  | 'untrusted-derived-send'
  /** Pairing, peer approval, MCP trust or role, channel login or allowlist, a hook, a declared-dangerous tool. */
  | 'grant-access'
  /** A change that loosens a security, judgment or payment setting. */
  | 'loosen-security'
  /** Changing what a contract requires: an operator method the catalog declares `changesContract`. */
  | 'change-contract'
  /**
   * An operator method the catalog declares `irreversible` (killing a session,
   * deleting a record nothing restores). Revoking the shared token and the
   * other access acts are `owner-act`, refused to a model outright.
   */
  | 'irreversible-operator'
  /** The owner's own standing "always ask me" rule matched. */
  | 'standing-ask'
  /** A change asked for on a channel the owner set up, where a message cannot direct one by itself. */
  | 'channel-request'
  /**
   * An act the owner performs himself: answering an approval or a purchase window
   * put to him, granting or withdrawing access through an operator method the
   * catalog declares `ownerOnly`. A model's call is refused, not asked about.
   */
  | 'owner-act';

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
  'owner-act': 'only you do this yourself, in your own app',
};

export function ownerOnlyReason(kind: OwnerOnlyKind): string {
  return OWNER_ONLY_REASONS[kind];
}

/** Every owner-only kind, for validating one that arrives over the wire. */
export const OWNER_ONLY_KINDS = Object.freeze(Object.keys(OWNER_ONLY_REASONS)) as readonly OwnerOnlyKind[];

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
  /**
   * The tool's registration declared this exact call read-only (its input
   * projection said so, ToolRegistry.isPreparedReadOnly): the registration,
   * not a reading, owns that fact.
   */
  readonly declaredReadOnly?: boolean | undefined;
}

/** What settled a fact, for the caller's own records. */
export type FactBasis = 'surface' | 'plan' | 'mode' | 'rule' | 'owner-rule' | 'declared-effect' | 'owner-act';

export type CallClass =
  | { readonly kind: 'fact'; readonly allow: boolean; readonly basis: FactBasis; readonly decision: ToolDecision; readonly rule?: CallRuleFact | undefined }
  | { readonly kind: 'owner-only'; readonly item: OwnerOnlyKind }
  | { readonly kind: 'judgment' };

const LOCAL_EFFECTS: ReadonlySet<ToolSideEffect> = new Set(['read_fs', 'write_fs']);
/** What a read may declare and still stay on this machine: files and the app's own state. */
const LOCAL_READ_EFFECTS: ReadonlySet<ToolSideEffect> = new Set(['read_fs', 'state']);

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

/** A read its declaration settles: files and the app's own state only (files declared and inside), or a call declared read-only that runs no command. */
function readSettledByDeclaration(facts: CallFacts): boolean {
  const effects = facts.sideEffects;
  if (facts.category !== 'read' || effects === undefined) return false;
  if (!effects.every((effect) => LOCAL_READ_EFFECTS.has(effect)) && !(facts.declaredReadOnly === true && !effects.includes('exec'))) return false;
  return !effects.includes('read_fs') || (facts.paths !== undefined && facts.paths.every((path) => path.inside));
}

/**
 * A plain read, what a guest's turn runs without asking: settled by its
 * declaration, reaching nothing outside this machine (no network) and reading
 * none of the app's own state (the owner's memory, inbox, profile, sessions).
 */
function plainRead(facts: CallFacts): boolean {
  return readSettledByDeclaration(facts) && !facts.sideEffects!.some((effect) => effect === 'network' || effect === 'state');
}

/** Classify one call. The first step that settles it decides; see the module comment for the order. */
export function classifyCall(mode: GatePresetName, facts: CallFacts): CallClass {
  if (facts.ownerOnly === 'owner-act') {
    return { kind: 'fact', allow: false, basis: 'owner-act', decision: {
      state: 'refused', decidedBy: 'code',
      reason: `${facts.tool} would do something only the owner does himself (answer what was put to him, or grant or withdraw access)`,
      next: ['do not call it again', 'tell the owner what is waiting; he answers it in his own app (the approval prompt, /approval, the web UI)'],
    } };
  }
  // A guest's turn (someone a channel admits who is not its owner) may read and
  // answer: a plain read (files inside the allowed directories, see plainRead)
  // runs; every other call is the owner's to approve, in every mode and with or
  // without a decision model, as a change asked for on a channel is.
  if (isGuestSurfaceId(facts.surface) && facts.category === 'read' && !plainRead(facts)) {
    return { kind: 'owner-only', item: 'channel-request' };
  }
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
  // A read is settled by its declaration, as plan mode settles it: one that
  // declares only files and the app's own state, or a call its registration
  // declared read-only (it changes and sends nothing, whatever it reads from).
  // A read of files is settled only when its files are declared and inside.
  if (readSettledByDeclaration(facts)) {
    const readsFiles = effects!.includes('read_fs');
    return { kind: 'fact', allow: true, basis: 'declared-effect', decision: {
      state: 'allowed', decidedBy: 'code',
      reason: readsFiles ? 'a read inside the allowed directories'
        : facts.declaredReadOnly === true ? 'a call its tool declared read-only' : 'a read of the app\'s own state',
    } };
  }
  if (effects !== undefined && paths !== undefined && paths.every((path) => path.inside)) {
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

/** Facts about a call the caller read from its owners, beyond the tool, mode and arguments. */
export interface OwnerOnlyCallFacts {
  /** The call writes a setting, and the key's declared loosening rule says this change loosens it (config-key-facts.ts). */
  readonly loosensSetting?: boolean | undefined;
  /**
   * The call sends as the owner to a recipient that is not one of his own
   * configured destinations and that he has not allowed (callRecipients, read
   * against his settings and answers by the caller).
   */
  readonly newRecipient?: boolean | undefined;
}

/** The definition fields the owner-only list is recognised from. */
export type OwnerOnlyDefinition = Pick<ToolDefinition, 'dangerous' | 'ownerActs' | 'ownerDecisions' | 'subjects' | 'sideEffects'>;

/** Whether the value the call gives `field` is one of `values`; a value that cannot be read counts as one (fails closed). */
function namesOneOf(args: Record<string, unknown>, field: string, values: readonly string[] | undefined): boolean {
  if (values === undefined || values.length === 0) return false;
  const named = argumentValues(args, field);
  // Ids are compared ignoring case and spaces, as the tools that take them resolve them.
  const declared = new Set(values.map((value) => value.trim().toLowerCase()));
  return named === undefined || named.some((value) => declared.has(value.trim().toLowerCase()));
}

/**
 * The shell commands a call runs or installs, for a tool that runs commands
 * (`exec`, a tool declaring the `exec` effect) or declares where its commands
 * sit; empty for any other tool.
 */
export function callCommands(toolName: string, args: Record<string, unknown>, definition?: Pick<ToolDefinition, 'subjects' | 'sideEffects'> | undefined): string[] {
  const declared = declaredValues(args, definition?.subjects?.commands) ?? [];
  const runs = toolName === 'exec' || definition?.sideEffects?.includes('exec') === true;
  return runs ? [...new Set([...execShellCommands(args), ...declared])] : declared;
}

/**
 * The recipients a call sends to, from the tool's declared recipient paths
 * (`subjects.recipients`, and `ownerDecisions.recipients` for the value its
 * dispatch field names). Empty for a call that sends to no chosen recipient;
 * undefined when a declared path holds something that is not text (it cannot
 * be read, so it is treated as a recipient nobody allowed).
 */
export function callRecipients(args: Record<string, unknown>, definition?: Pick<ToolDefinition, 'subjects' | 'ownerDecisions'> | undefined): string[] | undefined {
  const paths = [...(definition?.subjects?.recipients ?? [])];
  const decisions = definition?.ownerDecisions;
  if (decisions?.recipients !== undefined) {
    const named = argumentValues(args, decisions.field);
    if (named === undefined) return undefined;
    for (const value of named) {
      const key = Object.keys(decisions.recipients).find((candidate) => candidate.trim().toLowerCase() === value.trim().toLowerCase());
      if (key !== undefined) paths.push(...decisions.recipients[key]!);
    }
  }
  if (paths.length === 0) return [];
  const values = declaredValues(args, paths);
  return values?.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** The owner-only kind a call is, from its tool, mode, arguments and the facts its caller read; undefined when it is none. */
export function recognizeOwnerOnly(toolName: string, args: Record<string, unknown>,
  definition?: OwnerOnlyDefinition | undefined, facts: OwnerOnlyCallFacts = {}): OwnerOnlyKind | undefined {
  const acts = definition?.ownerActs;
  // A value that cannot be read is taken as an owner act: the declaration fails closed.
  if (acts !== undefined && namesOneOf(args, acts.field, acts.values)) return 'owner-act';
  if (definition?.dangerous === true || changesMcpTrust(toolName, args)) return 'grant-access';
  if (facts.loosensSetting === true) return 'loosen-security';
  const decisions = definition?.ownerDecisions;
  if (decisions !== undefined && namesOneOf(args, decisions.field, decisions.contractChanges)) return 'change-contract';
  if (decisions !== undefined && namesOneOf(args, decisions.field, decisions.irreversible)) return 'irreversible-operator';
  if (unrecoverableDeletion(toolName, args, definition) !== undefined) return 'unrecoverable-delete';
  if (facts.newRecipient === true) return 'new-recipient';
  return undefined;
}

/** What a call destroys that nothing keeps a copy of, in words (gate/unrecoverable-commands.ts); undefined when nothing. */
export function unrecoverableDeletion(toolName: string, args: Record<string, unknown>,
  definition?: Pick<ToolDefinition, 'subjects' | 'sideEffects'> | undefined): string | undefined {
  const commands = callCommands(toolName, args, definition);
  return (commands.length > 0 ? unrecoverableDeletionIn(commands) : undefined)
    ?? (toolName === 'exec' ? fileOperationDestroys(args) : undefined);
}
