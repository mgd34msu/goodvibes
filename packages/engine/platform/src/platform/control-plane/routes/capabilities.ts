/**
 * routes/capabilities.ts, the handlers of `capabilities.find` and
 * `capabilities.run` (method-catalog-capabilities.ts).
 *
 * Run, in order: the capability by id; where it runs (a conversation's
 * capability, or one not moved yet, is refused with where it does run); the
 * inputs against its definition; its effects admitted for the caller (the
 * same table every method is held to); then who asked decides whether it is
 * put to the owner: a person's own request (the claim the daemon keeps only
 * from a person's credential) and a call the Agent makes after its own gate
 * admitted it run at once; any other caller's call goes through this
 * daemon's permission gate under the owner's mode. A capability with its own
 * method runs through that method, as the same caller.
 *
 * A call the gate puts to the owner is never held open waiting for him: the
 * answer comes at once (202 OWNER_APPROVAL_PENDING with the approval's id,
 * the form every owner-held change of the operator API answers with), the
 * question waits in Waiting for you, and the call runs, or is refused with
 * his reason, when he answers. The caller reads what came of it with
 * `capabilities.run { approvalId }`. Nothing here waits on a clock.
 *
 * Folder trust is not asked here: a daemon capability acts on what the daemon
 * keeps, not in a project folder a turn is working in (capability-wiring.ts).
 */
import { join as joinPath, resolve as resolvePath } from 'node:path';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError, readGatewayVerbRefusal } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { admitEffects, effectFacts, EFFECTS, type EffectId } from '../../security/effect-authority.js';
import { callerKey, keptCallerKey, LOCAL_OWNER_PRINCIPAL } from '../../pairing/principal-ids.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { systemActor } from '@goodvibes/engine/daemon-api/http-policy';
import type { Actor } from '../../daemon/http-policy.js';
import { randomUUID } from 'node:crypto';
import { withUntrustedContentScope } from '../../security/untrusted-content.js';
import { capabilityEffects, effectiveRisk, OWNER_DECIDED_EFFECTS, type CapabilityCatalog, type CapabilityEntry } from '../../capabilities/catalog.js';
import { findCapabilities } from '../../capabilities/find.js';
import { checkCapabilityInputs } from '../../capabilities/validate.js';
import { COMMAND_LINE_CLIENT_KIND, commandLineHoldReason } from '../../capabilities/command-line-hold.js';
import { pathInputsRefusal, runHoldingPaths } from '../../capabilities/path-inputs.js';
import { receiveCarried, resumeCarried, type CarriedKept, type CarriedReceipt, type CarriedRun } from '../../capabilities/carried-files.js';
import { capabilityOutcomeText } from '../../capabilities/outcome.js';
import { daemonListOperators, type DaemonListOperator } from '../../capabilities/daemon-catalog.js';
import { methodBodyOf } from '../../capabilities/operator-input.js';
import { daemonCapability, methodCapability, type DaemonCapabilityServices } from '../../capabilities/builtin/index.js';
import { namesSharedMemoryRecord } from '../../capabilities/builtin/memory.js';

/** The memory methods that change a record by id (`id`, a link's `toId`): of a shared record, the owner's own act. */
const SHARED_MEMORY_WRITE_METHODS: ReadonlySet<string> = new Set([
  'memory.records.update', 'memory.records.update-review', 'memory.records.delete', 'memory.records.links.add',
]);
import { CapabilityRefusal, type CapabilityCaller, type RecordAuthor } from '../../capabilities/types.js';
import { endOwnerApprovedRun, markOwnerApprovedRun, markRunAct, markRunCovers, runActOf, runCoversOf } from '../owner-approved-call.js';
import type { SettingAct } from '@goodvibes/engine/daemon-api/control-routes';
import { noteListChanged } from '../../runtime/list-changes.js';
import { asCallOutsideTurn, turnInputParty } from '../../security/turn-input-party.js';
import { conversationExposedNow, exposureNow } from '../../security/conversation-exposure.js';
import { heldMethodCallEntry, heldMethodCallFromValues, heldMethodCallOf, type HeldMethodCallEntry } from '../held-method-call.js';
import { withArtifactMaker } from '../../artifacts/turn-maker.js';
import { OWNER_QUESTIONS_FULL, OwnerQuestionBounds, ownerQuestionsFullWords } from '../owner-question-bounds.js';
import { answersTheOwner, OWNER_ANSWERS_ONLY, OWNER_ANSWERS_ONLY_WORDS, ownerAnswers, ownerHimself, ownersAgentProgram, ownersOwnPress, ownersProgramCaller } from '../../daemon/method-owner-decision.js';
import { isCommandLineRegistration } from '../../daemon/program-registrations.js';
import type { WorkCause } from '../../workflow/work-ledger/work-plans.js';
import { REGISTRATION_MARK, registrantMayName } from '../session-broker-sessions.js';
export interface CapabilityGateRequest {
  readonly entry: CapabilityEntry;
  readonly values: Readonly<Record<string, string>>;
  readonly caller: CapabilityCaller;
  readonly signal?: AbortSignal | undefined;
  /** Who asked (the principal the transport authenticated), kept on the owner's question so only he reads its outcome. */
  readonly requestedBy?: string | undefined;
  /** Told the approval's id the moment the call is put to the owner; the caller is answered then, not when he decides. */
  readonly onAsked?: ((approvalId: string) => void) | undefined;
  /** Who the call runs as, kept with the question so it runs on the owner's yes after a restart too (never a credential). */
  readonly runsAs?: HeldCaller | undefined;
  /**
   * The act is the owner's own and the caller is not the owner (an admin's sign-in, a paired device, a member): it is
   * put to him as his own act, in every mode, and runs on his yes with his authority.
   */
  readonly ownerAct?: boolean | undefined;
  /**
   * A model's delegation from a conversation in the owner's own program (`work.delegate` sent so, conversationDelegation):
   * decided under the owner's mode as an agent spawn is, not put to him as his own act.
   */
  readonly asSpawn?: boolean | undefined;
  /**
   * The caller's credential, in process only: what tells later whether it is still current is derived from it and kept
   * with the question (a fingerprint or a session id), never the credential itself.
   */
  readonly authToken?: string | undefined;
  /**
   * Each carried path input (its value in `values` is the daemon's scratch copy) by the name the caller gave it, one
   * line: the card shows it as that caller's file, and the gate decides the call on that name (carried-files.ts).
   */
  readonly carriedNames?: Readonly<Record<string, string>> | undefined;
  /** The carried inputs whose content is a folder: the card names it as the caller's folder. */
  readonly carriedFolders?: readonly string[] | undefined;
  /** The carried content's scratch folder, kept with the question so a yes after a restart runs on it. */
  readonly carriedKept?: CarriedKept | undefined;
  /**
   * What the result carries that is secret (CapabilityDefinition `resultSecret`), when it would leave for a caller
   * that is not the owner's own program: the card says "This sends <it> to <that caller>.", and it is his own act.
   */
  readonly resultSecret?: string | undefined;
}

/** The caller a held call runs as, as the transport established it: kept with the question, never its credential. */
export interface HeldCaller {
  readonly principalId?: string | undefined;
  readonly principalKind?: GatewayMethodInvocation['context']['principalKind'];
  readonly credentialKind?: GatewayMethodInvocation['context']['credentialKind'];
  readonly admin?: boolean | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly actor?: Actor | undefined;
  /**
   * What tells whether the credential is still current after a restart, never the credential: the shared operator
   * token's fingerprint, or the sign-in session's id (a paired device is told by the id in its principal).
   */
  readonly credential?: { readonly kind: 'shared-token' | 'session'; readonly id: string } | undefined;
  /**
   * Which program of that caller asked: its registration's fingerprint (method-catalog-shared.ts `CallContext`). A
   * remembered answer belongs to that program; holders of one operator token are told apart by it.
   */
  readonly registration?: string | undefined;
  /** It came from a command line (`do`): its own words on the owner's card (capabilities/command-line-hold.ts). */
  readonly commandLine?: boolean | undefined;
}

/** Why an approved held call does not run for its caller: it is no longer allowed, or whether it is cannot be told. */
export interface HeldCallerRefusal {
  readonly code: 'CAPABILITY_CALLER_GONE' | 'CAPABILITY_ASK_AGAIN';
  readonly status: number;
  readonly error: string;
}

/** A held call the owner approved while no request of its caller is in hand (after a restart): run it as it was kept. */
export interface ApprovedHeldCall {
  readonly approvalId: string;
  readonly capabilityId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly caller: Readonly<Record<string, string>>;
  readonly runsAs: HeldCaller;
}

/** What came of a call that waited for the owner: the run's answer, or the refusal (his, or the capability's own). */
export type HeldCallOutcome =
  | { readonly ok: true; readonly answer: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly error: string; readonly next?: readonly string[] | undefined };

/** What is known of a call put to the owner, read by its approval's id. */
export type HeldCallReading =
  | { readonly state: 'unknown' }
  | { readonly state: 'waiting'; readonly requestedBy?: string | undefined; readonly capabilityId: string; readonly label?: string | undefined; readonly approved?: boolean | undefined;
    /** The question the owner's card asks about it (the record's own words), which the caller is told too. */
    readonly question?: string | undefined }
  | { readonly state: 'settled'; readonly requestedBy?: string | undefined; readonly capabilityId: string; readonly outcome: HeldCallOutcome }
  /**
   * Approved by the owner while no process of this daemon held the call (it restarted after the question was put):
   * what it needs to run was kept with the question, and it runs now, as the caller who reads it.
   */
  | { readonly state: 'approved-not-run'; readonly requestedBy?: string | undefined; readonly capabilityId: string;
    /** The caller's project, program, model and session as the call sent them (read again as a call's params). */
    readonly values: Readonly<Record<string, string>>; readonly caller: Readonly<Record<string, string>> };

