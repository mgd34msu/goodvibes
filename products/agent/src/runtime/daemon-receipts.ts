/**
 * Connected-host receipt delivery.
 *
 * The daemon keeps honesty receipts ("updated from X to Y", "restarted
 * after a crash at HH:MM", settings-migration notes) and delivers the
 * undelivered ones ONLY to a `/status` read that opts in with
 * `?receipts=` read (peek then ack, or consume against an older daemon), a
 * plain `/status` read is receipt-neutral. Each receipt is delivered once, so
 * whichever read takes them must render them or they are lost. The agent's
 * consuming reader runs once per attach
 * (createSessionSpineReceiptConsumer, platform platform/runtime/session-spine,
 * wired through services.consumeDaemonReceipts); the frequent liveness
 * keepalive probe stays plain and never touches receipts. Every consumed
 * payload is pushed here.
 *
 * The parsing helper (extractSessionSpineReceipts) and the DaemonReceipt type
 * now live in the platform (this file's own copy was a byte-identical mirror).
 * What stays agent-local is this buffering
 * feed: it delivers receipts captured before the renderer exists (the first
 * consuming read can fire during boot, before the render sink attaches),
 * exactly once each (dedupe by id), as soon as, and whenever, a delivery
 * sink is attached. That buffering/render-sink behavior is agent-specific
 * presentation, not transport.
 */

import type { DaemonReceipt } from '@goodvibes-jev/engine/platform/platform/daemon/receipts';

export type { DaemonReceipt };

export class AgentDaemonReceiptFeed {
  private readonly buffered: DaemonReceipt[] = [];
  private readonly seen = new Set<string>();
  private deliver: ((receipt: DaemonReceipt) => void) | null = null;

  /** Ingest receipts from a /status read; buffers until a sink attaches. */
  push(receipts: readonly DaemonReceipt[]): void {
    for (const receipt of receipts) {
      if (this.seen.has(receipt.id)) continue;
      this.seen.add(receipt.id);
      if (this.deliver) {
        this.deliver(receipt);
      } else {
        this.buffered.push(receipt);
      }
    }
  }

  /** Attach the rendering sink; anything captured earlier flushes immediately. */
  attach(deliver: (receipt: DaemonReceipt) => void): void {
    this.deliver = deliver;
    for (const receipt of this.buffered.splice(0)) deliver(receipt);
  }
}

/**
 * What runs once per attach: the receipt-taking `/status` read, whose receipts
 * go to the feed. The daemon's build was already judged by the adoption read
 * that led to this attach, so this read takes receipts only.
 */
export function createDaemonReceiptConsumption(deps: {
  readonly consumeReceipts: () => Promise<readonly DaemonReceipt[]>;
  readonly feed: Pick<AgentDaemonReceiptFeed, 'push'>;
  readonly afterAttach: () => Promise<void>;
}): () => Promise<void> {
  return async () => {
    const receipts = await deps.consumeReceipts();
    if (receipts.length > 0) deps.feed.push(receipts);
    await deps.afterAttach();
  };
}
