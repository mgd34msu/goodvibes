/**
 * capability-owner-gate.ts, how `capabilities.run` puts an outside caller's
 * call to the owner (control-plane/routes/capabilities.ts), and where what
 * came of it is kept.
 *
 * The decision is this daemon's permission gate under the owner's mode, in a
 * permission manager of its own: the daemon's shared one asks through the
 * folder-trust gate of the daemon's working directory, and a daemon
 * capability does not work in a project folder (it acts on what the daemon
 * keeps), so the caller's first write was asked about twice, the folder's
 * trust and then the call, and a restricted folder refused the call with a
 * thrown error (an HTTP 500). Here the question is the call's own, raised
 * straight on the owner's approvals: exactly one decision.
 *
 * The approval is raised without the caller's request signal: the caller is
 * answered when the question is raised, and the question waits for the owner
 * in Waiting for you. What came of the call (its answer, or the refusal) is
 * kept in memory for the caller to read by the approval's id, and its words
 * on the approval record itself (`capabilityOutcome`), so a person looking at
 * the answered question sees whether the work ran.
 *
 * A held call outlives a daemon restart. What it needs to run is kept with
 * its question in the daemon's approvals store (`capabilityCall`: the
 * capability, its inputs, the caller's project and program), and the question
 * is one its asker reads itself (`record-reader`), so a restart leaves it
 * open. Approved after a restart, it runs on the yes as the caller it was held
 * for, if that caller is still allowed (no credential is ever written down:
 * only what tells whether it is still current, see `heldCredential`).
 * A secret input's value is never written: a held call that carried one is,
 * after a restart, ended with the words that it must be asked again and why.
 * The moment it starts is written on the question too (`capabilityStarted`),
 * so a call the daemon stopped in the middle of says what is known; a call
 * whose start cannot be written does not run.
 *
 * Only a question this gate raised is ever run on a yes. It is known by what
 * the broker keeps beside the record and no caller can set (its requester is
 * `record-reader`, which only an in-process raise with `readsRecord` gets;
 * `approvals.raise` keeps only display keys of a caller's metadata and its
 * asks are `wire`), never by the metadata alone.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeServices } from '../runtime/services.js';
import { createBrokeredPermissionManager, type UserPermissionRuleAccess } from '../runtime/permissions/permission-composition.js';
import type { ApprovedHeldCall, CapabilityGateRequest, HeldCallerRefusal, HeldCallOutcome, HeldCallReading, HeldCaller, HeldCapabilityCalls } from '../control-plane/routes/capabilities.js';
import type { SharedApprovalRecord } from '../control-plane/approval-broker.js';
import type { Actor } from './http-policy.js';
import { isOpenApprovalStatus } from '../control-plane/approval-lifecycle.js';
import { daemonCapabilityCatalog } from '../capabilities/daemon-catalog.js';
import { hiddenSecret } from '../capabilities/outcome.js';
import type { CapabilityCaller } from '../capabilities/types.js';
import { capabilityRunDefinition, CAPABILITY_RUN_TOOL } from '../tools/capability/definitions.js';
import { toolAskWords } from '../permissions/tool-ask-words.js';
import { decideInProject } from '../permissions/call-project.js';
import type { ToolDefinition } from '../types/tools.js';
import type { PermissionAttribution } from '../permissions/prompt.js';
import type { UserPermissionRuleStore } from '../permissions/user-rule-store.js';
import type { PolicyRule } from '../runtime/permissions/types.js';
import { LOCAL_OWNER_PRINCIPAL, pairingTokenIdOfPrincipal } from '../pairing/principal-ids.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';

/** Approval metadata naming a question `capabilities.run` raised: which capability, and who asked. */
const SOURCE = 'capabilities.run';
const OUTCOME_KEY = 'capabilityOutcome';
/** What the call needs to run on the owner's yes, kept with the question: its inputs (never a secret's value) and the caller's project and program. */
const CALL_KEY = 'capabilityCall';
/** The labels of the secret inputs the call carried, whose values were never written. */
const SECRETS_KEY = 'capabilitySecretInputs';
/** When the approved call started (ISO time): written before it runs. */
const STARTED_KEY = 'capabilityStarted';
/** Why a held call from before a restart must be asked again, written when it was ended for that. */
const ASK_AGAIN_KEY = 'capabilityAskAgain';
/** The argument naming who asked, added to the call the gate decides: a remembered answer is kept for that caller only. */
const ASKED_BY_ARG = 'askedBy';
/** The words naming that caller (`callerName`), for the rule's description only: never matched on. */
const ASKED_BY_NAME_ARG = 'askedByName';

