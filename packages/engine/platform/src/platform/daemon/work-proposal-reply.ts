import { isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { assertSynchronousCurrent } from './reading-lifetime.js';
import type { CallOptions } from '@goodvibes-jev/judgment/decisions';
import { readInboundMessage, type InboundReading } from './inbound-reading.js';
/**
 * Channel-reply resolution of pending work proposals.
 *
 * When the gate proposes a workstream over a channel, agreement has to be
 * answerable over that same channel, a gate that requires walking to a
 * terminal is the same friction with extra steps. This module is the
 * counterpart to approval-reply.ts and hangs off the same shared ingress
 * hook (`authorizeSurfaceIngress`), so every surface adapter gets it without
 * any per-adapter wiring.
 */
import type { ChannelIngressPolicyInput } from '../channels/index.js';
import {
  renderProposalDeclinedMessage,
  renderProposalExpiredMessage,
} from '../agents/conversation-gate.js';
import type { WorkProposalRecord, WorkProposalStore } from '../agents/work-proposal-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type WorkProposalReplyOutcome =
  | { readonly consumed: false; readonly reason?: 'decision-model-required' }
  | { readonly consumed: true; readonly action: 'accepted' | 'declined' | 'expired' | 'already-accepted' | 'start-failed' };

export interface WorkProposalReplyDeps {
  readonly readingOptions?: CallOptions | undefined;
  /** Checked once, before the answer is acted on: the proposal's route is still the one it was delivered on. */
  readonly captureProposalSource?: ((proposal: WorkProposalRecord) => () => void) | undefined;
  /**
   * The answer the message's one inbound reading already gave for `target`,
   * when ingress asked it with the message's other questions.
   */
  readonly reading?: { readonly target: WorkProposalRecord; readonly answer: InboundReading['proposal'] } | undefined;
  readonly proposals?: (Pick<WorkProposalStore, 'listPending' | 'resolve'> & Partial<Pick<WorkProposalStore, 'get'>>) | undefined;
  /**
   * Start the agreed work. Called only after an affirmative reply resolved a
   * pending proposal, so the run is pre-authorized by construction and must
   * NOT be re-gated.
   */
  readonly startAgreedWork: (proposal: WorkProposalRecord, note?: string) => Promise<void>;
  /** Send a short acknowledgement back over the proposal's own channel. */
  readonly replyOnChannel: (proposal: WorkProposalRecord, text: string) => Promise<void>;
  /** Close the held message's input when the proposal will not run. */
  readonly settleUnstartedWork?: ((proposal: WorkProposalRecord, reason: string) => Promise<void>) | undefined;
}

/**
 * Match an inbound message against the pending proposals for its surface.
 *
 * Only one delivered pending proposal on the exact source is answerable.
 * Owner, channel and thread are deterministic boundaries; ambiguity or a
 * different identity cannot be resolved by falling back to a recent proposal.
 * ntfy alone authenticates a topic rather than exposing a sender identity.
 * Its userless replies require the same exact nonempty topic on both sides.
 */
export function findProposalForReply(
  input: Pick<ChannelIngressPolicyInput, 'surface' | 'userId' | 'threadId' | 'channelId'>,
  pending: readonly WorkProposalRecord[],
): WorkProposalRecord | null {
  // Never fall back to another owner, channel or thread. Unidentified owners
  // cannot answer someone else's proposal. Topic-authenticated surfaces may
  // omit user IDs only when both sides omit them and the exact channel matches.
  if (!input.userId && (input.surface !== 'ntfy' || !input.channelId)) return null;
  const candidates = pending.filter(record => record.surfaceKind === input.surface
    && record.userId === input.userId
    && record.threadId === input.threadId
    && (record.channelId ?? record.externalId) === input.channelId);
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Consume an inbound message if it answers a pending work proposal.
 *
 * Returns `consumed: true` when the message was an answer, the adapter must
 * then neither create a chat turn nor spawn anything, because this function
 * has already done whatever the answer called for.
 */
export async function tryResolveWorkProposalReplyFromChannel(
  input: ChannelIngressPolicyInput,
  deps: WorkProposalReplyDeps,
): Promise<WorkProposalReplyOutcome> {
  return withConfiguredDecisionModelPolicy(() => resolveOwnedProposalReply(input, deps));
}

/**
 * The pending proposal a message may answer, decided in code before anything
 * is read: a delivered proposal pending on the exact conversation for the same
 * sender. Undefined when there is none or decision models are off.
 */
export function proposalReplyTarget(
  input: ChannelIngressPolicyInput,
  proposals: WorkProposalReplyDeps['proposals'],
): WorkProposalRecord | undefined {
  if (isClassicOperation() || !proposals) return undefined;
  // Explicit authenticated button wire tokens are not conversational replies.
  if ((input.surface === 'slack' || input.surface === 'discord') && input.metadata?.interactive === true
    && /^gv:(?:approval:(?:approve|deny|claim)|run:(?:cancel|retry)):.+$/.test(input.text ?? '')) return undefined;
  return findProposalForReply(input, proposals.listPending({ surfaceKind: input.surface })) ?? undefined;
}

async function resolveOwnedProposalReply(input: ChannelIngressPolicyInput, deps: WorkProposalReplyDeps): Promise<WorkProposalReplyOutcome> {
  deps.readingOptions?.signal?.throwIfAborted();
  assertSynchronousCurrent(deps.readingOptions?.beforeAttempt);
  if (isClassicOperation()) return { consumed: false, reason: 'decision-model-required' };
  const store = deps.proposals;
  if (!store) return { consumed: false };
  // Bind an actual delivered pending proposal BEFORE interpreting the reply.
  const target = deps.reading?.target ?? proposalReplyTarget(input, store);
  if (!target) return { consumed: false };
  const proposalCurrent = deps.captureProposalSource?.(target);
  const text = input.text ?? '';
  const answer = deps.reading?.target === target
    ? deps.reading.answer
    : (await readInboundMessage({ message: text, proposal: { task: target.task, summary: target.summary } }, { signal: deps.readingOptions?.signal })).proposal;
  // An unsure reading answers nothing: the message goes on as conversation and the proposal stays pending.
  if (answer === undefined || answer === 'unsure' || answer === 'message') return { consumed: false };
  // Checked once, where the answer is acted on.
  deps.readingOptions?.signal?.throwIfAborted();
  assertSynchronousCurrent(deps.readingOptions?.beforeAttempt);
  assertSynchronousCurrent(proposalCurrent);
  const reply = { decision: answer === 'reject' ? 'negative' : 'affirmative',
    ...(answer === 'steer' ? { note: text } : {}) };
  if (reply.decision === 'affirmative') requireDecisionFeature('accepting an autonomous work proposal; continue through an ordinary conversation instead');

  const resolved = store.resolve(target.id, reply.decision === 'affirmative' ? 'accepted' : 'declined');
  if (!resolved) {
    // Reaped between listPending and resolve, or answered by a racing reply.
    // A racing "yes" lost to the winning one: that proposal is under way, not expired.
    const alreadyAccepted = deps.proposals?.get?.(target.id)?.status === 'accepted';
    const notice = alreadyAccepted ? `Already agreed, this is under way: ${target.summary}` : renderProposalExpiredMessage(target.summary);
    await deps.replyOnChannel(target, notice).catch((error: unknown) => {
      logger.warn('Work proposal expiry notice failed', { error: summarizeError(error) });
    });
    return { consumed: true, action: alreadyAccepted ? 'already-accepted' : 'expired' };
  }

  if (reply.decision === 'negative') {
    await deps.settleUnstartedWork?.(resolved, 'The owner declined this work.');
    await deps.replyOnChannel(resolved, renderProposalDeclinedMessage(resolved.summary)).catch((error: unknown) => {
      logger.warn('Work proposal decline notice failed', { error: summarizeError(error) });
    });
    logger.info('Work proposal declined from a channel reply', {
      surface: input.surface,
      proposalId: resolved.id,
    });
    return { consumed: true, action: 'declined' };
  }

  logger.info('Work proposal accepted from a channel reply', {
    surface: input.surface,
    proposalId: resolved.id,
    steered: Boolean(reply.note),
  });
  try {
    await deps.startAgreedWork(resolved, reply.note);
  } catch (error) {
    // The proposal is already terminal, so a throw here would otherwise leave
    // the owner's "yes" answered by nothing.
    logger.error('Agreed work could not be started', { proposalId: resolved.id, error: summarizeError(error) });
    // Release the proposal's held session input, as the conversation gate does for a failed start.
    await deps.settleUnstartedWork?.(resolved, 'The agreed work could not be started. Send the message again.').catch((settleError: unknown) => {
      logger.warn('Work proposal start-failure settlement failed', { proposalId: resolved.id, error: summarizeError(settleError) });
    });
    await deps.replyOnChannel(resolved, `Could not start: ${resolved.summary}. Please send the request again.`).catch((noticeError: unknown) => {
      logger.warn('Work proposal start-failure notice failed', { error: summarizeError(noticeError) });
    });
    return { consumed: true, action: 'start-failed' };
  }
  return { consumed: true, action: 'accepted' };
}
