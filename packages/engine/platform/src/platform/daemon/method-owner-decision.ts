/**
 * method-owner-decision.ts, the one rule the daemon applies to every act the owner decides: a method call
 * (daemon/control-plane.ts `dispatchGatewayMethodCall`, by its id, its REST route and the WebSocket alike) and a
 * capability (control-plane/routes/capabilities.ts) are decided by the same functions here.
 *
 * There is one user. Every authenticated caller that is not a model (`agentFor` set), a chat guest, a peer node or the
 * program itself is that user ({@link isTheUser}): their signed-in session under any name and role, any paired device, the
 * machine's token from any process, the Agent's and the MCP set-up's credential when no model is acting, a typed `do`. The
 * functions below give every one of them the same answer; what limits a credential is its stored scope list, checked where
 * methods are admitted by scope, and nothing here.
 *
 * Who runs an act of a class other than `none` (control-plane/method-risk.ts) at once: the user, from any of their credentials,
 * with or without a person's claim (`ownersOwnPress`). A model's call (`agentFor` set) is decided by the owner's capability gate
 * under the owner's mode, as the capability that does the same act is. A `steers-a-model` write from the user is theirs; a
 * model's is decided.
 *
 * Not decided here, so never twice:
 *  - a call nested in a capability that was decided already (`capabilityDecidedMark`), or one the owner approved
 *    (the owner's one-call grant);
 *  - a call the program's own gate decided: the Agent's credential with that gate's mark, or the user's own
 *    program (any credential of the user) with the mark;
 *  - a call the run's own answerer decided (`decidedInRun`), and a natively admitted method called with the Agent's
 *    credential (its native admission is its one decision, control-plane/native-admission-methods.ts);
 *  - the daemon's own in-process calls (the system actor).
 * A method whose class depends on the value it carries (VALUE_DECIDED_METHOD_IDS) is told `callerAdmitted` and answers
 * `OWNER_DECISION_NEEDED` when the value is the owner's to decide; the dispatch then puts it to the gate the same way.
 * Pure: no I/O.
 */
import type { Actor } from './http-policy.js';
import type { MethodRisk } from '../control-plane/method-risk.js';
import { ANSWER_METHOD_IDS, VALUE_DECIDED_METHOD_IDS } from '../control-plane/method-risk.js';
import { NATIVELY_ADMITTED_METHOD_IDS } from '../control-plane/native-admission-methods.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';

/** Who made a call, as the dispatch established it. */
export interface CallerFacts {
  /** Who the call is admitted as, from the verified principal. */
  readonly actor: Actor | undefined;
  /** The credential kind the call authenticated with. */
  readonly credentialKind: string | undefined;
  /** The terminal program the router checked the call's registration for (`tui`, `agent`), or undefined. */
  readonly registration: string | undefined;
  /** The person's claim, after the dispatch dropped it for every credential that cannot make it. */
  readonly personAsked: boolean;
  /**
   * The daemon served the request to itself, in process (a turn it hosts calling its own request path): bound by its
   * router, never read from a header (daemon-api control-routes.ts `CallContextHeaders.daemonHosted`).
   */
  readonly daemonHosted?: boolean | undefined;
}

export interface MethodCallFacts extends CallerFacts {
  readonly methodId: string;
  /** The class of this call (method-risk.ts `methodCallRisk`). */
  readonly risk: MethodRisk;
  /** The owner's one-call grant was spent on this call (owner-approved-call.ts). */
  readonly ownerApproved: boolean;
  /** The capability this call is nested in was decided (owner-approved-call.ts `capabilityDecidedMark`). */
  readonly decidedUpstream: boolean;
  /** The run's own answerer decided it (kept only from the Agent's credential). */
  readonly decidedInRun: boolean;
  /** The program's gate decided it (kept from the Agent's credential, or from the owner's own registered program). */
  readonly decidedByProgramGate: boolean;
  /** The call mints the Agent's credential (`pairing.tokens.create` with `client: "agent"`). */
  readonly agentCredentialMint?: boolean | undefined;
}

