/**
 * owner-act.ts, a change only the owner makes, asked of him.
 *
 * A write over the operator API that loosens a security, permission, judgment
 * or payment setting is the owner's own act (`settings.loosen` in the effect
 * table, security/effect-authority.ts). An admin who is not the owner (an
 * admin sign-in, a full pairing minted for automation) does not carry that
 * authority: the change is put to the owner as an approval, and it is applied
 * when he approves it from his own credential (`approval.answer`). Nothing is
 * written before that.
 */
import { randomUUID } from 'node:crypto';
import type { ApprovalBroker } from './approval-broker.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Approval metadata marking an ask only the owner's own credential may answer. */
export const OWNER_ACT_METADATA_KEY = 'ownerAct';

/** How long a change put to the owner waits for his answer before it lapses. */
export const OWNER_ACT_TIMEOUT_MS = 24 * 60 * 60_000;

export interface OwnerActRequest {
  /** What the change does, in words, for the prompt. */
  readonly summary: string;
  /** Each loosening, one line per setting. */
  readonly reasons: readonly string[];
  /** The call as the prompt shows it (method and arguments, never a credential). */
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Who asked (the principal id the transport authenticated). */
  readonly requestedBy: string;
  /** Applies the change; runs only after the owner approved it. */
  readonly apply: () => unknown | Promise<unknown>;
}

/** Put a change to the owner; returns the approval's id at once and applies the change when he approves. */
export async function putToOwner(broker: Pick<ApprovalBroker, 'raiseApproval'>, request: OwnerActRequest): Promise<{ readonly approvalId: string }> {
  const raised = await broker.raiseApproval({
    request: {
      callId: `owner-act-${randomUUID()}`,
      tool: request.tool,
      args: request.args,
      category: 'write',
      analysis: {
        classification: 'owner-act',
        riskLevel: 'high',
        summary: request.summary,
        reasons: [...request.reasons, `Asked for by ${request.requestedBy}, who is not the owner and cannot make this change itself.`],
      },
      ownerOnly: 'loosen-security',
      rememberOptions: [],
    },
    metadata: { [OWNER_ACT_METADATA_KEY]: true, requestedBy: request.requestedBy },
    timeoutMs: OWNER_ACT_TIMEOUT_MS,
  });
  void raised.decision.then(async (decision) => {
    if (!decision.approved) return;
    await request.apply();
  }).catch((error: unknown) => {
    logger.warn('A change the owner approved could not be applied', { approvalId: raised.approval.id, error: summarizeError(error) });
  });
  return { approvalId: raised.approval.id };
}