type GateRuntime = Pick<RuntimeServices, 'approvalBroker' | 'configManager' | 'policyRuntimeState' | 'hookDispatcher' | 'featureFlags' | 'userPermissionRuleStore' | 'secretsManager'>
  // The paired devices: a device that asked is named by its name, and must still be paired when the owner says yes;
  // the shared operator token, told by its fingerprint whether it was replaced since the call was held.
  & { readonly pairingTokens?: Pick<RuntimeServices['pairingTokens'], 'list' | 'refusesSharedToken' | 'sharedTokenFingerprint' | 'refusesSharedTokenFingerprint'>
    & Partial<Pick<RuntimeServices['pairingTokens'], 'servesSharedTokenFingerprint'>> | undefined };

/** Whether a held caller is a sign-in: told by the kind of credential, never by its name (a user name is its principal id). */
function isSignIn(caller: HeldCaller | undefined): boolean {
  return caller?.principalKind === 'user' || caller?.credentialKind === 'user-session';
}

/** The daemon's sign-in users, as a held call reads them: who a sign-in is, and whether it is still there. */
export interface HeldCallUsers {
  getUser(username: string): object | null;
  ownerUsername?(): string | null;
  /** The sign-in session a token is, or null once it ended (signed out, expired, the user removed). */
  validateSession?(token: string): { readonly id?: string } | null;
  /** The sign-in sessions alive now, by id: a held call's session is told current by its id alone. */
  listSessions?(): readonly { readonly id: string }[];
}

/** Who asked, written on the question, so the words survive the caller (a device's name after it is unpaired). */
const ASKED_BY_KEY = 'capabilityAskedBy';

