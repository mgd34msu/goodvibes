/**
 * routes/capabilities.ts, the handlers of `capabilities.find` and
 * `capabilities.run` (method-catalog-capabilities.ts).
 *
 * Run, in order: the capability by id; where it runs (a conversation's
 * capability, or one not moved yet, is refused with where it does run); the
 * inputs against its definition; its effects admitted for the caller (the
 * same table every method is held to); then who asked decides whether it is
 * decided under the owner's mode: a person's own request (the claim the daemon keeps only
 * from a person's credential) and a call the Agent makes after its own gate
 * admitted it run at once; any other caller's call goes through this
 * daemon's permission gate under the owner's mode. A capability with its own
 * method runs through that method, as the same caller.
 *
 * Under Ask me the gate raises the call's question through the daemon's one
 * approval broker, the card a model's tool call raises, and the request waits
 * on that one answer as a model's tool call does: it runs on the owner's yes, or is
 * refused with the owner's reason. The caller leaving withdraws the question; nothing
 * of it outlives the request. Nothing here waits on a clock.
 *
 * Folder trust is not asked here: a daemon capability acts on what the daemon
 * keeps, not in a project folder a turn is working in (capability-wiring.ts).
 */
import { join as joinPath, resolve as resolvePath } from 'node:path';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodDescriptor, GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { attachHandler } from './attach-handler.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { admitEffects, EFFECTS, modelNeverMakes, type EffectId } from '../../security/effect-authority.js';
import { callerKey, LOCAL_OWNER_PRINCIPAL } from '../../pairing/principal-ids.js';
import { logger } from '../../utils/logger.js';
import { systemActor } from '@goodvibes/engine/daemon-api/http-policy';
import type { Actor } from '../../daemon/http-policy.js';
import { randomUUID } from 'node:crypto';
import { withUntrustedContentScope } from '../../security/untrusted-content.js';
import { capabilityEffects, effectiveRisk, OWNER_DECIDED_EFFECTS, type CapabilityCatalog, type CapabilityEntry } from '../../capabilities/catalog.js';
import { findCapabilities } from '../../capabilities/find.js';
import { checkCapabilityInputs } from '../../capabilities/validate.js';
import { COMMAND_LINE_CLIENT_KIND, commandLineHoldReason } from '../../capabilities/command-line-hold.js';
import { pathInputsRefusal, runHoldingPaths } from '../../capabilities/path-inputs.js';
import { receiveCarried, type CarriedReceipt, type CarriedRun } from '../../capabilities/carried-files.js';
import { capabilityOutcomeText } from '../../capabilities/outcome.js';
import { daemonListOperators, type DaemonListOperator } from '../../capabilities/daemon-catalog.js';
import { methodBodyOf } from '../../capabilities/operator-input.js';
import { daemonCapability, methodCapability, type DaemonCapabilityServices } from '../../capabilities/builtin/index.js';
import { namesSharedMemoryRecord } from '../../capabilities/builtin/memory.js';

/** The memory methods that change a record by id (`id`, a link's `toId`): of a shared record, the owner's own act. */
const SHARED_MEMORY_WRITE_METHODS: ReadonlySet<string> = new Set([
  'memory.records.update', 'memory.records.update-review', 'memory.records.delete', 'memory.records.links.add',
]);
import { CapabilityRefusal, type ActionRisk, type CapabilityCaller, type InputDescription, type RecordAuthor } from '../../capabilities/types.js';
import { carryOwnerApprovedRun, endOwnerApprovedRun, markOwnerApprovedRun, markRunAct, markRunCovers, runActOf, runCoversOf } from '../owner-approved-call.js';
import type { SettingAct } from '@goodvibes/engine/daemon-api/control-routes';
import { noteListChanged } from '../../runtime/list-changes.js';
import { asCallOutsideTurn, turnInputParty } from '../../security/turn-input-party.js';
import { conversationExposedNow, exposureNow } from '../../security/conversation-exposure.js';
import { withArtifactMaker } from '../../artifacts/turn-maker.js';
import { methodCallRisk, OWNER_ONLY_WHERE, ownerOnlyCapabilityCall, ownerOnlyMethodArea, riskOfDescriptor, type MethodRisk, type OwnerOnlyArea } from '../method-risk.js';
import { OUTSIDE_AGENT_ISSUE_METHOD_ID, outsideAgentQuestion } from '../method-catalog-programs.js';
import { answersTheOwner, isTheUser, makesOwnerOnlyAct, MODEL_NEVER, modelNeverWords, OWNER_ANSWERS_ONLY, OWNER_ANSWERS_ONLY_WORDS, OWNER_ONLY_ACT, ownerAnswers,
  ownerOnlyActWords, ownersCommandLine, ownersAgentProgram, ownersOwnPress, ownersProgramCaller } from '../../daemon/method-owner-decision.js';
import { isCommandLineRegistration } from '../../daemon/program-registrations.js';
import type { WorkCause } from '../../workflow/work-ledger/work-plans.js';
import { REGISTRATION_MARK, registrantMayName } from '../session-broker-sessions.js';
export interface CapabilityGateRequest {
  readonly entry: CapabilityEntry;
  readonly values: Readonly<Record<string, string>>;
  readonly caller: CapabilityCaller;
  /** The caller's request signal: its connection closing withdraws a question Ask me raised for it. */
  readonly signal?: AbortSignal | undefined;
  /** Who asked (the principal the transport authenticated), named on the owner's question. */
  readonly requestedBy?: string | undefined;
  /** Who asks, as the transport established it: named on the card and told to Jev. */
  readonly runsAs?: GateCaller | undefined;
  /**
   * The act is the owner's own and the caller is not the owner (an admin's sign-in, a paired device, a member): an item
   * of the owner's list, decided under the owner's mode, and run with the owner's authority when allowed.
   */
  readonly ownerAct?: boolean | undefined;
  /**
   * A model's delegation from a conversation in the owner's own program (`work.delegate` sent so, conversationDelegation):
   * decided under the owner's mode as an agent spawn is, not as the owner's own act.
   */
  readonly asSpawn?: boolean | undefined;
  /** The project a method call names (the folder the outside agent's credential is asked for), when the caller names none. */
  readonly project?: string | undefined;
  /**
   * Each carried path input (its value in `values` is the daemon's scratch copy) by the name the caller gave it, one
   * line: the card shows it as that caller's file, and the gate decides the call on that name (carried-files.ts).
   */
  readonly carriedNames?: Readonly<Record<string, string>> | undefined;
  /** The carried inputs whose content is a folder: the card names it as the caller's folder. */
  readonly carriedFolders?: readonly string[] | undefined;
  /**
   * What the result carries that is secret (CapabilityDefinition `resultSecret`), when it would leave for a caller
   * that is not the owner's own program: the card says "This sends <it> to <that caller>.", and it is the owner's own act.
   */
  readonly resultSecret?: string | undefined;
}