/** The calls this daemon put to the owner: what came of each is kept with its question. */
export interface HeldCapabilityCalls {
  /**
   * The owner approved it and it starts now: said on the question (so a restart mid-run says it had started) and in
   * memory (so a read says it is running). False when it had already started (it never runs twice), or when that it
   * started could not be written (it does not run, and its outcome says so: `read` gives it).
   */
  start(approvalId: string): Promise<boolean>;
  /** Run each held call the owner approves that no request in this process holds (kept from before a restart). */
  runApprovedWith?(run: (call: ApprovedHeldCall) => Promise<void>): void;
  record(approvalId: string, outcome: HeldCallOutcome): Promise<void>;
  read(approvalId: string): HeldCallReading;
  /**
   * Before an approved call runs: why its caller may not have it run (its token replaced, its device unpaired, its
   * sign-in user or session gone; or, with no credential in hand, whether it still may cannot be told), naming it;
   * undefined while it still may. `authToken`: the caller's credential when the request is still in hand.
   */
  callerGone?(approvalId: string, caller: HeldCaller, authToken: string | undefined): HeldCallerRefusal | undefined;
  /** Who answered the question yes (the owner's principal), when it was answered by a person. */
  approvedBy?(approvalId: string): string | undefined;
  /**
   * An approved call held from before a restart, judged again against plan mode and the deny and never-run rules as
   * they are now, as the call was decided: the words that refuse it, or undefined while it may run.
   */
  refusedNow?(approvalId: string): Promise<string | undefined>;
  /** The carried content a held call kept with its question (`CarriedKept`, read back unchecked), if it carried any. */
  carriedOf?(approvalId: string): unknown;
  /** How many of this caller's (`requestedBy`) questions wait for the owner now, from their records. */
  openOf?(requester: string): number;
  /** The same call was sent again while its question waits: one more ask, counted on that question. */
  askedAgain?(approvalId: string): Promise<void>;
}

export interface CapabilityRouteDeps {
  readonly catalog: () => Promise<CapabilityCatalog>;
  readonly services: DaemonCapabilityServices;
  /** Run another method as the same caller (its own admission and confirmation gate apply), answering its body or throwing its refusal. */
  readonly invokeMethod: (methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation) => Promise<unknown>;
  /**
   * Run a method call the dispatch put to the owner (daemon/method-owner-decision.ts) as it came, as the same caller,
   * once he approved it: its body and query sent as they were, never decided again. Absent: such a call is refused.
   */
  readonly invokeHeldMethod?: ((methodId: string, body: unknown, query: Record<string, unknown> | undefined, invocation: GatewayMethodInvocation) => Promise<unknown>) | undefined;
  /**
   * This daemon's permission gate under the owner's mode, for a caller that is
   * neither a person asking nor the Agent after its own gate. Absent: such a
   * call runs only when it carries no risk and only reads.
   */
  readonly gate?: ((request: CapabilityGateRequest) => Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>) | undefined;
  /** Where what came of a call put to the owner is kept; absent, such a call is answered only when he decides. */
  readonly held?: HeldCapabilityCalls | undefined;
  /**
   * Whether a call's registration fingerprint is a terminal program's own key on this machine (the terminal app's or
   * the Agent's, pairing/terminal-program-registration.ts). Absent: none is, so nothing a call says it was delegated
   * from is believed.
   */
  readonly terminalProgram?: ((registration: string) => boolean) | undefined;
  /** Who registered a session the daemon holds (session-broker.ts `registrantOf`); undefined when nobody did. */
  readonly sessionRegistrant?: ((sessionId: string) => string | undefined) | undefined;
  /**
   * Where carried content is put for a call (`<daemon home>/carried`, owner-only) and how parts sent ahead are read
   * (carried-files.ts). Absent: nothing is carried; a call that sends content is refused.
   */
  readonly carried?: CarriedReceipt | undefined;
}

/** The answer to a call put to the owner, now and on every read of it while he has not answered. */
function waitingAnswer(invocation: GatewayMethodInvocation, capabilityId: string, label: string, approvalId: string, approved = false, question?: string): Response {
  // What the caller reads names the act as the owner's card does (its question), never a method's bare title, and says
  // where he answers.
  const asked = question?.trim() ? question.trim().replace(/\?*$/, '?') : undefined;
  return Response.json({
    id: capabilityId,
    ok: false,
    success: false,
    code: 'OWNER_APPROVAL_PENDING',
    approvalId,
    // Whether this caller may also read the approval itself (approvals.list); its outcome it reads here either way.
    followable: admitEffects(invocation.context.actor ?? systemActor('in-process'), ['approvals.read']).kind === 'allowed',
    state: approved
      ? `${asked ?? label}: the owner approved it and it is running now; its outcome is kept with approval ${approvalId}`
      : asked !== undefined
        ? `${asked} is waiting for the owner, as his card asks it: nothing ran yet. He answers it in Waiting for you (in the terminal app or the Agent, the web UI, or a paired phone) as approval ${approvalId}; it runs when he approves it, or is refused with his reason`
        : `${label} is waiting for the owner: nothing ran yet. He answers it in Waiting for you (in the terminal app or the Agent, the web UI, or a paired phone) as approval ${approvalId}; it runs when he approves it, or is refused with his reason`,
    next: [`Ask capabilities.run with approvalId ${approvalId} (and no id) for what came of it; until the owner answers it says it is still waiting.`],
  }, { status: 202 });
}

/** The answer a held call's outcome is read back as: its run's answer, or the same refusal a direct call would have had. */
function settledAnswer(outcome: HeldCallOutcome): Readonly<Record<string, unknown>> {
  if (outcome.ok) return outcome.answer;
  throw new GatewayVerbError(outcome.error, outcome.code, outcome.status, undefined, outcome.next ? { next: outcome.next } : {});
}

/** A refusal thrown while a held call ran, kept as its outcome; anything else is the daemon's own fault, said so without its detail. */
function outcomeOfFailure(error: unknown): HeldCallOutcome {
  const refusal = readGatewayVerbRefusal(error);
  if (refusal) {
    const next = error instanceof GatewayVerbError ? error.refusal.next : undefined;
    return { ok: false, status: refusal.status, code: refusal.code, error: refusal.message, ...(next && next.length > 0 ? { next } : {}) };
  }
  // The words say the failure is in the daemon log: it is written there.
  logger.warn('[capabilities] a call the owner answered could not be completed', { error: summarizeError(error) });
  return { ok: false, status: 500, code: 'INTERNAL_ERROR', error: 'The owner approved it, and the daemon could not complete it; the failure is in the daemon log.' };
}

/**
 * The status a capability's refusal is answered with: the one its code stands for, so a refusal keeps what refused it
 * (a card that is not held is 404 NOT_FOUND, as the method underneath said). 422 is only for inputs that do not fit;
 * a service the daemon was started without is 503; any other refusal, the state it found refusing it, is 409.
 */
function refusalStatus(refusal: CapabilityRefusal): number {
  if (refusal.status !== undefined && refusal.status >= 400 && refusal.status < 600) return refusal.status;
  const code = refusal.code;
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'INVALID_ARGUMENT' || code.endsWith('_INVALID')) return 422;
  if (code === 'UNAVAILABLE' || code.endsWith('_UNAVAILABLE') || code.endsWith('_UNREADABLE')) return 503;
  return 409;
}

