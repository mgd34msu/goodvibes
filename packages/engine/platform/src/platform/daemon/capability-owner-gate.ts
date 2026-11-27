/**
 * capability-owner-gate.ts, how `capabilities.run` (control-plane/routes/capabilities.ts) decides an outside caller's
 * call, and a first use given to a caller (a project, one of the owner's shared things, typing into an observed agent):
 * this daemon's instance of the one permission manager, under the owner's mode, with who is asking as a fact.
 *
 * YOLO runs the call when its scopes and reach allow it; Jev decides gives it to Jev's permission decision, told who
 * asks; Ask me raises an approval through the daemon's one approval broker, the same card a model's tool call raises,
 * and the request waits on that one answer as a model's tool call does. The caller's connection closing withdraws the
 * question (the request's signal); nothing of it is kept across a restart, and nothing is answered before the owner decides.
 *
 * The manager is one of its own: the daemon's shared one asks through the folder-trust gate of the daemon's working
 * directory, and a daemon capability does not work in a project folder (it acts on what the daemon keeps), so the
 * caller's first write was asked about twice, the folder's trust and then the call. Here the question is the call's own:
 * exactly one decision.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RuntimeServices } from '../runtime/services.js';
import { createBrokeredPermissionManager, type UserPermissionRuleAccess } from '../runtime/permissions/permission-composition.js';
import type { CapabilityGateRequest, GateCaller, GateDecision } from '../control-plane/routes/capabilities.js';
import { daemonCapabilityCatalog } from '../capabilities/daemon-catalog.js';
import type { CapabilityEntry } from '../capabilities/catalog.js';
import { withUntrustedContentScope } from '../security/untrusted-content.js';
import { asCallOutsideTurn } from '../security/turn-input-party.js';
import { hiddenSecret } from '../capabilities/outcome.js';
import { CARRIED_FROM_ARG, GRANT_LABEL_ARG, GRANT_SENTENCE_ARG, RESULT_LEAVES_ARG } from '../capabilities/ask-words.js';
import { capabilityRunDefinition, CAPABILITY_RUN_TOOL } from '../tools/capability/definitions.js';
import { toolAskWords } from '../permissions/tool-ask-words.js';
import { decideInProject } from '../permissions/call-project.js';
import { COMMAND_LINE_ASK, COMMAND_LINE_ASK_ARG as ASKED_AS_ARG } from '../permissions/command-line-ask.js';
import type { ToolDefinition } from '../types/tools.js';
import type { PermissionAttribution } from '../permissions/prompt.js';
import type { UserPermissionRuleStore } from '../permissions/user-rule-store.js';
import type { PolicyRule } from '../runtime/permissions/types.js';
import { LOCAL_OWNER_PRINCIPAL, pairingTokenIdOfPrincipal } from '../pairing/principal-ids.js';
import { noticeWaiting } from '@goodvibes/engine/daemon-api/control-routes';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';

/** Approval metadata naming a question `capabilities.run` raised: which capability, and who asked. */
const SOURCE = 'capabilities.run';
/** The argument naming who asked, added to the call the gate decides: a remembered answer is kept for that caller only. */
const ASKED_BY_ARG = 'askedBy';
/** The words naming that caller (`callerName`), for the rule's description only: never matched on. */
const ASKED_BY_NAME_ARG = 'askedByName';
/** Who asked, written on the question, so the card names the caller. */
const ASKED_BY_KEY = 'capabilityAskedBy';

/**
 * A carried file as the owner's card names it: the file of the caller the daemon authenticated, by the name that caller
 * gave it, quoted, never a path on this computer ("the paired device "laptop"'s file named "notes.json"").
 */
function callersFile(askedBy: string | undefined, name: string, kind: 'file' | 'folder' = 'file'): string {
  if (askedBy === undefined) return `the ${kind} named "${name}" of the caller that asked`;
  return /^you\b/.test(askedBy) ? `your ${kind} named "${name}"` : `${askedBy}'s ${kind} named "${name}"`;
}

