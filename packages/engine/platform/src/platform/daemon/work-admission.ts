/**
 * Whether the daemon admits new work right now: the one owner of that fact.
 *
 * The self-update closes admission in the same synchronous step as its last
 * idle check, before it commits the swap and asks the service manager for the
 * handover, so nothing admitted after that check can start and then be cut off
 * by the orderly stop that follows. A refused handover (or a commit that did
 * not happen) reopens admission under a new generation; a fence taken before
 * the close stays stale, so work that was admitted but had not yet started is
 * refused at its effect instead of starting under the closed generation.
 *
 * Every start point asks this one object: the HTTP router and the WebSocket
 * call path refuse a call that could start or change work ({@link startsWork})
 * with {@link DaemonWorkAdmission.refusal}; the daemon's agent spawn answers
 * {@link DaemonWorkAdmission.refusalResponse}, which a channel message keeps
 * as a held input the broker starts after the restart; the internal schedulers
 * (automation, watchers, knowledge schedules, retention sweeps) take
 * `() => admission.open` and leave a due occurrence due while it is false.
 *
 * Cost: one boolean read per mutating request, spawn or scheduler tick; nothing on a read.
 */
import { FenceIssuer, type Fence } from '../utils/owner-fence.js';

export interface DaemonWorkAdmissionRefusal {
  readonly error: string;
  readonly code: 'DAEMON_ADMISSION_CLOSED';
  readonly category: 'unavailable';
  readonly state: string;
  readonly next: readonly string[];
}

/** How often a scheduler holding a due occurrence asks again while admission is closed. */
export const WORK_ADMISSION_RECHECK_MS = 5_000;

/**
 * The rule every call path applies: a read never waits for admission;
 * anything else could start or change work. A call is described by its HTTP
 * method when it has one, else by its catalog effect (`read` or not).
 */
export function startsWork(httpMethod: string | undefined, effect?: string | undefined): boolean {
  if (httpMethod !== undefined) return httpMethod !== 'GET' && httpMethod !== 'HEAD' && httpMethod !== 'OPTIONS';
  return effect !== 'read';
}

/** The spawn refusals this module made, so a caller can tell "held for the restart" from a failure without parsing a body. */
const ADMISSION_REFUSALS = new WeakSet<Response>();

/** True when `response` is the daemon's "not taking new work" spawn refusal: the work is held, not failed. */
export function isAdmissionRefusal(response: Response): boolean {
  return ADMISSION_REFUSALS.has(response);
}

export class DaemonWorkAdmission {
  #issuer = new FenceIssuer('daemon work admission');
  #reason: string | null = null;
  readonly #reopenListeners = new Set<() => void>();

  /** True while new work is admitted. */
  get open(): boolean { return this.#reason === null; }

  /** The current generation's fence: an effect started under it checks it right before it runs. */
  fence(): Fence { return this.#issuer.peek(); }

  /** Stop admitting work; every fence of the open generation goes stale. Idempotent. */
  close(reason: string): void {
    if (this.#reason !== null) return;
    this.#reason = reason;
    this.#issuer.retire(reason);
  }

  /** Admit work again under a new generation (a refused handover, an update that did not commit). */
  reopen(): void {
    if (this.#reason === null) return;
    this.#reason = null;
    this.#issuer = new FenceIssuer('daemon work admission');
    // Work held while closed (channel messages, agreed work) starts now instead of waiting for the next restart.
    for (const listener of this.#reopenListeners) {
      try { listener(); } catch { /* a listener's failure never keeps admission closed */ }
    }
  }

  /** Call `listener` each time admission reopens. Returns the unsubscribe. */
  onReopen(listener: () => void): () => void {
    this.#reopenListeners.add(listener);
    return () => { this.#reopenListeners.delete(listener); };
  }

  /** Why new work is refused now, or null while admission is open. */
  refusal(): DaemonWorkAdmissionRefusal | null {
    const reason = this.#reason;
    if (reason === null) return null;
    return {
      error: `The daemon is not taking new work: ${reason}.`,
      code: 'DAEMON_ADMISSION_CLOSED',
      category: 'unavailable',
      state: reason,
      next: ['Retry in a few seconds: the daemon either restarts into the update or reopens if the restart is refused'],
    };
  }

  /** The refusal as the 503 every path answers, or null while admission is open; {@link isAdmissionRefusal} recognises it. */
  refusalResponse(): Response | null {
    const refusal = this.refusal();
    if (refusal === null) return null;
    const response = Response.json(refusal, { status: 503, headers: { 'Retry-After': '5' } });
    ADMISSION_REFUSALS.add(response);
    return response;
  }
}