/** What the gate decided: allowed (and, when the owner was asked, the question's id and who answered it) or refused. */
export type GateDecision =
  | { readonly approved: true; readonly askedId?: string | undefined; readonly answeredBy?: string | undefined }
  | { readonly approved: false; readonly reason?: string | undefined };

/** Who asks, as the transport established it: what the gate names on the card and tells Jev, never a credential. */
export interface GateCaller {
  readonly principalId?: string | undefined;
  readonly principalKind?: GatewayMethodInvocation['context']['principalKind'];
  readonly credentialKind?: GatewayMethodInvocation['context']['credentialKind'];
  readonly actor?: Actor | undefined;
  /**
   * Which program of that caller asked: its registration's fingerprint (method-catalog-shared.ts `CallContext`). A
   * remembered answer belongs to that program; holders of one operator token are told apart by it.
   */
  readonly registration?: string | undefined;
  /** It came from a command line (`do`): its own words on the owner's card (capabilities/command-line-hold.ts). */
  readonly commandLine?: boolean | undefined;
}

/** A daemon method call the dispatch handed to the gate (daemon/method-owner-decision.ts), in process only. */
export interface MethodCallToDecide {
  readonly id: string;
  readonly body: unknown;
  readonly query: Record<string, unknown>;
}

/** The input a decided method call carries: its body and query, as JSON (shown on the card; never read as fields). */
const METHOD_CALL_INPUT = 'request';
/** The input a secret write shows beside its hidden call: which secret it writes, and where it is kept. */
const SECRET_NAMED_INPUT = 'which';

const METHOD_ACTION_RISK: Readonly<Record<MethodRisk, ActionRisk>> = {
  // What steers a model is decided under the owner's mode, as a capability that declares `steersModel`.
  'none': 'none', 'loosens-a-protection': 'loosens-a-protection', 'runs-later': 'runs-later', 'steers-a-model': 'none', 'cannot-be-undone': 'cannot-be-undone',
  'spends-money': 'spends-money', 'writes-a-secret': 'none', 'owner-act': 'none',
  // Never handed over (an answer is answered or refused, method-owner-decision.ts); listed so every class has its line.
  'answers-the-owner': 'none',
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The method call the dispatch handed over, from an invocation's metadata, or undefined (a caller's body never makes one). */
function methodCallOf(invocation: GatewayMethodInvocation): MethodCallToDecide | undefined {
  const kept = readRecord(invocation.context.metadata?.['methodCall']);
  if (!kept || typeof kept['id'] !== 'string' || !kept['id']) return undefined;
  return { id: kept['id'], body: kept['body'] ?? {}, query: readRecord(kept['query']) ?? {} };
}

const textOf = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Which secret a write of one names, and where it will be kept, in words: its key, provider, domain or card label as the
 * call names them, never a value (the card shows these; the call itself stays hidden).
 */
export function secretWriteWords(methodId: string, body: unknown): string {
  const fields = readRecord(body) ?? {};
  const store = 'kept in the daemon\'s encrypted secret store';
  switch (methodId) {
    case 'credentials.set':
      return `the credential of the setting ${textOf(fields['key']) ?? '(no key named)'}, ${store}, filed under that setting`;
    case 'providers.apiKey.set':
      return `the API key of the provider ${textOf(fields['provider']) ?? '(no provider named)'}, ${store} under that provider's key name`;
    case 'secureAddress.set': {
      const domain = textOf(fields['domain']);
      const token = textOf(fields['cloudflareToken']) !== undefined;
      return `${token ? `a Cloudflare token${domain ? ` for ${domain}` : ''}, ${store}, with ` : ''}the secure address set to ${textOf(fields['certificate']) ?? '(none named)'}${domain && !token ? ` for ${domain}` : ''}`;
    }
    case 'stepup.credentials.register':
      return `a step-up passkey ${textOf(fields['label']) ?? textOf(fields['credentialId']) ?? '(unnamed)'} for ${textOf(fields['rpId']) ?? '(no site named)'}, kept in the daemon's step-up credentials`;
    case 'payments.cards.create':
      return `the ${textOf(fields['kind']) ?? ''} card "${textOf(fields['label']) ?? '(no label)'}", its number, expiry, security code and name ${store}`.replace(/\s+/g, ' ');
    default:
      // Another method's secret write: the names of what it sends, never their values.
      return `what it sends under ${Object.keys(fields).sort().join(', ') || '(nothing named)'}, ${store}`;
  }
}

/**
 * A method call the dispatch handed over, as the gate decides it: one capability entry made from the method's own
 * descriptor, so it is decided exactly as the capability that does the same act (its class is the entry's risk; an act
 * of the owner's own is the owner's `owner-act`; a write of a secret is `secret.write`, a loosening, whose value is never shown), the
 * card names it by the method's title, and the project it names (the folder the outside agent's credential is asked
 * for, else the body's `workingDirectory`). Pure: no I/O.
 */
function methodCallEntry(descriptor: GatewayMethodDescriptor, call: MethodCallToDecide): { readonly entry: CapabilityEntry; readonly values: Readonly<Record<string, string>>; readonly risk: MethodRisk; readonly project?: string } {
  const risk = methodCallRisk(descriptor, call.body);
  const secret = risk === 'writes-a-secret';
  const input: InputDescription = {
    id: METHOD_CALL_INPUT, label: 'What it sends', help: 'The call as it was sent: its body and query', kind: secret ? 'secret' : 'text',
    freeTextReason: 'the method call as its caller sent it', required: true, typed: { tail: true },
  };
  const named: InputDescription = {
    id: SECRET_NAMED_INPUT, label: 'Which secret', help: 'The secret this writes and where it is kept, never its value', kind: 'text',
    freeTextReason: 'words the daemon wrote from the names in the call', required: true, typed: { tail: true },
  };
  const effects: EffectId[] = [...(descriptor.effects ?? ['control-plane.write'])];
  if (secret && !effects.includes('secret.write')) effects.push('secret.write');
  const body = readRecord(call.body);
  const issueProject = descriptor.id === OUTSIDE_AGENT_ISSUE_METHOD_ID ? textOf(body?.['project']) : undefined;
  const project = descriptor.id === OUTSIDE_AGENT_ISSUE_METHOD_ID ? issueProject : textOf(body?.['workingDirectory']);
  const label = descriptor.id === OUTSIDE_AGENT_ISSUE_METHOD_ID ? outsideAgentQuestion(issueProject) : descriptor.title;
  const entry: CapabilityEntry = {
    id: descriptor.id, group: 'system', home: 'daemon', command: '', commandTitle: label, actionId: descriptor.id, word: '',
    label, sentence: descriptor.id === OUTSIDE_AGENT_ISSUE_METHOD_ID
      ? `It has a credential of its own (a paired device you revoke in Devices and network)${issueProject !== undefined ? ` and may work in ${issueProject}; nothing else is given` : ', for shared things only'}.`
      : descriptor.description, done: '', risk: METHOD_ACTION_RISK[risk],
    touches: secret ? 'credential' : 'this-machine', lasts: 'not-a-change',
    ...(risk === 'owner-act' ? { ownerOnly: { reason: 'it is an act only the owner makes', instead: 'Ask the owner to do it from their own app.' } } : {}),
    effects, inputs: secret ? [named, input] : [input], method: { id: descriptor.id, fields: {} },
  };
  return { entry, values: { ...(secret ? { [SECRET_NAMED_INPUT]: secretWriteWords(descriptor.id, call.body) } : {}),
    [METHOD_CALL_INPUT]: JSON.stringify({ body: call.body, query: call.query }) }, risk, ...(project !== undefined ? { project } : {}) };
}