interface AskScope {
  readonly onAsked?: ((approvalId: string) => void) | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** The words of an outcome kept on the approval record: never the run's data, which goes only to the caller. */
function outcomeWords(outcome: HeldCallOutcome): Record<string, unknown> {
  return outcome.ok
    ? { ok: true, text: typeof outcome.answer['text'] === 'string' ? outcome.answer['text'] : '' }
    : { ok: false, code: outcome.code, status: outcome.status, error: outcome.error };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A reason as written: one that ends a sentence gets no second full stop. */
function sentence(words: string): string {
  const said = words.trim();
  return /[.!?]["')\]]?$/.test(said) ? said : `${said}.`;
}

/**
 * Whether this gate raised the question: only such a record holds a call it runs on a yes. Known by the broker's own
 * requester kind (`record-reader`, given only to an in-process raise that asks for it) and by no `approvals.raise`
 * mark, never by the metadata's `source` alone, which a caller could once write.
 */
function raisedByGate(record: SharedApprovalRecord | null | undefined): record is SharedApprovalRecord {
  return record !== null && record !== undefined && record.requester?.kind === 'record-reader'
    && record.metadata['source'] === SOURCE && record.metadata['raisedVia'] === undefined;
}

/** The caller facts a call runs with, as kept on its question: only these four, each a string. */
function keptCaller(caller: CapabilityCaller): Record<string, string> {
  const kept: Record<string, string> = {};
  if (caller.workingDirectory) kept['workingDirectory'] = caller.workingDirectory;
  if (caller.program) kept['program'] = caller.program;
  if (caller.model) kept['model'] = caller.model;
  if (caller.sessionId) kept['sessionId'] = caller.sessionId;
  return kept;
}

/** A record of strings read back from the store; anything else in it is dropped. */
function stringsOf(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(recordOf(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Who the call runs as, kept with the question: the caller as the transport established it, never a credential. */
const RUNS_AS_KEY = 'capabilityRunsAs';

/** The actor classes a held call may run as: a caller's, as the transport established it; never the daemon's own. */
const HELD_ACTOR_CLASSES: ReadonlySet<string> = new Set(['owner', 'admin', 'device', 'member', 'guest', 'peer']);

function keptActor(actor: Actor): Record<string, unknown> {
  return { class: actor.class, id: actor.id, via: actor.via, scopes: actor.scopes === 'all' ? 'all' : [...actor.scopes],
    ...(actor.agentFor ? { agentFor: keptActor(actor.agentFor) } : {}) };
}

/** An actor read back from a question; a `system` actor, or one of no known class, is never one a held call runs as. */
function actorOf(value: unknown): Actor | undefined {
  const kept = recordOf(value);
  if (!kept || typeof kept['id'] !== 'string' || typeof kept['class'] !== 'string' || typeof kept['via'] !== 'string') return undefined;
  if (!HELD_ACTOR_CLASSES.has(kept['class'])) return undefined;
  const scopes = kept['scopes'] === 'all' ? 'all' as const
    : new Set(Array.isArray(kept['scopes']) ? (kept['scopes'] as unknown[]).filter((scope): scope is string => typeof scope === 'string') : []);
  const agentFor = kept['agentFor'] === undefined ? undefined : actorOf(kept['agentFor']);
  if (kept['agentFor'] !== undefined && agentFor === undefined) return undefined;
  return { class: kept['class'] as Actor['class'], id: kept['id'], via: kept['via'] as Actor['via'], scopes, ...(agentFor ? { agentFor } : {}) };
}

function keptRunsAs(runsAs: HeldCaller): Record<string, unknown> {
  return { ...runsAs, ...(runsAs.scopes ? { scopes: [...runsAs.scopes] } : {}), ...(runsAs.actor ? { actor: keptActor(runsAs.actor) } : {}) };
}

function runsAsOf(value: unknown): HeldCaller {
  const kept = recordOf(value) ?? {};
  const actor = actorOf(kept['actor']);
  const scopes = Array.isArray(kept['scopes']) ? (kept['scopes'] as unknown[]).filter((scope): scope is string => typeof scope === 'string') : undefined;
  const credential = recordOf(kept['credential']);
  const credentialKind = credential?.['kind'];
  const credentialId = credential?.['id'];
  const keptCredential = (credentialKind === 'shared-token' || credentialKind === 'session') && typeof credentialId === 'string'
    ? { kind: credentialKind, id: credentialId } : undefined;
  return {
    ...(typeof kept['principalId'] === 'string' ? { principalId: kept['principalId'] } : {}),
    ...(typeof kept['principalKind'] === 'string' ? { principalKind: kept['principalKind'] as HeldCaller['principalKind'] } : {}),
    ...(typeof kept['credentialKind'] === 'string' ? { credentialKind: kept['credentialKind'] as HeldCaller['credentialKind'] } : {}),
    ...(typeof kept['admin'] === 'boolean' ? { admin: kept['admin'] } : {}),
    ...(scopes ? { scopes } : {}), ...(actor ? { actor } : {}), ...(keptCredential ? { credential: keptCredential } : {}),
  };
}

function askAgainWords(capabilityId: string, secrets: readonly string[]): string {
  const named = secrets.length === 1 ? `a secret value (${secrets[0]})` : `secret values (${secrets.join(', ')})`;
  return `${capabilityId} must be asked again: it carried ${named}, which the daemon never writes down, and the daemon restarted before it ran, so the value is gone. Nothing ran.`;
}

/**
 * Who asked, as the owner reads it on the question: a sign-in by its user name, a paired device by its name, the
 * operator token as a program using it. `pairingTokens` and `users` are read in memory; no I/O.
 */
function callerName(runsAs: HeldCaller | undefined, runtime: GateRuntime, users: HeldCallUsers | undefined): string | undefined {
  const principalId = runsAs?.principalId;
  if (!principalId) return undefined;
  // A sign-in first, by its kind: a user name that reads like another credential's id is still a user's.
  if (isSignIn(runsAs)) {
    return users?.ownerUsername?.() === principalId ? `you, signed in as ${principalId}` : `${principalId}, signed in`;
  }
  if (principalId === LOCAL_OWNER_PRINCIPAL) return runsAs?.credentialKind === 'local' ? 'you, on this machine' : 'a program using your operator token';
  const deviceId = pairingTokenIdOfPrincipal(principalId);
  if (deviceId !== undefined) {
    const device = runtime.pairingTokens?.list().find((token) => token.id === deviceId);
    return device ? `the paired device "${device.name}"` : `a paired device (${deviceId})`;
  }
  return principalId;
}

/**
 * What tells later whether the credential a call was held for is still current, without keeping the credential: the
 * shared operator token's fingerprint (its hash, which the token store keeps too), or the sign-in session's id. A
 * paired device is told by its id, already in its principal. Undefined when the credential is neither.
 */
function heldCredential(runsAs: HeldCaller | undefined, authToken: string | undefined, runtime: GateRuntime, users: HeldCallUsers | undefined): HeldCaller['credential'] {
  if (!authToken || !runsAs?.principalId) return undefined;
  if (runsAs.credentialKind === 'user-session') {
    const session = users?.validateSession?.(authToken);
    return typeof session?.id === 'string' ? { kind: 'session', id: session.id } : undefined;
  }
  if (isSignIn(runsAs)) return undefined;
  if (runsAs.principalId === LOCAL_OWNER_PRINCIPAL && runtime.pairingTokens) return { kind: 'shared-token', id: runtime.pairingTokens.sharedTokenFingerprint(authToken) };
  return undefined;
}

/**
 * Whether the caller a held call was put for may still have it run, now that the owner said yes: its token was not
 * replaced, its device is still paired, its sign-in user and session are still there. With the caller's credential in
 * hand (the request is still this process's) it is read again; without it (a call kept from before a restart) by what
 * was kept with the question. When that cannot be told, the call does not run either: it must be asked again.
 */
function callerRefusal(caller: HeldCaller, authToken: string | undefined, runtime: GateRuntime, users: HeldCallUsers | undefined): { readonly gone: string } | { readonly unknown: string } | undefined {
  const principalId = caller.principalId;
  if (!principalId) return authToken ? undefined : { unknown: 'it was not kept who asked' };
  // A sign-in is told apart by its kind before any name is read: a user named like the operator token's or a device's
  // principal id is still a user, and is judged as one.
  if (!isSignIn(caller) && principalId === LOCAL_OWNER_PRINCIPAL) {
    const tokens = runtime.pairingTokens;
    if (authToken) return tokens?.refusesSharedToken(authToken) === true ? { gone: 'the operator token it used was replaced' } : undefined;
    if (!tokens) return { unknown: 'this daemon cannot read its operator token' };
    if (caller.credential?.kind !== 'shared-token') return { unknown: 'it was not kept which operator token it used' };
    if (tokens.refusesSharedTokenFingerprint(caller.credential.id)) return { gone: 'the operator token it used was replaced' };
    // The token it came with against the one this daemon serves now, however that one changed (revoked and replaced,
    // a regenerated token file, a value set through the environment and a restart).
    const serves = tokens.servesSharedTokenFingerprint?.(caller.credential.id);
    if (serves === false) return { gone: 'the operator token it used is no longer the one this daemon serves' };
    if (serves === undefined) return { unknown: 'this daemon cannot tell which operator token it serves' };
    return undefined;
  }
  const deviceId = isSignIn(caller) ? undefined : pairingTokenIdOfPrincipal(principalId);
  if (deviceId !== undefined) {
    if (!runtime.pairingTokens) return { unknown: 'this daemon cannot read its paired devices' };
    return runtime.pairingTokens.list().some((token) => token.id === deviceId) ? undefined : { gone: 'its pairing was revoked' };
  }
  if (isSignIn(caller)) {
    if (!users) return { unknown: 'this daemon cannot read its sign-ins' };
    if (users.getUser(principalId) === null) return { gone: 'that sign-in user was removed' };
    if (authToken) {
      if (caller.credentialKind === 'user-session' && users.validateSession && users.validateSession(authToken) === null) return { gone: 'its sign-in ended' };
      return undefined;
    }
    if (caller.credentialKind !== 'user-session') return undefined;
    if (caller.credential?.kind !== 'session' || !users.listSessions) return { unknown: 'it was not kept which sign-in it used' };
    const sessionId = caller.credential.id;
    return users.listSessions().some((session) => session.id === sessionId) ? undefined : { gone: 'its sign-in ended' };
  }
  // Any other caller (the Agent's credential, a peer): told only with its credential in hand.
  return authToken ? undefined : { unknown: 'whether that caller is still allowed cannot be told once the daemon restarted' };
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

/** A refusal by a gate check that changed while the owner was deciding: the call is judged again as things are now. */
const CHANGED_WHILE_DECIDING = /changed while (deciding|reading)|evidence changed during comparison/i;

export function createCapabilityOwnerGate(runtime: GateRuntime, options: { readonly users?: HeldCallUsers | undefined } = {}): {
  readonly gate: (request: CapabilityGateRequest) => Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>;
  readonly held: HeldCapabilityCalls;
} {
  const users = options.users;
  const scope = new AsyncLocalStorage<AskScope>();
  const broker = runtime.approvalBroker;
  const manager = createBrokeredPermissionManager({
    // No folder trust: the question is the call's own (see the header).
    workspaceTrust: null,
    requestApproval: async (input) => {
      const asking = scope.getStore();
      // The question as the capability words it (ask-words.ts), on the record itself too, never "capability_run".
      const words = toolAskWords(input.request.tool, input.request.args);
      // `outsideFolder` is the gate's in-process word to the folder's trust (none here): never kept on the record.
      const { outsideFolder: _inProcess, ...asked } = input.request;
      const request = words ? { ...asked, analysis: { ...asked.analysis, summary: words.question } } : asked;
      // Its caller reads the record itself, so a restart leaves the question open (see the header).
      const raised = await broker.raiseApproval({ ...input, request, metadata: { ...(input.metadata ?? {}), ...(asking?.metadata ?? {}) }, readsRecord: true });
      if (asking) raisedHere.add(raised.approval.id);
      asking?.onAsked?.(raised.approval.id);
      return raised.decision;
    },
    configManager: runtime.configManager,
    policyRuntimeState: runtime.policyRuntimeState,
    hookDispatcher: runtime.hookDispatcher,
    featureFlags: runtime.featureFlags,
    userRuleStore: callerScopedRules(runtime.userPermissionRuleStore),
    secretsManager: runtime.secretsManager,
  });
  let runDefinition: Promise<ToolDefinition> | undefined;
  /** What came of each call, whole (its data included), for the caller who made it; gone with this process. */
  const outcomes = new Map<string, HeldCallOutcome>();
  /** Approved and running now. */
  const running = new Set<string>();
  /** Questions this process put: their call is in its hands, so an approval of one is run here, not on a read. */
  const raisedHere = new Set<string>();

  /** What came of a held call, kept for its caller and written on its question (a failure to write it is logged). */
  const settle = async (approvalId: string, outcome: HeldCallOutcome): Promise<void> => {
    running.delete(approvalId);
    outcomes.set(approvalId, outcome);
    try {
      await broker.recordRemoteUpdate(approvalId, {
        actor: SOURCE, actorSurface: 'daemon',
        note: outcome.ok ? 'the call ran after the owner answered' : `the call did not run: ${outcome.error}`,
        metadata: { [OUTCOME_KEY]: outcomeWords(outcome) },
      });
    } catch (error) {
      logger.warn('[capabilities] what came of a call put to the owner could not be written on its approval; the caller still reads it', { approvalId, error: summarizeError(error) });
    }
  };

  // A held call from before a restart that carried a secret input cannot run on a yes: its value was never written.
  // It is ended now, with the words its caller reads, so the owner is not asked a question whose yes does nothing.
  void broker.start().then(async () => {
    for (const record of broker.listApprovals(Number.MAX_SAFE_INTEGER)) {
      if (!raisedByGate(record) || !isOpenApprovalStatus(record.status) || raisedHere.has(record.id)) continue;
      const secrets = Array.isArray(record.metadata[SECRETS_KEY]) ? (record.metadata[SECRETS_KEY] as unknown[]).filter((label): label is string => typeof label === 'string') : [];
      if (secrets.length === 0) continue;
      const words = askAgainWords(stringOf(record.metadata['capabilityId']) ?? 'The call', secrets);
      await broker.recordRemoteUpdate(record.id, { actor: SOURCE, actorSurface: 'daemon', note: words, metadata: { [ASK_AGAIN_KEY]: words } });
      await broker.cancelApproval(record.id, { actor: SOURCE, actorSurface: 'daemon', expectedRevision: undefined, note: words });
    }
  }).catch((error: unknown) => {
    logger.warn('[capabilities] held calls kept from before a restart could not be checked for secret inputs', { error: summarizeError(error) });
  });

  // A held call approved while no request of this process holds it (put before a restart): run on the yes, as kept.
  let runApproved: ((call: ApprovedHeldCall) => Promise<void>) | undefined;
  const runIfApprovedHere = (record: SharedApprovalRecord): void => {
    if (!runApproved || !raisedByGate(record) || record.status !== 'approved' || raisedHere.has(record.id)) return;
    if (running.has(record.id) || outcomes.has(record.id) || record.metadata[STARTED_KEY] !== undefined || record.metadata[OUTCOME_KEY] !== undefined) return;
    const reading = held.read(record.id);
    if (reading.state !== 'approved-not-run') {
      // Approved, and it cannot run on the yes (a secret it carried is gone): what came of it is that answer.
      if (reading.state === 'settled' && !reading.outcome.ok && reading.outcome.code === 'CAPABILITY_ASK_AGAIN') void held.record(record.id, reading.outcome);
      return;
    }
    const runsAs = runsAsOf(record.metadata[RUNS_AS_KEY]);
    // Who it runs as was kept by this gate from the transport; one it cannot read back (or the daemon's own actor) is
    // never filled in: the call does not run, and is asked again.
    if (!runsAs.actor) {
      void settle(record.id, { ok: false, status: 409, code: 'CAPABILITY_ASK_AGAIN',
        error: `${reading.capabilityId} was not run: who asked for it could not be read back from its question, so it does not run on the owner's yes. Nothing ran.`,
        next: ['Send the call again; the owner is asked again.'] });
      return;
    }
    const run = runApproved;
    void run({ approvalId: record.id, capabilityId: reading.capabilityId, values: reading.values, caller: reading.caller, runsAs }).catch((error: unknown) => {
      logger.warn('[capabilities] a held call the owner approved could not be run', { approvalId: record.id, error: summarizeError(error) });
    });
  };
  broker.subscribe(runIfApprovedHere);

  const gate = async ({ entry, values, signal, onAsked, requestedBy, caller, runsAs, ownerAct, authToken }: CapabilityGateRequest) => {
    runDefinition ??= daemonCapabilityCatalog().then((catalog) => capabilityRunDefinition(catalog.list()));
    const decidedBy = await runDefinition;
    // An act only the owner makes, asked for by a caller who is not the owner: put to him as his own act (asked in
    // every mode, opening on No; plan mode still refuses a change). Nothing is offered to remember (`once`): his
    // answer is for this caller's one call.
    const acts = decidedBy.ownerActs;
    const definition: ToolDefinition = ownerAct === true && acts
      ? { ...decidedBy, ownerActs: { ...acts,
        values: (acts.values.includes(entry.id) ? acts.values : [...acts.values, entry.id]),
        asked: (acts.asked ?? []).includes(entry.id) ? acts.asked : [...(acts.asked ?? []), entry.id],
        once: (acts.once ?? []).includes(entry.id) ? acts.once : [...(acts.once ?? []), entry.id],
        words: { ...(acts.words ?? {}), [entry.id]: entry.label } } }
      : decidedBy;
    // The question names who is asking.
    const askedBy = callerName(runsAs, runtime, users);
    const attribution: PermissionAttribution | undefined = askedBy && runsAs?.principalId ? { kind: 'outside-caller', name: askedBy, principalId: runsAs.principalId } : undefined;
    // A secret input is secret for these values unless its `plainWhen` says not (a setting's new value, for a setting
    // that holds no password or key): such a value is shown in the question and read by the gate, so a change that
    // only tightens a protection applies at once and one that loosens is asked with what it would set.
    const secret = new Set(entry.inputs.filter((input) => input.kind === 'secret' && input.plainWhen?.(values) !== true).map((input) => input.id));
    // What it needs to run on his yes, kept with the question: never a secret's value, only that one was given.
    const kept = Object.fromEntries(Object.entries(values).filter(([id]) => !secret.has(id)));
    const secrets = entry.inputs.filter((input) => secret.has(input.id) && values[input.id] !== undefined && values[input.id] !== '').map((input) => input.label);
    const credential = heldCredential(runsAs, authToken, runtime, users);
    const metadata = {
      source: SOURCE, capabilityId: entry.id, capabilityLabel: entry.label, ...(requestedBy ? { requestedBy } : {}),
      [CALL_KEY]: { values: kept, caller: keptCaller(caller) },
      ...(runsAs ? { [RUNS_AS_KEY]: keptRunsAs({ ...runsAs, ...(credential ? { credential } : {}) }) } : {}),
      ...(secrets.length > 0 ? { [SECRETS_KEY]: secrets } : {}),
      ...(askedBy ? { [ASKED_BY_KEY]: askedBy } : {}),
    };
    // The call as decided: the capability, its inputs (never a secret's value), and who asks, so an answer remembered
    // for it covers that caller's calls only (approval-rules.ts) and a rule given for another caller never settles it.
    const who = `${runsAs?.credentialKind ?? runsAs?.principalKind ?? 'caller'}:${runsAs?.principalId ?? 'unknown'}`;
    // Its name as the owner reads it (a paired device by its name, a sign-in by its user) goes with it, so a rule kept
    // for this caller is listed by that name in Rules, never by the key it is matched on.
    const args = { id: entry.id, inputs: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, secret.has(id) ? hiddenSecret(value) : value])), [ASKED_BY_ARG]: who,
      ...(askedBy ? { [ASKED_BY_NAME_ARG]: askedBy } : {}) };
    // The owner's card names the capability and its inputs (ask-words.ts), never a secret value, and who asked.
    let raisedId: string | undefined;
    const asked = (approvalId: string): void => { raisedId = approvalId; onAsked?.(approvalId); };
    let result: Awaited<ReturnType<typeof manager.checkDetailed>>;
    try {
      // Decided for the caller's project when it named one (call-project.ts): an answer "in this project" is kept, and a
      // rule matched, for that project, never the folder the daemon started in.
      result = await scope.run({ onAsked: asked, metadata }, () => decideInProject(caller.workingDirectory, () => manager.checkDetailed(CAPABILITY_RUN_TOOL, args,
        attribution, { definition, ...(signal ? { signal } : {}) })));
    } catch (error) {
      // A held question stays open for as long as the owner takes, and the gate's own check that nothing moved while
      // it decided (a setting written meanwhile, a call that ran on another yes) then fails after he answered. That by
      // itself does not fail the call: his recorded answer stands, judged again against the mode and the deny rules as
      // they are now (plan mode, or a rule that now refuses it, refuses it with that reason). Any other failure, or a
      // check that failed before he answered, refuses the call: a check that throws is never a yes.
      const answered = raisedId !== undefined ? broker.getApproval(raisedId) : null;
      if (answered?.status === 'denied') return { approved: false, reason: stringOf(answered.decision?.reason) ?? 'the owner did not approve it' };
      const why = summarizeError(error);
      if (answered?.status !== 'approved' || !CHANGED_WHILE_DECIDING.test(error instanceof Error ? error.message : String(error))) {
        logger.warn('[capabilities] the decision on an outside caller\'s call failed; it is refused', { capabilityId: entry.id, error: why });
        return { approved: false, reason: 'its permission check failed, so it was not run; ask again' };
      }
      const refused = await refusalNow(entry.id, args, definition, caller.workingDirectory, signal);
      return refused === undefined ? { approved: true } : { approved: false, reason: refused };
    }
    return { approved: result.approved, ...(result.approved ? {} : { reason: result.detail ?? result.userReason ?? 'the owner did not approve it' }) };
  };

  /**
   * An approved call judged again against the mode and the deny and never-run rules as they are now, for the call as
   * the gate decided it (its arguments, who asked included) in its caller's project: the words that refuse it (plan
   * mode, a rule), or undefined while it may run. A check that cannot be read refuses it. The one judgement for a yes
   * whose own check failed while the question waited and for a yes to a call held from before a restart.
   */
  async function refusalNow(capabilityId: string, args: Record<string, unknown>, definition: ToolDefinition, workingDirectory: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const now = await decideInProject(workingDirectory, () => manager.previewDecision(CAPABILITY_RUN_TOOL, args, definition, signal));
      // Plan mode, a deny or never-run rule: what refuses the call now, in the words the gate gives it.
      if (now.decided.kind === 'fact' && !now.decided.allow) {
        return now.mode === 'plan' ? 'plan mode was switched on while the question waited, and plan mode runs no change'
          : now.decided.decision.reason ?? 'a rule now refuses it';
      }
      return undefined;
    } catch (recheck) {
      logger.warn('[capabilities] an approved call could not be judged again; it is refused', { capabilityId, error: summarizeError(recheck) });
      return 'whether it is still allowed could not be read after the question waited; ask again';
    }
  }

  const held: HeldCapabilityCalls = {
    async refusedNow(approvalId) {
      const record = broker.getApproval(approvalId);
      if (!raisedByGate(record)) return 'its question could not be read back';
      runDefinition ??= daemonCapabilityCatalog().then((catalog) => capabilityRunDefinition(catalog.list()));
      const call = recordOf(record.metadata[CALL_KEY]);
      // The call as the gate decided it, kept on its question (its arguments name who asked), in its caller's project.
      return refusalNow(stringOf(record.metadata['capabilityId']) ?? 'capability', { ...record.request.args }, await runDefinition,
        stringsOf(call?.['caller'])['workingDirectory']);
    },
    callerGone(approvalId, caller, authToken): HeldCallerRefusal | undefined {
      const refusal = callerRefusal(caller, authToken, runtime, users);
      if (refusal === undefined) return undefined;
      const record = broker.getApproval(approvalId);
      const who = stringOf(record?.metadata[ASKED_BY_KEY]) ?? callerName(caller, runtime, users) ?? caller.principalId ?? 'the caller';
      const capabilityId = stringOf(record?.metadata['capabilityId']) ?? 'The call';
      if ('gone' in refusal) {
        return { code: 'CAPABILITY_CALLER_GONE', status: 403,
          error: `${capabilityId} was not run: ${who} asked for it, and that caller is no longer allowed here (${refusal.gone}). The owner's yes was for that caller, so nothing ran.` };
      }
      return { code: 'CAPABILITY_ASK_AGAIN', status: 409,
        error: `${capabilityId} was not run: ${who} asked for it, and ${refusal.unknown}, so whether it may still have it run is not known. Nothing ran; it must be asked again.` };
    },
    approvedBy(approvalId) {
      return stringOf(broker.getApproval(approvalId)?.resolvedBy);
    },
    runApprovedWith(run) {
      runApproved = run;
      // Approved before this process could run it (it stopped between the yes and the start): run now.
      void broker.start().then(() => { for (const record of broker.listApprovals(Number.MAX_SAFE_INTEGER)) runIfApprovedHere(record); })
        .catch((error: unknown) => logger.warn('[capabilities] approved held calls could not be read at start', { error: summarizeError(error) }));
    },
    async start(approvalId) {
      if (running.has(approvalId) || outcomes.has(approvalId)) return false;
      const record = broker.getApproval(approvalId);
      if (record?.metadata[STARTED_KEY] !== undefined || record?.metadata[OUTCOME_KEY] !== undefined) return false;
      running.add(approvalId);
      try {
        await broker.recordRemoteUpdate(approvalId, { actor: SOURCE, actorSurface: 'daemon', note: 'the call started after the owner approved it',
          metadata: { [STARTED_KEY]: new Date().toISOString() } });
      } catch (error) {
        // Without the mark a restart would take the call as never started and run it again: it does not run now.
        logger.warn('[capabilities] that an approved call started could not be written on its approval; it was not run', { approvalId, error: summarizeError(error) });
        const capabilityId = stringOf(record?.metadata['capabilityId']) ?? 'The call';
        await settle(approvalId, { ok: false, status: 409, code: 'CAPABILITY_ASK_AGAIN',
          error: `${capabilityId} was not run: the daemon could not write on its question that it started, and without that a restart could run it a second time. Nothing ran.`,
          next: ['Send the call again; the owner is asked again.'] });
        return false;
      }
      return true;
    },
    record: settle,
    read(approvalId): HeldCallReading {
      const record = broker.getApproval(approvalId);
      if (!raisedByGate(record)) return { state: 'unknown' };
      const capabilityId = stringOf(record.metadata['capabilityId']) ?? 'capability';
      const requestedBy = stringOf(record.metadata['requestedBy']);
      const who = requestedBy ? { requestedBy } : {};
      const kept = outcomes.get(approvalId);
      if (kept) return { state: 'settled', ...who, capabilityId, outcome: kept };
      const label = stringOf(record.metadata['capabilityLabel']);
      if (isOpenApprovalStatus(record.status)) return { state: 'waiting', ...who, capabilityId, ...(label ? { label } : {}) };
      if (running.has(approvalId)) return { state: 'waiting', ...who, capabilityId, ...(label ? { label } : {}), approved: true };
      // Kept on the record by an earlier run of this daemon: its words (the data went with that process).
      const said = recordOf(record.metadata[OUTCOME_KEY]);
      if (said) {
        if (said['ok'] === true) return { state: 'settled', ...who, capabilityId, outcome: { ok: true, answer: { id: capabilityId, ok: true, text: stringOf(said['text']) ?? `${capabilityId}: done.` } } };
        return { state: 'settled', ...who, capabilityId, outcome: { ok: false, status: typeof said['status'] === 'number' ? said['status'] : 403,
          code: stringOf(said['code']) ?? 'CAPABILITY_NOT_APPROVED', error: stringOf(said['error']) ?? `${capabilityId} was not run.` } };
      }
      const askAgain = stringOf(record.metadata[ASK_AGAIN_KEY]);
      if (askAgain) {
        return { state: 'settled', ...who, capabilityId, outcome: { ok: false, status: 409, code: 'CAPABILITY_ASK_AGAIN', error: askAgain,
          next: ['Send the call again with its secret input; the owner is asked again.'] } };
      }
      if (record.status === 'approved') {
        const started = stringOf(record.metadata[STARTED_KEY]);
        if (started) {
          // Approved and started, then the daemon stopped before it said what came of it.
          return { state: 'settled', ...who, capabilityId, outcome: { ok: false, status: 409, code: 'CAPABILITY_OUTCOME_UNKNOWN',
            error: `The owner approved ${capabilityId} and it started at ${started}; the daemon stopped before it said what came of it, so whether it took effect is not known. It is not run again by itself.`,
            next: [`Read the current state of what ${capabilityId} acts on before asking again.`] } };
        }
        // Approved in this process: it is about to start here.
        if (raisedHere.has(approvalId)) return { state: 'waiting', ...who, capabilityId, ...(label ? { label } : {}), approved: true };
        const secrets = Array.isArray(record.metadata[SECRETS_KEY]) ? (record.metadata[SECRETS_KEY] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
        if (secrets.length > 0) {
          return { state: 'settled', ...who, capabilityId, outcome: { ok: false, status: 409, code: 'CAPABILITY_ASK_AGAIN', error: askAgainWords(capabilityId, secrets),
            next: ['Send the call again with its secret input; the owner is asked again.'] } };
        }
        const call = recordOf(record.metadata[CALL_KEY]);
        if (call) return { state: 'approved-not-run', ...who, capabilityId, values: stringsOf(call['values']), caller: stringsOf(call['caller']) };
        return { state: 'settled', ...who, capabilityId, outcome: { ok: false, status: 409, code: 'CAPABILITY_OUTCOME_UNKNOWN',
          error: `The owner approved ${capabilityId}, and the daemon stopped before it said what came of it; read the current state before asking again.` } };
      }
      const why = record.status === 'denied'
        ? stringOf(record.decision?.reason) ?? 'the owner did not approve it'
        : record.status === 'expired' ? 'the question expired before the owner answered it'
          : record.cause === 'requester-restarted' ? 'the question ended when the daemon restarted, before the owner answered it'
            : 'the question ended before the owner answered it (it was withdrawn)';
      return { state: 'settled', ...who, capabilityId, outcome: { ok: false, status: 403, code: 'CAPABILITY_NOT_APPROVED', error: `${capabilityId} was not run: ${sentence(why)}` } };
    },
  };
  return { gate, held };
}
