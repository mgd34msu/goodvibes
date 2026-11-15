import { useCallback, useEffect, useRef, useState } from 'react';
import { client as platformClient, type DaemonReceipt } from '../lib/goodvibes';
import { takeRelayPairingCorruptionNotice } from '../lib/relay-pairing';

/**
 * useDaemonReceipts, consume the daemon's undelivered receipts exactly once
 * per connect and expose them as dismissible notices.
 *
 * The daemon holds a small queue of one-line receipts (a crash restart, a
 * self-update, a migration) and hands them over, marking them delivered, only
 * once control.status is called with { receipts: 'peek' } and then
 * { receipts: 'ack', ids } for the ones shown (a daemon that predates peek is
 * read with 'consume'). This hook fires that read on the ATTACH EDGE (the transition into connected +
 * signed-in), never on the recurring health poll, so plain status reads stay
 * receipt-neutral and each receipt surfaces exactly once.
 *
 * Belt-and-suspenders: every id ever surfaced is remembered, so a dismissed
 * receipt, or one seen on a prior connect, never re-appears even if a
 * reconnect re-reads. A failed read marks nothing delivered daemon-side,
 * so it is retried on the next attach edge.
 *
 * ALSO carries any pending LOCAL notice (relay-pairing.ts's
 * takeRelayPairingCorruptionNotice, a corrupt stored record this device just
 * discarded), consumed once on mount, independent of connection/sign-in state,
 * since it describes something this browser already did to itself rather than
 * anything the daemon reported.
 */
export interface DaemonReceiptsState {
  readonly receipts: readonly DaemonReceipt[];
  readonly dismiss: (id: string) => void;
}

function isDaemonReceipt(value: unknown): value is DaemonReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string'
    && typeof candidate.text === 'string'
    && typeof candidate.at === 'number'
  );
}

export function useDaemonReceipts(connected: boolean, signedIn: boolean): DaemonReceiptsState {
  const [receipts, setReceipts] = useState<DaemonReceipt[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Latches true once we've consumed for the current connect; a drop resets it
  // so the next reconnect is a fresh attach edge.
  const consumedForConnectRef = useRef(false);

  useEffect(() => {
    const localNotice = takeRelayPairingCorruptionNotice();
    if (localNotice && !seenIdsRef.current.has(localNotice.id)) {
      seenIdsRef.current.add(localNotice.id);
      setReceipts((current) => [...current, localNotice]);
    }
  }, []);

  useEffect(() => {
    const attached = connected && signedIn;
    if (!attached) {
      consumedForConnectRef.current = false;
      return;
    }
    if (consumedForConnectRef.current) return;
    consumedForConnectRef.current = true;

    // Deliberately NOT gated behind an effect-cleanup "cancelled" flag: a consume
    // marks the receipts delivered daemon-side, so discarding the resolved result
    // (e.g. on StrictMode's double-invoke cleanup, or a transient prop toggle)
    // would lose them for good. The seenIds set makes surfacing idempotent, and a
    // setState on an unmounted component is a no-op in React 18+.
    void (async () => {
      try {
        // peek leaves the receipts with the daemon until the ack, so a response
        // lost in transit offers them again on the next attach.
        let result = await platformClient.operator.control.status({ receipts: 'peek' });
        let peeked = true;
        if (!Array.isArray((result as { receipts?: unknown }).receipts)) {
          // A daemon that predates peek ignores it; consume is its only delivery.
          result = await platformClient.operator.control.status({ receipts: 'consume' });
          peeked = false;
        }
        const raw = (result as { receipts?: unknown }).receipts;
        const incoming = Array.isArray(raw) ? raw.filter(isDaemonReceipt) : [];
        const fresh = incoming.filter((receipt) => !seenIdsRef.current.has(receipt.id));
        for (const receipt of fresh) seenIdsRef.current.add(receipt.id);
        if (fresh.length > 0) setReceipts((current) => [...current, ...fresh]);
        if (peeked) {
          // Acknowledge after they are surfaced; a failed ack only means the
          // daemon offers them again, and seenIds keeps them from repeating.
          const ids = incoming.map((receipt) => receipt.id);
          try {
            for (let index = 0; index < ids.length; index += 100) {
              await platformClient.operator.control.status({ receipts: 'ack', ids: ids.slice(index, index + 100).join(',') });
            }
          } catch { /* offered again on the next attach */ }
        }
      } catch {
        // Nothing was marked delivered on a thrown call; allow the next attach
        // edge to retry rather than silently dropping the queue.
        consumedForConnectRef.current = false;
      }
    })();
  }, [connected, signedIn]);

  const dismiss = useCallback((id: string) => {
    setReceipts((current) => current.filter((receipt) => receipt.id !== id));
  }, []);

  return { receipts, dismiss };
}
