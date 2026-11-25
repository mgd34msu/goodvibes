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
import { resolve as resolvePath } from 'node:path';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError, readGatewayVerbRefusal } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { admitEffects, effectFacts, EFFECTS, type EffectId } from '../../security/effect-authority.js';
import { LOCAL_OWNER_PRINCIPAL } from '../../pairing/principal-ids.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { systemActor } from '@goodvibes/engine/daemon-api/http-policy';
import type { Actor } from '../../daemon/http-policy.js';
import { randomUUID } from 'node:crypto';
import { withUntrustedContentScope } from '../../security/untrusted-content.js';
import { capabilityEffects, effectiveRisk, OWNER_DECIDED_EFFECTS, type CapabilityCatalog, type CapabilityEntry } from '../../capabilities/catalog.js';
import { findCapabilities } from '../../capabilities/find.js';
import { checkCapabilityInputs } from '../../capabilities/validate.js';
import { pathInputsRefusal } from '../../capabilities/path-inputs.js';
import { capabilityOutcomeText } from '../../capabilities/outcome.js';
import { daemonListOperators, type DaemonListOperator } from '../../capabilities/daemon-catalog.js';
import { methodBodyOf } from '../../capabilities/operator-input.js';
import { daemonCapability, methodCapability, type DaemonCapabilityServices } from '../../capabilities/builtin/index.js';
import { CapabilityRefusal, type CapabilityCaller } from '../../capabilities/types.js';
import { endOwnerApprovedRun, markOwnerApprovedRun } from '../owner-approved-call.js';
import { noteListChanged } from '../../runtime/list-changes.js';
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
   * The caller's credential, in process only: what tells later whether it is still current is derived from it and kept
   * with the question (a fingerprint or a session id), never the credential itself.
   */
  readonly authToken?: string | undefined;
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
  | { readonly state: 'waiting'; readonly requestedBy?: string | undefined; readonly capabilityId: string; readonly label?: string | undefined; readonly approved?: boolean | undefined }
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
}

export interface CapabilityRouteDeps {
  readonly catalog: () => Promise<CapabilityCatalog>;
  readonly services: DaemonCapabilityServices;
  /** Run another method as the same caller (its own admission and confirmation gate apply), answering its body or throwing its refusal. */
  readonly invokeMethod: (methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation) => Promise<unknown>;
  /**
   * This daemon's permission gate under the owner's mode, for a caller that is
   * neither a person asking nor the Agent after its own gate. Absent: such a
   * call runs only when it carries no risk and only reads.
   */
  readonly gate?: ((request: CapabilityGateRequest) => Promise<{ readonly approved: boolean; readonly reason?: string | undefined }>) | undefined;
  /** Where what came of a call put to the owner is kept; absent, such a call is answered only when he decides. */
  readonly held?: HeldCapabilityCalls | undefined;
}

/** The answer to a call put to the owner, now and on every read of it while he has not answered. */
function waitingAnswer(invocation: GatewayMethodInvocation, capabilityId: string, label: string, approvalId: string, approved = false): Response {
  return Response.json({
    id: capabilityId,
    ok: false,
    success: false,
    code: 'OWNER_APPROVAL_PENDING',
    approvalId,
    // Whether this caller may also read the approval itself (approvals.list); its outcome it reads here either way.
    followable: admitEffects(invocation.context.actor ?? systemActor('in-process'), ['approvals.read']).kind === 'allowed',
    state: approved
      ? `${label}: the owner approved it and it is running now; its outcome is kept with approval ${approvalId}`
      : `${label} is waiting for the owner: nothing ran yet. It is in Waiting for you as approval ${approvalId}, and it runs when the owner approves it, or is refused with the owner's reason`,
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
  return Object.freeze({ class: 'owner' as const, id: approvedBy ?? LOCAL_OWNER_PRINCIPAL, scopes: 'all' as const, via: 'in-process' as const });
}

function personAsked(invocation: GatewayMethodInvocation): boolean {
  return invocation.context.metadata?.['explicitUserRequest'] === true;
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
  return invocation.context.credentialKind === 'agent' && invocation.context.metadata?.['decidedByCapabilityGate'] === true;
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
  return { ...(workingDirectory ? { workingDirectory } : {}), ...(program ? { program } : {}), ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}) };
}

