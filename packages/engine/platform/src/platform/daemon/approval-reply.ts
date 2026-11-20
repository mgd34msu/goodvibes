/** Channel-owner replies to permission asks, through the shared ApprovalBroker. */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { LIMITS, toJson, type Selection } from '@goodvibes-jev/judgment';
import type { ChannelIngressPolicyInput, ChannelPolicyDecision, RouteBindingManager } from '../channels/index.js';
import { channelSenderActor } from '../channels/policy-manager.js';
import { admitEffects } from '../security/effect-authority.js';
import type { ApprovalBroker, SharedApprovalRecord } from '../control-plane/approval-broker.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import { logger } from '../utils/logger.js';
import { assertJudgmentInput, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { channelApprovalTarget } from './batteries/approval-reply.js';
import { isClassicOperation } from '../runtime/decision-policy.js';
import { readInboundMessage, type InboundReading } from './inbound-reading.js';
import { isOwnerConversation } from './owner-alert.js';
import { approvalGuestChannel } from '../control-plane/approval-broker-raise.js';

export type ApprovalReplyBroker = Pick<ApprovalBroker, 'listApprovals' | 'resolveApproval'>;

const SITE = 'daemon.approval-reply';
const isPending = (record: SharedApprovalRecord): boolean => record.status === 'pending' || record.status === 'claimed';
/** What the owner's reply is read against: the ask's id, tool, summary and arguments. */
export function approvalProposal(record: SharedApprovalRecord) {
  const proposal = {
    approvalId: record.id,
    tool: record.request.tool,
    summary: record.request.analysis.summary,
    arguments: record.request.args,
  };
  // Direct or restored broker asks can predate the tool gate's input check.
  // Inspect raw data before JSON serialization can invoke accessors/toJSON.
  return toJson(snapshotJudgmentInput(proposal, record.request.tool) as typeof proposal);
}

/** Only routing/source identity, not mutable last-seen timestamps or audit metadata. */
function sourceKey(record: SharedApprovalRecord, routes: Pick<RouteBindingManager, 'getBinding'>): string {
  const binding = record.routeId ? routes.getBinding(record.routeId) : undefined;
  return JSON.stringify([
    record.callId, record.request.callId, record.sessionId, record.routeId,
    binding?.id, binding?.surfaceKind, binding?.surfaceId, binding?.externalId,
    binding?.channelId, binding?.threadId, binding?.sessionId,
  ]);
}

/**
 * The route an ask is delivered to: its own route, else the first route of its
 * session. The same rule picks where the approval prompt is sent.
 */
export function approvalDeliveryRouteId(
  record: Pick<SharedApprovalRecord, 'routeId' | 'sessionId'>,
  sessions: Pick<SharedSessionBroker, 'getSession'> | undefined,
): string | undefined {
  return record.routeId ?? (record.sessionId ? sessions?.getSession(record.sessionId)?.routeIds[0] : undefined);
}

interface ApprovalReplyDeps {
  readonly approvalBroker?: ApprovalReplyBroker | undefined;
  readonly routeBindings: Pick<RouteBindingManager, 'getBinding'> & Partial<Pick<RouteBindingManager, 'listBindings'>>;
  readonly sessions?: Pick<SharedSessionBroker, 'getSession'> | undefined;
}

/**
 * The asks a reply may answer, decided in code before anything is read: the
 * sender may answer an approval (`approval.answer`: the channel's owner; an
 * allowlisted guest cannot approve tool use), and the ask was delivered to the conversation the reply
 * arrived in (same surface, channel and thread), or, for an ask a guest's turn
 * raised, the reply came from one of the owner's own conversations, where it
 * was delivered. Empty when there is none.
 */
export function approvalReplyCandidates(
  input: ChannelIngressPolicyInput,
  decision: ChannelPolicyDecision,
  deps: ApprovalReplyDeps,
): readonly SharedApprovalRecord[] {
  const broker = deps.approvalBroker;
  const { userId, surface, text } = input;
  if (!broker || !decision.allowed || !userId || !text?.trim()) return [];
  if (admitEffects(channelSenderActor(decision, surface, userId), ['approval.answer']).kind !== 'allowed') return [];
  // A guest's ask is delivered to the owner's own conversations, so it is
  // answered from one of them; the reply's conversation is resolved once.
  let ownConversation: boolean | undefined;
  const repliedInOwnConversation = () => ownConversation ??= (() => {
    let bindings: readonly ReturnType<RouteBindingManager['listBindings']>[number][];
    try { bindings = deps.routeBindings.listBindings?.() ?? []; }
    catch { return false; }
    return bindings.some((binding) => binding.surfaceKind === surface
      && (binding.channelId ?? binding.externalId) === input.channelId && binding.threadId === input.threadId
      && isOwnerConversation(binding, decision.policy.ownerId));
  })();
  // Inspect all pending records: truncating newest-first can hide ambiguity.
  return broker.listApprovals(Number.MAX_SAFE_INTEGER).filter((record) => {
    if (!isPending(record)) return false;
    if (approvalGuestChannel(record) !== undefined) return input.channelId !== undefined && repliedInOwnConversation();
    const routeId = approvalDeliveryRouteId(record, deps.sessions);
    const binding = routeId ? deps.routeBindings.getBinding(routeId) : undefined;
    return binding !== undefined && binding.surfaceKind === surface
      && (binding.channelId ?? binding.externalId) === input.channelId && binding.threadId === input.threadId;
  });
}

/**
 * Only the channel's owner can answer, and only an ask that was delivered to
 * the conversation the reply arrived in. An ask raised elsewhere is answered
 * where it was shown, and a message in a conversation that holds no ask costs
 * no decision request. With one ask the reply is read with the message's
 * other questions (or alone, when no reading is handed in); with several the
 * selector must identify exactly one first. Unclear, unsure or missing
 * readings consume nothing: the message goes on as conversation and every ask
 * keeps waiting.
 */
export async function tryResolveApprovalReplyFromChannel(
  input: ChannelIngressPolicyInput,
  decision: ChannelPolicyDecision,
  deps: ApprovalReplyDeps & {
    /** The single candidate's answer from the message's one inbound reading, when ingress asked it. */
    readonly reading?: { readonly approvalId: string; readonly answer: InboundReading['approval'] } | undefined;
  },
): Promise<boolean> {
  const broker = deps.approvalBroker;
  const { userId, surface, text } = input;
  const candidates = approvalReplyCandidates(input, decision, deps);
  // A selector has one additional option for none. Never truncate candidates.
  if (!broker || !userId || !text || candidates.length === 0 || candidates.length >= LIMITS.maxChoiceOptions) return false;
  if (isClassicOperation()) {
    const command = /^\/(approve|deny)\s+(\S+)$/u.exec(text.trim());
    const action = command?.[1], id = command?.[2];
    if (!id || (action !== 'approve' && action !== 'deny')) return false;
    if (!candidates.some(candidate => candidate.id === id)) return false;
    const resolved = await broker.resolveApproval(id, { approved: action === 'approve', disposition: action === 'approve' ? 'approved' : 'denied',
      actor: userId, actorSurface: surface, note: text.trim(), reason: 'Explicit owner command without a decision model.' });
    return resolved?.status === (action === 'approve' ? 'approved' : 'denied');
  }

  // Validate every candidate and the full reply before any request starts.
  // Keep this safe snapshot across the asynchronous selection/reply steps.
  assertJudgmentInput(text);
  const offers = candidates.map((record) => ({
    id: record.id, content: approvalProposal(record), source: sourceKey(record, deps.routeBindings),
  }));
  let target = offers[0]!;
  let selection: Selection | undefined;
  if (candidates.length > 1) {
    // Several asks in one conversation: which one is answered is its own request, before the reply is read.
    selection = await channelApprovalTarget.select(judgmentPort(SITE), { reply: text }, offers, { site: SITE });
    const chosen = offers.find((offer) => offer.id === selection?.chosen);
    // All fits must be settled and exactly one must fit. Conflicting fits are
    // ambiguity even when the relative pick itself looks confident.
    const fits = Object.values(selection.fits);
    if (!chosen || selection.outcome !== 'act' || fits.some((fit) => fit.outcome !== 'act')
      || fits.filter((fit) => fit.verdict === 'yes').length !== 1) {
      selection.recordAction('no resolution: target unclear or unsettled');
      return false;
    }
    target = chosen;
    selection.recordAction(`selected approval ${target.id}; awaiting reply reading`);
  }

  const answer = deps.reading?.approvalId === target.id
    ? deps.reading.answer
    : (await readInboundMessage({ message: text, approval: target.content })).approval;
  if (answer === undefined || answer === 'unsure' || answer === 'unclear') {
    selection?.recordAction(`no resolution: reply ${answer ?? 'unread'}`);
    return false;
  }
  const approved = answer === 'approve';
  const action = `resolve approval ${target.id}: ${answer}`;
  selection?.recordAction(action);
  const settled = await broker.resolveApproval(target.id, {
    approved,
    disposition: approved ? 'approved' : answer === 'amend' ? 'amended' : 'denied',
    actor: userId,
    actorSurface: surface,
    // Preserve ALL owner guidance without guessing where a verb ends. Amend
    // declines the original arguments and returns the requested change to the
    // waiting model; it never executes an unchanged conditional approval.
    note: text.trim(),
    reason: text.trim(),
  });
  // A record's request and route are fixed when it is raised; only its status
  // moves. When the ask was settled elsewhere during the reading, the broker
  // returns that record, which this reply did not decide, and the message
  // goes on as ordinary chat.
  if (!settled || settled.status !== (approved ? 'approved' : 'denied')) {
    selection?.recordAction(`no resolution: approval ${target.id} was already ${settled?.status ?? 'unavailable'}`);
    logger.info('Channel reply did not resolve the approval', { surface, userId, approvalId: target.id, status: settled?.status ?? null });
    return false;
  }
  logger.info('Pending approval resolved from a channel reply', {
    surface,
    userId,
    approvalId: target.id,
    approved,
    reading: answer,
    targetDecisionId: selection?.decisionId,
  });
  return true;
}
