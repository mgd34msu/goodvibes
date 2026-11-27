/**
 * approvals.raise, a surface RAISING an ask into the daemon's broker.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `approvals.list/claim/approve/deny/cancel` have existed for a long time, so
 * every surface could SEE and DECIDE an ask. None of them could create one: the
 * only way into the broker was `ApprovalBroker.requestApproval`, an in-process
 * method call. A surface that is not in the daemon's process, a client whose
 * runtime lives on another machine, or simply another process on this one,
 * therefore had no way to route a permission ask through the daemon at all. It
 * kept its own broker, prompted at its own terminal, and the asks it raised
 * were invisible to every other surface and to the daemon's own attention
 * machinery (the web-push fan-out, the fleet blocked-on-user signal).
 *
 * ── Why it does not block ──────────────────────────────────────────────────
 *
 * The verb returns the PENDING record and returns it immediately. It does not
 * hold the call open until someone answers, for two reasons: an HTTP request
 * parked across a person's attention span is a request that dies to any idle
 * timeout between here and there (and over the relay there are several), and
 * the decision has a better channel already, `control.approval_update` on the
 * SSE stream carries every transition of this record the moment the broker
 * records it. So the shape is: raise, then watch the id you were handed.
 *
 * `waitMs` is offered for the caller that genuinely wants one round trip (a
 * script, a short-lived CLI). It is CLAMPED, and a wait that runs out is not an
 * error: the response comes back with the record still pending and
 * `decided: false`, which is the truth. Nothing here ever reports a decision
 * that was not made.
 *
 * ── Who owns the answer ────────────────────────────────────────────────────
 *
 * The daemon does. A raised ask becomes a record in the daemon's store, several
 * surfaces may claim and answer it, and what a surface renders afterwards is
 * what the record says, not what it locally believes it asked for. That is the
 * same parity contract the web UI already documents for the decide verbs, and
 * raising through this verb is what extends it to the ask itself.
 *
 * ── The hold, and the receipt ──────────────────────────────────────────────
 *
 * The raiser is handed a `holdId`, recorded on the ask. It gives the hold up
 * with `approvals.cancel { release: true, holdId }`: before a decision that
 * means it left (the last hold to go cancels the ask), after a decision it
 * means it received the answer, and the reading's receipt reads `delivered`
 * once every hold is released. A raiser that restarts reads the record again
 * and releases then, so a decision made while it was away still arrives.
 */

import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { PermissionAttribution, PermissionPromptRequest } from '../../permissions/prompt.js';
import { approvalQuestion } from '../../permissions/ask-presentation.js';
import { callerKey, isLocalOwnerCaller, pairingTokenIdOfCaller } from '../../pairing/principal-ids.js';
import { registrantMayName } from '../session-broker-sessions.js';
import type { RequestSharedApprovalInput, SharedApprovalRecord } from '../approval-broker.js';
import type { RaisedApproval } from '../approval-broker-raise.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { OWNER_ONLY_KINDS } from '../../gate/classify.js';
import { readApproval } from '../approval-lifecycle.js';
import { approvalViewerOfActor } from '../approval-actions.js';
import { systemActor } from '@goodvibes/engine/daemon-api/http-policy';
import { admitEffects } from '../../security/effect-authority.js';
import { ownersAgentProgram, ownersProgramCaller } from '../../daemon/method-owner-decision.js';
import {
  PERMISSION_CATEGORIES,
  PERMISSION_RISK_LEVELS,
  isPermissionCategory,
  isPermissionRiskLevel,
} from '../../permissions/types.js';

/** The broker surface this verb needs, nothing but raising and reading back. */
export interface ApprovalRaiseService {
  readonly homeNode: string;
  raiseApproval(input: RequestSharedApprovalInput): Promise<RaisedApproval>;
  getApproval(approvalId: string): SharedApprovalRecord | null;
  /** Put a change in effect inside the approver's answer (ApprovalBroker.onApproved). */
  onApproved(approvalId: string, effect: () => unknown | Promise<unknown>): () => void;
}

/**
 * Longest inline wait a caller may ask for, in ms.
 *
 * 60s is chosen against what is on the other side of the call rather than
 * against what a person takes to decide: an idle proxy, a tunnel, or a browser
 * fetch will drop a parked request well before a slow answer arrives, and a
 * dropped request looks like a failure rather than like "still waiting". A
 * caller that needs longer is the caller that should be on the event stream.
 */
export const APPROVAL_RAISE_MAX_WAIT_MS = 60_000;