/** The invocation with the caller's project and conversation as its call context, so a method it runs acts there too. */
function withCallOf(at: GatewayMethodInvocation, caller: CapabilityCaller): GatewayMethodInvocation {
  if (!caller.workingDirectory && !caller.sessionId) return at;
  return { ...at, context: { ...at.context, call: { ...at.context.call, ...(caller.workingDirectory ? { project: caller.workingDirectory } : {}), ...(caller.sessionId ? { sessionId: caller.sessionId } : {}) } } };
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
/** The caller a held call run on a yes was kept as (what tells whether it is still allowed included), by its invocation. */
const resumedCallers = new WeakMap<object, HeldCaller>();

/** What came of a call that waited for the owner, for the caller who made it: the outcome, a refusal, or still waiting. */
async function readHeldCall(deps: CapabilityRouteDeps, invocation: GatewayMethodInvocation, approvalId: string, run: GatewayMethodHandler): Promise<unknown> {
  const reading = deps.held?.read(approvalId) ?? { state: 'unknown' as const };
  // Only the caller who made the call reads what came of it; to anyone else the id is unknown.
  const asker = invocation.context.principalId;
  if (reading.state === 'unknown' || (reading.requestedBy !== undefined && reading.requestedBy !== asker)) {
    throw new GatewayVerbError(`No call put to the owner has the id ${approvalId} for this caller.`, 'CAPABILITY_CALL_NOT_FOUND', 404, 'approvalId', {
      next: ['Send the approvalId a 202 OWNER_APPROVAL_PENDING answer of capabilities.run gave you, with the same credential.'],
    });
  }
  if (reading.state === 'waiting') return waitingAnswer(invocation, reading.capabilityId, reading.label ?? reading.capabilityId, approvalId, reading.approved === true);
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
    const entry = id ? catalog.get(id) : undefined;
    if (!entry) throw new GatewayVerbError(`No capability ${id || '(no id given)'}.`, 'CAPABILITY_NOT_FOUND', 404, 'id', { next: ['Say what you need to capabilities.find; it names the capabilities that do it.'] });
    if (entry.home !== 'daemon') throw new GatewayVerbError(where(entry), 'CAPABILITY_ELSEWHERE', 409, 'id', {
      next: [entry.home === 'session' ? 'Run it in the terminal app or the Agent, from its place there.' : `Run it in the terminal app or the Agent: /${entry.command}${entry.word ? ` ${entry.word}` : ''}.`],
    });
    const checked = checkCapabilityInputs(entry, params['inputs']);
    if (!checked.ok) throw new GatewayVerbError(checked.problem, 'CAPABILITY_INPUT_INVALID', 400, checked.input ? `inputs.${checked.input}` : 'inputs', { next: ['capabilities.find lists each input with its kind and choices.'] });
    const values = checked.values;
    const caller = callerOf(params, invocation.context);
    const risk = effectiveRisk(entry, values);
    const definition = daemonCapability(entry.id);
    // What the capability needs from its caller (the project it acts in, the program asking) is checked first: a call
    // that would be refused for want of it is refused now, and the owner is never asked about it.
    const needs = definition?.callerNeeds;
    const lacking = needs?.project !== undefined && !caller.workingDirectory ? { field: 'workingDirectory', said: needs.project }
      : needs?.program !== undefined && !caller.program ? { field: 'program', said: needs.program } : undefined;
    if (lacking) {
      throw new GatewayVerbError(lacking.said, 'CAPABILITY_CALLER_CONTEXT_MISSING', 422, lacking.field, {
        state: 'nothing ran', next: [`Send ${lacking.field} with the request${lacking.field === 'program' ? ' (tui or agent)' : ' (the project folder)'}.`],
      });
    }
    // Its preview check (a file outside the project named by a caller who is not the person, a path named from another
    // machine): refused now, before the owner is asked anything about a call that would then be refused.
    // Every file named by path is inside the caller's project unless the person named it himself (path-inputs.ts).
    const previewRefusal = pathInputsRefusal(entry, values, { ...caller, personAsked: personAsked(invocation), ...fromElsewhere(invocation) })
      ?? definition?.check?.(values, { ...caller, personAsked: personAsked(invocation), ...fromElsewhere(invocation) });
    if (previewRefusal) throw refusalAnswer(previewRefusal);
    // An act only the owner makes, asked for by a caller who is not the owner (an admin's sign-in, a paired device, a
    // member, a person's own press on such a credential included): put to the owner as his own act, never refused
    // before he is asked, and run on his yes with his authority (owner-approved-call.ts).
    let ownerAct = false;
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
      const hisOwn = (effect: (typeof effects)[number]): boolean => OWNER_DECIDED_EFFECTS.has(effect) || effectFacts([effect]).modelRefused;
      const putToOwner = ownerDecided ? [] : ownersOwnEffects(actor, effects);
      ownerAct = putToOwner.length > 0 && deps.gate !== undefined;
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
      if (putToOwner.length > 0) {
        ownerAct = true;
        const rest = admitEffects(actor, declared.filter((effect) => !putToOwner.includes(effect)));
        if (rest.kind === 'refused') throw new GatewayVerbError(`${entry.id}: ${rest.reason}. ${rest.next}`, rest.code, 403);
        if (rest.kind === 'ask-owner') throw new GatewayVerbError(`${entry.id} is the owner's to decide (${rest.reason}).`, 'OWNER_ONLY', 403);
      }
    }
    // What a method capability sends, read before anything is asked: an action with a preview sends the body its
    // preview reads from the values (as the web UI's sheet does), and the preview is a read that refuses what will
    // not run (a described time that needs a decision model, inputs that do not fit, a target that is not there), so
    // the owner is never asked about a call that then fails for a reason known now.
    let methodInput: Record<string, unknown> | undefined;
    if (!definition && entry.method) {
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
      const answer = await performOnce(at);
      // A capability that acts on the caller's project (callerNeeds.project) changed that project's list: the notice
      // names it, so screens in other projects do not read again. Any other change names none (every screen reads).
      const project = needs?.project !== undefined && caller.workingDirectory ? resolvePath(caller.workingDirectory) : undefined;
      if (entry.lasts !== 'not-a-change') noteListChanged({ list: 'capabilities', change: 'changed', id: entry.id, ...(project !== undefined ? { project } : {}) });
      return answer;
    };
    // The run itself, as the caller `at` (the request, or the same caller once the owner approved a call put to him).
    const performOnce = async (at: GatewayMethodInvocation): Promise<Record<string, unknown>> => {
    if (definition) {
      try {
        // A handler whose act a daemon method does calls that method as this same caller.
        const result = await definition.run(values, deps.services, {
          ...caller, personAsked: personAsked(at), ...fromElsewhere(at),
          method: (methodId, body) => deps.invokeMethod(methodId, body, withCallOf(at, caller)),
        });
        // A value the person must see once is returned only to the person who asked (a key pressed, a form submitted,
        // a line typed); any other caller is told where he sees it, and never gets it.
        const reveal = definition.reveals && result.reveal ? { ...definition.reveals, ...result.reveal } : undefined;
        const toPerson = reveal !== undefined && personAsked(at);
        const withheld = reveal && !toPerson ? ` The ${definition.reveals!.label.toLowerCase()} is shown only to the owner, when he asks for it himself.` : '';
        return {
          id: entry.id, ok: true, text: `${capabilityOutcomeText(entry, values, result)}${withheld}`, detail: `${result.text}${withheld}`, risk,
          ...(result.data ? { data: result.data } : {}), ...(toPerson ? { reveal } : {}), repeat: definition.capability.repeat,
        };
      } catch (error) {
        if (error instanceof CapabilityRefusal) throw refusalAnswer(error);
        throw error;
      }
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
    const text = capabilityOutcomeText(entry, values, { text: detail, ...(did !== undefined ? { riskDone: did } : {}) });
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
      return outcome ? settledAnswer(outcome) : waitingAnswer(invocation, entry.id, entry.label, resumedId, true);
    }
    // A person's own request and a call the program's capability gate decided run at once; an act of the owner's own
    // asked for by someone who is not the owner is his to decide, whoever pressed it. A read with no risk is never a
    // decision, whoever calls: its effects were admitted above, and it runs. Any other call made with the Agent's
    // credential (no gate mark: not judged by the capability's own risk) is decided here, as an outside caller's.
    const readsOnly = entry.touches === 'reads' && risk === 'none';
    const admittedElsewhere = !ownerAct && (readsOnly || personAsked(invocation) || decidedByProgramGate(invocation));
    if (!admittedElsewhere) {
      if (deps.gate) {
        // The gate's check reads the untrusted-content window of the scope it runs in and fails if that window moves
        // while the owner is being asked. Over HTTP the call's scope is its principal's, and the owner's answer from
        // the same credential, as a person's request, starts a new turn in exactly that scope: the check then failed
        // with "untrusted content evidence changed during comparison" and the approved call never ran. The call is a
        // request over the wire with nothing it read in this daemon, so it is decided in a window of its own, which
        // only this call can move.
        // The decision is not tied to this request: put to the owner, it outlives the answer this caller gets now.
        let asked: (approvalId: string) => void = () => {};
        const putToOwner = new Promise<string>((resolve) => { asked = resolve; });
        const deciding = withUntrustedContentScope(`capability-run:${randomUUID()}`,
          () => deps.gate!({ entry, values, caller, onAsked: (approvalId) => asked(approvalId), runsAs: heldCallerOf(invocation),
            ...(ownerAct ? { ownerAct: true } : {}), ...(invocation.context.authToken ? { authToken: invocation.context.authToken } : {}),
            ...(invocation.context.principalId ? { requestedBy: invocation.context.principalId } : {}) }));
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
          }, (error: unknown) => held.record(approvalId, outcomeOfFailure(error))).catch(() => undefined);
          return waitingAnswer(invocation, entry.id, entry.label, approvalId);
        }
        if (!first.decided.approved) throw notApproved(first.decided.reason);
      } else if (risk !== 'none' || entry.touches !== 'reads') {
        throw new GatewayVerbError(`${entry.id} was not run: it changes something, and nobody here can be asked under your mode.`, 'CAPABILITY_NOT_APPROVED', 403);
      }
    }
    // An act of the owner's own that his own rule settled for this caller: run with his authority, that one call. A
    // run marked at admission (a model's act of his own) or here ends with this call.
    if (ownerAct) markOwnerApprovedRun(invocation, `${entry.id}:owner-rule`, ownerAuthority(undefined));
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
