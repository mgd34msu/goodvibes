/**
 * Connected-host receipt delivery.
 *
 * The daemon keeps honesty receipts ("updated from X to Y", "restarted
 * after a crash at 2026-11-15 03:12", settings-migration notes) and returns
 * the undelivered ones ONLY to a `/status?receipts=peek` read; a plain
 * `/status` read is receipt-neutral. A receipt stays undelivered at the daemon
 * until a reader acknowledges it (`?receipts=ack`), and this feed acknowledges
 * a receipt only once it has been handed to the render sink. An Agent that
 * exits or fails before its renderer attaches (a boot failure, a headless run)
 * has acknowledged nothing, so the owner sees the receipt on the next surface.
 * The agent's reader runs once per attach (createSessionSpineReceiptConsumer,
 * platform platform/runtime/session-spine, wired through
 * services.consumeDaemonReceipts); the frequent liveness keepalive probe stays
 * plain and never touches receipts.
 *
 * The parsing helper (extractSessionSpineReceipts) and the DaemonReceipt type
 * live in the platform. What stays agent-local is this buffering feed: it
 * delivers receipts captured before the renderer exists, exactly once each
 * (dedupe by id), as soon as, and whenever, a delivery sink is attached.
 */

import type { DaemonReceipt } from '@goodvibes/engine/platform/platform/daemon/receipts';

export type { DaemonReceipt };

/** Tells the daemon these receipts are on screen; never throws. */
export type DaemonReceiptAcknowledge = (ids: readonly string[]) => Promise<void> | void;

function settle(acknowledge: DaemonReceiptAcknowledge, ids: readonly string[]): void {
  if (ids.length === 0) return;
  // A failed acknowledgement leaves the receipt with the daemon, which offers it again.
  void Promise.resolve().then(() => acknowledge(ids)).catch(() => undefined);
}

interface BufferedReceipt {
  readonly receipt: DaemonReceipt;
  readonly acknowledge?: DaemonReceiptAcknowledge | undefined;
}

export class AgentDaemonReceiptFeed {
  private readonly buffered: BufferedReceipt[] = [];
  /** Receipts the sink took: marked only once delivery returned, so a throw leaves the receipt to be offered again. */
  private readonly shown = new Set<string>();
  private deliver: ((receipt: DaemonReceipt) => void) | null = null;

  /** Hand one receipt to the sink; false when the sink threw (the receipt was not shown). */
  private show(deliver: (receipt: DaemonReceipt) => void, receipt: DaemonReceipt): boolean {
    try {
      deliver(receipt);
    } catch {
      return false;
    }
    this.shown.add(receipt.id);
    return true;
  }

  private buffer(receipt: DaemonReceipt, acknowledge: DaemonReceiptAcknowledge | undefined): void {
    if (!this.buffered.some((entry) => entry.receipt.id === receipt.id)) this.buffered.push({ receipt, acknowledge });
  }

  /**
   * Ingest receipts; buffers until a sink attaches. `acknowledge`, for
   * receipts read from the daemon, is called with each id once that receipt
   * has been handed to the sink. A receipt whose delivery threw is neither
   * acknowledged nor marked shown: it stays buffered and is shown on the next
   * offer or attach, and the rest are still delivered.
   */
  push(receipts: readonly DaemonReceipt[], acknowledge?: DaemonReceiptAcknowledge): void {
    const shownNow: string[] = [];
    for (const receipt of receipts) {
      if (this.shown.has(receipt.id)) {
        // Shown before and offered again because its acknowledgement did not land.
        shownNow.push(receipt.id);
        continue;
      }
      if (this.deliver && this.show(this.deliver, receipt)) {
        this.buffered.splice(0, this.buffered.length, ...this.buffered.filter((entry) => entry.receipt.id !== receipt.id));
        shownNow.push(receipt.id);
      } else {
        this.buffer(receipt, acknowledge);
      }
    }
    if (acknowledge) settle(acknowledge, shownNow);
  }

  /** Attach the rendering sink; anything captured earlier flushes immediately and is then acknowledged. */
  attach(deliver: (receipt: DaemonReceipt) => void): void {
    this.deliver = deliver;
    const shownBy = new Map<DaemonReceiptAcknowledge, string[]>();
    const kept: BufferedReceipt[] = [];
    // Each buffered receipt is tried on its own: one that throws stays buffered and the rest are shown.
    for (const entry of this.buffered.splice(0)) {
      if (!this.show(deliver, entry.receipt)) { kept.push(entry); continue; }
      if (!entry.acknowledge) continue;
      const ids = shownBy.get(entry.acknowledge) ?? [];
      ids.push(entry.receipt.id);
      shownBy.set(entry.acknowledge, ids);
    }
    this.buffered.push(...kept);
    for (const [acknowledge, ids] of shownBy) settle(acknowledge, ids);
  }
}

/**
 * What runs once per attach: the receipt-reading `/status` read, whose
 * receipts go to the feed, which acknowledges each one once it is shown. The
 * daemon's build was already judged by the adoption read that led to this
 * attach, so this read takes receipts only.
 */
export function createDaemonReceiptConsumption(deps: {
  readonly consumeReceipts: () => Promise<readonly DaemonReceipt[]>;
  readonly acknowledgeReceipts?: DaemonReceiptAcknowledge | undefined;
  readonly feed: Pick<AgentDaemonReceiptFeed, 'push'>;
  readonly afterAttach: () => Promise<void>;
}): () => Promise<void> {
  return async () => {
    const receipts = await deps.consumeReceipts();
    if (receipts.length > 0) deps.feed.push(receipts, deps.acknowledgeReceipts);
    await deps.afterAttach();
  };
}