/** Words ending a sentence: as written when they end in . ! or ?, else with a full stop. */
function sentenceOf(words: string): string {
  const said = words.trim();
  return /[.!?]["')\]]?$/.test(said) ? said : `${said}.`;
}

/** A capability's refusal as the answer: its words, its own code and the status that code stands for. */
function refusalAnswer(refusal: CapabilityRefusal): GatewayVerbError {
  return new GatewayVerbError(refusal.message, refusal.code, refusalStatus(refusal), undefined, { next: refusal.next ? [refusal.next] : [] });
}

/** The caller of a request, as a held call keeps it: what the transport established, never the credential. */
function heldCallerOf(invocation: GatewayMethodInvocation): HeldCaller {
  const context = invocation.context;
  return {
    ...(context.principalId ? { principalId: context.principalId } : {}), ...(context.principalKind ? { principalKind: context.principalKind } : {}),
    ...(context.credentialKind ? { credentialKind: context.credentialKind } : {}), ...(context.admin !== undefined ? { admin: context.admin } : {}),
    ...(context.scopes ? { scopes: context.scopes } : {}), ...(context.actor ? { actor: context.actor } : {}),
    ...(context.call?.registration ? { registration: context.call.registration } : {}),
    ...(context.clientKind === COMMAND_LINE_CLIENT_KIND || isCommandLineRegistration(context.call?.registration) ? { commandLine: true } : {}),
  };
}

/** The client kind of a held call run on the owner's yes after a restart (capability-wiring.ts reads it). */
export const HELD_CALL_CLIENT_KIND = 'held-call';

/**
 * The invocation a held call approved after a restart runs under: its kept caller (principal, kind, credential kind,
 * scopes, actor), made in process with no credential, so each method it calls is dispatched as that same caller, with
 * that caller's scopes and effects (capability-wiring.ts), never with the daemon's own credential and never wider than
 * the same call had live. The owner's yes is the decision for the call itself.
 */
function approvedHeldInvocation(call: ApprovedHeldCall): GatewayMethodInvocation {
  const as = call.runsAs;
  return {
    body: { id: call.capabilityId, inputs: { ...call.values }, ...call.caller },
    context: {
      clientKind: HELD_CALL_CLIENT_KIND,
      ...(as.principalId ? { principalId: as.principalId } : {}), ...(as.principalKind ? { principalKind: as.principalKind } : {}),
      ...(as.credentialKind ? { credentialKind: as.credentialKind } : {}),
      ...(as.admin !== undefined ? { admin: as.admin } : {}), ...(as.scopes ? { scopes: as.scopes } : {}),
      ...(as.actor ? { actor: as.actor } : {}),
    },
  };
}

/**
 * The effects of a call only the owner causes that this caller cannot make: for a caller who is a person's credential
 * and not the owner (an admin's sign-in, a paired device, a member), none for the owner, a model, the program or a peer.
 * Those are put to the owner as his own act, never refused before he is asked.
 */
function ownersOwnEffects(actor: Actor, effects: readonly EffectId[]): readonly EffectId[] {
  if (actor.agentFor !== undefined || actor.class === 'owner' || actor.class === 'system' || actor.class === 'peer') return [];
  return effects.filter((effect) => EFFECTS[effect].least === 'owner' && admitEffects(actor, [effect]).kind !== 'allowed');
}

/** The owner's authority a call he approved for another caller runs with: his principal (who answered yes), never a credential. */
function ownerAuthority(approvedBy: string | undefined): Actor {
  // His yes (or his standing rule) is what makes this his authority; who answered is named only as recorded, never
  // filled in as another credential (the operator token's `local`) when the record does not say.
  return Object.freeze({ class: 'owner' as const, id: approvedBy ?? 'system:owner-yes', scopes: 'all' as const, via: 'in-process' as const });
}

function personAsked(invocation: GatewayMethodInvocation): boolean {
  return invocation.context.metadata?.['explicitUserRequest'] === true;
}

/**
 * A model's delegation from a conversation in the owner's own program on this machine (terminal-shell
 * agent-turn/daemon-work-delegation.ts): the call says so (`delegatedFrom: 'conversation'`, and `otherParty` when that
 * conversation's turn acts on someone else's input). It is honoured only from a terminal program's own registered key
 * (the terminal app's or the Agent's key file on this machine, pairing/terminal-program-registration.ts), over the
 * operator token on this machine (`local`, never one from another machine), for a conversation session that same
 * program registered. From any other caller (a script or `mcp serve` holding the operator token, a key a script made up,
 * a session it registered itself, a remote token holder, a device, a member) the field is ignored and the delegation is
 * decided as that caller's: put to the owner as his own act. Such a delegation is decided under the owner's mode as an
 * agent spawn is, and the work it makes carries that conversation's party.
 */
function conversationDelegation(params: Record<string, unknown>, invocation: GatewayMethodInvocation, deps: Pick<CapabilityRouteDeps, 'terminalProgram' | 'sessionRegistrant'>): { readonly otherParty?: string } | undefined {
  if (params['delegatedFrom'] !== 'conversation') return undefined;
  const kind = invocation.context.credentialKind;
  const actor = invocation.context.actor;
  if (kind !== 'local' || actor?.class !== 'owner' || actor.agentFor !== undefined) return undefined;
  if (invocation.context.transport !== undefined && invocation.context.transport !== 'loopback') return undefined;
  const registration = invocation.context.call?.registration;
  if (!registration || deps.terminalProgram?.(registration) !== true) return undefined;
  // A session this same program registered: kept with its registration (`<caller>#<program>`); one kept with none (a
  // script's, or one from before registrations were kept) is not that program's conversation.
  const sessionId = invocation.context.call?.sessionId;
  if (!sessionId || deps.sessionRegistrant?.(sessionId) !== `${callerKey(invocation.context)}${REGISTRATION_MARK}${registration}`) return undefined;
  const other = typeof params['otherParty'] === 'string' ? params['otherParty'].trim() : '';
  return other ? { otherParty: other } : {};
}

/**
 * Who caused a run (CapabilityCaller.cause): the owner himself only for his own press or typed line (the person's claim
 * from a credential that is his), his answer in Waiting for you (or his own remembered answer to the act), or a model
 * of his own conversation (the party of the turn that called it: a turn on someone else's input runs reads only, so a
 * model's act that arrives here was the owner's own turn's). Anyone else (a device, a member, an admin's sign-in, a
 * script or outside agent with the operator token, a person on a credential that is not the owner's) is someone else.
 */
function causeOfRun(at: GatewayMethodInvocation, facts: { readonly ownerAnswered: boolean; readonly modelOfTurn: boolean; readonly conversation: { readonly otherParty?: string } | undefined }): WorkCause {
  const actor = at.context.actor ?? systemActor('in-process');
  if (facts.ownerAnswered) return { party: 'owner' };
  // The owner's own press, by the ONE definition of the owner himself (daemon/method-owner-decision.ts): every request
  // on his signed-in session, and a person's claim in his own program. What he writes so is his, never someone else's.
  if (!facts.modelOfTurn && ownersOwnPress({ actor, credentialKind: at.context.credentialKind ?? undefined, registration: at.context.call?.registration, personAsked: personAsked(at) })) return { party: 'owner' };
  if (personAsked(at) && actor.class === 'owner' && actor.agentFor === undefined) return { party: 'owner' };
  if (facts.modelOfTurn) {
    // The model acts for whose turn it is (security/turn-session.ts): a member's or a device's chat is theirs, so what it
    // runs is theirs, whoever sent the message there.
    const actingFor = actor.agentFor;
    if (actingFor !== undefined && actingFor.class !== 'owner' && actingFor.class !== 'system') return { party: 'other', who: `the model of ${actingFor.class} ${actingFor.id}` };
    // A model of the owner's own verified program (its capability gate decided the call, `decidedByProgramGate`): the
    // turn ran in that program, which keeps its own party (a turn there on someone else's input runs reads only and
    // never reaches this), so this daemon has no turn in scope to read: it is his own turn's. What that conversation
    // read from outside the program says on the call (x-goodvibes-read-outside), and `authorOfRun` holds it to that.
    // One of the daemon's own turns reads its party here, from the turn in scope.
    const daemonTurn = at.context.clientKind === 'daemon-turn' && !at.context.authToken;
    if (!daemonTurn) return { party: 'owner' };
    const party = turnInputParty();
    return party.party === 'owner' ? { party: 'owner' } : { party: 'other', who: party.who };
  }
  if (facts.conversation) return facts.conversation.otherParty ? { party: 'other', who: facts.conversation.otherParty } : { party: 'owner' };
  return { party: 'other', who: `a caller that is not the owner himself (${actor.class} ${actor.id})` };
}

/**
 * Who made a run's act and how it was decided (a settings write it makes keeps this record, and a machine group
 * carries it): his yes in Waiting for you to a call put to him (the caller who asked is named), the owner's own press,
 * or admitted under his rules for the caller named, with nothing asked.
 */
function actOfRun(at: GatewayMethodInvocation, ownerAnswer: boolean): SettingAct {
  const actor = at.context.actor ?? systemActor('in-process');
  const by = at.context.principalId ?? actor.id;
  const owner = actor.class === 'owner' && actor.agentFor === undefined;
  if (ownerAnswer) return { by, owner, how: 'yes' };
  if (personAsked(at) && owner) return { by, owner, how: 'press' };
  return { by, owner, how: 'rules' };
}

/**
 * Who wrote what a run keeps that steers the owner's turns (CapabilityCaller.author), from who caused it: the owner
 * himself (his own press or typed words, his yes in Waiting for you), his model in his own turn (a model whose call a
 * turn's gate admitted, in a turn on his own input), or someone else, named as the cause names him.
 */
function authorOfRun(cause: WorkCause, model: boolean): RecordAuthor {
  if (cause.party === 'other') return { kind: 'other', ...(cause.who ? { who: cause.who } : {}) };
  // His model in a conversation that read text from outside (this turn or any earlier one: security/conversation-
  // exposure.ts) may be writing what it read: written "by your model after reading text from outside", it waits for the
  // owner's acceptance as someone else's writing does, and no later turn is given it until he accepts it.
  if (model && conversationExposedNow()) {
    const where = exposureNow().slice(0, 3).map((entry) => entry.origin).join(', ');
    return { kind: 'other', who: `your model after reading text from outside${where ? ` (${where})` : ''}` };
  }
  return model ? { kind: 'owner-model' } : { kind: 'owner' };
}

/**
 * Whether the caller of `invocation` registered a session (session-broker-sessions.ts `registrantMayName`): a session a
 * caller names is kept as where a thing came from only when it is its own. One of the daemon's own turns (made in
 * process with no credential) names the session the daemon gave it.
 */
function registeredSessionOf(invocation: GatewayMethodInvocation, deps: Pick<CapabilityRouteDeps, 'sessionRegistrant'>): (sessionId: string) => boolean {
  if (invocation.context.clientKind === 'daemon-turn' && !invocation.context.authToken && invocation.context.actor !== undefined) return () => true;
  const key = callerKey(invocation.context);
  const registration = invocation.context.call?.registration;
  // The Agent's own credential (the owner's Agent pairing, held by the Agent program alone): the conversation the Agent
  // registered with the owner's operator token under its checked registration (`<owner>#agent`: a registration is
  // issued only to a process the daemon verified is the Agent, daemon/program-peer.ts) is that same program's, so its
  // model's record names it truthfully. A registration is issued for the operator token only: a call with the Agent's
  // credential carries that registration (the router checks it against the operator token the Agent registered with),
  // and without it the credential is a script (method-owner-decision.ts `ownersAgentProgram`).
  const agentOfOwner = ownersAgentProgram(callerFactsOf(invocation));
  return (sessionId) => {
    const registrant = deps.sessionRegistrant?.(sessionId);
    return registrantMayName(registrant, { key, registration })
      || (agentOfOwner && registration !== undefined && registrant === `${LOCAL_OWNER_PRINCIPAL}${REGISTRATION_MARK}${registration}`);
  };
}

/**
 * The call came over the network, not over loopback (the listener says how it arrived; an in-process call says
 * nothing): its caller is on another machine, so a path it names is that machine's, never one this daemon reads.
 */
function fromElsewhere(invocation: GatewayMethodInvocation): { readonly elsewhere?: true } {
  const transport = invocation.context.transport;
  return transport !== undefined && transport !== 'loopback' ? { elsewhere: true } : {};
}

/**
 * A model's call that the program's capability gate itself decided: `capability_run`, which judged the capability by
 * its own risk and effects, sends it with the Agent's credential and that gate's mark (daemon-api control-routes.ts
 * `CAPABILITY_GATE_DECIDED_HEADER`; the dispatch keeps the mark only from the Agent's credential). Every turn tool that
 * runs a capability goes through that gate (agent-turn/capability-tools.ts); a call with the Agent's credential and no
 * mark was not judged so, and is decided here as any outside caller's.
 */
function decidedByProgramGate(invocation: GatewayMethodInvocation): boolean {
  // The owner's own program's model (its credential with its registration), or one of the daemon's own turns, whose
  // call is made in process with no credential (tools/capability/daemon-tools.ts): its own gate, in this daemon, decided.
  const daemonTurn = invocation.context.clientKind === 'daemon-turn' && !invocation.context.authToken;
  return (ownersAgentProgram(callerFactsOf(invocation)) || daemonTurn) && invocation.context.metadata?.['decidedByCapabilityGate'] === true;
}

/** Who made the call, as the one owner rule reads it (method-owner-decision.ts), from what the dispatch established. */
function callerFactsOf(invocation: GatewayMethodInvocation): { readonly actor: GatewayMethodInvocation['context']['actor']; readonly credentialKind: string | undefined; readonly registration: string | undefined; readonly daemonHosted: boolean } {
  return { actor: invocation.context.actor, credentialKind: invocation.context.credentialKind ?? undefined,
    registration: invocation.context.call?.registration, daemonHosted: invocation.context.call?.daemonHosted === true };
}

/**
 * Who asked, as the call context says it (method-catalog-shared.ts `CallContext`): the body's fields (the context given
 * by hand: the web UI's chosen project, an outside caller's `workingDirectory`) over the context the calling program
 * sends on every request (its project, its conversation; the program is `clientKind`). Nothing else fills a part that
 * is missing: the daemon's own folder is never taken for the caller's project.
 */
function callerOf(params: Record<string, unknown>, context?: GatewayMethodInvocation['context']): CapabilityCaller {
  const given = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const workingDirectory = given(params['workingDirectory']) ?? given(context?.call?.project);
  const named = params['program'] ?? context?.clientKind;
  const program = named === 'tui' || named === 'agent' ? named : undefined;
  // The model of the asking program's conversation (a context window size acts on it unless the call names another).
  const model = given(params['model']);
  // The asking program's conversation (a memory record says which session it came from).
  const sessionId = given(params['sessionId']) ?? given(context?.call?.sessionId);
  // Every project at once: the owner's own choice in his place's project chooser, with no project named; anyone else's
  // ask for it is dropped, so the call reads only what belongs to no project.
  const everyProject = params['everyProject'] === true && !workingDirectory
    && ownerHimself({ actor: context?.actor, credentialKind: context?.credentialKind, registration: context?.call?.registration });
  return { ...(workingDirectory ? { workingDirectory } : {}), ...(program ? { program } : {}), ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}),
    ...(everyProject ? { everyProject: true } : {}) };
}