type GateRuntime = Pick<RuntimeServices, 'approvalBroker' | 'configManager' | 'policyRuntimeState' | 'hookDispatcher' | 'featureFlags' | 'userPermissionRuleStore' | 'secretsManager'>
  // The paired devices: a device that asks is named by its name on the card.
  & { readonly pairingTokens?: Pick<RuntimeServices['pairingTokens'], 'list'> | undefined };

/** The daemon's sign-in users, as the card names a sign-in: the owner's own, or another user's. */
export interface CallerUsers {
  ownerUsername?(): string | null;
}

/** Whether a caller is a sign-in: told by the kind of credential, never by its name (a user name is its principal id). */
function isSignIn(caller: GateCaller | undefined): boolean {
  return caller?.principalKind === 'user' || caller?.credentialKind === 'user-session';
}

/**
 * The caller a remembered answer is kept for: its credential's kind and principal, and the program of that principal
 * when it sent its registration (the terminal app, the Agent), so an answer given for one holder of the operator token
 * never settles another's call (a script's, an outside agent's).
 */
function rememberedCallerKey(runsAs: GateCaller | undefined): string {
  const who = `${runsAs?.credentialKind ?? runsAs?.principalKind ?? 'caller'}:${runsAs?.principalId ?? 'unknown'}`;
  return runsAs?.registration ? `${who}#${runsAs.registration}` : who;
}

/**
 * Who asked, as the owner reads it on the question and Jev is told it: a sign-in by its user name, a paired device by
 * its name, the operator token as a program using it. `pairingTokens` and `users` are read in memory; no I/O.
 */
function callerName(runsAs: GateCaller | undefined, runtime: GateRuntime, users: CallerUsers | undefined): string | undefined {
  const principalId = runsAs?.principalId;
  if (!principalId) return undefined;
  // A sign-in first, by its kind: a user name that reads like another credential's id is still a user's.
  if (isSignIn(runsAs)) {
    return users?.ownerUsername?.() === principalId ? `you, signed in as ${principalId}` : `${principalId}, signed in`;
  }
  if (principalId === LOCAL_OWNER_PRINCIPAL) {
    // A command line (`do`): decided whoever typed it, since anything that drives a terminal can type there.
    if (runsAs?.commandLine === true) return 'a do command typed on this machine';
    if (runsAs?.registration) return 'one of your GoodVibes programs on this machine';
    // The operator token alone is held by every command line and script of the account: never "you".
    return runsAs?.credentialKind === 'local' ? 'a program or script on this machine using your operator token (not one of your verified programs)'
      : 'a program or script using your operator token from another machine';
  }
  const deviceId = pairingTokenIdOfPrincipal(principalId);
  if (deviceId !== undefined) {
    const device = runtime.pairingTokens?.list().find((token) => token.id === deviceId);
    return device ? `the paired device "${device.name}"` : `a paired device (${deviceId})`;
  }
  return principalId;
}

/**
 * The owner's saved rules as an outside caller's call is decided by them: every deny and ask rule, and an allow rule
 * for `capability_run` only when it names who it was given to (`askedBy`), so an answer remembered for one caller (or
 * for the owner's own model) never settles another caller's call. Lists are read through this view for every check.
 */
function callerScopedRules(store: UserPermissionRuleAccess | null): UserPermissionRuleAccess | null {
  if (!store) return null;
  const full = store as UserPermissionRuleAccess & Partial<Pick<UserPermissionRuleStore, 'committedRevision' | 'remember' | 'rememberedRules'>>;
  const keep = (rule: PolicyRule): boolean => {
    if (rule.effect !== 'allow') return true;
    const tools = Array.isArray(rule.toolPattern) ? rule.toolPattern : [rule.toolPattern];
    if (!tools.includes(CAPABILITY_RUN_TOOL)) return true;
    return rule.type === 'arg-shape' && typeof rule.argMatchers[ASKED_BY_ARG] === 'string';
  };
  const view: UserPermissionRuleAccess & Partial<Pick<UserPermissionRuleStore, 'committedRevision' | 'remember' | 'rememberedRules'>> = {
    rules: (project) => store.rules(project).filter(keep),
    add: (record) => store.add(record),
    ...(store.init ? { init: () => store.init!() } : {}),
    ...(store.awaitReady ? { awaitReady: () => store.awaitReady!() } : {}),
    ...(store.getPublicationRevision ? { getPublicationRevision: () => store.getPublicationRevision!() } : {}),
    ...(full.committedRevision ? { committedRevision: () => full.committedRevision!() } : {}),
    ...(full.remember ? { remember: (record) => full.remember!(record) } : {}),
    ...(full.rememberedRules ? { rememberedRules: (project) => full.rememberedRules!(project).filter(keep) } : {}),
  };
  return view;
}

