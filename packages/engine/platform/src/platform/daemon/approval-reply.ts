/** Channel-owner replies to permission asks, through the shared ApprovalBroker. */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { LIMITS, toJson, type Selection } from '@goodvibes-jev/judgment';
import type { ChannelIngressPolicyInput, ChannelPolicyDecision, RouteBindingManager } from '../channels/index.js';
import type { ApprovalBroker, SharedApprovalRecord } from '../control-plane/approval-broker.js';
import type { SharedSessionBroker } from '../control-plane/session-broker.js';
import { logger } from '../utils/logger.js';
import { assertJudgmentInput, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { channelApprovalReply, channelApprovalTarget } from './batteries/approval-reply.js';
import { isClassicOperation } from '../runtime/decision-policy.js';

export type ApprovalReplyBroker = Pick<ApprovalBroker, 'listApprovals' | 'resolveApproval'>;

const SITE = 'daemon.approval-reply';
const isPending = (record: SharedApprovalRecord): boolean => record.status === 'pending' || record.status === 'claimed';
function proposalFor(record: SharedApprovalRecord) {
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

/**
 * Only an authorized owner can answer, and only an ask that was delivered to
 * the conversation the reply arrived in (same surface, channel and thread).
 * An ask raised elsewhere is answered where it was shown, and a message in a
 * conversation that holds no ask costs no decision request. With several
 * asks in one conversation the selector must identify exactly one before the
 * reply is read against it. Unclear or unsettled readings consume nothing;
 * unavailable judgment throws and leaves every ask waiting.
 */
export async function tryResolveApprovalReplyFromChannel(
  input: ChannelIngressPolicyInput,
  decision: ChannelPolicyDecision,
  deps: {
    readonly approvalBroker?: ApprovalReplyBroker | undefined;
    readonly routeBindings: Pick<RouteBindingManager, 'getBinding'>;
    readonly sessions?: Pick<SharedSessionBroker, 'getSession'> | undefined;
  },
): Promise<boolean> {
  const broker = deps.approvalBroker;
  const { userId, surface, text } = input;
  if (!broker || !decision.allowed || !userId || !text?.trim()) return false;
  const owners = decision.matchedGroupPolicy?.allowlistUserIds ?? decision.policy.allowlistUserIds;
  if (owners.length === 0 || !owners.includes(userId)) return false;

  // Inspect all pending records: truncating newest-first can hide ambiguity.
  const candidates = broker.listApprovals(Number.MAX_SAFE_INTEGER).filter((record) => {
    if (!isPending(record)) return false;
    const routeId = approvalDeliveryRouteId(record, deps.sessions);
    const binding = routeId ? deps.routeBindings.getBinding(routeId) : undefined;
    return binding !== undefined && binding.surfaceKind === surface
      && (binding.channelId ?? binding.externalId) === input.channelId && binding.threadId === input.threadId;
  });
  // A selector has one additional option for none. Never truncate candidates.
  if (candidates.length === 0 || candidates.length >= LIMITS.maxChoiceOptions) return false;
  if (isClassicOperation()) {
    const command = /^\/(approve|deny)\s+(\S+)$/u.exec(text.trim());
    const action = command?.[1], id = command?.[2];
    if (!id || (action !== 'approve' && action !== 'deny')) return false;
    if (!candidates.some(candidate => candidate.id === id)) return false;
    const resolved = await broker.resolveApproval(id, { approved: action === 'approve', disposition: action === 'approve' ? 'approved' : 'denied',
      actor: userId, actorSurface: surface, note: text.trim(), reason: 'Explicit owner command during Classic operation.' });
    return resolved?.status === (action === 'approve' ? 'approved' : 'denied');
  }

  // Validate every candidate and the full reply before any request starts.
  // Keep this safe snapshot across the asynchronous selection/reply steps.
  assertJudgmentInput(text);
  const offers = candidates.map((record) => ({
    id: record.id, content: proposalFor(record), source: sourceKey(record, deps.routeBindings),
  }));
  const port = judgmentPort(SITE);
  let target = offers[0]!;
  let selection: Selection | undefined;
  if (candidates.length > 1) {
    selection = await channelApprovalTarget.select(port, { reply: text }, offers, { site: SITE });
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

  const reply = await channelApprovalReply.read(port, target.content, text, { site: SITE });
  if (reply.reading.outcome !== 'act' || reply.reading.choice === 'unclear') {
    const action = `no resolution: reply ${reply.reading.choice} (${reply.reading.outcome})`;
    reply.recordAction(action);
    selection?.recordAction(action);
    return false;
  }
  const approved = reply.reading.choice === 'approve';
  // Record the decision before its side effect. A recording failure cannot
  // authorize an action without the underlying reading in the decision log.
  const action = `resolve approval ${target.id}: ${reply.reading.choice}`;
  reply.recordAction(action);
  selection?.recordAction(action);
  const settled = await broker.resolveApproval(target.id, {
    approved,
    disposition: approved ? 'approved' : reply.reading.choice === 'amend' ? 'amended' : 'denied',
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
    const outcome = `no resolution: approval ${target.id} was already ${settled?.status ?? 'unavailable'}`;
    reply.recordAction(outcome);
    selection?.recordAction(outcome);
    logger.info('Channel reply did not resolve the approval', { surface, userId, approvalId: target.id, status: settled?.status ?? null });
    return false;
  }
  logger.info('Pending approval resolved from a channel reply', {
    surface,
    userId,
    approvalId: target.id,
    approved,
    reading: reply.reading.choice,
    replyDecisionId: reply.decisionId,
    targetDecisionId: selection?.decisionId,
  });
  return true;
}
