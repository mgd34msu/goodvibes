/**
 * method-owner-decision.ts, the one rule the daemon applies to every act the owner decides: a method call
 * (daemon/control-plane.ts `dispatchGatewayMethodCall`, by its id, its REST route and the WebSocket alike) and a
 * capability (control-plane/routes/capabilities.ts) are decided by the same functions here.
 *
 * Who runs an act of a class other than `none` (control-plane/method-risk.ts) at once: the owner's own program with a
 * person's press (`ownersOwnPress`). The owner's own program is their signed-in session, or the operator token from a terminal
 * program whose registration the daemon checked (daemon/program-registrations.ts): the operator token alone is held by
 * every command line and script on the machine, so it is never the owner's program by itself. Anyone else (a script or a
 * program with the operator token and no press, the MCP server's own credential, any paired device, the owner's own device
 * included, a member paired as admin, a person's press on such a
 * credential) is decided by the owner's capability gate exactly as the capability that does the same act: put to the owner,
 * opening on No, or decided under the owner's mode. A `steers-a-model` write from the owner's own program is theirs (their press,
 * or their model in their own conversation, kept with its author by the store): only anyone else's is decided.
 *
 * Not decided here, so never twice:
 *  - a call nested in a capability that was decided already (`capabilityDecidedMark`), or one the owner approved
 *    (the owner's one-call grant);
 *  - a call the program's own gate decided: the Agent's credential with that gate's mark, or the owner's own
 *    registered program with the mark;
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
// Every program the daemon issues a verified registration to (daemon/program-registrations.ts): one list, so a program
// added there is the owner's program at every check here.
import { isCommandLineRegistration, isRegisteredProgram } from './program-registrations.js';

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
 * The ONE definition of the owner in person, read by every check of that kind (who acts, answers and names projects as
 * the owner, whose message is their own turn, who holds the owner's native authority): exactly two things, both the
 * owner being there: their signed-in session (the owner account, on a session the daemon issued) and the operator token
 * from their own terminal program holding a live registration the daemon verified (daemon/program-registrations.ts).
 * Never a paired device, whatever its origin mark says (the owner's own device is `ownersDevice`, which answers questions other
 * callers raised and nothing more); never the operator token alone (every command line and script on the machine
 * holds it); never a model's credential; never an admin or member who is not the owner; never a record, a token, a
 * mark or a message carried in from a caller, a yes to someone else's request, a peer machine, a file or an upgrade.
 */
export function ownerHimself(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration'>): boolean {
  const actor = caller.actor;
  if (!actor || actor.class !== 'owner' || actor.agentFor !== undefined) return false;
  if (caller.credentialKind === 'user-session') return true;
  return caller.credentialKind === 'local' && isRegisteredProgram(caller.registration);
}

/**
 * A device the owner paired in person (their pairing flow, started from their verified program or their signed-in session and
 * completed with the code their own screen showed; pairing-token-store.ts `ownerDeviceOf`): their phone, or a program of
 * theirs on a computer that cannot prove itself to the daemon. It is NOT the owner in person. It may do exactly this beyond
 * what its scopes allow anyone: answer a question that some OTHER caller raised (never one it raised, nor one of a
 * credential made from it: the approval viewer checks the question's asker, control-plane/approval-actions.ts), and
 * do the owner's native work (their turns, under their mode). Its own risky acts are put to the owner like anyone's.
 */
export function ownersDevice(caller: Pick<CallerFacts, 'actor' | 'credentialKind'>): boolean {
  const actor = caller.actor;
  return caller.credentialKind === 'device-token' && actor !== undefined && actor.agentFor === undefined
    && actor.class === 'admin' && actor.ownerDevice !== undefined;
}

/** The answering methods an owner's device may call: an approval's answer, which the approval viewer checks per asker. */
export const OWNER_DEVICE_ANSWER_METHOD_IDS: ReadonlySet<string> = new Set(['approvals.approve', 'approvals.deny']);