/** The invocation with the caller's project and conversation as its call context, so a method it runs acts there too. */
function withCallOf(at: GatewayMethodInvocation, caller: CapabilityCaller): GatewayMethodInvocation {
  if (!caller.workingDirectory && !caller.sessionId) return at;
  const next = { ...at, context: { ...at.context, call: { ...at.context.call, ...(caller.workingDirectory ? { project: caller.workingDirectory } : {}), ...(caller.sessionId ? { sessionId: caller.sessionId } : {}) } } };
  // The same run: its act goes with it (the methods it calls keep it).
  const act = runActOf(at);
  if (act) markRunAct(next, act);
  const covers = runCoversOf(at);
  if (covers) markRunCovers(next, covers);
  return next;
}

function where(entry: CapabilityEntry): string {
  const line = `/${entry.command}${entry.word ? ` ${entry.word}` : ''}`;
  return entry.home === 'session'
    // A session capability may have no slash command any more: it is named by where it is, never by a line to type.
    ? `${entry.id} acts on what a terminal program holds (its conversation, its screen or its own records), so it runs in that program (its place there, or capability_run from its model); nothing ran here.`
    : `${entry.id} has not moved to the daemon yet: it runs only inside a terminal program (${line} there, or capability_run from its model); nothing ran here.`;
}

/**
 * The runs of approved calls whose question outlived the process that put it (a daemon restart): the invocation they
 * run under, built from the caller's own read, with the approval's id. Such a run skips the gate (the owner decided).
 */
const resumedRuns = new WeakMap<object, string>();
/** Each caller's questions waiting for the owner, bounded, and a call sent again counted on its question. */
const questionBounds = new OwnerQuestionBounds();
/** The caller a held call run on a yes was kept as (what tells whether it is still allowed included), by its invocation. */
const resumedCallers = new WeakMap<object, HeldCaller>();
/** The runs the owner answered yes to himself (in Waiting for you, or by his own remembered answer to his act), by invocation. */
const ownerAnswered = new WeakSet<object>();

/**
 * A method call the dispatch put to the owner (daemon/method-owner-decision.ts), as this route decides it: from the
 * metadata the dispatch builds in process (`methodCall`), or, for a run the daemon resumed itself after a restart, from
 * the question's kept input when its id names a method and no capability. Undefined for any other call: a caller's body
 * never makes one.
 */