/** What a first use given to a caller is decided on (see `daemonGrantDecision`). */
export interface GrantRequest {
  /** The grant's id, as its rule is kept: `outside-agent.project`, `unverified-program.project`, `shared-kind.<kind>`. */
  readonly id: string;
  /** The act in the owner's words ("Let the paired device "kiosk" read and send your mail"). */
  readonly label: string;
  readonly sentence: string;
  /** The project it is decided for (a project grant names its folder). */
  readonly project?: string | undefined;
  /** Who asks, as the transport established it. */
  readonly runsAs: GateCaller;
  /** The asking request's signal: its connection closing withdraws a question Ask me raised for it. */
  readonly signal?: AbortSignal | undefined;
}
export type GrantDecision = (request: GrantRequest) => Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>;

/**
 * The call a first use is needed for, when the dispatch decides that first use (one act, one decision): the first use
 * and the call are decided together, by one decision that names both, with the call's own class (a stricter one than a
 * loosening is the decision's class). `covered` is set when that decision allowed both: the call is then not decided
 * again. A call with no class of its own (a read) needs no second decision anyway; an answer and an owner-only act are
 * never covered (each keeps its flat rule).
 */
export interface FirstUseCall {
  readonly label: string;
  readonly risk: 'none' | 'loosens-a-protection' | 'runs-later' | 'steers-a-model' | 'cannot-be-undone' | 'spends-money' | 'writes-a-secret' | 'owner-act' | 'answers-the-owner';
  covered: boolean;
}
const firstUseCallScope = new AsyncLocalStorage<FirstUseCall>();

/** Runs `fn` (a first use's admission) with `call` as the call it is needed for (see {@link FirstUseCall}). */
export function withFirstUseCall<T>(call: FirstUseCall, fn: () => Promise<T>): Promise<T> {
  return firstUseCallScope.run(call, fn);
}

/** The capability risk a first use decided with its call is decided as: the call's when stricter than a loosening. */
function firstUseRisk(call: FirstUseCall | undefined): CapabilityEntry['risk'] {
  if (call?.risk === 'cannot-be-undone' || call?.risk === 'spends-money') return call.risk;
  return 'loosens-a-protection';
}

/**
 * Whether a first use decided with `call` decides the call too (one act, one decision): a call that loosens, cannot be
 * undone, spends, writes a secret or writes what steers a model, whose class the one decision is made in (the first
 * use is an owner item, never weaker than the call's own class). Never an answer or an owner-only act (each keeps its
 * flat rule).
 */
function coversCall(call: FirstUseCall | undefined): call is FirstUseCall {
  // Any call but an answer and an owner-only act: a change of no class of its own (a capability run, a judgment) is
  // decided with its first use too, so the act is decided once, never the first use and then the call again.
  return call !== undefined && call.risk !== 'owner-act' && call.risk !== 'answers-the-owner';
}

let daemonGrant: GrantDecision | undefined;
/**
 * The decision of a first use given to a caller, by this daemon's one permission manager under the owner's mode (set
 * when the capability gate is made). Undefined before then: the caller is refused, never asked.
 */
export function daemonGrantDecision(): GrantDecision | undefined { return daemonGrant; }

/** Decide a first use: YOLO, Jev or a rule at once; Ask me when the owner answers. Without the daemon's decision: refused. */
export async function decideGrant(request: GrantRequest): Promise<{ readonly approved: boolean; readonly reason?: string | undefined }> {
  const decide = daemonGrant;
  if (!decide) return { approved: false, reason: 'this daemon has no permission decision for it yet' };
  return decide(request);
}