/**
 * The owner's own program's model acting for them: the Agent's credential (kind `agent`, their model; the model tools of the
 * Agent and of the terminal app both use it) presented together with the registration the daemon issued to that
 * program's process it verified (the router checks the key against the operator token the program registered with,
 * daemon/http/router.ts `bindCheckedRegistration`), or a call of an Agent turn the
 * daemon itself hosts (served to itself in process). The credential alone is a script, whoever minted it: it is a file
 * any process of the account reads (terminal-shell agent-delegation-credential.ts). Only this is believed when it says
 * its gate decided a call (`x-goodvibes-decided-by-capability-gate`, `x-goodvibes-decided-in-run`), names a file or a
 * project as the owner's program, or names the conversation it registered.
 */
export function ownersAgentProgram(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration' | 'daemonHosted'>): boolean {
  if (caller.credentialKind !== 'agent') return false;
  const acting = caller.actor?.agentFor;
  if (acting === undefined || acting.class !== 'owner') return false;
  return isRegisteredProgram(caller.registration) || caller.daemonHosted === true;
}

/**
 * Who works as the owner's own program (names any file on the daemon's disk, any project, reaches every record): the
 * owner in person ({@link ownerHimself}), their Agent program ({@link ownersAgentProgram}), or a turn the daemon itself hosts
 * calling its own request path with its operator credential. Never by the kind of credential alone: the operator token
 * from a script, the operator token from another machine and the Agent's credential without its program are scripts.
 */
export function ownersProgramCaller(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration' | 'daemonHosted'>): boolean {
  return ownerHimself(caller) || ownersAgentProgram(caller) || ownersCommandLine(caller)
    || (caller.daemonHosted === true && caller.credentialKind === 'local' && caller.actor?.class === 'owner');
}

/**
 * A verified command line of the owner's (`do`, `find` of the product's own binary, registered over the program socket
 * as its own kind: daemon/program-registrations.ts `COMMAND_LINE_REGISTRATION`, with the operator token of this machine).
 * It is the owner's own program FOR WHERE IT WORKS: it names the folder it was typed in as the terminal app does and
 * reaches what the owner reaches there for reads. It makes the acts only the owner makes ({@link makesOwnerOnlyAct}). It is
 * never a person's press: every risky capability it sends, the owner's own acts included, is decided by the daemon's gate
 * under the mode in force (capabilities/command-line-hold.ts, control-plane/routes/capabilities.ts), and it answers no
 * question and approves nothing (`ownerAnswers` reads `ownerHimself`, which it is not).
 */
export function ownersCommandLine(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration'>): boolean {
  const actor = caller.actor;
  return actor !== undefined && actor.class === 'owner' && actor.agentFor === undefined
    && caller.credentialKind === 'local' && isCommandLineRegistration(caller.registration);
}

/**
 * Who mints the Agent's credential (`pairing.tokens.create` with `client: "agent"`): the owner in person (their sign-in, their
 * registered program) or an Agent turn the daemon hosts. Anyone else (an admin or member who is not the owner, any
 * device, the owner's own device included, the operator token from a script, the outside agent's credential) is refused: the
 * credential is the owner's model, so no yes of theirs turns it into anyone else's.
 */
export function mintsAgentCredential(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration' | 'daemonHosted'>): boolean {
  if (caller.actor?.class === 'system') return true;
  return ownerHimself(caller) || (caller.daemonHosted === true && caller.credentialKind === 'local' && caller.actor?.class === 'owner');
}

/** The words of a refused mint of the Agent's credential. */
export const AGENT_CREDENTIAL_OWNER_ONLY_WORDS = 'The Agent\'s credential acts as the owner\'s model, so only the owner\'s own Agent '
  + '(or the owner\'s own sign-in) has one made; this caller is not the owner in person. Nothing was made, and nothing was put to the owner.';

/**
 * The owner in person on their signed-in session ({@link ownerHimself}, signed in with their password, on a session the daemon
 * issued: the web UI). Every request on it is their own press: the session's cookie is HttpOnly and SameSite=Strict, and
 * a request from another site's page is refused by the daemon's origin check, so no other page, device or token holder
 * makes one.
 */
export function ownersOwnSession(caller: Pick<CallerFacts, 'actor' | 'credentialKind'>): boolean {
  return caller.credentialKind === 'user-session' && ownerHimself({ ...caller, registration: undefined });
}