/** The classes an actor can be (daemon-api actor.ts `ActorClass`); anything else is a malformed actor. */
const ACTOR_CLASSES: ReadonlySet<string> = new Set(['owner', 'admin', 'script', 'member', 'device', 'guest', 'peer', 'system']);

/**
 * Whether `actor` is one the daemon built: a known class, an id, and its scopes. An undefined or malformed actor is
 * refused by every check here (never admitted at once, never answering for the owner); the daemon's own in-process
 * calls carry the system actor explicitly.
 */
export function wellFormedActor(actor: Actor | undefined): actor is Actor {
  if (actor === undefined || actor === null || typeof actor !== 'object') return false;
  if (typeof actor.class !== 'string' || !ACTOR_CLASSES.has(actor.class)) return false;
  if (typeof actor.id !== 'string' || actor.id === '') return false;
  if (actor.scopes !== 'all' && !(actor.scopes instanceof Set)) return false;
  return actor.agentFor === undefined || wellFormedActor(actor.agentFor);
}

/**
 * Whether `actor` is the user: an actor the daemon built (well formed) that is not a model (`agentFor`), a chat guest, a
 * peer node or the program itself (`system`). Whatever its class (a sign-in under any username and role, a full or narrow
 * pairing, the operator token), the user is one person.
 */
export function isTheUser(actor: Actor | undefined): actor is Actor {
  if (!wellFormedActor(actor) || actor.agentFor !== undefined) return false;
  return actor.class !== 'guest' && actor.class !== 'peer' && actor.class !== 'system';
}

/**
 * The ONE definition of the user, read by every check of that kind (who acts, answers and names projects, whose message is
 * their own turn): an authenticated caller (it has a credential kind) whose actor is the user ({@link isTheUser}), from any
 * credential: their signed-in session under any username, any paired device, the operator token from any process with or
 * without a program's registration, the Agent's credential when no model is acting. Never a model's credential (the model
 * a credential carries stays a model), a chat guest, a peer machine or the program itself.
 */
export function ownerHimself(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration'>): boolean {
  if (caller.credentialKind === undefined || caller.credentialKind === null || caller.credentialKind === '') return false;
  return isTheUser(caller.actor);
}

/**
 * A paired device (any pairing, whatever its scope list): the user's own device. It does what the user does, limited only by
 * its stored scope list, which is checked where methods are admitted by scope. It answers a question some caller raised (the
 * approval viewer's own rule for who may read which question, control-plane/approval-actions.ts, is not decided here) and
 * does the user's native work.
 */
export function ownersDevice(caller: Pick<CallerFacts, 'actor' | 'credentialKind'>): boolean {
  return caller.credentialKind === 'device-token' && isTheUser(caller.actor);
}

/** The answering methods an owner's device may call: an approval's answer, which the approval viewer checks per asker. */
export const OWNER_DEVICE_ANSWER_METHOD_IDS: ReadonlySet<string> = new Set(['approvals.approve', 'approvals.deny']);

/**
 * The user's own Agent: the Agent's credential (kind `agent`; the model tools of the Agent and of the terminal app both use
 * it) carrying the user as the one it acts for. It needs no program registration: the credential is the user's program.
 * The model it carries stays a model (`agentFor` stays set on its actor, so {@link ownerHimself} and the checks that tell a
 * model from the user still see a model); this answers only whether the program holding the credential is the user's, which
 * is what lets it say its gate decided a call (`x-goodvibes-decided-by-capability-gate`, `x-goodvibes-decided-in-run`), name a
 * file or a project, or name the conversation it registered.
 */
export function ownersAgentProgram(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration' | 'daemonHosted'>): boolean {
  if (caller.credentialKind !== 'agent') return false;
  return isTheUser(caller.actor?.agentFor);
}

/**
 * Who works as the user's own program (names any file on the daemon's disk, any project, reaches every record): the user
 * ({@link ownerHimself}), their Agent program ({@link ownersAgentProgram}), their command line, or a turn the daemon itself
 * hosts calling its own request path with its operator credential.
 */
