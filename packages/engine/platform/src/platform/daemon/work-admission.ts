/**
 * Whether the daemon admits new work right now.
 *
 * The self-update closes admission in the same synchronous step as its last
 * idle check, before it commits the swap and asks the service manager for the
 * handover, so nothing admitted after that check can start and then be cut off
 * by the orderly stop that follows. A refused handover (or a commit that did
 * not happen) reopens admission under a new generation; a fence taken before
 * the close stays stale, so work that was admitted but had not yet started is
 * refused at its effect instead of starting under the closed generation.
 *
 * Cost: one boolean read per mutating request; nothing on a read.
 */
import { FenceIssuer, type Fence } from '../utils/owner-fence.js';

export interface DaemonWorkAdmissionRefusal {
  readonly error: string;
  readonly code: 'DAEMON_ADMISSION_CLOSED';
  readonly category: 'unavailable';
  readonly state: string;
  readonly next: readonly string[];
}

export class DaemonWorkAdmission {
  #issuer = new FenceIssuer('daemon work admission');
  #reason: string | null = null;

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
}