export interface CapabilityRouteDeps {
  readonly catalog: () => Promise<CapabilityCatalog>;
  readonly services: DaemonCapabilityServices;
  /** Run another method as the same caller (its own admission and confirmation gate apply), answering its body or throwing its refusal. */
  readonly invokeMethod: (methodId: string, body: Record<string, unknown>, invocation: GatewayMethodInvocation) => Promise<unknown>;
  /**
   * Run a method call the dispatch handed to the gate (daemon/method-owner-decision.ts) as it came, as the same caller,
   * once the gate allowed it: its body and query sent as they were, never decided again. Absent: such a call is refused.
   */
  readonly invokeMethodCall?: ((methodId: string, body: unknown, query: Record<string, unknown> | undefined, invocation: GatewayMethodInvocation) => Promise<unknown>) | undefined;
  /**
   * This daemon's permission gate under the owner's mode, for a caller that is
   * neither a person asking nor the Agent after its own gate. Absent: such a
   * call runs only when it carries no risk and only reads.
   */
  readonly gate?: ((request: CapabilityGateRequest) => Promise<GateDecision>) | undefined;
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

/** Who asks, as the transport established it: what the gate names and tells Jev, never the credential. */
function gateCallerOf(invocation: GatewayMethodInvocation): GateCaller {
  const context = invocation.context;
  return {
    ...(context.principalId ? { principalId: context.principalId } : {}), ...(context.principalKind ? { principalKind: context.principalKind } : {}),
    ...(context.credentialKind ? { credentialKind: context.credentialKind } : {}), ...(context.actor ? { actor: context.actor } : {}),
    ...(context.call?.registration ? { registration: context.call.registration } : {}),
    ...(context.clientKind === COMMAND_LINE_CLIENT_KIND || isCommandLineRegistration(context.call?.registration) ? { commandLine: true } : {}),
  };
}

/**
 * The effects of a call only the owner causes that this caller cannot make: for a caller who is a person's credential
 * and not the owner (an admin's sign-in, a paired device, a member, a script), none for the owner, a model, the program
 * or a peer. Those are the owner's own acts: refused for that caller, in every mode, never put to the owner.
 */
function ownersOwnEffects(actor: Actor, effects: readonly EffectId[]): readonly EffectId[] {
  if (actor.agentFor !== undefined || actor.class === 'owner' || actor.class === 'system' || actor.class === 'peer') return [];
  return effects.filter((effect) => EFFECTS[effect].least === 'owner' && admitEffects(actor, [effect]).kind !== 'allowed');
}

/** Where the owner makes an act whose effect only the owner causes, by that effect (named in the refusal). */
function ownerOnlyEffectArea(effect: EffectId): OwnerOnlyArea {
  if (effect === 'settings.loosen') return 'settings';
  if (effect === 'access.withdraw') return 'devices';
  if (effect === 'card.enter' || effect === 'purchase.start' || effect === 'purchase.approve') return 'money';
  return 'work';
}

/** A settings write naming a permission setting (the mode, the rules): a model never makes it. */
function namesPermissionSetting(id: string, values: Readonly<Record<string, string>>): boolean {
  if (id !== 'settings.set' && id !== 'settings.reset') return false;
  const key = (values['key'] ?? '').trim();
  return key === 'permissions' || key.startsWith('permissions.');
}

/** The owner's authority a call the owner approved for another caller runs with: the owner's principal (who answered yes), never a credential. */
function ownerAuthority(approvedBy: string | undefined): Actor {
  // The owner's yes (or standing rule) is what makes this the owner's authority; who answered is named only as recorded, never
  // filled in as another credential (the operator token's `local`) when the record does not say.
  return Object.freeze({ class: 'owner' as const, id: approvedBy ?? 'system:owner-yes', scopes: 'all' as const, via: 'in-process' as const });
}

function personAsked(invocation: GatewayMethodInvocation): boolean {
  return invocation.context.metadata?.['explicitUserRequest'] === true;
}

/**
 * A model's delegation from a conversation in the owner's own program on this machine (terminal-shell
 * agent-turn/daemon-work-delegation.ts): the call says so (`delegatedFrom: 'conversation'`, and `otherParty` when that
 * conversation's turn acts on someone else's input). It is honoured over the operator token on this machine (`local`, never
 * one from another machine), whether or not the program holds a registration (a registration decides nothing). From any
 * other caller (a remote token holder, a device, a sign-in) the field is ignored and the call is the user's own. Such a
 * delegation is a model's: decided under the owner's mode as an agent spawn is, and the work it makes carries that
 * conversation's party.
 */
function conversationDelegation(params: Record<string, unknown>, invocation: GatewayMethodInvocation, _deps: Pick<CapabilityRouteDeps, 'terminalProgram' | 'sessionRegistrant'>): { readonly otherParty?: string } | undefined {
  if (params['delegatedFrom'] !== 'conversation') return undefined;
  const kind = invocation.context.credentialKind;
  const actor = invocation.context.actor;
  if (kind !== 'local' || actor?.class !== 'owner' || actor.agentFor !== undefined) return undefined;
  if (invocation.context.transport !== undefined && invocation.context.transport !== 'loopback') return undefined;
  // A registration decides nothing (daemon/program-registrations.ts): the operator token on this machine, registered or not,
  // sends this, and what it says can only tighten (the work is marked as someone else's when it names `otherParty`).
  const other = typeof params['otherParty'] === 'string' ? params['otherParty'].trim() : '';
  return other ? { otherParty: other } : {};
}

/**
 * Who caused a run (CapabilityCaller.cause): the owner in person only for their own press or typed line (the person's claim
 * from a credential that is theirs), their answer in Waiting for you (or their own remembered answer to the act), or a model
 * of their own conversation (the party of the turn that called it: a turn on someone else's input runs reads only, so a
 * model's act that arrives here was the owner's own turn's). Anyone else (a device, a member, an admin's sign-in, a
 * script or outside agent with the operator token, a person on a credential that is not the owner's) is someone else.
 */
function causeOfRun(at: GatewayMethodInvocation, facts: { readonly ownerAnswered: boolean; readonly modelOfTurn: boolean; readonly conversation: { readonly otherParty?: string } | undefined }): WorkCause {
  const actor = at.context.actor ?? systemActor('in-process');
  // The owner's yes to a caller below the owner's own call: the owner's own, and that caller (by its principal) acts on it afterwards.
  if (facts.ownerAnswered) {
    const asker = !isTheUser(actor) && actor.class !== 'system' && at.context.principalId ? { madeFor: at.context.principalId } : {};
    return { party: 'owner', ...asker };
  }
  // The user, from any credential (daemon/method-owner-decision.ts `isTheUser`: a sign-in under any name, a device, the
  // machine's token, a typed `do`), with or without a person's claim: what the user starts is theirs, on every device.
  if (!facts.modelOfTurn && isTheUser(actor)) return { party: 'owner' };
  if (facts.modelOfTurn) {
    // The model acts for whose turn it is (security/turn-session.ts): a member's or a device's chat is theirs, so what it
    // runs is theirs, whoever sent the message there.
    const actingFor = actor.agentFor;
    if (actingFor !== undefined && !isTheUser(actingFor) && actingFor.class !== 'system') return { party: 'other', who: `the model of ${actingFor.class} ${actingFor.id}` };
    // A model of the owner's own verified program (its capability gate decided the call, `decidedByProgramGate`): the
    // turn ran in that program, which keeps its own party (a turn there on someone else's input runs reads only and
    // never reaches this), so this daemon has no turn in scope to read: it is the owner's own turn's. What that conversation
    // read from outside the program says on the call (x-goodvibes-read-outside), and `authorOfRun` holds it to that.
    // One of the daemon's own turns reads its party here, from the turn in scope.
    const daemonTurn = at.context.clientKind === 'daemon-turn' && !at.context.authToken;
    if (!daemonTurn) return { party: 'owner' };
    const party = turnInputParty();
    return party.party === 'owner' ? { party: 'owner' } : { party: 'other', who: party.who };
  }
  if (facts.conversation) return facts.conversation.otherParty ? { party: 'other', who: facts.conversation.otherParty } : { party: 'owner' };
  // Named by its principal too: such a caller acts afterwards on the work it caused, and on no one else's (routes/work.ts `ownWork`).
  return { party: 'other', who: `a caller that is not the owner in person (${actor.class} ${actor.id})`,
    ...(at.context.principalId ? { madeFor: at.context.principalId } : {}) };
}

/**
 * Who made a run's act and how it was decided (a settings write it makes keeps this record, and a machine group
 * carries it): the owner's yes in Waiting for you to a call put to them (the caller who asked is named), the owner's own press,
 * or admitted under the owner's rules for the caller named, with nothing asked.
 */
function actOfRun(at: GatewayMethodInvocation, ownerAnswer: boolean): SettingAct {
  const actor = at.context.actor ?? systemActor('in-process');
  const by = at.context.principalId ?? actor.id;
  const owner = isTheUser(actor);
  if (ownerAnswer) return { by, owner, how: 'yes' };
  if (personAsked(at) && owner) return { by, owner, how: 'press' };
  return { by, owner, how: 'rules' };
}

/**
 * Who wrote what a run keeps that steers the owner's turns (CapabilityCaller.author), from who caused it: the owner
 * in person (their own press or typed words, their yes in Waiting for you), their model in their own turn (a model whose call a
 * turn's gate admitted, in a turn on their own input), or someone else, named as the cause names them.
 */
function authorOfRun(cause: WorkCause, model: boolean): RecordAuthor {
  if (cause.party === 'other') return { kind: 'other', ...(cause.who ? { who: cause.who } : {}) };
  // The owner's model in a conversation that read text from outside (this turn or any earlier one: security/conversation-
  // exposure.ts) may be writing what it read: written "by your model after reading text from outside", it is kept as
  // someone else's writing, so a conversation it later enters counts as having read text from outside.
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
  // Every project at once: the owner's own choice in their place's project chooser, with no project named; anyone else's
  // ask for it is dropped, so the call reads only what belongs to no project. The owner in person or the owner's own command
  // line (method-owner-decision.ts `makesOwnerOnlyAct`, the one test).
  const everyProject = params['everyProject'] === true && !workingDirectory
    && makesOwnerOnlyAct({ actor: context?.actor, credentialKind: context?.credentialKind, registration: context?.call?.registration });
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
  // And the decision it runs under: its nested methods take that run's grant (owner-approved-call.ts).
  carryOwnerApprovedRun(at, next);
  return next;
}

function where(entry: CapabilityEntry): string {
  const line = `/${entry.command}${entry.word ? ` ${entry.word}` : ''}`;
  return entry.home === 'session'
    // A session capability may have no slash command any more: it is named by where it is, never by a line to type.
    ? `${entry.id} acts on what a terminal program holds (its conversation, its screen or its own records), so it runs in that program (its place there, or capability_run from its model); nothing ran here.`
    : `${entry.id} has not moved to the daemon yet: it runs only inside a terminal program (${line} there, or capability_run from its model); nothing ran here.`;
}

/** The runs the owner answered yes to in person (their answer to the call's card, or their own remembered answer to their act), by invocation. */
const ownerAnswered = new WeakSet<object>();

function createRunHandler(deps: CapabilityRouteDeps, methods: Pick<GatewayMethodCatalog, 'get'>): GatewayMethodHandler {
  const handler: GatewayMethodHandler = async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = typeof params['id'] === 'string' ? params['id'].trim() : '';
    const catalog = await deps.catalog();
    // A method call the dispatch handed to the gate (daemon/method-owner-decision.ts): from the dispatch's own metadata
    // only, never from what a caller sends.
    const handed = methodCallOf(invocation);
    const handedDescriptor = handed ? methods.get(handed.id) : undefined;
    const handedMethod = handed && handedDescriptor ? { ...methodCallEntry(handedDescriptor, handed), call: handed } : undefined;
    const entry = handedMethod ? handedMethod.entry : id ? catalog.get(id) : undefined;
    if (!entry) throw new GatewayVerbError(`No capability ${id || '(no id given)'}.`, 'CAPABILITY_NOT_FOUND', 404, 'id', { next: ['Say what you need to capabilities.find; it names the capabilities that do it.'] });
    if (entry.home !== 'daemon') throw new GatewayVerbError(where(entry), 'CAPABILITY_ELSEWHERE', 409, 'id', {
      next: [entry.home === 'session' ? 'Run it in the terminal app or the Agent, from its place there.' : `Run it in the terminal app or the Agent: /${entry.command}${entry.word ? ` ${entry.word}` : ''}.`],
    });
    const checked = handedMethod ? { ok: true as const, values: handedMethod.values } : checkCapabilityInputs(entry, params['inputs']);
    if (!checked.ok) throw new GatewayVerbError(checked.problem, 'CAPABILITY_INPUT_INVALID', 400, checked.input ? `inputs.${checked.input}` : 'inputs', { next: ['capabilities.find lists each input with its kind and choices.'] });
    // The owner's own program, by who it is (method-owner-decision.ts `ownersProgramCaller`: the owner in person, their
    // registered terminal program, their Agent program, a turn the daemon hosts; never a credential's kind alone): only it
    // says where a file is (`filesAt: program`, the program does the file work and sends the content); from anyone else
    // that input is dropped and the path rules apply as for any path (path-inputs.ts).
    const ownersProgram = ownersProgramCaller(callerFactsOf(invocation));
    const given = !ownersProgram && checked.values['filesAt'] !== undefined
      ? Object.fromEntries(Object.entries(checked.values).filter(([input]) => input !== 'filesAt')) : checked.values;
    // The files and folders the program asking sent for its path inputs (its machine's, carried-files.ts): put in a
    // scratch folder of this call's in the daemon's home, and named there; what the run leaves there goes back with the
    // answer. Carried only for a caller on another machine or the owner's own program: a paired device or member on this
    // machine names a file in its project here.
    let carriedRun: CarriedRun | undefined;
    try {
      if (params['carried'] !== undefined && params['carried'] !== null) {
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
      // The owner in person or the owner's own command line (daemon/method-owner-decision.ts `makesOwnerOnlyAct`, the one
      // test of who makes an owner-only act): an act only the owner makes (a record moved out of its project).
      ...(makesOwnerOnlyAct({ actor: invocation.context.actor, credentialKind: invocation.context.credentialKind, registration: invocation.context.call?.registration }) ? { ownerHimself: true } : {}),
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
          ...(lacking.field === 'workingDirectory' ? ['A caller that is not the owner\'s own program works only in a project the owner gave it: the owner gives it one in Devices and network, on its row, and the outside agent (goodvibes-daemon mcp serve) that names one is asked about once.'] : [])],
      });
    }
    // Its preview check (a file outside the project named by a caller who is not the person, a path named from another
    // machine): refused now, before anything is decided about a call that would then be refused.
    // Every file named by path is inside the caller's project unless the person named it themselves (path-inputs.ts).
    // A command line's call that goes to the gate (below): the person typed its paths, so they are taken as that person named them.
    // Whether this act is one the owner decides (it weakens a protection, cannot be undone, spends money, writes a
    // secret or what steers a model, or is the owner's own act): the same words the command line's hold and the method rule use.
    // An act only the owner makes (method-risk.ts `OWNER_ONLY_CAPABILITIES`, `ownerOnlyCapabilityCall`, or a method of
    // class `owner-act`), by the area where the owner does it; an answer keeps its own rule (`ownerAnswers` below).
    const ownerOnlyArea = handedMethod || answersTheOwner(entry) ? undefined : (() => {
      const loosensNow = risk === 'loosens-a-protection' || (definition?.loosensIf ?? methodCapability(entry.id)?.loosensIf)?.(judged) === true;
      const methodDescriptor = !definition && entry.method ? methods.get(entry.method.id) : undefined;
      return ownerOnlyCapabilityCall(entry.id, judged, { loosens: loosensNow, workingDirectory: caller.workingDirectory, principalId: invocation.context.principalId ?? undefined })
        ?? (methodDescriptor && riskOfDescriptor(methodDescriptor) === 'owner-act' ? ownerOnlyMethodArea(methodDescriptor.id) : undefined);
    })();
    const ownerDecides = ownerOnlyArea !== undefined
      || commandLineHoldReason(entry, judged, definition?.loosensIf ?? methodCapability(entry.id)?.loosensIf, definition?.steersModel === true) !== undefined;
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
      ...(risk === 'runs-later' ? ['runs-later'] : []),
      ...(risk === 'cannot-be-undone' ? ['cannot-be-undone'] : []),
      ...(risk === 'spends-money' ? ['spends-money'] : []),
      ...(entry.touches === 'credential' || capabilityEffects(entry, judged).includes('secret.write') ? ['writes-a-secret'] : []),
      ...(definition?.steersModel === true ? ['steers-a-model'] : []),
      ...(entry.ownerOnly || ownerOnlyArea !== undefined ? ['owner-act'] : []),
      // A method call the dispatch handed over is decided here at its own class, and then sent as it came: that one decision
      // covers it. Without its class here (a `steers-a-model` call maps to no capability risk above) the dispatch would find the
      // sent call undecided and hand it over again, and again, until the caller's in-flight limit refused it.
      ...(handedMethod ? [handedMethod.risk] : []),
      // A capability that answers, run by the owner answering (checked below before anything runs): its nested answer
      // answers. Any other run's nested answer is refused (method-owner-decision.ts `nestedAnswerAdmitted`).
      ...(answering ? ['answers-the-owner'] : []),
    ]);
    // A typed `do` is the user's own act: it carries the person's claim and is decided exactly as the same act from the
    // terminal app with the user's press, in every mode. Nothing is held for being a command line (capabilities/
    // command-line-hold.ts is no longer read here), so no call is "decided from a command line".
    const decidedFromCommandLine = false;
    const namedByPerson = (at: GatewayMethodInvocation): boolean => personAsked(at) || decidedFromCommandLine;
    // A model behind this call (the owner's program's model, one of the daemon's turns, or a script holding the
    // Agent's credential): what no model makes is refused, in every mode, the owner's own turn included (method-risk.ts
    // `MODEL_NEVER_CAPABILITY_IDS`, the effect table's `model.refused`), before anything is decided or put to anyone.
    const callerActor = invocation.context.actor ?? systemActor('in-process');
    const daemonTurnCall = invocation.context.clientKind === 'daemon-turn' && !invocation.context.authToken;
    const modelCall = callerActor.agentFor !== undefined || invocation.context.credentialKind === 'agent' || daemonTurnCall;
    if (!handedMethod && modelCall && !answers && (capabilityEffects(entry, judged).some(modelNeverMakes) || namesPermissionSetting(entry.id, judged))) {
      throw new GatewayVerbError(modelNeverWords(`${entry.label} (${entry.id})`), MODEL_NEVER, 403, 'id', { state: 'nothing ran' });
    }
    // An act only the owner makes (`ownerOnlyArea`): refused for anyone but the owner in person, the owner's own command line
    // and the owner's own model's turn, in every mode, before any check reads its files and before anything is decided or put
    // to anyone (method-owner-decision.ts `makesOwnerOnlyAct`). The command line's goes on to the gate (`decidedFromCommandLine`).
    if (ownerOnlyArea !== undefined) {
      const hisOwnModelTurn = modelCall && invocation.context.call?.othersInput !== true
        && (daemonTurnCall ? turnInputParty().party === 'owner' : ownersAgentProgram(callerFactsOf(invocation)));
      if (!makesOwnerOnlyAct({ ...callerFactsOf(invocation), ownersOwnTurn: hisOwnModelTurn })) {
        throw new GatewayVerbError(ownerOnlyActWords(`${entry.label} (${entry.id})`, OWNER_ONLY_WHERE[ownerOnlyArea]), OWNER_ONLY_ACT, 403, 'id', { state: 'nothing ran' });
      }
    }
    const previewRefusal = pathInputsRefusal(entry, values, { ...caller, personAsked: namedByPerson(invocation), ...fromElsewhere(invocation) })
      ?? definition?.check?.(values, { ...caller, personAsked: namedByPerson(invocation), ...fromElsewhere(invocation) });
    if (previewRefusal) throw refusalAnswer(previewRefusal);
    // A capability that applies a file reads it here, once, before anything is asked: what its content already earns is
    // refused now (a setting in it locked as managed), and what is decided is that content, which is what then runs.
    if (definition?.readsFileBefore) {
      let read: ReturnType<NonNullable<typeof definition.readsFileBefore>>;
      try { read = definition.readsFileBefore(values, deps.services, { ...caller, personAsked: namedByPerson(invocation), ...fromElsewhere(invocation) }); }
      catch (error) { if (error instanceof CapabilityRefusal) throw refusalAnswer(error); throw error; }
      if (read instanceof CapabilityRefusal) throw refusalAnswer(read);
      if (read) values = read as typeof values;
    }
    // A refusal the capability reads by asking, as this caller (a piece of work it did not cause): before anything is decided
    // or asked, so nobody is asked about a call refused whatever the answer.
    if (definition?.refusedBefore) {
      let refusal: CapabilityRefusal | undefined;
      try {
        refusal = await definition.refusedBefore(values, deps.services, { ...caller, personAsked: namedByPerson(invocation), ...fromElsewhere(invocation),
          method: (methodId, body) => deps.invokeMethod(methodId, body, withCallOf(invocation, caller)) });
      } catch (error) { if (error instanceof CapabilityRefusal) throw refusalAnswer(error); throw error; }
      if (refusal) throw refusalAnswer(refusal);
    }
    // An act only the owner makes reaches here only from the owner in person or their own turn (anyone else was refused
    // above): their own program's call without their press (a handed method of theirs, a result carrying a secret to them) is
    // decided under the owner's mode as an item of the owner's list, and run when allowed with the owner's authority (owner-approved-call.ts).
    let ownerAct = false;
    // A model's call that a turn's gate admitted (the program's capability gate, or one of the daemon's own turns): who
    // caused what it runs is that turn's party (causeOfRun).
    let modelOfTurn = false;
    // A model's delegation from a conversation in the owner's own program: decided under the owner's mode as an agent spawn is
    // (the gate is asked with work.delegate not taken as the owner's own act), the work carrying that conversation's party.
    const conversation = entry.id === 'work.delegate' ? conversationDelegation(params, invocation, deps) : undefined;
    // A capability with its own method is admitted by that method; a moved one by its own effects.
    if (definition) {
      const actor = invocation.context.actor ?? systemActor('in-process');
      const effects = capabilityEffects(entry, values);
      // A model's call that arrives through capability_run (the Agent's kind, after the program's or the turn's gate)
      // was put to the owner for what it writes: writing a credential is admitted as the owner's, not refused as the model's.
      // The effect table's refusal (security/effect-authority.ts, `secret.write`) stands for every other path.
      // So is an act that is the owner's own (an effect a model never causes): the program's gate put it to the owner on
      // every call (gate/classify.ts, `ownerActs.asked`), so it arrives only after the owner's yes and is admitted as theirs,
      // and its nested method is admitted as theirs for that one call (owner-approved-call.ts).
      // A call the program's capability gate decided (the Agent's credential with that gate's mark), or one of the
      // daemon's own turns (its call made in process as that turn's model).
      const ownerDecided = (decidedByProgramGate(invocation)
        || (invocation.context.clientKind === 'daemon-turn' && !invocation.context.authToken))
        && actor.agentFor !== undefined;
      modelOfTurn = ownerDecided;
      // A model's own call makes, of what the table refuses a model, only what the owner's own turn makes under the owner's mode (a
      // credential the owner gave it, a purchase allowed within the owner's limits: effect-authority.ts `MODEL_UNDER_MODE`); what no
      // model makes was refused above.
      const hisOwn = (effect: (typeof effects)[number]): boolean => OWNER_DECIDED_EFFECTS.has(effect);
      // What only the owner causes that this caller cannot (an effect whose least class is the owner), an act only the owner
      // does (`ownersAct`: handing work over, approving a plan), or a change of one of the owner's shared things of no project
      // (`ownersActWhen`: a memory record of theirs that applies everywhere), asked for by a caller who is not the owner
      // in person nor the owner's own turn: refused, in every mode, never put to the owner.
      const othersOwnerEffects = ownerDecided ? [] : ownersOwnEffects(actor, effects);
      const hisOwnTurn = ownerDecided && invocation.context.call?.othersInput !== true;
      const othersOwnAct = othersOwnerEffects.length > 0
        || (definition.ownersAct === true && !ownerDecided && actor.agentFor === undefined && !isTheUser(actor) && actor.class !== 'system')
        || (caller.ownerHimself !== true && !hisOwnTurn && actor.class !== 'owner' && actor.class !== 'system' && definition.ownersActWhen?.(values, deps.services) === true);
      // An answer keeps its own rule and words (`ownerAnswers`, below).
      if (othersOwnAct && !answers) {
        throw new GatewayVerbError(ownerOnlyActWords(`${entry.label} (${entry.id})`, OWNER_ONLY_WHERE[othersOwnerEffects.length > 0 ? ownerOnlyEffectArea(othersOwnerEffects[0]!) : 'memory']),
          OWNER_ONLY_ACT, 403, 'id', { state: 'nothing ran' });
      }
      const asModel = ownerDecided ? effects.filter((effect) => !hisOwn(effect)) : effects;
      const asOwner = ownerDecided ? effects.filter(hisOwn) : [];
      // The class and the scopes of the credential alone admit it, as released: no gift of one of the user's shared kinds.
      const modelAdmission = admitEffects(actor, asModel);
      const admission = modelAdmission.kind !== 'allowed' || asOwner.length === 0 ? modelAdmission : admitEffects(actor.agentFor!, asOwner);
      if (admission.kind === 'refused') throw new GatewayVerbError(`${entry.id}: ${admission.reason}. ${admission.next}`, admission.code, 403);
      if (admission.kind === 'ask-owner') throw new GatewayVerbError(`${entry.id} is the owner's to decide (${admission.reason}).`, 'OWNER_ONLY', 403);
      // The owner's own turn's call was decided by the owner's mode at that turn's gate (YOLO ran it, Jev decided it with its arguments,
      // Ask me asked the owner): that decision is the person's request for its own nested method that needs one (a spend's
      // `payments.standing.create`, `confirmation: 'owner-request'`), for this one call. The owner's limits still refuse past them.
      if (asOwner.some((effect) => !OWNER_DECIDED_EFFECTS.has(effect)) || hisOwnTurn) markOwnerApprovedRun(invocation, `${entry.id}:decided-in-program`);
    } else if (entry.method && deps.gate) {
      // An action run through its own method is admitted there, as the caller; only an act of the owner's own that
      // this caller cannot make is taken here, so it is put to the owner instead of refused after the owner was asked.
      const actor = invocation.context.actor ?? systemActor('in-process');
      const declared = methods.get(entry.method.id)?.effects ?? [];
      // What only the owner causes that this caller cannot, or an act only the owner does (`ownersAct`, as for a handler
      // capability), asked for by a caller who is not the owner: refused, in every mode, never put to the owner.
      const othersOwnerEffects = ownersOwnEffects(actor, declared);
      if (othersOwnerEffects.length > 0
        || (methodCapability(entry.id)?.ownersAct === true && actor.agentFor === undefined && !isTheUser(actor) && actor.class !== 'system')) {
        throw new GatewayVerbError(ownerOnlyActWords(`${entry.label} (${entry.id})`, OWNER_ONLY_WHERE[othersOwnerEffects.length > 0 ? ownerOnlyEffectArea(othersOwnerEffects[0]!) : ownerOnlyMethodArea(entry.method.id)]),
          OWNER_ONLY_ACT, 403, 'id', { state: 'nothing ran' });
      }
    }
    // A handed-over method call of the owner's own act (its class `owner-act`): an item of the owner's list, decided under the owner's mode.
    if (handedMethod?.risk === 'owner-act' && deps.gate) ownerAct = true;
    // A handed-over memory method changing one of the owner's shared records (of no project): the owner's own act, as the
    // capability that does the same is (memory.ts `ownersActWhen`).
    if (handedMethod && deps.gate && SHARED_MEMORY_WRITE_METHODS.has(handedMethod.call.id)) {
      const body = handedMethod.call.body !== null && typeof handedMethod.call.body === 'object' ? handedMethod.call.body as Record<string, unknown> : {};
      const query = handedMethod.call.query;
      const ids = [body['id'], body['toId'], query['id'], query['toId']].map((value) => typeof value === 'string' ? value : undefined);
      if (namesSharedMemoryRecord(deps.services, ids)) ownerAct = true;
    }
    // A result that carries a secret (a sign-in file, a device's token, the group's join key), asked for by a caller that
    // is not the owner's own program (a paired device, a member, a sign-in; its person's own press included): its
    // result would leave for that caller, so it is the owner's own act, decided under the owner's mode with what it sends and
    // to whom as a fact.
    // The one rule (daemon/method-owner-decision.ts): the owner's own press (their sign-in, or their verified program with
    // their press) or a call their program's gate decided gets it at once; any other caller, the operator token alone
    // included, goes to the gate.
    // A model's delegation from a conversation (`conversation`, sent by the program with the user's token for its model) is a
    // model's call: it is decided under the owner's mode as an agent spawn is, never taken as the user's own act.
    const hisOwnPress = (conversation === undefined && ownersOwnPress({
      actor: invocation.context.actor, credentialKind: invocation.context.credentialKind ?? undefined,
      registration: invocation.context.call?.registration, personAsked: personAsked(invocation),
    })) || decidedByProgramGate(invocation);
    const resultSecret = definition?.resultSecret !== undefined && !hisOwnPress ? definition.resultSecret : undefined;
    if (resultSecret !== undefined) {
      // Carried out to anyone but the owner in person: the owner's own act, refused (a model never gets it: refused above).
      if (!makesOwnerOnlyAct(callerFactsOf(invocation))) {
        throw new GatewayVerbError(ownerOnlyActWords(`${entry.label} (${entry.id}), which carries ${resultSecret}`, OWNER_ONLY_WHERE.secrets), OWNER_ONLY_ACT, 403, 'id', { state: 'nothing ran' });
      }
      if (!deps.gate) throw new GatewayVerbError(`${entry.id} was not run: its result carries ${resultSecret}, which goes to a caller that is not your own program, and this daemon has no permission decision for it. Nothing ran.`, 'OWNER_ONLY', 403);
      ownerAct = true;
    }
    // What a method capability sends, read before anything is asked: an action with a preview sends the body its
    // preview reads from the values (as the web UI's sheet does), and the preview is a read that refuses what will
    // not run (a described time that needs a decision model, inputs that do not fit, a target that is not there), so
    // the owner is never asked about a call that then fails for a reason known now.
    let methodInput: Record<string, unknown> | undefined;
    if (!definition && entry.method && !handedMethod) {
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
      // One line per run in the daemon's activity log (one call, one run).
      logger.info(`[run] ${handedMethod ? handedMethod.call.id : entry.id} for ${at.context.principalId ?? 'the daemon'}`);
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
    // The run itself, as the caller `at` (the request, or the same caller once the owner approved a call put to them).
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
        // a line typed): the owner's own press, or the owner's own verified command line (`do`, printed to that command's
        // own output as any command line prints what it made; method-owner-decision.ts `ownersCommandLine`). Any other
        // caller is told where the owner sees it, and never gets it.
        const reveal = definition.reveals && result.reveal ? { ...definition.reveals, ...result.reveal } : undefined;
        const toPerson = reveal !== undefined && (personAsked(at) || ownersCommandLine(callerFactsOf(at)));
        const withheld = reveal && !toPerson ? ` The ${definition.reveals!.label.toLowerCase()} is shown only to the owner, when they ask for it themselves.` : '';
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
    // A handed-over method call runs as it came, as its caller: its own answer is the answer (never a capability's sentence).
    if (handedMethod) {
      if (!deps.invokeMethodCall) throw new GatewayVerbError(`${entry.id} was not run: this daemon cannot send a method call it decided.`, 'CAPABILITY_ELSEWHERE', 409, 'id');
      const sent = await deps.invokeMethodCall(handedMethod.call.id, handedMethod.call.body, handedMethod.call.query, at);
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
      // The owner's reason as written: one that ends a sentence itself gets no second full stop ("Not now.", never "Not now..").
      new GatewayVerbError(`${entry.id} was not run: ${sentenceOf(reason ?? 'the owner did not approve it')}`, 'CAPABILITY_NOT_APPROVED', 403, undefined, {
        state: 'nothing ran', next: ['It was the owner\'s to decide: ask the owner, or let them run it themselves.'],
      });
    // A person's own request and a call the program's capability gate decided run at once; an act of the owner's own
    // asked for by someone who is not the owner is the owner's to decide, whoever pressed it. A read with no risk is never a
    // decision, whoever calls: its effects were admitted above, and it runs. Any other call made with the Agent's
    // credential (no gate mark: not judged by the capability's own risk) is decided here, as an outside caller's.
    // Answering a question addressed to the owner is never itself a question: the owner's own press in their own program or their
    // sign-in answers at once; anyone else (a script, a command line, an admin who is not the owner, a model) is refused.
    if (answers && !answering) throw new GatewayVerbError(OWNER_ANSWERS_ONLY_WORDS, OWNER_ANSWERS_ONLY, 403);
    const readsOnly = entry.touches === 'reads' && risk === 'none';
    // A command line's call that weakens a protection, cannot be undone, spends money, writes a secret or is the owner's
    // own (capabilities/command-line-hold.ts) goes to the gate, the owner's claim or not (a y typed at a terminal may have been
    // typed by anything that drives a terminal), where it is decided under the owner's mode as an item of the owner's list, the command
    // line named as who asks: YOLO runs it, Jev decides and Just vibes ask Jev, Ask me asks the owner.
    // A method call the dispatch handed over is never admitted elsewhere: the dispatch found nothing that admits it.
    // A person's press runs an act the owner decides at once only from the owner's own program (daemon/method-owner-
    // decision.ts `ownersOwnPress`: their sign-in, a device they paired, or a registered terminal program of theirs); an admin or
    // member who is not the owner pressing it goes to the gate. One rule, the same function the method dispatch uses.
    // The owner's own signed-in session is their press whether or not the request says so (ownersOwnPress).
    const pressAdmits = hisOwnPress || (personAsked(invocation) && !ownerDecides);
    // A first use this run needed (a project, one of the owner's shared things) was decided together with it at the
    // dispatch, in one decision naming both (daemon/capability-owner-gate.ts `coversCall`): not decided again here.
    const decidedWithFirstUse = invocation.context.metadata?.['decidedWithFirstUse'] === true;
    const admittedElsewhere = !handedMethod && !ownerAct && !decidedFromCommandLine && (readsOnly || pressAdmits || decidedByProgramGate(invocation) || decidedWithFirstUse);
    /** The question the owner answered yes for this call (Ask me), and who answered it. */
    let answered: { readonly askedId: string; readonly answeredBy?: string | undefined } | undefined;
    if (!admittedElsewhere) {
      if (deps.gate) {
        // The gate's check reads the untrusted-content window of the scope it runs in and fails if that window moves
        // while the owner is being asked. The call is a request over the wire with nothing it read in this daemon, so it
        // is decided in a window of its own, which only this call can move. A caller's own call over the wire is no turn:
        // decided as such (security/turn-input-party.ts `asCallOutsideTurn`), never as unmarked work.
        // Under Ask me the request waits on the owner's one answer, as a model's tool call does; the caller leaving
        // (its request's signal) withdraws the question.
        let decided: GateDecision;
        try {
          decided = await withUntrustedContentScope(`capability-run:${randomUUID()}`,
            () => asCallOutsideTurn(() => deps.gate!({ entry, values, caller, runsAs: gateCallerOf(invocation),
              ...(invocation.signal ? { signal: invocation.signal } : {}),
              ...(handedMethod?.project !== undefined ? { project: handedMethod.project } : {}),
              // The owner's card names a carried file as the caller's own, by its name (carried-files.ts).
              ...(carriedRun ? { carriedNames: carriedRun.names, carriedFolders: carriedRun.folders } : {}),
              ...(resultSecret !== undefined ? { resultSecret } : {}),
              ...(ownerAct || decidedFromCommandLine ? { ownerAct: true } : {}),
              ...(conversation ? { asSpawn: true } : {}),
              // Keyed by kind first (`callerKey`): a sign-in named `shared-token` is never taken for this machine's token.
              ...(invocation.context.principalId ? { requestedBy: callerKey(invocation.context) } : {}) })));
        } catch (error) {
          carriedRun?.dispose();
          throw error;
        }
        if (!decided.approved) { carriedRun?.dispose(); throw notApproved(decided.reason); }
        if (decided.askedId !== undefined) answered = { askedId: decided.askedId, answeredBy: decided.answeredBy };
      } else if (risk !== 'none' || entry.touches !== 'reads') {
        carriedRun?.dispose();
        throw new GatewayVerbError(`${entry.id} was not run: it changes something, and this daemon has no permission decision for it.`, 'CAPABILITY_NOT_APPROVED', 403);
      }
    }
    if (answered !== undefined) {
      // The owner's yes to this call's card: the person's request for its own nested method that needs one, and, for an act of their
      // own asked for by a caller who is not the owner, their authority for that call's nested methods (owner-approved-call.ts).
      markOwnerApprovedRun(invocation, answered.askedId, ownerAct ? ownerAuthority(answered.answeredBy) : undefined);
      // The owner's answer: what it runs is their own (causeOfRun).
      ownerAnswered.add(invocation);
    } else if (ownerAct) {
      // An act of the owner's own that the owner's mode or own rule settled for this caller: run with the owner's authority, that
      // one call. A run marked at admission (a model's act of the owner's own) or here ends with this call.
      markOwnerApprovedRun(invocation, `${entry.id}:owner-rule`, ownerAuthority(undefined));
      ownerAnswered.add(invocation);
    }
    try {
      return await perform(invocation);
    } finally {
      endOwnerApprovedRun(invocation);
    }
  };
  return handler;
}

function createFindHandler(deps: CapabilityRouteDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const need = typeof params['need'] === 'string' ? params['need'].trim() : '';
    if (!need) throw new GatewayVerbError('Say what you need in words: need is required.', 'CAPABILITY_INPUT_INVALID', 400, 'need');
    const catalog = await deps.catalog();
    const found = await findCapabilities(catalog, need, invocation.signal ? { signal: invocation.signal } : {});
    // A capability that runs in a terminal program's conversation (`runsIn: session`) is offered only to the owner's own
    // program (or the owner in person): no other caller (a paired device, a member, the outside agent, a script, a hosted
    // session's turn) can run it anywhere (`capabilities.run` answers CAPABILITY_ELSEWHERE), so it is not offered to them.
    const offered = ownersProgramCaller(callerFactsOf(invocation)) ? found.capabilities
      : found.capabilities.filter((capability) => capability.runsIn !== 'session');
    return {
      ...found,
      capabilities: offered.map((capability) => {
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
