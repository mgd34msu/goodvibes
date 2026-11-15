/** Side-effect-free admission for one retained unattended service operation. */
import type { AutoUpdateServiceActions } from './auto-updater.js';
import type { ServiceHandoverOutcome } from './service-handover.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';

export interface ServiceHandoverSupport {
  readonly supported: boolean;
  readonly detail?: string;
  /**
   * The supervision the preflight saw on the same service-manager reading.
   * When given, the handover compares it with the one captured at creation and
   * does not ask `isSupervised()` again for that step.
   */
  readonly supervised?: boolean;
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
  /** Settle everything that can refuse the handover while the runtime still serves; no-op when nothing is needed. */
  prepare(signal?: AbortSignal): Promise<ServiceHandoverOutcome>;
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
  // One service-manager reading per step: at creation, before the runtime stops
  // (the end of `prepare`) and before the request. Each reading is compared
  // with the supervision captured here.
  const assertCurrent = () => {
    if (cancelled) throw new ServiceHandoverPreflightError('Service handover reservation was cancelled.');
    const support = preflight.call(actions, supervised);
    if (support && (typeof support === 'object' || typeof support === 'function') && 'then' in support) {
      drainOwned(support);
      throw new ServiceHandoverPreflightError('Service handover preflight must complete synchronously.');
    }
    if ((support?.supervised ?? actions.isSupervised()) !== supervised) {
      throw new ServiceHandoverPreflightError('Service supervision changed during unattended handover preflight.');
    }
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
    async prepare(signal?: AbortSignal) {
      // Restarting a supervised daemon and a manager-owned reservation have nothing to settle early.
      if (!supervised && !reservation && actions.prepareAdoption) {
        let outcome: ServiceHandoverOutcome;
        try { outcome = await actions.prepareAdoption(signal); }
        catch (error) { return { status: 'failed', detail: error instanceof Error ? error.message : String(error) } as const; }
        if (outcome.status !== 'accepted') return outcome;
      }
      // The reading before the runtime stops: the step after this cannot be undone.
      assertCurrent();
      return { status: 'accepted' } as const;
    },
    request(signal?: AbortSignal) {
      assertCurrent();
      if (reserve && !reservation) throw new ServiceHandoverPreflightError('Service handover helper was not admitted before publication.');
      return reservation ? reservation.commit(signal) : operation.call(actions, signal);
    },
  });
}

/**
 * `prepare` for callers that may hold no prepared handover (legacy embedders):
 * nothing to settle is an accepted preparation. A thrown refusal is an outcome,
 * never an exception into the stop path.
 */
export async function prepareHandoverBeforeStop(handover: PreparedServiceHandover | undefined, signal?: AbortSignal): Promise<ServiceHandoverOutcome> {
  if (!handover) return { status: 'accepted' };
  try { return await handover.prepare(signal); }
  catch (error) {
    return error instanceof ServiceHandoverPreflightError ? error.outcome : { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
