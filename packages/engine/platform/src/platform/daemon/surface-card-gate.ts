/**
 * surface-card-gate.ts, refuse card-shaped and protected credential content
 * arriving on a remote messaging channel before judgment or persistence
 * (docs/decisions/2026-07-27-inbound-email-design.md §11.0).
 *
 * **Provenance, stated plainly: §11.0 is a coordinator ruling, not an owner
 * quote.** Design rule it enforces: card details are entered only at a local
 * terminal or in the webui, never over a remote messaging channel. This is the
 * daemon-side enforcement of that.
 *
 * ## The distinction that must not be collapsed
 *
 * Approvals and vetoes for purchases **do** work over remote channels. That is
 * the owner's explicit ruling and it stays. Remote surfaces have authority to
 * **say yes or no about a purchase**; they have **no path for entering the
 * instrument**. Authority over a decision is not a channel for a secret. A
 * later reader will be tempted to unify the two, "if the owner can approve a
 * payment from Telegram, why not enter the card there", and must not.
 *
 * This is also why the refusal reply is delivered rather than dropped silently:
 * the message being refused may itself have BEEN a veto, and an unheard
 * objection inside a veto window elapses into a completed purchase. Silence is
 * the one response here that can cost money.
 *
 * ## Why this lives on the shared ingress hook and not in the adapters
 *
 * `authorizeSurfaceIngress` is the single hook all nineteen remote adapter call
 * sites already pass through, the same reason work-proposal and approval-reply
 * consumption live there. The payments round learned the alternative firsthand:
 * a fix applied per-adapter leaves the other seventeen open.
 *
 * ## Why the code checks run first and the reading before any answer
 *
 * The checksum and protected-input refusals run before `evaluateIngress` and
 * before anything else reads the message. The audit trail `evaluateIngress`
 * writes masks every digit whatever the message says, so it holds no card
 * value. The card questions are part of the message's one inbound reading
 * (inbound-reading.ts), and their refusal is applied before a proposal,
 * purchase or permission answer is acted on, since an approval reply's text
 * becomes a stored steering note.
 */
import type { ChannelIngressPolicyInput, ChannelPolicyDecision, ChannelPolicyManager } from '../channels/index.js';
import { logger } from '../utils/logger.js';
import { JudgmentInputError, judgmentInputProblem, type JudgmentInputProblem } from '../gate/judgment-input.js';
import {
  cardShapeKinds,
  findCardNumberShapes,
  findLabelledCardShapes,
  renderCardShapeRefusal,
  type CardShapeFinding,
} from '../security/card-shapes.js';
import type { InboundReading } from './inbound-reading.js';
import { isSecurityCodeAwaited } from '../payments/security-code-requests.js';
import { readsAsSecurityCode } from '../payments/entry-surface.js';
import {
  deliverProposalNotice,
  resolveOriginBinding,
  type ConversationGateDeps,
} from './surface-conversation-gate.js';

export interface SurfaceCardGateDeps
  extends Pick<ConversationGateDeps, 'routeBindings' | 'sessionBroker' | 'deliverSurfaceNotice'> {
  /** Read-only. The gate needs a policy record for the decision it returns and must NOT evaluate ingress to get one. */
  readonly channelPolicy: Pick<ChannelPolicyManager, 'getPolicy'>;
}

/** Decision reason prefix. The suffix names the matched shape KINDS, never the digits. */
export const CARD_SHAPES_REFUSED_REASON = 'card-shapes-refused';
export const JUDGMENT_INPUT_REFUSED_REASON = 'judgment-input-refused';

/** Report a protected-input refusal without an audit write, model call or raw value. */
async function refuseProtectedInput(
  deps: SurfaceCardGateDeps,
  input: ChannelIngressPolicyInput,
  problem: JudgmentInputProblem,
): Promise<ChannelPolicyDecision> {
  const outcome = await deliverProposalNotice(deps, originBinding(deps, input),
    `${new JudgmentInputError(problem).message} Approving or vetoing an action still works here; resend your answer without protected values.`);
  logger.warn('Refused protected input on a remote channel before judgment', {
    surface: input.surface, problem, refusalDelivered: outcome.delivered,
  });
  return {
    allowed: false,
    reason: `${JUDGMENT_INPUT_REFUSED_REASON}:${problem}`,
    policy: deps.channelPolicy.getPolicy(input.surface),
  };
}

/** The conversation a refusal is said in: where the message came from, never carrying its text. */
function originBinding(deps: SurfaceCardGateDeps, input: ChannelIngressPolicyInput) {
  return resolveOriginBinding(deps, {
    surface: input.surface,
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  });
}