export function ownersProgramCaller(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration' | 'daemonHosted'>): boolean {
  return ownerHimself(caller) || ownersAgentProgram(caller) || ownersCommandLine(caller)
    || (caller.daemonHosted === true && caller.credentialKind === 'local' && caller.actor?.class === 'owner');
}

/**
 * The user's command line (`do`, `find` of the product's own binary, with the operator token of this machine, a program's
 * registration or none). It is the user: it names the folder it was typed in as the terminal app does, reaches what the user
 * reaches there, and makes the acts only the user makes ({@link makesOwnerOnlyAct}). Nothing it sends is held for a question:
 * a typed `do` runs at once in every permission mode, as the user's own typed command does.
 */
export function ownersCommandLine(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration'>): boolean {
  return caller.credentialKind === 'local' && isTheUser(caller.actor);
}

/**
 * Who mints the Agent's credential (`pairing.tokens.create` with `client: "agent"`): the user, from any credential, or the
 * program itself. A model never does (the actor of a model is not the user).
 */
export function mintsAgentCredential(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration' | 'daemonHosted'>): boolean {
  if (caller.actor?.class === 'system') return true;
  return ownerHimself(caller) || (caller.daemonHosted === true && caller.credentialKind === 'local' && caller.actor?.class === 'owner');
}

/** The words of a refused mint of the Agent's credential. */
export const AGENT_CREDENTIAL_OWNER_ONLY_WORDS = 'The Agent\'s credential acts as the owner\'s model, so only the owner\'s own Agent '
  + '(or the owner\'s own sign-in) has one made; this caller is not the owner in person. Nothing was made, and nothing was put to the owner.';

/**
 * The user on a signed-in session ({@link ownerHimself}: the web UI, under any username and role). Every request on it is
 * their own press: the session's cookie is HttpOnly and SameSite=Strict, and a request from another site's page is refused
 * by the daemon's origin check, so no other page, device or token holder makes one.
 */
export function ownersOwnSession(caller: Pick<CallerFacts, 'actor' | 'credentialKind'>): boolean {
  return caller.credentialKind === 'user-session' && ownerHimself({ ...caller, registration: undefined });
}

/**
 * Whose call this is, as what it makes keeps it (a schedule, a trigger, a watch, a task: security/turn-input-party.ts
 * `recordedCauseInScope`): the user's, from every credential ({@link ownerHimself}: any sign-in, any device, the operator
 * token, a command line), and their own Agent program's model on their own input; someone else's only for a model on
 * someone else's input, a guest or a peer, named by its class and id. Undefined for the daemon's own in-process calls and
 * a turn it hosts (its turn's party stands).
 */
export function partyOfCaller(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration' | 'daemonHosted'> & {
  readonly principalId?: string | undefined; readonly othersInput?: boolean | undefined;
}): { readonly party: 'owner' } | { readonly party: 'other'; readonly who: string; readonly madeFor?: string | undefined } | undefined {
  const actor = caller.actor;
  if (actor === undefined || actor.class === 'system' || caller.daemonHosted === true) return undefined;
  if (ownerHimself(caller)) return { party: 'owner' };
  if (ownersAgentProgram(caller) && caller.othersInput !== true) return { party: 'owner' };
  const acting = actor.agentFor ?? actor;
  return { party: 'other', who: `a caller that is not the owner in person (${acting.class} ${acting.id})`,
    ...(caller.principalId ? { madeFor: caller.principalId } : {}) };
}

/**
 * The user's own act: any call from one of the user's credentials ({@link ownerHimself}), with or without a person's claim. A
 * script with the machine's token, a device or a sign-in calling with no claim is the user acting, exactly as with the claim;
 * a model's call (`agentFor` set), a guest, a peer and the program itself are never this. (The methods v3.5.0 itself refused
 * without the claim keep that rule in their own confirmation, control-plane/confirmation-gate.ts, not here.)
 */
export function ownersOwnPress(caller: CallerFacts): boolean {
  return ownersOwnSession(caller) || ownerHimself(caller);
}

