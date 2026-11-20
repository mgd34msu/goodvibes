/**
 * unattended-runs.ts, what a run nobody is watching (a scheduled run, a
 * trigger's turn) needs from the host beside its agent: where its answer goes,
 * and the tools the owner has connected that it may use.
 *
 * The answer goes to the surface named on the run. When none is named, or the
 * named surface could not take it, it goes to the owner inbox as a `report`
 * (open until the owner answers `read`), so an answer is never only in a run
 * history nobody reads. A host with no owner inbox (a terminal app keeping
 * routines while the daemon is off) leaves it in the run history and says so.
 *
 * Connected tools are the mail and calendar tool when the owner has connected
 * them. The host that registers those tools on its worker registries supplies
 * the reading; a run's own tool allowlist always wins over it.
 */

import type { ChannelDeliveryRouter } from '../channels/delivery-router.js';
import { deliveryChannelProblem, parseChannelDeliveryTarget, type ChannelDeliveryTarget } from '../channels/delivery/types.js';
import type { NewOwnerItem, OwnerPostOutcome } from '../control-plane/owner-inbox.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

/** The part of the owner inbox an unattended answer is posted through. */
export interface UnattendedAnswerInbox {
  post(item: NewOwnerItem, postedBy?: string): Promise<OwnerPostOutcome>;
}

/** One answer of an unattended run. */
export interface UnattendedAnswer {
  /** What produced it: `schedule` or `trigger`, and the run's own id (a run id, or `<trigger id>:<agent id>`). */
  readonly source: 'schedule' | 'trigger';
  readonly runId: string;
  /** The schedule or trigger it belongs to, for the message and the inbox item. */
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly agentId?: string | undefined;
  /** A channel written as in configuration (`telegram`, `slack:C123`); absent: the owner inbox. */
  readonly deliverTo?: string | undefined;
}

/** Where an unattended answer went. */
export type UnattendedAnswerReceipt =
  | { readonly to: 'channel'; readonly channel: string; readonly responseId?: string | undefined }
  | { readonly to: 'inbox'; readonly itemId: string; readonly reason?: string | undefined }
  | { readonly to: 'nowhere'; readonly reason: string };

/** The owner inbox keeps at most this much of an answer; the rest is said to be cut. */
const INBOX_DETAIL_CHARS = 3800;

function inboxDetail(body: string, reason: string | undefined): string {
  const lead = reason ? `${reason}\n\n` : '';
  const room = INBOX_DETAIL_CHARS - lead.length;
  const text = body.trim() || '(The run finished without an answer.)';
  return lead + (text.length <= room ? text : `${text.slice(0, room)}\n[Cut: the run history keeps the whole answer.]`);
}

export class UnattendedRuns {
  #inbox: UnattendedAnswerInbox | undefined;
  #connectedTools: () => readonly string[] = () => [];

  constructor(private readonly router: Pick<ChannelDeliveryRouter, 'deliver'>) {}

  /** The owner inbox answers fall back to. Returns the detach. */
  attachOwnerInbox(inbox: UnattendedAnswerInbox): () => void {
    this.#inbox = inbox;
    return () => { if (this.#inbox === inbox) this.#inbox = undefined; };
  }

  /** How the host reads which connected tools (mail, calendar) an unattended run gets. Returns the detach. */
  attachConnectedTools(read: () => readonly string[]): () => void {
    this.#connectedTools = read;
    return () => { if (this.#connectedTools === read) this.#connectedTools = () => []; };
  }

  /** The connected tools an unattended run gets beside its template's; empty when none is connected. */
  connectedTools(): readonly string[] {
    try {
      return this.#connectedTools();
    } catch (error) {
      logger.warn('Unattended run: the connected tools could not be read; the run gets its template tools only', { error: summarizeError(error) });
      return [];
    }
  }

  /** Delivers an answer to its named channel, else (or when that send fails) to the owner inbox. */
  async deliver(answer: UnattendedAnswer): Promise<UnattendedAnswerReceipt> {
    const channel = answer.deliverTo?.trim();
    if (!channel) return this.postToInbox(answer);
    const problem = deliveryChannelProblem(channel);
    if (problem) return this.postToInbox(answer, `Not delivered to ${channel}: ${problem}.`);
    const target: ChannelDeliveryTarget = parseChannelDeliveryTarget(channel);
    try {
      const responseId = await this.router.deliver({
        target,
        body: answer.body.trim() || '(The run finished without an answer.)',
        title: answer.title,
        jobId: answer.ownerId,
        runId: answer.runId,
        includeLinks: false,
        announces: `${answer.source}:${answer.runId}:result`,
        ...(answer.agentId ? { agentId: answer.agentId } : {}),
      });
      return { to: 'channel', channel, ...(responseId ? { responseId } : {}) };
    } catch (error) {
      return this.postToInbox(answer, `Not delivered to ${channel}: ${summarizeError(error)}.`);
    }
  }

  /** Posts an answer to the owner inbox as a `report`; `reason` says why it is here instead of on a channel. */
  async postToInbox(answer: UnattendedAnswer, reason?: string): Promise<UnattendedAnswerReceipt> {
    const inbox = this.#inbox;
    if (!inbox) {
      const why = `no owner inbox in this process${reason ? `; ${reason}` : ''}`;
      logger.warn('Unattended run answer kept only in the run history', { source: answer.source, runId: answer.runId, reason: why });
      return { to: 'nowhere', reason: why };
    }
    try {
      const outcome = await inbox.post({
        kind: 'report',
        title: answer.title.slice(0, 200),
        detail: inboxDetail(answer.body, reason),
        options: ['read'],
        key: `${answer.source}:${answer.runId}`,
        askedBy: answer.source === 'schedule' ? `schedule ${answer.ownerId}` : `trigger ${answer.ownerId}`,
        metadata: { source: answer.source, runId: answer.runId, ownerId: answer.ownerId, ...(answer.agentId ? { agentId: answer.agentId } : {}) },
      }, 'unattended-run');
      return { to: 'inbox', itemId: outcome.item.id, ...(reason ? { reason } : {}) };
    } catch (error) {
      const why = `the owner inbox refused it: ${summarizeError(error)}${reason ? `; ${reason}` : ''}`;
      logger.warn('Unattended run answer kept only in the run history', { source: answer.source, runId: answer.runId, reason: why });
      return { to: 'nowhere', reason: why };
    }
  }
}