/** A refusal by a gate check that changed while the owner was deciding: the call is judged again as things are now. */
const CHANGED_WHILE_DECIDING = /changed while (deciding|reading)|evidence changed during comparison/i;

export function createCapabilityOwnerGate(runtime: GateRuntime, options: { readonly users?: CallerUsers | undefined } = {}): {
  readonly gate: (request: CapabilityGateRequest) => Promise<GateDecision>;
} {
  const users = options.users;
  const broker = runtime.approvalBroker;
  const scope = new AsyncLocalStorage<{ readonly metadata: Record<string, unknown> }>();
  /** The question each call raised (Ask me), by the metadata object handed to the manager for it. */
  const raisedFor = new WeakMap<object, string>();
  const manager = createBrokeredPermissionManager({
    // No folder trust: the question is the call's own (see the header).
    workspaceTrust: null,
    requestApproval: async (input) => {
      // The question as the capability words it (ask-words.ts), on the record itself too, never "capability_run".
      const words = toolAskWords(input.request.tool, input.request.args);
      // `outsideFolder` is the gate's in-process word to the folder's trust (none here): never kept on the record.
      const { outsideFolder: _inProcess, ...asked } = input.request;
      const request = words ? { ...asked, analysis: { ...asked.analysis, summary: words.question } } : asked;
      // Raised as a model's call raises it, with the caller's request signal: its connection closing withdraws it.
      const asking = scope.getStore();
      const raised = await broker.raiseApproval({ ...input, request, metadata: { ...(input.metadata ?? {}), ...(asking?.metadata ?? {}) } });
      if (asking) raisedFor.set(asking.metadata, raised.approval.id);
      // A caller that asked to be told (`goodvibes do`) hears now, in the same answer, that its call waits on this card.
      noticeWaiting({ question: request.analysis?.summary ?? `${input.request.tool} is put to you`,
        where: 'answer it in GoodVibes: the approval in your terminal app or Agent, Waiting for you, or the web view' });
      return raised.decision;
    },
    configManager: runtime.configManager,
    policyRuntimeState: runtime.policyRuntimeState,
    hookDispatcher: runtime.hookDispatcher,
    featureFlags: runtime.featureFlags,
    userRuleStore: callerScopedRules(runtime.userPermissionRuleStore),
    secretsManager: runtime.secretsManager,
  });
  /** The metadata of the call being decided, read by `requestApproval` above in that call's own async scope. */
  const withAsking = <T>(metadata: Record<string, unknown>, check: () => Promise<T>): Promise<T> => scope.run({ metadata }, check);
  let runDefinition: Promise<ToolDefinition> | undefined;
  /** The definitions method calls are decided by, by method id and class (a handful, made once each). */
  const methodDefinitions = new Map<string, Promise<ToolDefinition>>();
  const definitionWith = (entry: CapabilityGateRequest['entry']): Promise<ToolDefinition> => daemonCapabilityCatalog().then((catalog) => {
    runDefinition ??= Promise.resolve(capabilityRunDefinition(catalog.list()));
    if (catalog.get(entry.id)) return runDefinition;
    const key = `${entry.id}\u0000${entry.risk}\u0000${entry.ownerOnly ? 'own' : ''}\u0000${entry.touches}`;
    let made = methodDefinitions.get(key);
    if (!made) {
      made = Promise.resolve(capabilityRunDefinition([...catalog.list(), entry]));
      methodDefinitions.set(key, made);
    }
    return made;
  });

  const gate = async ({ entry, values, signal, requestedBy, caller, runsAs, ownerAct, asSpawn, carriedNames, carriedFolders, resultSecret, project: namedProject }: CapabilityGateRequest): Promise<GateDecision> => {
    // A method call the dispatch handed over (routes/capabilities.ts `methodCallEntry`) is no capability of the catalog:
    // decided with its own entry beside them, so its class is read as a capability's risk is.
    const declared = await definitionWith(entry);
    // A model's delegation from a conversation in the owner's own program is decided under the owner's mode as an agent spawn
    // is (routes/capabilities.ts conversationDelegation): handing work over is not taken as the owner's own act here.
    const decidedBy: ToolDefinition = asSpawn === true && declared.ownerActs
      ? { ...declared, ownerActs: { ...declared.ownerActs,
        values: declared.ownerActs.values.filter((id) => id !== entry.id),
        asked: (declared.ownerActs.asked ?? []).filter((id) => id !== entry.id),
        once: (declared.ownerActs.once ?? []).filter((id) => id !== entry.id) } }
      : declared;
    // An act that was the owner's own, asked for by a caller who is not the owner: an item of the owner's list ("owner act"),
    // decided under the owner's mode as an owner item, with who asked as a fact (YOLO runs it, Ask me and Jev decides put
    // it on the owner's card, Just vibes holds it for them; plan mode refuses a change). Nothing is offered to remember (`once`): an answer is for this caller's one call.
    // What the run definition refuses to a model by its arguments (`refusedWhen`: a write of a permission setting) is a
    // model's refusal only: this gate decides callers that are not a model, so it is not read here.
    const acts = decidedBy.ownerActs ? { ...decidedBy.ownerActs, refusedWhen: undefined } : undefined;
    // This gate decides callers that are not a model (a model's own call was decided at its turn's gate, and what no model
    // makes was refused before this: routes/capabilities.ts): an act the run definition refuses to a model is decided here
    // under the mode, as an item of the owner's list. What only the owner in person makes never reaches here from anyone else.
    const refusedOnlyToModels = acts !== undefined && acts.values.includes(entry.id) && !(acts.asked ?? []).includes(entry.id);
    const definition: ToolDefinition = ownerAct === true && acts
      ? { ...decidedBy, ownerActs: { ...acts,
        values: (acts.values.includes(entry.id) ? acts.values : [...acts.values, entry.id]),
        asked: (acts.asked ?? []).includes(entry.id) ? acts.asked : [...(acts.asked ?? []), entry.id],
        once: (acts.once ?? []).includes(entry.id) ? acts.once : [...(acts.once ?? []), entry.id],
        words: { ...(acts.words ?? {}), [entry.id]: entry.label } } }
      : refusedOnlyToModels && acts
        ? { ...decidedBy, ownerActs: { ...acts, asked: [...(acts.asked ?? []), entry.id] } }
        : acts ? { ...decidedBy, ownerActs: acts } : decidedBy;
    // The project the question is about: the caller's, else the one a method call names (the folder the outside agent's
    // credential is asked for). It is decided there and named as its place, never the daemon's own folder.
    const project = caller.workingDirectory ?? namedProject;
    const askedBy = callerName(runsAs, runtime, users);
    const attribution: PermissionAttribution | undefined = askedBy && runsAs?.principalId ? { kind: 'outside-caller', name: askedBy, principalId: runsAs.principalId } : undefined;
    // A secret input is secret for these values unless its `plainWhen` says not (a setting's new value, for a setting
    // that holds no password or key): such a value is shown in the question and read by the gate.
    const secret = new Set(entry.inputs.filter((input) => input.kind === 'secret' && input.plainWhen?.(values) !== true).map((input) => input.id));
    const metadata: Record<string, unknown> = {
      source: SOURCE, capabilityId: entry.id, capabilityLabel: entry.label, ...(requestedBy ? { requestedBy } : {}),
      ...(askedBy ? { [ASKED_BY_KEY]: askedBy } : {}),
    };
    const who = rememberedCallerKey(runsAs);
    // A carried path is decided as the caller named it and shown as the caller's own file, named by the caller the daemon
    // authenticated, never as a path on this computer (ask-words.ts `carriedFrom`).
    const carried = carriedNames ?? {};
    const shownValue = (id: string, value: string): string => secret.has(id) ? hiddenSecret(value) : carried[id] ?? value;
    const args = { id: entry.id, inputs: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, shownValue(id, value)])), [ASKED_BY_ARG]: who,
      ...(askedBy ? { [ASKED_BY_NAME_ARG]: askedBy } : {}),
      ...(Object.keys(carried).length > 0 ? { [CARRIED_FROM_ARG]: Object.fromEntries(Object.entries(carried).map(([id, name]) => [id, callersFile(askedBy, name,
        carriedFolders?.includes(id) || /^folder$/i.test(entry.inputs.find((input) => input.id === id)?.label ?? '') ? 'folder' : 'file')])) } : {}),
      // A result that carries a secret, leaving for a caller that is not the owner's own program: said in plain words.
      ...(resultSecret ? { [RESULT_LEAVES_ARG]: `This sends ${resultSecret} to ${askedBy ?? 'the caller that asked'}.` } : {}),
      // Typed as a command (`do`): the card says so (ask-presentation.ts).
      ...(runsAs?.commandLine === true ? { [ASKED_AS_ARG]: COMMAND_LINE_ASK } : {}) };
    let result: Awaited<ReturnType<typeof manager.checkDetailed>>;
    try {
      // Decided for the caller's project when it named one (call-project.ts): an answer "in this project" is kept, and a
      // rule matched, for that project, never the folder the daemon started in.
      result = await withAsking(metadata, () => decideInProject(project, () => manager.checkDetailed(CAPABILITY_RUN_TOOL, args,
        attribution, { definition, ...(signal ? { signal } : {}) })));
    } catch (error) {
      // The gate's own check that nothing moved while it decided (a setting written meanwhile) can fail after the owner
      // answered a question that waited. The owner's recorded answer stands, judged again against the mode and the deny rules
      // as they are now. Any other failure refuses the call: a check that throws is never a yes.
      const raisedId = raisedFor.get(metadata);
      const answered = raisedId !== undefined ? broker.getApproval(raisedId) : null;
      if (answered?.status === 'denied') return { approved: false, reason: typeof answered.decision?.reason === 'string' && answered.decision.reason ? answered.decision.reason : 'the owner did not approve it' };
      if (answered?.status !== 'approved' || !CHANGED_WHILE_DECIDING.test(error instanceof Error ? error.message : String(error))) {
        logger.warn('[capabilities] the decision on an outside caller\'s call failed; it is refused', { capabilityId: entry.id, error: summarizeError(error) });
        return { approved: false, reason: signal?.aborted ? 'the caller left before it was decided' : 'its permission check failed, so it was not run; ask again' };
      }
      const refused = await refusalNow(args, definition, project, signal);
      return refused === undefined ? { approved: true, askedId: raisedId, ...answeredBy(raisedId) } : { approved: false, reason: refused };
    }
    // One line per decision in the daemon's activity log: what was decided, for whom, and how (one call, one decision).
    logger.info(`[decision] ${entry.id} asked by ${askedBy ?? 'a caller'}: ${result.approved ? 'allowed' : 'refused'} (${result.sourceLayer}/${result.reasonCode})`);
    const raisedId = raisedFor.get(metadata);
    if (!result.approved) {
      // Refused with no question put (plan mode, a rule): said as what refused it, never as the owner's No.
      const why = raisedId === undefined && result.reasonCode === 'plan-mode' ? 'plan mode is on, so nothing that changes anything runs until the owner leaves it'
        : raisedId === undefined ? 'the permission mode or a rule in force refused it' : 'the owner did not approve it';
      return { approved: false, reason: result.detail ?? result.userReason ?? why };
    }
    return { approved: true, ...(raisedId !== undefined ? { askedId: raisedId, ...answeredBy(raisedId) } : {}) };
  };

  /** Who answered a question yes (the owner's principal), as the broker recorded it. */
  function answeredBy(approvalId: string | undefined): { readonly answeredBy?: string } {
    const by = approvalId !== undefined ? broker.getApproval(approvalId)?.resolvedBy : undefined;
    return typeof by === 'string' && by ? { answeredBy: by } : {};
  }

  /**
   * An approved call judged again against the mode and the deny and never-run rules as they are now, for the call as
   * the gate decided it in its caller's project: the words that refuse it (plan mode, a rule), or undefined while it
   * may run. A check that cannot be read refuses it.
   */
  async function refusalNow(args: Record<string, unknown>, definition: ToolDefinition, workingDirectory: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const now = await decideInProject(workingDirectory, () => manager.previewDecision(CAPABILITY_RUN_TOOL, args, definition, signal));
      if (now.decided.kind === 'fact' && !now.decided.allow) {
        return now.mode === 'plan' ? 'plan mode was switched on while the question waited, and plan mode runs no change'
          : now.decided.decision.reason ?? 'a rule now refuses it';
      }
      return undefined;
    } catch (recheck) {
      logger.warn('[capabilities] an approved call could not be judged again; it is refused', { error: summarizeError(recheck) });
      return 'whether it is still allowed could not be read after the question waited; ask again';
    }
  }

  // A first use given to a caller (a project for the outside agent or for a program this computer cannot verify, one of
  // the owner's shared things for a device, a member or a script, typing into an observed agent): decided by this same
  // permission manager under the owner's mode, as a loosening of a protection with who asks as a fact. YOLO gives it;
  // Jev decides and Just vibes ask Jev; Ask me asks the owner and the asking request waits on their answer.
  daemonGrant = async ({ id, label: grantLabel, sentence: grantSentence, project, runsAs, signal }) => {
    // The call this first use is needed for, decided with it in this one decision (one act, one decision): named on the
    // card and told to Jev, its class the decision's when stricter; allowed, the call is not decided again.
    const call = firstUseCallScope.getStore();
    const withCall = coversCall(call) ? call : undefined;
    const label = withCall ? `${grantLabel}, and do this now: ${withCall.label}` : grantLabel;
    const sentence = withCall ? `${grantSentence} The call it is needed for runs at once with it: ${withCall.label}.` : grantSentence;
    const entry: CapabilityEntry = {
      id, group: 'system', home: 'daemon', command: '', commandTitle: label, actionId: id, word: '', label, sentence, done: '',
      risk: firstUseRisk(withCall), touches: 'this-machine', lasts: 'kept', effects: ['control-plane.write'], inputs: [],
    };
    const definition = await definitionWith(entry);
    const askedBy = callerName(runsAs, runtime, users);
    const attribution: PermissionAttribution | undefined = askedBy && runsAs.principalId ? { kind: 'outside-caller', name: askedBy, principalId: runsAs.principalId } : undefined;
    // The card names the act in the owner's words (ask-words.ts `GRANT_LABEL_ARG`), never the grant's id.
    const args = { id, inputs: {}, [ASKED_BY_ARG]: rememberedCallerKey(runsAs), ...(askedBy ? { [ASKED_BY_NAME_ARG]: askedBy } : {}),
      [GRANT_LABEL_ARG]: label, [GRANT_SENTENCE_ARG]: sentence };
    try {
      // A caller's own request over the wire, decided at its door: in a window of its own, as no turn.
      const result = await withUntrustedContentScope(`grant:${randomUUID()}`, () => asCallOutsideTurn(() =>
        withAsking({ source: 'grant', grant: id, ...(runsAs.principalId ? { requestedBy: runsAs.principalId } : {}) },
          () => decideInProject(project, () => manager.checkDetailed(CAPABILITY_RUN_TOOL, args, attribution, { definition, ...(signal ? { signal } : {}) })))));
      logger.info(`[decision] ${id}${withCall ? ` with its call (${withCall.label})` : ''} asked by ${askedBy ?? 'a caller'}: ${result.approved ? 'allowed' : 'refused'} (${result.sourceLayer}/${result.reasonCode})`);
      if (result.approved && withCall) withCall.covered = true;
      return { approved: result.approved, ...(result.approved ? {} : { reason: result.detail ?? result.userReason ?? 'it was not allowed under your permission mode' }) };
    } catch (error) {
      logger.warn('[capabilities] the decision on a first use for a caller failed; it is refused', { grant: id, error: summarizeError(error) });
      return { approved: false, reason: signal?.aborted ? 'the caller left before it was decided' : 'its permission check failed, so nothing was given; ask again' };
    }
  };

  return { gate };
}