/** Whether the rule runs this caller's act of `risk` at once, by who made it alone (nothing nested or decided before). */
export function callerAdmitted(caller: CallerFacts, risk: MethodRisk): boolean {
  if (risk === 'none') return true;
  // No actor, or one the daemon did not build: never admitted at once (put to the owner, or refused where nobody asks).
  if (!wellFormedActor(caller.actor)) return false;
  if (caller.actor.class === 'system') return true;
  if (ownersOwnPress(caller)) return true;
  return risk === 'steers-a-model' && ownerHimself(caller);
}

/**
 * Why a call is decided as the owner's (put to the owner's gate), or undefined when it runs as its effects admit. A method that
 * decides by its value is never held here: its handler is told `callerAdmitted` and answers `OWNER_DECISION_NEEDED`.
 */
export function methodCallPutToOwner(facts: MethodCallFacts): Exclude<MethodRisk, 'none'> | undefined {
  const risk = facts.risk;
  if (risk === 'none') return undefined;
  if (VALUE_DECIDED_METHOD_IDS.has(facts.methodId)) return undefined;
  // An answer is answered or refused (ownerAnswers), never put to the owner as a question of its own.
  if (ANSWER_METHOD_IDS.has(facts.methodId)) return undefined;
  if (facts.ownerApproved || facts.decidedUpstream || facts.decidedInRun || facts.decidedByProgramGate) return undefined;
  // A natively admitted method is decided by its native admission, for the owner's own Agent program only.
  if (ownersAgentProgram(facts) && NATIVELY_ADMITTED_METHOD_IDS.has(facts.methodId)) return undefined;
  // The user's own Agent has its credential made (its own act, for its own program; a program's registration decides
  // nothing); a model asking for one is refused before this (dispatch).
  if (facts.agentCredentialMint === true && mintsAgentCredential(facts)) return undefined;
  return callerAdmitted(facts, risk) ? undefined : risk;
}

/**
 * The methods and capabilities that answer a question addressed to the owner: an approval (approve, deny), an inbox
 * question, a contract's escalation, a piece of work's question or plan, a device or a machine waiting to pair, a held
 * channel message, a purchase window, a conversation rewind request, a tidying proposal. Answering is never itself a
 * question: the user answers at once from any of their credentials (a sign-in, a device, the machine's token, a program of
 * theirs); a model, a guest or a peer is refused (`ownerAnswerRefusal`), never put to the user, so no question waits on
 * another one for ever.
 */
export { ANSWER_METHOD_IDS };
/**
 * The capabilities with a handler of their own that answer (each calls an answering method nested): declared beside the
 * class, since a handler's nested calls are not known before it runs. A capability run by its method is an answer when
 * its method is (`answersTheOwner`). And a call of the answering class nested in any other run is refused unless that
 * run's caller was admitted as the owner answering (the dispatch, `nestedAnswerAdmitted`), so a handler missing here
 * fails closed: it answers nothing.
 */
export const ANSWER_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'questions.answer', 'work.answer', 'work.approve', 'payments.answer-window', 'telegram.approve', 'telegram.deny',
  'devices.approve', 'devices.reject', 'remote.pair.requests.approve', 'remote.pair.requests.reject', 'memory.decide-proposal',
  // The owner's held mail (google.ts): sending or dropping it answers the inbox question it waits on.
  'google.approve', 'google.drop',
]);

/** Whether a capability answers something addressed to the owner: its own declaration, or its method's class. */
export function answersTheOwner(entry: { readonly id: string; readonly method?: { readonly id: string } | undefined }): boolean {
  return ANSWER_CAPABILITY_IDS.has(entry.id) || (entry.method !== undefined && ANSWER_METHOD_IDS.has(entry.method.id));
}

/**
 * Whether a call of the answering class nested in a capability run answers: only when that run's caller was admitted as
 * the owner answering (the run covers `answers-the-owner`), or it ran on the owner's own press or their yes.
 */
export function nestedAnswerAdmitted(upstream: { readonly covers?: ReadonlySet<string> | undefined; readonly how?: string | undefined }): boolean {
  return upstream.covers?.has('answers-the-owner') === true || upstream.how === 'press' || upstream.how === 'yes';
}