/**
 * Whose call this is, as what it makes keeps it (a schedule, a trigger, a watch, a task: security/turn-input-party.ts
 * `recordedCauseInScope`): the owner's for the owner in person ({@link ownerHimself}) and their own Agent program's model on
 * their own input; someone else's for every other credential (a paired device, the owner's own phone included, a member, an
 * admin who is not the owner, the outside agent, a script or command line with the operator token), named by its class and
 * id. Undefined for the daemon's own in-process calls and a turn it hosts (its turn's party stands).
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

/** The owner's own press: a person's claim in the owner's own program, or anything on their own signed-in session. */
export function ownersOwnPress(caller: CallerFacts): boolean {
  return ownersOwnSession(caller) || (caller.personAsked && ownerHimself(caller));
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
  // The owner's own Agent has its credential made (its own act, for its own program: the credential works as the owner's
  // model only with that program's registration); anyone else asking for one is refused before this (dispatch).
  if (facts.agentCredentialMint === true && mintsAgentCredential(facts)) return undefined;
  return callerAdmitted(facts, risk) ? undefined : risk;
}

/**
 * The methods and capabilities that answer a question addressed to the owner: an approval (approve, deny), an inbox
 * question, a contract's escalation, a piece of work's question or plan, a device or a machine waiting to pair, a held
 * channel message, a purchase window, a conversation rewind request, a tidying proposal. Answering is never itself a
 * question: the owner's own press in their own program, or their sign-in, answers at once; anyone else is refused
 * (`ownerAnswerRefusal`), never put to the owner, so no question waits on another one for ever.
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
 * Whether this caller answers a question addressed to the owner: their own press in their own program (`ownersOwnPress`),
 * their sign-in (the web UI), the daemon itself, a run's own answerer (`decidedInRun`, the Agent's credential only), or a
 * call nested in an answer that was admitted already (`decidedUpstream`). A program's gate never answers for the owner.
 */
export function ownerAnswers(caller: CallerFacts, decided: { readonly decidedInRun?: boolean; readonly decidedUpstream?: boolean } = {}): boolean {
  // No actor, or one the daemon did not build, never answers for the owner.
  if (!wellFormedActor(caller.actor)) return false;
  if (caller.actor.class === 'system') return true;
  if (decided.decidedInRun === true || decided.decidedUpstream === true) return true;
  if (ownersOwnPress(caller)) return true;
  return caller.credentialKind === 'user-session' && caller.actor.class === 'owner' && caller.actor.agentFor === undefined;
}

/**
 * Who makes an act only the owner makes (control-plane/method-risk.ts `owner-act`, `OWNER_ONLY_CAPABILITIES`): the owner
 * in person ({@link ownerHimself}), the daemon itself, the owner's own command line ({@link ownersCommandLine}: a `do` typed
 * at the product's own verified program on this machine, which is how the owner scripts the product; its act is decided under
 * the mode in force as an item of the owner's list, exactly as the same act from the owner's own program without a press),
 * and the owner's own model in their own turn (one of the daemon's turns on their input, or their Agent program's model:
 * `ownersOwnTurn`), which makes it under their mode unless a model never makes it (the effect table's `model.refused`,
 * refused on its own). Anyone else (a paired device, the owner's own phone included, an admin or member sign-in that is not
 * the owner's, the outside agent, a script holding the operator token without the verified program, another caller's turn)
 * is refused, in every mode, before anything is decided: never put to the owner as a question. A model that runs
 * `goodvibes do` as a command is running a command: decided as a command by the turn's gate, and never reaching the daemon
 * from inside the sandbox.
 */
export function makesOwnerOnlyAct(caller: Pick<CallerFacts, 'actor' | 'credentialKind' | 'registration'> & { readonly ownersOwnTurn?: boolean | undefined }): boolean {
  if (caller.actor?.class === 'system' && caller.actor.agentFor === undefined) return true;
  if (ownerHimself(caller) || ownersCommandLine(caller)) return true;
  return caller.ownersOwnTurn === true;
}

/** The code of an owner-only act refused for a caller that is not the owner in person. */
export const OWNER_ONLY_ACT = 'OWNER_ONLY_ACT';

/** The one sentence of that refusal: what it was, that only the owner does it, and where the owner does it. */
export function ownerOnlyActWords(what: string, where: string): string {
  return `${what} is done only by the owner in person, in ${where}; this caller is not the owner. Nothing was done, and nothing was put to the owner.`;
}

/** The code of an act a model never makes (the effect table's `model.refused`), refused in every mode. */
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