function heldMethodOf(invocation: GatewayMethodInvocation, id: string, params: Record<string, unknown>,
  methods: Pick<GatewayMethodCatalog, 'get'>, catalog: CapabilityCatalog): HeldMethodCallEntry | undefined {
  const fromDispatch = heldMethodCallOf(invocation.context.metadata);
  const call = fromDispatch
    ?? (resumedRuns.has(invocation) && id && !catalog.get(id) ? heldMethodCallFromValues(id, readRecord(params['inputs'])) : undefined);
  const descriptor = call ? methods.get(call.id) : undefined;
  return call && descriptor ? heldMethodCallEntry(descriptor, call) : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** What came of a call that waited for the owner, for the caller who made it: the outcome, a refusal, or still waiting. */
async function readHeldCall(deps: CapabilityRouteDeps, invocation: GatewayMethodInvocation, approvalId: string, run: GatewayMethodHandler): Promise<unknown> {
  const reading = deps.held?.read(approvalId) ?? { state: 'unknown' as const };
  // Only the caller who made the call reads what came of it; to anyone else the id is unknown.
  // Compared by kind first (pairing/principal-ids.ts): one kept before the kind was kept is read by its form.
  const asker = callerKey(invocation.context);
  if (reading.state === 'unknown' || (reading.requestedBy !== undefined && keptCallerKey(reading.requestedBy) !== asker)) {
    throw new GatewayVerbError(`No call put to the owner has the id ${approvalId} for this caller.`, 'CAPABILITY_CALL_NOT_FOUND', 404, 'approvalId', {
      next: ['Send the approvalId a 202 OWNER_APPROVAL_PENDING answer of capabilities.run gave you, with the same credential.'],
    });
  }
  if (reading.state === 'waiting') return waitingAnswer(invocation, reading.capabilityId, reading.label ?? reading.capabilityId, approvalId, reading.approved === true, reading.question);
  if (reading.state === 'approved-not-run') {
    // Approved after a restart: run now as this same caller (its credential is current; none was ever written down),
    // with the inputs kept on the question. Its inputs are checked and its effects admitted again, as for any call.
    const resumed: GatewayMethodInvocation = {
      ...invocation, signal: undefined, query: undefined,
      body: { id: reading.capabilityId, inputs: { ...reading.values }, ...reading.caller },
    };
    resumedRuns.set(resumed, approvalId);
    try {
      return await run(resumed);
    } catch (error) {
      // Refused before it started (its inputs or effects, checked again): that refusal is what came of it.
      if (deps.held?.read(approvalId).state === 'approved-not-run') await deps.held.record(approvalId, outcomeOfFailure(error));
      throw error;
    }
  }
  return settledAnswer(reading.outcome);
}

function createRunHandler(deps: CapabilityRouteDeps, methods: Pick<GatewayMethodCatalog, 'get'>): GatewayMethodHandler {
  const handler: GatewayMethodHandler = async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = typeof params['id'] === 'string' ? params['id'].trim() : '';
    const heldId = typeof params['approvalId'] === 'string' ? params['approvalId'].trim() : '';
    // The outcome of a call that waited for the owner, read by the id its first answer gave.
    if (heldId && !id) return readHeldCall(deps, invocation, heldId, handler);
    const catalog = await deps.catalog();
    // A method call the dispatch put to the owner (daemon/method-owner-decision.ts): from the dispatch's own metadata, or,
    // run on his yes after a restart, from the question this gate raised (never from what a caller sends).
    const heldMethod = heldMethodOf(invocation, id, params, methods, catalog);
    // The question a held call's card asks, read from its record, for the answer the caller reads (waitingAnswer).
    const questionOf = (approvalId: string): string | undefined => {
      const reading = deps.held?.read(approvalId);
      return reading?.state === 'waiting' ? reading.question : undefined;
    };
    const entry = heldMethod ? heldMethod.entry : id ? catalog.get(id) : undefined;
    if (!entry) throw new GatewayVerbError(`No capability ${id || '(no id given)'}.`, 'CAPABILITY_NOT_FOUND', 404, 'id', { next: ['Say what you need to capabilities.find; it names the capabilities that do it.'] });
    if (entry.home !== 'daemon') throw new GatewayVerbError(where(entry), 'CAPABILITY_ELSEWHERE', 409, 'id', {
      next: [entry.home === 'session' ? 'Run it in the terminal app or the Agent, from its place there.' : `Run it in the terminal app or the Agent: /${entry.command}${entry.word ? ` ${entry.word}` : ''}.`],
    });
    const checked = heldMethod ? { ok: true as const, values: heldMethod.values } : checkCapabilityInputs(entry, params['inputs']);
    if (!checked.ok) throw new GatewayVerbError(checked.problem, 'CAPABILITY_INPUT_INVALID', 400, checked.input ? `inputs.${checked.input}` : 'inputs', { next: ['capabilities.find lists each input with its kind and choices.'] });
    // The owner's own program, by who it is (method-owner-decision.ts `ownersProgramCaller`: the owner himself, his
    // registered terminal program, his Agent program, a turn the daemon hosts; never a credential's kind alone): only it
    // says where a file is (`filesAt: program`, the program does the file work and sends the content); from anyone else
    // that input is dropped and the path rules apply as for any path (path-inputs.ts).
    const ownersProgram = ownersProgramCaller(callerFactsOf(invocation));
    // A held call run on the owner's yes after a restart runs on the values kept with its question, which the daemon
    // made: a file it read before asking (`readsFileBefore`) is kept there as `filesAt: program` and its content.
    const resumedCall = resumedRuns.has(invocation);
    const given = !ownersProgram && !resumedCall && checked.values['filesAt'] !== undefined
      ? Object.fromEntries(Object.entries(checked.values).filter(([input]) => input !== 'filesAt')) : checked.values;
    // The files and folders the program asking sent for its path inputs (its machine's, carried-files.ts): put in a
    // scratch folder of this call's in the daemon's home, and named there; what the run leaves there goes back with the
    // answer. Carried only for a caller on another machine or the owner's own program: a paired device or member on this
    // machine names a file in its project here. A held call approved after a restart runs on the content kept with its
    // question; that content gone, it is asked again, never run on the daemon's own disk.
    let carriedRun: CarriedRun | undefined;
    const resumedFrom = resumedRuns.get(invocation);
    try {
      const kept = resumedFrom !== undefined ? deps.held?.carriedOf?.(resumedFrom) : undefined;
      if (kept !== undefined) {
        carriedRun = deps.carried ? resumeCarried(kept, given, deps.carried.daemonHome) : undefined;
        if (!carriedRun) {
          throw new GatewayVerbError(`${entry.id} was not run: the files sent with it were kept with its question, and they are no longer there (the daemon removed them, or its home changed), so it does not run on its own disk instead. Nothing ran.`,
            'CAPABILITY_ASK_AGAIN', 409, undefined, { next: ['Send the call again with its files; the owner is asked again.'] });
        }
      } else if (resumedFrom === undefined && params['carried'] !== undefined && params['carried'] !== null) {
        if (fromElsewhere(invocation).elsewhere !== true && !ownersProgram) {
          throw new GatewayVerbError(`${entry.id} was not run: files are sent with a call only from another machine or from your own program; this caller is on this machine, so it names a file in its project here. Nothing ran.`,
            'CAPABILITY_CARRY_REFUSED', 403, 'carried', { next: ['Name the file by its path inside the project, without sending its content.'] });
        }
        if (!deps.carried) throw new GatewayVerbError(`${entry.id} was not run: this daemon takes no files sent with a call. Nothing ran.`, 'CAPABILITY_CARRY_REFUSED', 403, 'carried');
        carriedRun = await receiveCarried(entry, given, params['carried'], deps.carried);
      }
    } catch (error) {
      if (error instanceof CapabilityRefusal) throw refusalAnswer(error);
      throw error;
    }
    // Reassigned once, below, by a capability that reads its file before anything is asked (`readsFileBefore`).
    let values = carriedRun?.values ?? given;
    // What the call is judged on (its risk, a command line's hold, the gate): each carried path as the caller named it,
    // the full path the card shows, never the scratch copy's last name (carried-files.ts `asNamed`).
    const judged = carriedRun ? carriedRun.asNamed(values) : values;
    // A session the caller names is where a thing came from only when this caller registered it (its own conversation);
    // one of the daemon's own turns names the session the daemon gave it.
    const registeredSession = registeredSessionOf(invocation, deps);
    const named = callerOf(params, invocation.context);
    const { sessionId: namedSession, ...rest } = named;
    const caller: CapabilityCaller = {
      ...rest, ...(namedSession !== undefined && registeredSession(namedSession) ? { sessionId: namedSession } : {}),
      registeredSession, ...(carriedRun ? { carried: carriedRun.roots } : {}),
      // Only the owner's own program's person names any file on this disk; anyone else's path is in its given project.
      namesAnyFile: ownersProgram,
      // The owner himself (daemon/method-owner-decision.ts): an act only he makes (a record moved out of its project).
      ...(ownerHimself({ actor: invocation.context.actor, credentialKind: invocation.context.credentialKind, registration: invocation.context.call?.registration }) ? { ownerHimself: true } : {}),
    };
    const risk = effectiveRisk(entry, judged);
    const definition = daemonCapability(entry.id);
    // What the capability needs from its caller (the project it acts in, the program asking) is checked first: a call
    // that would be refused for want of it is refused now, and the owner is never asked about it.
    const needs = definition?.callerNeeds;
    const lacking = needs?.project !== undefined && !caller.workingDirectory ? { field: 'workingDirectory', said: needs.project }
      : needs?.program !== undefined && !caller.program ? { field: 'program', said: needs.program } : undefined;
    if (lacking) {
      throw new GatewayVerbError(lacking.said, 'CAPABILITY_CALLER_CONTEXT_MISSING', 422, lacking.field, {
        state: 'nothing ran', next: [`Send ${lacking.field} with the request${lacking.field === 'program' ? ' (tui or agent)' : ' (the project folder)'}.`,
          ...(lacking.field === 'workingDirectory' ? ['A caller that is not the owner\'s own program works only in a project the owner gave it: he gives it one in Devices and network, on its row, and the outside agent (goodvibes-daemon mcp serve) that names one is asked about once.'] : [])],
      });
    }
    // Its preview check (a file outside the project named by a caller who is not the person, a path named from another
    // machine): refused now, before the owner is asked anything about a call that would then be refused.
    // Every file named by path is inside the caller's project unless the person named it himself (path-inputs.ts).
    // A command line's call held for the owner (below): the person typed its paths, and the owner reads them on its card
    // before it runs, so they are taken as the person named them.
    // Whether this act is one the owner decides (it weakens a protection, cannot be undone, spends money, writes a
    // secret or what steers a model, or is his own act): the same words the command line's hold and the method rule use.
    const ownerDecides = commandLineHoldReason(entry, judged, definition?.loosensIf ?? methodCapability(entry.id)?.loosensIf, definition?.steersModel === true) !== undefined;
    // The classes of the one owner decision this run's own decision covers (method-risk.ts names), read by the dispatch
    // for each method the run calls (owner-approved-call.ts `markRunCovers`).
    // Whether this run answers something addressed to the owner, and its caller is the owner answering (ownerAnswers).
    const answers = answersTheOwner(entry);
    const answering = answers && ownerAnswers({
      actor: invocation.context.actor, credentialKind: invocation.context.credentialKind ?? undefined,
      registration: invocation.context.call?.registration, personAsked: personAsked(invocation),
    });
    const coveredClasses: ReadonlySet<string> = new Set([
      ...(risk === 'loosens-a-protection' ? ['loosens-a-protection'] : []),
      ...(risk === 'cannot-be-undone' ? ['cannot-be-undone'] : []),
      ...(risk === 'spends-money' ? ['spends-money'] : []),
      ...(entry.touches === 'credential' || capabilityEffects(entry, judged).includes('secret.write') ? ['writes-a-secret'] : []),
      ...(definition?.steersModel === true ? ['steers-a-model'] : []),
      ...(entry.ownerOnly ? ['owner-act'] : []),
      // A capability that answers, run by the owner answering (checked below before anything runs): its nested answer
      // answers. Any other run's nested answer is refused (method-owner-decision.ts `nestedAnswerAdmitted`).
      ...(answering ? ['answers-the-owner'] : []),
    ]);
    // A command line by its client kind, or by the registration the daemon issued it (`cli`: known by the registration it
    // runs under, never by an environment variable a command can unset; daemon/program-registrations.ts).
    const commandLineCall = invocation.context.clientKind === COMMAND_LINE_CLIENT_KIND || isCommandLineRegistration(invocation.context.call?.registration);
    const heldFromCommandLine = commandLineCall && !resumedRuns.has(invocation) && ownerDecides;
    // The same after a daemon restart: the held call's kept caller says it was typed as a command (capability-owner-gate.ts
    // keeps `commandLine` with its question), read only for a run the daemon resumed itself, never from a caller's body.
    const resumedFromCommandLine = resumedRuns.has(invocation) && params['commandLine'] === 'true';
    const namedByPerson = (at: GatewayMethodInvocation): boolean => personAsked(at) || heldFromCommandLine || resumedFromCommandLine;
    const previewRefusal = pathInputsRefusal(entry, values, { ...caller, personAsked: namedByPerson(invocation), ...fromElsewhere(invocation) })
      ?? definition?.check?.(values, { ...caller, personAsked: namedByPerson(invocation), ...fromElsewhere(invocation) });
    if (previewRefusal) throw refusalAnswer(previewRefusal);
    // A capability that applies a file reads it here, once, before anything is asked: what its content already earns is
    // refused now (a setting in it locked as managed), and what the owner is asked about is that content, which is what
    // then runs (a run on his yes after a restart runs on the values kept with the question, so it is not read again).
    if (definition?.readsFileBefore && !resumedCall) {
      let read: ReturnType<NonNullable<typeof definition.readsFileBefore>>;
      try { read = definition.readsFileBefore(values, deps.services, { ...caller, personAsked: namedByPerson(invocation), ...fromElsewhere(invocation) }); }
      catch (error) { if (error instanceof CapabilityRefusal) throw refusalAnswer(error); throw error; }
      if (read instanceof CapabilityRefusal) throw refusalAnswer(read);
      if (read) values = read as typeof values;
    }
    // An act only the owner makes, asked for by a caller who is not the owner (an admin's sign-in, a paired device, a
    // member, a person's own press on such a credential included): put to the owner as his own act, never refused
    // before he is asked, and run on his yes with his authority (owner-approved-call.ts).
    let ownerAct = false;
    // A model's call that a turn's gate admitted (the program's capability gate, or one of the daemon's own turns): who
    // caused what it runs is that turn's party (causeOfRun).
    let modelOfTurn = false;
    // A model's delegation from a conversation in the owner's own program: decided under his mode as an agent spawn is
    // (the gate is asked with work.delegate not taken as his own act), the work carrying that conversation's party.
    const conversation = entry.id === 'work.delegate' ? conversationDelegation(params, invocation, deps) : undefined;
    // A capability with its own method is admitted by that method; a moved one by its own effects.
    if (definition) {
      const actor = invocation.context.actor ?? systemActor('in-process');
      const effects = capabilityEffects(entry, values);
      // A model's call that arrives through capability_run (the Agent's kind, after the program's or the turn's gate)
      // was put to the owner for what it writes: writing a credential is admitted as his, not refused as the model's.
      // The effect table's refusal (security/effect-authority.ts, `secret.write`) stands for every other path.
      // So is an act that is the owner's own (an effect a model never causes): the program's gate put it to him on
      // every call (gate/classify.ts, `ownerActs.asked`), so it arrives only after his yes and is admitted as his,
      // and its nested method is admitted as his for that one call (owner-approved-call.ts).
      // A call the program's capability gate decided (the Agent's credential with that gate's mark), or one of the
      // daemon's own turns (its call made in process as that turn's model; never a held call run on a yes).
      const ownerDecided = (decidedByProgramGate(invocation)
        || (invocation.context.clientKind === 'daemon-turn' && !invocation.context.authToken && !resumedRuns.has(invocation)))
        && actor.agentFor !== undefined;
      modelOfTurn = ownerDecided;
      const hisOwn = (effect: (typeof effects)[number]): boolean => OWNER_DECIDED_EFFECTS.has(effect) || effectFacts([effect]).modelRefused;
      const putToOwner = ownerDecided ? [] : ownersOwnEffects(actor, effects);
      // An act only the owner himself does (`ownersAct`: handing work over, approving a plan), asked for by a caller who
      // is not the owner (a device, a member, an admin's sign-in, a person's press on such a credential): his to decide.
      const othersAskHim = definition.ownersAct === true && !ownerDecided && actor.agentFor === undefined && actor.class !== 'owner' && actor.class !== 'system';
      ownerAct = (putToOwner.length > 0 || othersAskHim) && deps.gate !== undefined;
      // A change of one of the owner's shared things of no project (a memory record of his that applies everywhere):
      // his own act for these values (`ownersActWhen`), put to him in every mode, unless he makes it himself or his own
      // turn does (a daemon turn or his program's model on his own input).
      const hisOwnTurn = ownerDecided && invocation.context.call?.othersInput !== true;
      if (deps.gate !== undefined && caller.ownerHimself !== true && !hisOwnTurn && actor.class !== 'owner' && actor.class !== 'system'
        && definition.ownersActWhen?.(values, deps.services) === true) ownerAct = true;
      const asModel = ownerDecided ? effects.filter((effect) => !hisOwn(effect)) : ownerAct ? effects.filter((effect) => !putToOwner.includes(effect)) : effects;
      const asOwner = ownerDecided ? effects.filter(hisOwn) : [];
      const modelAdmission = admitEffects(actor, asModel);
      const admission = modelAdmission.kind !== 'allowed' || asOwner.length === 0 ? modelAdmission : admitEffects(actor.agentFor!, asOwner);
      if (admission.kind === 'refused') throw new GatewayVerbError(`${entry.id}: ${admission.reason}. ${admission.next}`, admission.code, 403);
      if (admission.kind === 'ask-owner') throw new GatewayVerbError(`${entry.id} is the owner's to decide (${admission.reason}).`, 'OWNER_ONLY', 403);
      if (asOwner.some((effect) => !OWNER_DECIDED_EFFECTS.has(effect))) markOwnerApprovedRun(invocation, `${entry.id}:decided-in-program`);
    } else if (entry.method && deps.gate) {
      // An action run through its own method is admitted there, as the caller; only an act of the owner's own that
      // this caller cannot make is taken here, so it is put to him instead of refused after he was asked.
      const actor = invocation.context.actor ?? systemActor('in-process');
      const declared = methods.get(entry.method.id)?.effects ?? [];
      const putToOwner = ownersOwnEffects(actor, declared);
      // An act only the owner himself does (`ownersAct`, as for a handler capability), asked for by a caller who is not
      // the owner (an admin pairing, a member, a device not his): his to decide, whatever the method admits.
      if (methodCapability(entry.id)?.ownersAct === true && actor.agentFor === undefined && actor.class !== 'owner' && actor.class !== 'system') ownerAct = true;
      if (putToOwner.length > 0) {
        ownerAct = true;
        const rest = admitEffects(actor, declared.filter((effect) => !putToOwner.includes(effect)));
        if (rest.kind === 'refused') throw new GatewayVerbError(`${entry.id}: ${rest.reason}. ${rest.next}`, rest.code, 403);
        if (rest.kind === 'ask-owner') throw new GatewayVerbError(`${entry.id} is the owner's to decide (${rest.reason}).`, 'OWNER_ONLY', 403);
      }
    }
    // A held method call of the owner's own act (its class `owner-act`): put to him as his own act, in every mode.
    if (heldMethod?.risk === 'owner-act' && deps.gate) ownerAct = true;
    // A held memory method changing one of the owner's shared records (of no project): his own act, in every mode, as
    // the capability that does the same is (memory.ts `ownersActWhen`).
    if (heldMethod && deps.gate && SHARED_MEMORY_WRITE_METHODS.has(heldMethod.call.id)) {
      const body = heldMethod.call.body !== null && typeof heldMethod.call.body === 'object' ? heldMethod.call.body as Record<string, unknown> : {};
      const query = heldMethod.call.query;
      const ids = [body['id'], body['toId'], query['id'], query['toId']].map((value) => typeof value === 'string' ? value : undefined);
      if (namesSharedMemoryRecord(deps.services, ids)) ownerAct = true;
    }
    // A result that carries a secret (a sign-in file, a device's token, the group's join key), asked for by a caller that
    // is not the owner's own program (a paired device, a member, a sign-in; its person's own press included): its
    // result would leave for that caller, so it is the owner's own act, put to him opening on No with what it sends and to
    // whom. A run on his yes after a restart is his answer already.
    // The one rule (daemon/method-owner-decision.ts): the owner's own press (his sign-in, or his verified program with
    // his press) or a call his program's gate decided gets it at once; any other caller, the operator token alone
    // included, is put to him.
    const hisOwnPress = ownersOwnPress({
      actor: invocation.context.actor, credentialKind: invocation.context.credentialKind ?? undefined,
      registration: invocation.context.call?.registration, personAsked: personAsked(invocation),
    }) || decidedByProgramGate(invocation);
    const resultSecret = definition?.resultSecret !== undefined && !hisOwnPress && resumedFrom === undefined ? definition.resultSecret : undefined;
    if (resultSecret !== undefined) {
      if (!deps.gate) throw new GatewayVerbError(`${entry.id} was not run: its result carries ${resultSecret}, which goes to a caller that is not your own program only on your yes, and nobody here can be asked. Nothing ran.`, 'OWNER_ONLY', 403);
      ownerAct = true;
    }
    // What a method capability sends, read before anything is asked: an action with a preview sends the body its
    // preview reads from the values (as the web UI's sheet does), and the preview is a read that refuses what will
    // not run (a described time that needs a decision model, inputs that do not fit, a target that is not there), so
    // the owner is never asked about a call that then fails for a reason known now.
    let methodInput: Record<string, unknown> | undefined;
    if (!definition && entry.method && !heldMethod) {
      try {
        // What it makes is the caller's project's (a schedule's runs work there): its folder goes with the body.
        methodInput = await methodBodyOf(entry.method, values, (previewId, fields) => deps.invokeMethod(previewId, fields, withCallOf(invocation, caller)), caller.workingDirectory);
      } catch (error) {
        if (error instanceof CapabilityRefusal) throw refusalAnswer(error);
        throw error;
      }
    }
    // A change that ran is announced (LIST_CHANGED `capabilities`, its id), so every place list it acts on is read again,
    // whoever ran it: the web view, the model, a script, another program. A read announces nothing.
    const perform = async (at: GatewayMethodInvocation): Promise<Record<string, unknown>> => {
      let answer: Record<string, unknown>;
      try {
        // A file the run saves is its caller's, in the project the call names (artifacts/turn-maker.ts): its maker
        // reaches it there afterwards; a daemon turn's file is its chat's (decided in the store).
        answer = await withArtifactMaker({ createdBy: at.context.principalId ?? undefined, project: caller.workingDirectory }, () => performOnce(at));
        // What the run made or changed at a carried path goes back to the program asking, which writes it on its machine.
        if (carriedRun) {
          const back = carriedRun.collect();
          const data = answer['data'] !== null && typeof answer['data'] === 'object' && !Array.isArray(answer['data']) ? answer['data'] as Record<string, unknown> : {};
          // Its words name the caller's own file, never the daemon's scratch copy of it.
          const named = (value: unknown): unknown => typeof value === 'string' ? carriedRun!.named(value) : value;
          const namedData = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, named(value)]));
          answer = { ...answer, text: named(answer['text']), ...(answer['detail'] !== undefined ? { detail: named(answer['detail']) } : {}),
            ...(answer['data'] !== undefined || Object.keys(back).length > 0 ? { data: { ...namedData, ...(Object.keys(back).length > 0 ? { carried: back } : {}) } } : {}) };
        }
      } finally {
        carriedRun?.dispose();
      }
      // A capability that acts on the caller's project (callerNeeds.project) changed that project's list: the notice
      // names it, so screens in other projects do not read again. Any other change names none (every screen reads).
      const projectOnly = needs?.project !== undefined || definition?.changesCallerProject?.(values) === true;
      const project = projectOnly && caller.workingDirectory ? resolvePath(caller.workingDirectory) : undefined;
      if (entry.lasts !== 'not-a-change') noteListChanged({ list: 'capabilities', change: 'changed', id: entry.id, ...(project !== undefined ? { project } : {}) });
      return answer;
    };
    // The run itself, as the caller `at` (the request, or the same caller once the owner approved a call put to him).
    const performOnce = async (at: GatewayMethodInvocation): Promise<Record<string, unknown>> => {
    // Who made this act and how it was decided, for the methods it calls (capability-wiring.ts sends it with them).
    const settingAct = actOfRun(at, ownerAnswered.has(at));
    markRunAct(at, settingAct);
    // And the owner-decision classes this run's own decision covered: a method it calls of a class outside them (a
    // setting write that stores a credential through credentials.set) is decided by the method's own class.
    markRunCovers(at, coveredClasses);
    if (definition) {
      try {
        // A handler whose act a daemon method does calls that method as this same caller.
        const cause = causeOfRun(at, { ownerAnswered: ownerAnswered.has(at), modelOfTurn, conversation });
        // Every file it names by path is held from its check to its use, for the whole run (capabilities/held-paths.ts).
        // Run as the party that caused it when no turn carries it (security/turn-input-party.ts `asCallOutsideTurn`).
        const result = await runHoldingPaths(() => asCallOutsideTurn(() => definition.run(values, deps.services, {
          ...caller, personAsked: namedByPerson(at), ...fromElsewhere(at),
          // Who caused it, for an act that makes work run (builtin/work.ts keeps it on the work's record).
          cause,
          // Who wrote what it keeps that steers the owner's turns (a memory record, a persona, a note, a routine).
          author: authorOfRun(cause, modelOfTurn && !ownerAnswered.has(at)),
          settingAct,
          method: (methodId, body) => deps.invokeMethod(methodId, body, withCallOf(at, caller)),
        // A held file's or folder's copies are kept in the daemon's own home, never the shared temp folder.
        }), cause), deps.carried?.daemonHome ? joinPath(deps.carried.daemonHome, 'held') : undefined);
        // A value the person must see once is returned only to the person who asked (a key pressed, a form submitted,
        // a line typed); any other caller is told where he sees it, and never gets it.
        const reveal = definition.reveals && result.reveal ? { ...definition.reveals, ...result.reveal } : undefined;
        const toPerson = reveal !== undefined && personAsked(at);
        const withheld = reveal && !toPerson ? ` The ${definition.reveals!.label.toLowerCase()} is shown only to the owner, when he asks for it himself.` : '';
        return {
          // Its words judged on the values as the caller named them, as its risk is (never the scratch copy's path).
          id: entry.id, ok: true, text: `${capabilityOutcomeText(entry, judged, result)}${withheld}`, detail: `${result.text}${withheld}`, risk,
          ...(result.data ? { data: result.data } : {}), ...(toPerson ? { reveal } : {}), repeat: definition.capability.repeat,
        };
      } catch (error) {
        // A refusal names the caller's own file, never the daemon's scratch copy of it.
        if (error instanceof CapabilityRefusal) throw refusalAnswer(carriedRun ? new CapabilityRefusal(carriedRun.named(error.message), error.next, error.code, error.status) : error);
        throw error;
      }
    }
    // A held method call runs as it came, as its caller: its own answer is the answer (never a capability's sentence).
    if (heldMethod) {
      if (!deps.invokeHeldMethod) throw new GatewayVerbError(`${entry.id} was not run: this daemon cannot send a held method call again.`, 'CAPABILITY_ELSEWHERE', 409, 'id');
      const sent = await deps.invokeHeldMethod(heldMethod.call.id, heldMethod.call.body, heldMethod.call.query, at);
      return sent !== null && typeof sent === 'object' && !Array.isArray(sent) ? sent as Record<string, unknown> : { result: sent };
    }
    if (!entry.method || !methodInput) throw new GatewayVerbError(where(entry), 'CAPABILITY_ELSEWHERE', 409, 'id');
    const body = await deps.invokeMethod(entry.method.id, methodInput, withCallOf(at, caller));
    const data = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : { result: body };
    // A method capability's own words for what ran and how it came out (builtin/method-capability.ts `said`).
    let detail = '';
    try { detail = methodCapability(entry.id)?.said?.(data, values) ?? ''; } catch { detail = ''; }
    // What this run did about what its risk names, when not every run does it (builtin/method-capability.ts `did`).
    let did: string | undefined;
    try { did = methodCapability(entry.id)?.did?.(data, values); } catch { did = undefined; }
    const text = capabilityOutcomeText(entry, judged, { text: detail, ...(did !== undefined ? { riskDone: did } : {}) });
    return {
      id: entry.id, ok: true, text: text || `${entry.label}: done.`, ...(detail ? { detail } : {}), risk, method: entry.method.id,
      data,
    };
    };
    const notApproved = (reason: string | undefined): GatewayVerbError =>
      // His reason as he wrote it: one that ends a sentence itself gets no second full stop ("Not now.", never "Not now..").
      new GatewayVerbError(`${entry.id} was not run: ${sentenceOf(reason ?? 'the owner did not approve it')}`, 'CAPABILITY_NOT_APPROVED', 403, undefined, {
        state: 'nothing ran', next: ['It was the owner\'s to decide: ask him, or let him run it himself.'],
      });
    // A call the owner approved runs once, as its caller `at`; what came of it is kept with the question.
    const runApproved = async (at: GatewayMethodInvocation, approvalId: string): Promise<HeldCallOutcome | undefined> => {
      const held = deps.held!;
      // The caller it was held for must still be allowed (its token not revoked, its device still paired, its user
      // still there): the owner's yes was for that caller, and it is not carried over to anyone after it.
      const gone = held.callerGone?.(approvalId, resumedCallers.get(at) ?? heldCallerOf(at), at.context.authToken);
      if (gone !== undefined) {
        const outcome: HeldCallOutcome = { ok: false, status: gone.status, code: gone.code, error: gone.error,
          next: ['Ask again from a credential this daemon accepts now; the owner is asked again.'] };
        if (held.read(approvalId).state !== 'settled') await held.record(approvalId, outcome);
        return outcome;
      }
      // A yes to a call held from before a restart is judged again, before it starts, against plan mode and the deny and
      // never-run rules as they are now, by the gate's own judgement of a yes (capability-owner-gate.ts `refusalNow`).
      if (resumedRuns.has(at) && held.refusedNow) {
        const refused = await held.refusedNow(approvalId);
        if (refused !== undefined) {
          const error = notApproved(refused);
          const outcome: HeldCallOutcome = { ok: false, status: error.status, code: error.code, error: error.message, next: error.refusal.next };
          if (held.read(approvalId).state !== 'settled') await held.record(approvalId, outcome);
          return outcome;
        }
      }
      // Started already (a second read of a call approved while the daemon was down): it never runs twice. Or that it
      // started could not be written: it does not run, and what came of it says so.
      if (!(await held.start(approvalId))) {
        const reading = held.read(approvalId);
        return reading.state === 'settled' ? reading.outcome : undefined;
      }
      // His approval is the person's request for this call's own nested method that needs one, and, for an act of his
      // own asked for by a caller who is not the owner, his authority for that call's nested methods (owner-approved-call.ts).
      markOwnerApprovedRun(at, approvalId, ownerAct ? ownerAuthority(held.approvedBy?.(approvalId)) : undefined);
      // His answer in Waiting for you: what it runs is his own (causeOfRun).
      ownerAnswered.add(at);
      let outcome: HeldCallOutcome;
      try {
        outcome = { ok: true, answer: await perform(at) };
      } catch (error) {
        outcome = outcomeOfFailure(error);
      } finally {
        endOwnerApprovedRun(at);
      }
      await held.record(approvalId, outcome);
      return outcome;
    };
    // Approved while the daemon was down, read now by its caller (readHeldCall): the owner decided; it runs.
    const resumedId = resumedRuns.get(invocation);
    if (resumedId !== undefined) {
      const outcome = await runApproved(invocation, resumedId);
      return outcome ? settledAnswer(outcome) : waitingAnswer(invocation, entry.id, entry.label, resumedId, true, questionOf(resumedId));
    }
    // A person's own request and a call the program's capability gate decided run at once; an act of the owner's own
    // asked for by someone who is not the owner is his to decide, whoever pressed it. A read with no risk is never a
    // decision, whoever calls: its effects were admitted above, and it runs. Any other call made with the Agent's
    // credential (no gate mark: not judged by the capability's own risk) is decided here, as an outside caller's.
    // Answering a question addressed to the owner is never itself a question: his own press in his own program or his
    // sign-in answers at once; anyone else (a script, a command line, an admin who is not him, a model) is refused.
    if (answers && !answering) throw new GatewayVerbError(OWNER_ANSWERS_ONLY_WORDS, OWNER_ANSWERS_ONLY, 403);
    const readsOnly = entry.touches === 'reads' && risk === 'none';
    // A command line's call that weakens a protection, cannot be undone, spends money, writes a secret or is the owner's
    // own (capabilities/command-line-hold.ts) is held for the owner in every mode, his claim or not: a y typed at a
    // terminal may have been typed by anything that drives a terminal. Answered in Waiting for you, opening on No.
    // A method call the dispatch put to the owner is never admitted elsewhere: the dispatch found nothing that admits it.
    // A person's press runs an act the owner decides at once only from the owner's own program (daemon/method-owner-
    // decision.ts `ownersOwnPress`: his sign-in, a device he paired, or a registered terminal program of his); an admin or
    // member who is not the owner pressing it is put to him. One rule, the same function the method dispatch uses.
    // His own signed-in session is his press whether or not the request says so (ownersOwnPress).
    const pressAdmits = hisOwnPress || (personAsked(invocation) && !ownerDecides);
    const admittedElsewhere = !heldMethod && !ownerAct && !heldFromCommandLine && (readsOnly || pressAdmits || decidedByProgramGate(invocation));
    if (!admittedElsewhere) {
      if (deps.gate) {
        // The gate's check reads the untrusted-content window of the scope it runs in and fails if that window moves
        // while the owner is being asked. Over HTTP the call's scope is its principal's, and the owner's answer from
        // the same credential, as a person's request, starts a new turn in exactly that scope: the check then failed
        // with "untrusted content evidence changed during comparison" and the approved call never ran. The call is a
        // request over the wire with nothing it read in this daemon, so it is decided in a window of its own, which
        // only this call can move.
        // The decision is not tied to this request: put to the owner, it outlives the answer this caller gets now.
        // One caller's questions are bounded (owner-question-bounds.ts): the same call again while its question waits is
        // that question once more (a counter on it); past the bound a new call is refused with words, never held.
        const requester = invocation.context.principalId ? callerKey(invocation.context) : undefined;
        const openOf = deps.held?.openOf;
        // One question per caller, project and session: the same call from another project (or another conversation) is
        // a question of its own, run on its own yes (the project checked for this caller, the session it named).
        const bound = requester !== undefined && openOf !== undefined
          ? await questionBounds.admit(requester, { id: entry.id, values, project: caller.workingDirectory, session: named.sessionId }, (who) => openOf(who)) : undefined;
        if (bound?.kind === 'same') {
          carriedRun?.dispose();
          void deps.held?.askedAgain?.(bound.approvalId);
          return waitingAnswer(invocation, entry.id, entry.label, bound.approvalId, false, questionOf(bound.approvalId));
        }
        if (bound?.kind === 'full') {
          carriedRun?.dispose();
          throw new GatewayVerbError(ownerQuestionsFullWords(bound.open), OWNER_QUESTIONS_FULL, 429);
        }
        let asked: (approvalId: string) => void = () => {};
        let wasAsked = false;
        const putToOwner = new Promise<string>((resolve) => { asked = resolve; });
        // A caller's own call over the wire is no turn: decided under the owner's gate as such (security/turn-input-party.ts
        // `asCallOutsideTurn`), never as unmarked work; a daemon turn's nested call keeps its turn's party.
        const deciding = withUntrustedContentScope(`capability-run:${randomUUID()}`,
          // The owner's card names a carried file as the caller's own, by its name (carried-files.ts); the values kept with
          // the question are the scratch copies, kept with it too, so his yes after a restart runs on that content.
          () => asCallOutsideTurn(() => deps.gate!({ entry, values, caller, onAsked: (approvalId) => { wasAsked = true; bound?.kind === 'new' && bound.asked(approvalId); asked(approvalId); }, runsAs: heldCallerOf(invocation),
            ...(carriedRun ? { carriedNames: carriedRun.names, carriedFolders: carriedRun.folders, carriedKept: carriedRun.kept } : {}),
            ...(resultSecret !== undefined ? { resultSecret } : {}),
            ...(ownerAct || heldFromCommandLine ? { ownerAct: true } : {}), ...(invocation.context.authToken ? { authToken: invocation.context.authToken } : {}),
            ...(conversation ? { asSpawn: true } : {}),
            // Keyed by kind first (`callerKey`): a sign-in named `shared-token` never shares this machine's token's question.
            ...(invocation.context.principalId ? { requestedBy: callerKey(invocation.context) } : {}) })));
        // Decided (answered, refused, or run without asking): no longer one of this caller's waiting questions.
        if (bound?.kind === 'new') void deciding.finally(() => bound.done()).catch(() => undefined);
        const first = await Promise.race([
          deciding.then((decided) => ({ decided } as const)),
          // Only where an outcome can be kept is the caller answered before the owner decides.
          ...(deps.held ? [putToOwner.then((approvalId) => ({ approvalId } as const))] : []),
        ]);
        if ('approvalId' in first) {
          const held = deps.held!;
          const approvalId = first.approvalId;
          // The call runs later as this same caller, with nothing tied to the request that has been answered.
          const later: GatewayMethodInvocation = { ...invocation, signal: undefined };
          void deciding.then(async (decided) => {
            if (!decided.approved) {
              const refused = notApproved(decided.reason);
              return held.record(approvalId, { ok: false, status: refused.status, code: refused.code, error: refused.message, next: refused.refusal.next });
            }
            await runApproved(later, approvalId);
          }, (error: unknown) => held.record(approvalId, outcomeOfFailure(error)))
            // The files a program sent for it wait only until the owner answers (or the ask expires): then they go.
            .finally(() => carriedRun?.dispose()).catch(() => undefined);
          return waitingAnswer(invocation, entry.id, entry.label, approvalId, false, questionOf(approvalId));
        }
        if (!first.decided.approved) { carriedRun?.dispose(); throw notApproved(first.decided.reason); }
        // He was asked and said yes (no place to keep the outcome, so the caller waited for him): his answer.
        if (wasAsked) ownerAnswered.add(invocation);
      } else if (risk !== 'none' || entry.touches !== 'reads') {
        throw new GatewayVerbError(`${entry.id} was not run: it changes something, and nobody here can be asked under your mode.`, 'CAPABILITY_NOT_APPROVED', 403);
      }
    }
    // An act of the owner's own that his own rule settled for this caller: run with his authority, that one call. A
    // run marked at admission (a model's act of his own) or here ends with this call.
    if (ownerAct) {
      markOwnerApprovedRun(invocation, `${entry.id}:owner-rule`, ownerAuthority(undefined));
      // His own remembered answer to this act settled it: his own.
      ownerAnswered.add(invocation);
    }
    try {
      return await perform(invocation);
    } finally {
      endOwnerApprovedRun(invocation);
    }
  };
  // A held call the owner approves while no request of its caller is in hand (put before a restart) runs on his yes,
  // as the caller it was held for; that caller reads what came of it whenever it comes back.
  deps.held?.runApprovedWith?.(async (call) => {
    const resumed = approvedHeldInvocation(call);
    resumedRuns.set(resumed, call.approvalId);
    resumedCallers.set(resumed, call.runsAs);
    try {
      await handler(resumed);
    } catch (error) {
      // Refused before it started (its inputs, preview or effects checked again): that refusal is what came of it.
      if (deps.held?.read(call.approvalId).state === 'approved-not-run') await deps.held.record(call.approvalId, outcomeOfFailure(error));
    }
  });
  return handler;
}