/**
 * The refusals code decides alone, before anything stores, logs or reads the
 * message: a card number (by its checksum) and protected credential input.
 *
 * Returns `null` when there is nothing to refuse, which is the overwhelming
 * majority of messages. Returns a not-allowed `ChannelPolicyDecision` after
 * putting a refusal on the channel the message came from.
 *
 * No raw values from `input.text` reach logs, reasons, notices or stores:
 * outward strings name only fixed card-shape or judgment-input problem kinds.
 */
export async function refuseCardShapedIngress(
  deps: SurfaceCardGateDeps,
  input: ChannelIngressPolicyInput,
): Promise<ChannelPolicyDecision | null> {
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0) return null;
  const pans = findCardNumberShapes(text);
  if (pans.length > 0) return refuseCardShapes(deps, input, pans);
  const problem = judgmentInputProblem(text);
  return problem === undefined ? null : refuseProtectedInput(deps, input, problem);
}

/**
 * The refusal a reading decides: the message's one inbound reading says it
 * gives a card's security code or expiry, or a purchase is waiting for its
 * security code and the short number typed here reads as that code.
 *
 * A card question no answer settled is not a pass. When the model read the
 * message and was unsure, the detail is refused unless the answer was a
 * confident no. When no model answered (decision models off, none
 * configured, past the deadline), code decides: a month/year pair or a short
 * number the words just before it label as an expiry or a security code.
 */
export async function refuseCardTalk(
  deps: SurfaceCardGateDeps,
  input: ChannelIngressPolicyInput,
  reading: Pick<InboundReading, 'card' | 'source'>,
): Promise<ChannelPolicyDecision | null> {
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0) return null;
  const { card } = reading;
  const modelRead = reading.source === 'model' || reading.source === 'cache';
  const labelled = !modelRead && (card.unsure.securityCode || card.unsure.expiry)
    ? new Set(findLabelledCardShapes(text).map((finding) => finding.kind))
    : null;
  const unsettled = (kind: 'securityCode' | 'expiry', shape: 'security-code' | 'expiry'): boolean =>
    card.unsure[kind] && (modelRead || labelled?.has(shape) === true);
  const securityCode = card.securityCode || unsettled('securityCode', 'security-code');
  const expiry = card.expiry || unsettled('expiry', 'expiry');
  if (securityCode || expiry) {
    return refuseCardShapes(deps, input, [
      ...(securityCode ? [{ kind: 'security-code' as const, startIndex: 0, length: 0 }] : []),
      ...(expiry ? [{ kind: 'expiry' as const, startIndex: 0, length: 0 }] : []),
    ]);
  }
  // While a purchase waits for its security code, a short number typed here
  // is most likely that code: it is refused and the owner told to delete it.
  if (!isSecurityCodeAwaited() || !await readsAsSecurityCode(text)) return null;
  const outcome = await deliverProposalNotice(deps, originBinding(deps, input),
    'That looks like your card security code. Do not send it here: delete that message from this chat. '
    + 'Type the code in the terminal app or the Agent (Waiting for you, under Purchases), or in the local web UI.');
  logger.warn('Refused a likely card security code on a remote channel', { surface: input.surface, refusalDelivered: outcome.delivered });
  return { allowed: false, reason: `${CARD_SHAPES_REFUSED_REASON}:security-code`, policy: deps.channelPolicy.getPolicy(input.surface) };
}

async function refuseCardShapes(
  deps: SurfaceCardGateDeps,
  input: ChannelIngressPolicyInput,
  findings: readonly CardShapeFinding[],
): Promise<ChannelPolicyDecision> {
  const kinds = cardShapeKinds(findings);
  // The policy record comes from a plain read, deliberately: getPolicy touches nothing.
  const decision: ChannelPolicyDecision = {
    allowed: false,
    reason: `${CARD_SHAPES_REFUSED_REASON}:${kinds.join(',')}`,
    policy: deps.channelPolicy.getPolicy(input.surface),
  };
  // Tell the owner, on the channel they sent from, through the same delivery path
  // the conversation gate uses for its proposals. They can resend without the digits,
  // including resending a veto, which is the case that makes silence costly.
  const outcome = await deliverProposalNotice(deps, originBinding(deps, input), renderCardShapeRefusal(findings));
  logger.warn('Refused a message carrying card-shaped content on a remote channel', {
    surface: input.surface,
    kinds,
    findingCount: findings.length,
    refusalDelivered: outcome.delivered,
    ...(outcome.delivered ? {} : { refusalUndeliverableReason: outcome.reason }),
  });
  return decision;
}
