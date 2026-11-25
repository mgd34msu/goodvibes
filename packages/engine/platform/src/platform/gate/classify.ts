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
 *      a call that only tightens a protection (allowed, in every mode and
 *      folder), then the plan posture;
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
import { execShellCommandsAt, type ShellCommandAt } from '../runtime/permissions/exec-command-text.js';
import { fileOperationDestroys, unrecoverableDeletionIn, type Destruction } from './unrecoverable-commands.js';
import { reachesPastTheGate, writesRunByItself, type ProductReachProbe } from './product-commands.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';

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
  'owner-act': 'it is an act that is yours alone; it runs only on your yes',
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
  /** For an owner act, the act in its own words when the tool's declaration gives them (ownerActWordsOf). */
  readonly ownerActWords?: string | undefined;
  /**
   * The owner act is one the tool puts to the owner rather than refusing (its `ownerActs.asked`: every capability
   * through capability_run): asked in every mode, opening on No, never refused outright.
   */
  readonly ownerActAsked?: boolean | undefined;
  /** The owner act is answered each time (its `ownerActs.once`: a card's detail he types): no remembered yes covers it. */
  readonly ownerActOnce?: boolean | undefined;
  /** The turn read text anyone can write (the untrusted-content ledger holds an entry for it). */
  readonly untrustedRead: boolean;
  /**
   * The tool's registration declared this exact call read-only (its input
   * projection said so, ToolRegistry.isPreparedReadOnly): the registration,
   * not a reading, owns that fact.
   */
  readonly declaredReadOnly?: boolean | undefined;
  /**
   * True when the owner explicitly kept the workspace restricted (the trust
   * manager's isRestricted); false or absent when it is trusted, has no
   * decision yet, or no workspace trust policy applies.
   */
  readonly workspaceRestricted?: boolean | undefined;
  /** The host the call is sent to decides it itself when it arrives (hostDecidesCall). */
  readonly hostDecides?: boolean | undefined;
  /**
   * The call only tightens a protection (the tool's `tightens`, types/tools.ts): plan mode on, a folder restricted, a
   * "never" rule added, a protection switched on. Allowed as a fact in every mode and folder: nothing is asked.
   */
  readonly onlyTightens?: boolean | undefined;
  /**
   * The call writes only the model's own working state (its running checklist: the tool's `ownWorkingState`,
   * types/tools.ts). Not an act on the person's things: allowed as a fact in every mode, never held or asked.
   */
  readonly ownWorkingState?: boolean | undefined;
  /**
   * The owner-only item is answered each time (a command that runs one of the product's own programs or touches the
   * GoodVibes home, reachesProductPastGate): no remembered yes settles it and the ask offers none.
   */
  readonly ownerOnlyOnce?: boolean | undefined;
}

/** What settled a fact, for the caller's own records. */
export type FactBasis = 'surface' | 'plan' | 'mode' | 'rule' | 'owner-rule' | 'declared-effect' | 'owner-act' | 'host';