/** The code and words of an answer refused because its caller is not the owner answering. */
export const OWNER_ANSWERS_ONLY = 'OWNER_ANSWERS_ONLY';
export const OWNER_ANSWERS_ONLY_WORDS = 'Only the owner answers this, in person: in Waiting for you, in the terminal app, the Agent, '
  + 'the web UI or a phone the owner paired. Nothing was answered, and nothing was put to the owner.';

/**
 * Whether this caller answers a question addressed to the owner: the user from any credential ({@link ownerHimself}), the
 * daemon itself, a run's own answerer (`decidedInRun`, the Agent's credential only), or a call nested in an answer that was
 * admitted already (`decidedUpstream`). A model never answers for the user. The credential's own scope list still limits which
 * answering methods it reaches (the effect table, security/effect-authority.ts).
 */
export function ownerAnswers(caller: CallerFacts, decided: { readonly decidedInRun?: boolean; readonly decidedUpstream?: boolean } = {}): boolean {
  // No actor, or one the daemon did not build, never answers for the owner.
  if (!wellFormedActor(caller.actor)) return false;
  if (caller.actor.class === 'system') return true;
  if (decided.decidedInRun === true || decided.decidedUpstream === true) return true;
  return ownersOwnPress(caller) || ownerHimself(caller);
}

/**
 * Who makes an act only the owner makes (control-plane/method-risk.ts `owner-act`, `OWNER_ONLY_CAPABILITIES`): the user from
 * any credential ({@link ownerHimself}, {@link ownersCommandLine}: a sign-in under any username, a device, the operator token
 * from any process, a typed `do`), the daemon itself, and the user's own model in their own turn (one of the daemon's turns
 * on their input, or their Agent program's model: `ownersOwnTurn`), which makes it under their mode unless a model never makes
 * it (the effect table's `model.refused`, refused on its own). A guest, a peer and another caller's turn are refused, in
 * every mode, before anything is decided: never put to the owner as a question. A model that runs `goodvibes do` as a command
 * is running a command: decided as a command by the turn's gate, and never reaching the daemon from inside the sandbox.
 */
export function makesOwnerOnlyAct(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration'> & { readonly ownersOwnTurn?: boolean | undefined }): boolean {
  if (caller.actor?.class === 'system' && caller.actor.agentFor === undefined) return true;
  if (ownerHimself(caller) || ownersCommandLine(caller)) return true;
  return caller.ownersOwnTurn === true;
}

/** The code of an owner-only act refused for a caller that is not the user: a guest, a peer, or a model that never makes it. */
export const OWNER_ONLY_ACT = 'OWNER_ONLY_ACT';

/** The one sentence of that refusal: what it was, that only the owner does it, and where the owner does it. */
export function ownerOnlyActWords(what: string, where: string): string {
  return `${what} is done only by the owner in person, in ${where}; this caller is not the owner. Nothing was done, and nothing was put to the owner.`;
}

/**
 * The code of an act a model never makes (the effect table's `model.refused`), refused in every mode: only the acts the
 * released v3.5.0 refused a model on the route a model had (an operator method), such as granting or withdrawing access,
 * a sign-in, a credential, a pairing and the permission rules. A model's call of anything else is decided by the five
 * permission modes.
 */
export const MODEL_NEVER = 'MODEL_NEVER';
/** Its one sentence. */
export function modelNeverWords(what: string): string {
  return `${what} is never done by a model, in any mode and in the owner's own turn too: a model never creates a sign-in, `
    + 'changes a password, mints, carries out or widens a credential, pairs a device, gives or takes access, reads out a secret, '
    + 'or changes the permission mode or rules. The owner does it in person. Nothing was done, and nothing was put to the owner.';
}

/** The code a value-deciding handler answers with when the value is the owner's to decide for a caller not admitted. */
export const OWNER_DECISION_NEEDED = 'OWNER_DECISION_NEEDED';

/**
 * The answer of a value-deciding handler whose value the owner decides, for a caller the rule does not admit: the
 * dispatch puts the same call to the owner's gate (never seen by the caller as this code).
 */
export function ownerDecisionNeeded(why: string): GatewayVerbError {
  return new GatewayVerbError(why, OWNER_DECISION_NEEDED, 409);
}
