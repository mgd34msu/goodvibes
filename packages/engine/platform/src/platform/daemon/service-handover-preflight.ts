/** Side-effect-free admission for one retained unattended service operation. */
import type { AutoUpdateServiceActions } from './auto-updater.js';
import type { ServiceHandoverOutcome } from './service-handover.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';

export interface ServiceHandoverSupport {
  readonly supported: boolean;
  readonly detail?: string;
}

/** A manager-admitted helper remains inert until runtime cleanup completes. */
export interface ServiceHandoverReservation {
  readonly exitRequired: true;
  assertCurrent(): void;
  commit(signal?: AbortSignal): Promise<ServiceHandoverOutcome>;
  cancel(): Promise<void>;
}

export class ServiceHandoverPreflightError extends Error {
  readonly outcome: ServiceHandoverOutcome;
  constructor(detail: string) {
    super(detail);
    this.name = 'ServiceHandoverPreflightError';
    this.outcome = Object.freeze({ status: 'unsupported', detail });
  }
}

export interface PreparedServiceHandover {
  readonly supervised: boolean;
  readonly reservationRequired: boolean;
  readonly exitRequired: boolean;
  reserve(signal: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
  assertCurrent(): void;
  request(signal?: AbortSignal): ReturnType<AutoUpdateServiceActions['restartService']>;
}

/** Legacy embedders without preflight retain their existing action contract.
 * Production supplies preflight; support is never manager acknowledgement. */
export function prepareServiceHandover(actions: AutoUpdateServiceActions): PreparedServiceHandover | undefined {
  const preflight = actions.preflight;
  if (!preflight) {
    if (actions.reserve) throw new ServiceHandoverPreflightError('A service handover reservation requires its capability preflight.');
    return undefined;
  }
  const supervised = actions.isSupervised();
  const operation = supervised ? actions.restartService : actions.adoptIntoService;
  const reserve = actions.reserve;
  let reservation: ServiceHandoverReservation | undefined;
  let reservationWork: Promise<void> | undefined;
  let cancelled = false;
  const assertCurrent = () => {
    if (cancelled) throw new ServiceHandoverPreflightError('Service handover reservation was cancelled.');
    if (actions.isSupervised() !== supervised) throw new ServiceHandoverPreflightError('Service supervision changed before unattended handover.');
    const support = preflight.call(actions, supervised);
    if (support && (typeof support === 'object' || typeof support === 'function') && 'then' in support) {
      drainOwned(support);
      throw new ServiceHandoverPreflightError('Service handover preflight must complete synchronously.');
    }
    if (actions.isSupervised() !== supervised) throw new ServiceHandoverPreflightError('Service supervision changed during unattended handover preflight.');
    if (support?.supported !== true) throw new ServiceHandoverPreflightError(support?.detail
      ?? 'No supported unattended service handover is available.');
    try { reservation?.assertCurrent(); }
    catch (error) { drainOwned(error); throw new ServiceHandoverPreflightError('The admitted service handover helper is no longer current.'); }
  };
  assertCurrent();
  return Object.freeze({ supervised, reservationRequired: reserve !== undefined,
    get exitRequired() { return reservation?.exitRequired === true; }, assertCurrent,
    reserve(signal: AbortSignal) {
      assertCurrent(); signal.throwIfAborted();
      if (!reserve) return Promise.resolve();
      return reservationWork ??= Promise.resolve().then(async () => {
        const admitted = await reserve.call(actions, supervised, signal);
        reservation = admitted;
        if (cancelled || signal.aborted) { await admitted.cancel(); signal.throwIfAborted(); throw new ServiceHandoverPreflightError('Service handover reservation was cancelled.'); }
        assertCurrent();
      });
    },
    async cancel() {
      cancelled = true;
      try { await reservationWork; } catch { /* The admission owner reports its original failure. */ }
      await reservation?.cancel();
    },
    request(signal?: AbortSignal) {
      assertCurrent();
      if (reserve && !reservation) throw new ServiceHandoverPreflightError('Service handover helper was not admitted before publication.');
      return reservation ? reservation.commit(signal) : operation.call(actions, signal);
    },
  });
}