function createFindHandler(deps: CapabilityRouteDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const need = typeof params['need'] === 'string' ? params['need'].trim() : '';
    if (!need) throw new GatewayVerbError('Say what you need in words: need is required.', 'CAPABILITY_INPUT_INVALID', 400, 'need');
    const catalog = await deps.catalog();
    const found = await findCapabilities(catalog, need, invocation.signal ? { signal: invocation.signal } : {});
    return {
      ...found,
      capabilities: found.capabilities.map((capability) => {
        const repeat = daemonCapability(capability.id)?.capability.repeat ?? catalog.get(capability.id)?.repeat;
        return repeat ? { ...capability, repeat } : capability;
      }),
    };
  };
}

/**
 * One capability as `capabilities.list` answers it: the entry's words, with the definition's own when it has moved.
 * An input that chooses from a live list carries `listOperator`, the method that returns the list's rows (or why only
 * a terminal reads it), so a form drawn from this answer offers the list's rows.
 */
function listed(entry: CapabilityEntry, lists: Readonly<Record<string, DaemonListOperator>>): Record<string, unknown> {
  const definition: { readonly undoneBy?: string | undefined; readonly button?: string | undefined; readonly asksItself?: true | undefined; readonly reveals?: unknown; readonly capability?: { readonly repeat?: string } } | undefined =
    daemonCapability(entry.id) ?? methodCapability(entry.id);
  const repeat = definition?.capability?.repeat ?? entry.repeat;
  const undoneBy = definition?.undoneBy ?? entry.undoneBy;
  const button = definition?.button ?? entry.button;
  return {
    id: entry.id, group: entry.group, runsIn: entry.home, ...(repeat ? { repeat } : {}),
    command: entry.command, commandTitle: entry.commandTitle, actionId: entry.actionId, word: entry.word,
    label: entry.label, sentence: entry.sentence, done: entry.done, risk: entry.risk, ...(entry.riskDone ? { riskDone: entry.riskDone } : {}),
    touches: entry.touches, lasts: entry.lasts, ...(entry.ownerOnly ? { ownerOnly: entry.ownerOnly } : {}),
    ...(undoneBy ? { undoneBy } : {}),
    ...(button ? { button } : {}),
    ...(entry.stepTitles ? { stepTitles: entry.stepTitles } : {}),
    ...(definition?.asksItself ? { asksItself: true } : {}),
    ...(definition?.reveals ? { reveals: definition.reveals } : {}),
    // An input's suggestion is a function of the screen it is asked on: it does not travel.
    inputs: entry.inputs.map(({ suggest: _suggest, ...input }) => {
      const list = input.choices && !Array.isArray(input.choices) ? (input.choices as { readonly list?: unknown }).list : undefined;
      const operator = typeof list === 'string' ? lists[list] : undefined;
      return operator ? { ...input, listOperator: operator } : input;
    }),
  };
}

function createListHandler(deps: CapabilityRouteDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const ids = Array.isArray(params['ids']) ? new Set(params['ids'].filter((id): id is string => typeof id === 'string')) : undefined;
    const group = typeof params['group'] === 'string' ? params['group'] : undefined;
    const [catalog, lists] = await Promise.all([deps.catalog(), daemonListOperators()]);
    const entries = catalog.list().filter((entry) => (!ids || ids.has(entry.id)) && (!group || entry.group === group));
    return { capabilities: entries.map((entry) => listed(entry, lists)) };
  };
}

export function registerCapabilityGatewayMethods(catalog: GatewayMethodCatalog, deps: CapabilityRouteDeps): void {
  attachHandler(catalog, 'capabilities.list', createListHandler(deps));
  attachHandler(catalog, 'capabilities.find', createFindHandler(deps));
  attachHandler(catalog, 'capabilities.run', createRunHandler(deps, catalog));
}