/** Longest expiry a raised ask may carry, in ms. Twelve hours. */
export const APPROVAL_RAISE_MAX_TIMEOUT_MS = 12 * 60 * 60 * 1_000;

function invalid(message: string, field: string): GatewayVerbError {
  return new GatewayVerbError(message, 'INVALID_ARGUMENT', 400, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`Invalid ${field}: expected a string`, field);
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

/** A bounded, non-negative millisecond count, or undefined when unset. */
function clampedMs(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(`Invalid ${field}: expected a non-negative number of milliseconds`, field);
  }
  return Math.min(Math.floor(value), max);
}

/**
 * Validate the ask itself.
 *
 * A raised ask is rendered by every surface and stored durably, so a malformed
 * one is refused at the door rather than persisted and drawn as a blank prompt.
 * The required set is exactly what the broker's own store validator demands of
 * a restored record, an ask that could not be reloaded must not be creatable.
 */
export function readApprovalRaiseRequest(raw: unknown): PermissionPromptRequest {
  if (!isRecord(raw)) throw invalid('Invalid request: expected the permission ask object', 'request');
  const callId = requireStringValue(raw['callId'], 'request.callId');
  const tool = requireStringValue(raw['tool'], 'request.tool');
  const args = raw['args'];
  if (!isRecord(args)) throw invalid('Invalid request.args: expected an object of tool arguments', 'request.args');
  const category = raw['category'];
  if (!isPermissionCategory(category)) {
    throw invalid(`Invalid request.category: expected one of ${PERMISSION_CATEGORIES.join(', ')}`, 'request.category');
  }
  const analysis = raw['analysis'];
  if (!isRecord(analysis)) {
    throw invalid('Invalid request.analysis: expected the analysis object a surface renders the prompt from', 'request.analysis');
  }
  const riskLevel = analysis['riskLevel'];
  if (!isPermissionRiskLevel(riskLevel)) {
    throw invalid(`Invalid request.analysis.riskLevel: expected one of ${PERMISSION_RISK_LEVELS.join(', ')}`, 'request.analysis.riskLevel');
  }
  const reasons = analysis['reasons'];
  if (!Array.isArray(reasons) || !reasons.every((entry) => typeof entry === 'string')) {
    throw invalid('Invalid request.analysis.reasons: expected an array of strings', 'request.analysis.reasons');
  }
  const classification = requireStringValue(analysis['classification'], 'request.analysis.classification');
  requireStringValue(analysis['summary'], 'request.analysis.summary');
  const workingDirectory = optionalString(raw['workingDirectory'], 'request.workingDirectory');
  const ownerOnly = raw['ownerOnly'];
  if (ownerOnly !== undefined && (typeof ownerOnly !== 'string' || !(OWNER_ONLY_KINDS as readonly string[]).includes(ownerOnly))) {
    throw invalid(`Invalid request.ownerOnly: expected one of ${OWNER_ONLY_KINDS.join(', ')}`, 'request.ownerOnly');
  }
  // What is being asked, and nothing the daemon later reads as authority, wording, routing or identity: the caller's
  // `attribution` (who asked, and the kind of card), `rememberOptions` (the tiers and their words), `ownerOnly`, and
  // the analysis' own words (its summary, reasons, reading and effects) are dropped. The daemon words the question
  // itself from the tool and its arguments and names the principal it authenticated (createApprovalRaiseHandler). The
  // project folder stays as the place the card shows; no rule or sweep reads it from a wire record (approval-broker.ts).
  return {
    callId,
    tool,
    args,
    category: category as PermissionPromptRequest['category'],
    analysis: { classification, riskLevel: riskLevel as PermissionPromptRequest['analysis']['riskLevel'], summary: '', reasons: [] },
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}

/**
 * Who raised a wire ask, as the owner reads it on the card: the principal the daemon authenticated, never a name the
 * caller sent. A sign-in by its user name, a paired device by its name, the Agent's credential and the operator token
 * as a program on this machine (a person's own terminal program raises its model's asks with that token).
 */
export function wireAskerWords(context: GatewayMethodInvocation['context'], deviceName?: (pairingId: string) => string | undefined): string {
  const principalId = context.principalId;
  if (!principalId) return 'a caller the daemon could not name';
  // Told apart by the kind of credential first, never by the name alone: a sign-in user's name is its principal id.
  if (context.principalKind === 'user' || context.credentialKind === 'user-session') return `${principalId}, signed in`;
  if (context.credentialKind === 'agent') {
    return ownersAgentProgram({ actor: context.actor, credentialKind: 'agent', registration: context.call?.registration, daemonHosted: context.call?.daemonHosted === true })
      ? 'the Agent on this machine' : 'a program holding the Agent\'s credential that is not the Agent itself';
  }
  const pairingId = pairingTokenIdOfCaller(context);
  if (pairingId !== undefined) {
    const name = deviceName?.(pairingId);
    return name ? `the paired device "${name}"` : `a paired device (${pairingId})`;
  }
  if (isLocalOwnerCaller(context)) return context.credentialKind === 'local' ? 'a program on this machine using your operator token' : 'a program using your operator token';
  return principalId;
}

/**
 * Who raised this, recorded on the record's metadata.
 *
 * A raised ask that says nothing about where it came from is an ask an operator
 * cannot audit: several surfaces can now create records in one store, and "the
 * TUI asked" versus "a token asked" is exactly the distinction that matters
 * when reviewing what was approved. The invocation context already carries the
 * authenticated principal, so the attribution is the daemon's own observation
 * rather than a claim the caller makes about itself.
 */
export function buildRaiseMetadata(
  invocation: GatewayMethodInvocation,
  supplied: unknown,
): Record<string, unknown> {
  // Nothing a caller supplies is ever read back as authority: only the keys a surface shows are kept, and every key the
  // daemon itself reads on an approval (who raised it, which capability call it holds and who that call runs as, where
  // it is delivered, when it started, what came of it, its settled words) is dropped, whatever the caller sent.
  const base: Record<string, unknown> = {};
  // Display facts only, and only from the owner's own programs by who they are (method-owner-decision.ts
  // `ownersProgramCaller`: his registered terminal program, his Agent program, a turn the daemon hosts; never the operator
  // token or the Agent's credential alone): its background agent's id (the fleet's "blocked on you") and the decision
  // model's verdict, each a short text.
  const context = invocation.context;
  if (isRecord(supplied) && ownersProgramCaller({ actor: context.actor, credentialKind: context.credentialKind ?? undefined,
    registration: context.call?.registration, daemonHosted: context.call?.daemonHosted === true })) {
    for (const [key, valid] of Object.entries(RAISE_DISPLAY_METADATA_KEYS)) {
      const value = supplied[key];
      if (Object.hasOwn(supplied, key) && valid(value)) base[key] = value;
    }
  }
  return {
    ...base,
    raisedVia: 'approvals.raise',
    ...(invocation.context.principalId ? { raisedByPrincipal: invocation.context.principalId } : {}),
    ...(invocation.context.principalKind ? { raisedByPrincipalKind: invocation.context.principalKind } : {}),
    ...(invocation.context.clientKind ? { raisedBySurface: invocation.context.clientKind } : {}),
  };
}

/**
 * The metadata a raiser may put on its ask, and only the owner's own programs (credential kind `local`, the terminal
 * app's operator token from loopback, or `agent`, the Agent's own credential): the keys a surface shows for it, never read by the daemon as authority, wording or identity. `agentId` and
 * `agentTemplate` list the ask under that program's background agent in the fleet view ("blocked on you");
 * `judgmentVerdict` is drawn as the decision model's verdict on the web card. Each must be a short text (the verdict
 * one of its three words). Any other key, or any key from another caller, is dropped (buildRaiseMetadata).
 */
const SHORT_TEXT = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
const RAISE_DISPLAY_METADATA_KEYS: Readonly<Record<string, (value: unknown) => boolean>> = {
  agentId: SHORT_TEXT,
  agentTemplate: SHORT_TEXT,
  judgmentVerdict: (value) => value === 'looks-safe' || value === 'flags-risk' || value === 'uncertain',
};

/** Wait for a decision for at most `waitMs`; resolves false when it runs out. */
async function awaitDecision(raised: RaisedApproval, waitMs: number, signal?: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
    timer.unref?.();
    // A caller that went away stops waiting; the ask itself stays raised.
    if (signal) {
      if (signal.aborted) resolve(false);
      else {
        onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
  try {
    // A decision that settles by rejecting is not a decision: the record read
    // back below says where the ask stands.
    return await Promise.race([raised.decision.then(() => true, () => false), expired]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** What the raise verb reads beside the broker: a paired device's name, so the card names the device that asked. */
export interface ApprovalRaiseNames {
  readonly deviceName?: ((pairingId: string) => string | undefined) | undefined;
  /** Who registered a session (the session broker's); a raise names a session only when its raiser registered it. */
  readonly sessionRegistrant?: ((sessionId: string) => string | undefined) | undefined;
}

export function createApprovalRaiseHandler(broker: ApprovalRaiseService, names: ApprovalRaiseNames = {}): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const asked = readApprovalRaiseRequest(params['request']);
    // The card names the principal the daemon authenticated, and its question is the daemon's own words for the call.
    const attribution: PermissionAttribution = {
      kind: 'outside-caller', name: wireAskerWords(invocation.context, names.deviceName), principalId: invocation.context.principalId ?? 'unknown',
    };
    const attributed: PermissionPromptRequest = { ...asked, attribution };
    const request: PermissionPromptRequest = { ...attributed, analysis: { ...attributed.analysis, summary: approvalQuestion(attributed) } };
    const timeoutMs = clampedMs(params['timeoutMs'], 'timeoutMs', APPROVAL_RAISE_MAX_TIMEOUT_MS);
    const waitMs = clampedMs(params['waitMs'], 'waitMs', APPROVAL_RAISE_MAX_WAIT_MS);
    // Where the ask is shown and delivered is never the caller's word: a channel route is dropped, and a session is
    // kept only when this raiser registered it (its own conversation), never one it merely named.
    const named = optionalString(params['sessionId'], 'sessionId');
    optionalString(params['routeId'], 'routeId');
    const registrant = named !== undefined ? names.sessionRegistrant?.(named) : undefined;
    // Compared as kept caller keys (pairing/principal-ids.ts `callerKey`): by kind first, so a sign-in user named
    // `shared-token` never matches a session this machine's programs registered.
    // The registering program too (its registration): holders of one operator token are told apart by it.
    const sessionId = named !== undefined && registrantMayName(registrant, { key: callerKey(invocation.context), registration: invocation.context.call?.registration })
      && invocation.context.credentialKind !== 'user-session' ? named : undefined;

    // A registered program's question is held by its process (bound by the daemon with the registration, never sent):
    // when that process is no longer running its hold is given up, so a program that died leaves no question open.
    const holdProcess = invocation.context.call?.registration !== undefined ? invocation.context.call.process : undefined;
    const raised = await broker.raiseApproval({
      request,
      ...(holdProcess === undefined ? {} : { holdProcess }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(timeoutMs === undefined || timeoutMs === 0 ? {} : { timeoutMs }),
      metadata: buildRaiseMetadata(invocation, params['metadata']),
    });

    // An unawaited decision promise is normal here, the decision arrives on
    // the event stream, but an unhandled rejection would take the process
    // down, and the broker rejects nothing today only by construction.
    raised.decision.catch(() => undefined);

    const decided = waitMs !== undefined && waitMs > 0 ? await awaitDecision(raised, waitMs, invocation.signal) : false;
    // Read the record BACK rather than returning the one raise produced: if a
    // decision landed during the wait, the caller should see the resolved
    // record, and the store is the authority on what it says.
    const approval = broker.getApproval(raised.approval.id) ?? raised.approval;
    // The record goes back only to a caller that may read it: one this raiser
    // raised (`approval.read`, subject its raiser). A raiser without
    // read:approvals gets the id to watch and the decision state, not the record.
    const raiserId = typeof approval.metadata['raisedByPrincipal'] === 'string' ? approval.metadata['raisedByPrincipal'] : undefined;
    const readable = admitEffects(invocation.context.actor ?? systemActor('in-process'), ['approval.read'],
      { owners: raiserId === undefined ? [] : [raiserId] }).kind === 'allowed';
    return {
      approvalId: approval.id,
      // With the record, its reading for this caller: waiting on whom, until when; once decided, its receipt waits on this hold.
      ...(readable ? { approval, reading: readApproval(approval, approvalViewerOfActor(invocation.context.actor, broker.homeNode), Date.now()) } : {}),
      coalesced: raised.coalesced,
      decided,
      ...(raised.holdId === undefined ? {} : { holdId: raised.holdId }),
    };
  };
}

/** Attach the approvals.raise handler to its descriptor. Missing descriptor is a silent no-op. */
export function registerApprovalRaiseGatewayMethods(
  catalog: GatewayMethodCatalog,
  broker: ApprovalRaiseService,
  names: ApprovalRaiseNames = {},
): void {
  const descriptor = catalog.get('approvals.raise');
  if (descriptor) catalog.register(descriptor, createApprovalRaiseHandler(broker, names), { replace: true });
}
