/** Account eligibility owns election membership; content dispositions never do. */
import { createSystemClusterClock, type ClusterClock } from '@goodvibes-jev/engine/platform/platform/cluster';
import type { InboxPollingControl } from '@goodvibes-jev/engine/platform/platform/intake';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';

interface Eligibility {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
interface EligibilityOptions {
  readonly verify: () => Promise<Eligibility>;
  readonly control: InboxPollingControl;
  readonly register: (control: InboxPollingControl) => () => void | Promise<void>;
  readonly clock?: ClusterClock;
  /** Where a failed probe step or a permanent stop is reported; defaults to the daemon activity log. */
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * Metadata-only probes are single-flight, once at startup then every 30 seconds
 * after completion. There is no content retry here and no time-based authority
 * expiry: transport uncertainty preserves a still-current proof. Explicit local
 * or provider invalidation withdraws immediately, even while a probe is pending.
 *
 * A failed probe step (for example the registry refusing a registration) is
 * logged and the next scheduled probe tries again; nothing was left half
 * registered. Only a failed RETIREMENT stops probing for good: the owned
 * coordinator could not prove it drained, so registering again could overlap
 * the old owner. That stop is logged once and close() reports it.
 */
export function ownInboxEligibility(options: EligibilityOptions): { ready: Promise<void>; close(): Promise<void> } {
  const clock = options.clock ?? createSystemClusterClock();
  let closed = false;
  let proof: Eligibility | undefined;
  let unregister: (() => void | Promise<void>) | undefined;
  let unlisten: (() => void) | undefined;
  let cancelTimer: (() => void) | undefined;
  let transition: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let failed = false;
  const log = options.log ?? ((message: string, detail: Record<string, unknown>) => { logger.warn(message, detail); });
  const reported = new WeakSet<object>();
  const report = (message: string, error: unknown): void => {
    if (typeof error === 'object' && error !== null) reported.add(error);
    try { log(message, { error: error instanceof Error ? error.name : 'non-error rejection' }); }
    catch { /* Reporting cannot change what the prober does. */ }
  };
  const valid = (value: Eligibility | undefined): value is Eligibility => {
    try { if (!value || value.signal.aborted) return false; value.assertCurrent(); return true; }
    catch { return false; }
  };
  const serialize = (action: () => Promise<void>): Promise<void> => {
    const next = transition.then(action);
    // A step's own failure does not poison later steps; retire() latches `failed` itself.
    transition = next.catch(() => {});
    return next;
  };
  const retire = async (): Promise<void> => {
    proof = undefined;
    unlisten?.(); unlisten = undefined;
    // Remove eligibility immediately. Owned coordinator withdrawal retains the
    // exact retiring gate until its accepted polls drain before RESIGN/reentry.
    // A failure remains sticky and retains the enclosing lifetime storage lock.
    const cleanup = unregister;
    try {
      await Promise.all([cleanup?.(), options.control.stop()]);
    } catch (error) {
      failed = true;
      report('Inbox eligibility probing stopped: the account could not be withdrawn cleanly; restart the daemon to probe again', error);
      throw error;
    }
    unregister = undefined;
  };
  const revoked = (): void => {
    proof = undefined;
    void serialize(retire).catch(() => {});
  };
  const probe = async (): Promise<void> => {
    if (closed || failed) return;
    if (proof && !valid(proof)) await serialize(retire);
    let next: Eligibility | undefined;
    try { next = await options.verify(); } catch { /* Keep only a still-current proof. */ }
    if (closed || failed) return;
    await serialize(async () => {
      if (closed || failed) return;
      if (!valid(next)) {
        if (proof && !valid(proof)) await retire();
        return;
      }
      if (valid(proof) && proof.signal === next.signal) return;
      if (unregister) await retire();
      if (closed || !valid(next)) return;
      const accepted = next;
      proof = accepted;
      accepted.signal.addEventListener('abort', revoked, { once: true });
      unlisten = () => accepted.signal.removeEventListener('abort', revoked);
      try {
        unregister = options.register({
          async start() {
            if (closed || failed || proof !== accepted || !valid(accepted)) throw new Error('Inbox account is not eligible');
            await options.control.start();
          },
          stop: () => options.control.stop(),
        });
      } catch (error) {
        // Nothing was registered, so forget this proof; the next probe verifies and registers afresh.
        proof = undefined; unlisten?.(); unlisten = undefined;
        report('Inbox eligibility registration failed; it will be retried at the next scheduled probe', error);
        throw error;
      }
      if (closed || !valid(accepted)) await retire();
    });
  };
  const schedule = (): void => {
    if (closed || failed) return;
    cancelTimer = clock.setTimer(() => {
      cancelTimer = undefined;
      probing = probe().catch(error => {
        // Registration and retirement failures were reported where they happened; anything else is retried at the next probe.
        if (!(typeof error === 'object' && error !== null && reported.has(error))) report('Inbox eligibility probe failed; it will be retried at the next scheduled probe', error);
      }).finally(schedule);
    }, 30_000);
  };
  let probing = Promise.resolve().then(probe);
  const ready = probing.finally(schedule);
  void ready.catch(() => {});
  return { ready, close() {
    if (!closing) {
      closed = true; cancelTimer?.(); cancelTimer = undefined;
      // Start drainage without waiting for an uncooperative metadata request.
      // The factory closes its provider concurrently to abort owned I/O.
      const retirement = serialize(retire);
      closing = Promise.allSettled([probing, retirement]).then(([, retired]) => {
        // A probe that failed and was retried says nothing about retirement; only retirement failures are fatal here.
        if (failed || retired.status === 'rejected') throw new Error('Inbox eligibility did not retire cleanly');
      });
    }
    return closing;
  } };
}
