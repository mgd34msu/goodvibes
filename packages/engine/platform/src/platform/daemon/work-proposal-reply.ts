import { workProposalReply } from './batteries/conversation-gate.js';
import { decisionOrClassic, isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { assertSynchronousCurrent, daemonReadingPort } from './reading-lifetime.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { CallOptions } from '@goodvibes-jev/judgment/decisions';
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

const UNSETTLED_REPLY_NOTICE = 'I could not read that reply just now. Please send it again.';

export type WorkProposalReplyOutcome =
  | { readonly consumed: false; readonly reason?: 'decision-model-required' }
  | { readonly consumed: true; readonly action: 'accepted' | 'declined' | 'expired' | 'unsettled' | 'already-accepted' | 'start-failed' };

export interface WorkProposalReplyDeps {
  readonly readingOptions?: CallOptions | undefined;
  readonly captureProposalSource?: ((proposal: WorkProposalRecord) => () => void) | undefined;
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

async function resolveOwnedProposalReply(input: ChannelIngressPolicyInput, deps: WorkProposalReplyDeps): Promise<WorkProposalReplyOutcome> {
  deps.readingOptions?.signal?.throwIfAborted();
  assertSynchronousCurrent(deps.readingOptions?.beforeAttempt);
  if (isClassicOperation()) return { consumed: false, reason: 'decision-model-required' };
  const store = deps.proposals;
  if (!store) return { consumed: false };
  // Explicit authenticated button wire tokens are not conversational replies.
  if ((input.surface === 'slack' || input.surface === 'discord') && input.metadata?.interactive === true
    && /^gv:(?:approval:(?:approve|deny|claim)|run:(?:cancel|retry)):.+$/.test(input.text ?? '')) return { consumed: false };

  // Bind an actual delivered pending proposal BEFORE interpreting the reply.
  const target = findProposalForReply(input, store.listPending({ surfaceKind: input.surface }));
  if (!target) return { consumed: false };
  const options = deps.readingOptions ?? {};
  const proposalCurrent = deps.captureProposalSource?.(target);
  const inputSource = JSON.stringify(captureOwnedJson(input));
  const targetSource = JSON.stringify(captureOwnedJson(target));
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    assertSynchronousCurrent(options.beforeAttempt);
    assertSynchronousCurrent(proposalCurrent);
    const current = findProposalForReply(input, store.listPending({ surfaceKind: input.surface }));
    if (JSON.stringify(input) !== inputSource || !current || current !== target || current.id !== target.id
      || JSON.stringify(current) !== targetSource) throw new Error('Work proposal source is no longer current');
  };
  assertCurrent();
  const proposal = snapshotJudgmentInput({ task: target.task, summary: target.summary }) as { task: string; summary: string };
  const text = snapshotJudgmentInput(input.text ?? '') as string;
  const result = await decisionOrClassic<Awaited<ReturnType<typeof workProposalReply.read>> | null>(
    () => workProposalReply.read(daemonReadingPort('daemon.work-proposal-reply', assertCurrent, options.signal), proposal, text, { ...options, beforeAttempt: assertCurrent }),
    () => { assertCurrent(); return null; }, () => { assertCurrent(); return true; });
  assertCurrent();
  if (result === null) return { consumed: false, reason: 'decision-model-required' };
  if (result.reading.outcome !== 'act') {
    result.recordAction('held: work proposal reply unsettled');
    // The answer is consumed, so say it was not understood rather than leave the owner waiting.
    await deps.replyOnChannel(target, UNSETTLED_REPLY_NOTICE).catch((error: unknown) => {
      logger.warn('Work proposal unsettled-reply notice failed', { error: summarizeError(error) });
    });
    return { consumed: true, action: 'unsettled' };
  }
  const answer = result.reading.choice;
  if (answer === 'message') { result.recordAction('ordinary-message'); return { consumed: false }; }
  const reply = { decision: answer === 'reject' ? 'negative' : 'affirmative',
    ...(answer === 'steer' ? { note: text } : {}) };
  result.recordAction(answer);
  assertCurrent();
  if (reply.decision === 'affirmative') requireDecisionFeature('accepting an autonomous work proposal; continue through an ordinary Classic conversation instead');

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