export type CallClass =
  | { readonly kind: 'fact'; readonly allow: boolean; readonly basis: FactBasis; readonly decision: ToolDecision; readonly rule?: CallRuleFact | undefined }
  /** `once`: an owner act answered each time (ownerActs.once): the ask offers nothing to remember. */
  | { readonly kind: 'owner-only'; readonly item: OwnerOnlyKind; readonly once?: true | undefined }
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
  if (facts.ownerOnly === 'owner-act' && facts.ownerActAsked !== true) {
    return { kind: 'fact', allow: false, basis: 'owner-act', decision: {
      state: 'refused', decidedBy: 'code',
      reason: facts.ownerActWords
        ? `${facts.ownerActWords} is something only the owner does from their own screen`
        : `${facts.tool} would do something only the owner does himself (answer what was put to him, or grant or withdraw access)`,
      next: ['do not call it again', 'tell the owner what is waiting; he answers it in his own app (the approval prompt, Waiting for you, the web UI)'],
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
  // An act that only tightens a protection is never refused or asked about, in any mode or folder: it can only
  // make what follows safer, and asking the owner about it would put a question in front of him that is not his.
  if (facts.onlyTightens === true) {
    return { kind: 'fact', allow: true, basis: 'declared-effect', decision: {
      state: 'allowed', decidedBy: 'code', reason: 'it only tightens a protection',
    } };
  }
  // The model's own checklist is its working state, not the person's things: written in every mode, plan mode and
  // just-vibes with no decision model included, and never held or asked about.
  if (facts.ownWorkingState === true) {
    return { kind: 'fact', allow: true, basis: 'declared-effect', decision: {
      state: 'allowed', decidedBy: 'code', reason: 'it writes only the model\'s own checklist',
    } };
  }
  if (mode === 'plan' && facts.category !== 'read') {
    return { kind: 'fact', allow: false, basis: 'plan', decision: {
      state: 'refused', decidedBy: 'mode',
      reason: `plan mode is on and ${facts.tool} would change something`,
      next: ['present the plan of changes and wait for the owner to approve it', 'the owner leaves plan mode to run it'],
    } };
  }
  // An act only the owner does, of a tool that puts such acts to him (a capability: capability_run): asked in every
  // mode, yolo included, opening on No; it runs on his yes (or on his own remembered answer to it).
  if (facts.ownerOnly === 'owner-act') {
    const owned = facts.rule;
    if (owned?.effect === 'deny') return { kind: 'fact', allow: false, basis: 'rule', rule: owned, decision: ruleDecision(owned, false) };
    if (owned?.effect === 'allow' && owned.ownerOnly === 'owner-act' && facts.ownerActOnce !== true) {
      return { kind: 'fact', allow: true, basis: 'owner-rule', rule: owned, decision: {
        state: 'allowed', decidedBy: 'rule', reason: `you allowed this before (${owned.description})`, limit: owned.description,
      } };
    }
    return facts.ownerActOnce === true ? { kind: 'owner-only', item: 'owner-act', once: true } : { kind: 'owner-only', item: 'owner-act' };
  }
  if (mode === 'yolo') {
    return { kind: 'fact', allow: true, basis: 'mode', decision: { state: 'allowed', decidedBy: 'mode', reason: 'yolo mode runs every call' } };
  }
  const rule = facts.rule;
  if (rule?.effect === 'deny') return { kind: 'fact', allow: false, basis: 'rule', rule, decision: ruleDecision(rule, false) };
  if (rule?.effect === 'ask') return { kind: 'owner-only', item: 'standing-ask' };
  // One decision, at the host: it admits this call itself under the owner's mode when it arrives.
  if (facts.hostDecides === true) {
    return { kind: 'fact', allow: true, basis: 'host', decision: {
      state: 'allowed', decidedBy: 'code', reason: `${facts.tool} is decided by the daemon it is sent to, under your mode, when it arrives`,
    } };
  }
  if (facts.ownerOnly !== undefined) {
    // One answered each time (a command reaching past the gate through the product itself) is never settled by a
    // remembered yes, and its ask offers none.
    if (facts.ownerOnlyOnce === true) return { kind: 'owner-only', item: facts.ownerOnly, once: true };
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
  // A workspace the owner kept restricted has no write allowed by code: it is refused at dispatch.
  // A workspace with no decision yet is decided as before (an interactive session asks, or trusts, on opening).
  if (effects !== undefined && paths !== undefined && paths.every((path) => path.inside) && facts.workspaceRestricted !== true) {
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
  /**
   * The GoodVibes home directories as the caller's process resolves them (`<home>/.goodvibes` and the daemon's home):
   * a command naming a file under one reaches past the gate (product-commands.ts). Handed in, never read here.
   */
  readonly productHomes?: readonly string[] | undefined;
  /**
   * How a command's words are resolved to what they name (links followed, script files read, the person's home):
   * handed in by the caller, never read here (product-commands.ts `ProductReachProbe`).
   */
  readonly productProbe?: ProductReachProbe | undefined;
  /** The folders on the program search path: a file written under one runs by itself later. Handed in. */
  readonly searchPath?: readonly string[] | undefined;
}

/**
 * Whether a call runs one of the product's own programs to change something, or reads or writes a file under the
 * GoodVibes home, or runs something whose reach cannot be resolved (product-commands.ts). Such a yes is answered each
 * time: never remembered.
 */
export function reachesProductPastGate(toolName: string, args: Record<string, unknown>,
  definition: Pick<ToolDefinition, 'subjects' | 'sideEffects'> | undefined, directory: string | undefined, homes: readonly string[] | undefined,
  probe?: ProductReachProbe): boolean {
  return reachesPastTheGate(callCommands(toolName, args, definition), directory, homes ?? [], probe ?? {});
}

/**
 * Whether a call writes a file that runs by itself later (a git hook, `.envrc`, a package's scripts, a shell start-up
 * file, a project's hooks or tool-server file, a file under a folder on the search path): it installs something that
 * runs without this gate seeing what it runs then (product-commands.ts `writesRunByItself`).
 */
export function installsRunByItself(toolName: string, args: Record<string, unknown>,
  definition: Pick<ToolDefinition, 'sideEffects'> | undefined, directory: string | undefined, searchPath: readonly string[] = []): boolean {
  const writes = toolName === 'write' || toolName === 'edit' || definition?.sideEffects?.includes('write_fs') === true;
  if (!writes) return false;
  return writesRunByItself(extractPathArgs(args), directory, searchPath);
}

/** The definition fields the owner-only list is recognised from. */
export type OwnerOnlyDefinition = Pick<ToolDefinition, 'dangerous' | 'ownerActs' | 'ownerDecisions' | 'subjects' | 'sideEffects'>;

/**
 * Whether the host this call is sent to decides it itself (`hostDecides`): only when the call names exactly one value
 * and it is one of them; a value that cannot be read, or several, is this gate's to decide (fails closed).
 */
export function hostDecidesCall(args: Record<string, unknown>, definition: Pick<ToolDefinition, 'hostDecides'> | undefined): boolean {
  const declared = definition?.hostDecides;
  if (declared === undefined || declared.values.length === 0) return false;
  const named = argumentValues(args, declared.field);
  if (named === undefined || named.length !== 1) return false;
  return declared.values.some((value) => value.trim().toLowerCase() === named[0]!.trim().toLowerCase());
}

/**
 * Whether a call acts on what the daemon holds, in no project folder (`outsideFolder`): only when it names exactly one
 * declared value, so a value that cannot be read stays held to the folder (fails closed).
 */
export function outsideFolderCall(args: Record<string, unknown>, definition: Pick<ToolDefinition, 'outsideFolder'> | undefined): boolean {
  const declared = definition?.outsideFolder;
  if (declared === undefined || declared.values.length === 0) return false;
  const named = argumentValues(args, declared.field);
  if (named === undefined || named.length !== 1) return false;
  const value = named[0]!.trim().toLowerCase();
  if (declared.values.some((entry) => entry.trim().toLowerCase() === value)) return true;
  // Outside only with these arguments (kept for all your projects, not this one): each given, and one of its values.
  const conditions = Object.entries(declared.when ?? {}).find(([key]) => key.trim().toLowerCase() === value)?.[1];
  if (!conditions || conditions.length === 0) return false;
  return conditions.every((condition) => {
    const given = argumentValues(args, condition.path);
    return given !== undefined && given.length === 1 && condition.values.includes(given[0]!.trim());
  });
}

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
 * sit; empty for any other tool. Each carries the directory it names for
 * itself (an exec entry's `cwd`), where a script it runs is read from.
 */
export function callCommands(toolName: string, args: Record<string, unknown>, definition?: Pick<ToolDefinition, 'subjects' | 'sideEffects'> | undefined): ShellCommandAt[] {
  const runs = toolName === 'exec' || definition?.sideEffects?.includes('exec') === true;
  const commands: ShellCommandAt[] = runs ? execShellCommandsAt(args) : [];
  for (const text of declaredValues(args, definition?.subjects?.commands) ?? []) {
    if (!commands.some((entry) => entry.text === text && entry.cwd === undefined)) commands.push({ text });
  }
  return commands;
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

/** A verb phrase as an act: "Start a remote runner" becomes "Starting a remote runner". */
function asAct(label: string): string {
  const [verb = '', ...rest] = label.trim().split(/\s+/);
  const lower = verb.toLowerCase();
  const ing = /[^e]e$/.test(lower) ? `${lower.slice(0, -1)}ing`
    : /^[^aeiou]*[aeiou][bdgmnprt]$/.test(lower) ? `${lower}${lower.at(-1)}ing` : `${lower}ing`;
  return [ing.charAt(0).toUpperCase() + ing.slice(1), ...rest].join(' ');
}

/** Whether the owner act a call names is one its tool puts to the owner (`ownerActs.asked`) rather than refusing. */
export function ownerActAsked(args: Record<string, unknown>, definition: OwnerOnlyDefinition | undefined): boolean {
  const acts = definition?.ownerActs;
  if (!acts?.asked || acts.asked.length === 0) return false;
  const named = argumentValues(args, acts.field);
  // Every value the call names must be an asked one; a value that cannot be read stays refused (fails closed).
  if (named === undefined || named.length === 0) return false;
  const asked = new Set(acts.asked.map((value) => value.trim().toLowerCase()));
  return named.every((value) => asked.has(value.trim().toLowerCase()));
}

/** Whether the owner act a call names is answered each time (`ownerActs.once`): no remembered yes covers it. */
export function ownerActOnce(args: Record<string, unknown>, definition: OwnerOnlyDefinition | undefined): boolean {
  const acts = definition?.ownerActs;
  const once = acts?.once;
  if (!acts || !once || once.length === 0) return false;
  const named = argumentValues(args, acts.field);
  if (named === undefined || named.length === 0) return false;
  const set = new Set(once.map((value) => value.trim().toLowerCase()));
  return named.some((value) => set.has(value.trim().toLowerCase()));
}

/** The act an owner-act call names, in its declaration's own words; undefined when it gives none. */
export function ownerActWordsOf(args: Record<string, unknown>, definition: OwnerOnlyDefinition | undefined): string | undefined {
  const acts = definition?.ownerActs;
  if (!acts?.words) return undefined;
  const value = acts.field.split('.').reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), args);
  const words = typeof value === 'string' ? acts.words[value] : undefined;
  return words ? asAct(words) : undefined;
}

/**
 * The owner-only kind a call is, from its tool, mode, arguments and the facts
 * its caller read; undefined when it is none. `directory` is the call's working
 * directory, where a shell script a command runs is read from.
 */
export function recognizeOwnerOnly(toolName: string, args: Record<string, unknown>,
  definition: OwnerOnlyDefinition | undefined, facts: OwnerOnlyCallFacts, directory: string | undefined): OwnerOnlyKind | undefined {
  const acts = definition?.ownerActs;
  // A value that cannot be read is taken as an owner act: the declaration fails closed.
  if (acts !== undefined && namesOneOf(args, acts.field, acts.values)) return 'owner-act';
  if (definition?.dangerous === true || changesMcpTrust(toolName, args)) return 'grant-access';
  if (facts.loosensSetting === true) return 'loosen-security';
  // A command that runs one of the product's own programs to change something, or reads or writes the GoodVibes
  // home's files (its credential, settings and rules): it can loosen a protection past this gate (product-commands.ts).
  if (reachesProductPastGate(toolName, args, definition, directory, facts.productHomes, facts.productProbe)) return 'loosen-security';
  // A file written that runs by itself later (a git hook, `.envrc`, a package script, a shell start-up file, ...).
  if (installsRunByItself(toolName, args, definition, directory, facts.searchPath)) return 'loosen-security';
  const decisions = definition?.ownerDecisions;
  if (decisions !== undefined && (namesOneOf(args, decisions.field, decisions.loosens) || loosensByArguments(args, decisions))) return 'loosen-security';
  if (decisions !== undefined && namesOneOf(args, decisions.field, decisions.contractChanges)) return 'change-contract';
  if (decisions !== undefined && (namesOneOf(args, decisions.field, decisions.irreversible) || byArguments(args, decisions.field, decisions.irreversibleWhen))) return 'irreversible-operator';
  if (unrecoverableDeletion(toolName, args, definition, directory) !== undefined) return 'unrecoverable-delete';
  if (facts.newRecipient === true) return 'new-recipient';
  return undefined;
}

/**
 * Whether the value the call names loosens a protection with the arguments it
 * carries (`ownerDecisions.loosensWhen`): one of the listed values at the
 * listed path. A path that cannot be read counts as loosening (fails closed).
 */
function loosensByArguments(args: Record<string, unknown>, decisions: NonNullable<OwnerOnlyDefinition['ownerDecisions']>): boolean {
  return byArguments(args, decisions.field, decisions.loosensWhen);
}

/**
 * Whether the value the call names is one of `when`'s with one of its listed values at the listed path
 * (`loosensWhen`, `irreversibleWhen`). A path that cannot be read counts (fails closed).
 */
function byArguments(args: Record<string, unknown>, field: NonNullable<OwnerOnlyDefinition['ownerDecisions']>['field'],
  when: NonNullable<OwnerOnlyDefinition['ownerDecisions']>['loosensWhen']): boolean {
  if (when === undefined) return false;
  const named = argumentValues(args, field);
  if (named === undefined) return Object.keys(when).length > 0;
  for (const value of named) {
    const key = Object.keys(when).find((candidate) => candidate.trim().toLowerCase() === value.trim().toLowerCase());
    if (key === undefined) continue;
    for (const condition of when[key]!) {
      const given = argumentValues(args, condition.path);
      if (given === undefined) return true;
      if (given.some((entry) => condition.values.includes(entry.trim()))) return true;
    }
  }
  return false;
}

/**
 * What a call destroys that nothing keeps a copy of (gate/unrecoverable-commands.ts);
 * undefined when nothing. `directory` is where a relative script path is read from.
 */
export function unrecoverableDeletion(toolName: string, args: Record<string, unknown>,
  definition: Pick<ToolDefinition, 'subjects' | 'sideEffects'> | undefined, directory: string | undefined): Destruction | undefined {
  const commands = callCommands(toolName, args, definition);
  const fromCommands = commands.length > 0 ? unrecoverableDeletionIn(commands, directory) : undefined;
  if (fromCommands !== undefined) return fromCommands;
  const fileOperation = toolName === 'exec' ? fileOperationDestroys(args) : undefined;
  return fileOperation === undefined ? undefined : { reason: fileOperation, unread: false };
}
