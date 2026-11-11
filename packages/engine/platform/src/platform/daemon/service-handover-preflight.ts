/** Side-effect-free admission for one retained unattended service operation. */
import type { AutoUpdateServiceActions } from './auto-updater.js';
import type { ServiceHandoverOutcome } from './service-handover.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';

export interface ServiceHandoverSupport {
  readonly supported: boolean;
  readonly detail?: string;
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
  assertCurrent(): void;
  request(signal?: AbortSignal): ReturnType<AutoUpdateServiceActions['restartService']>;
}

/** Legacy embedders without preflight retain their existing action contract.
 * Production supplies preflight; support is never manager acknowledgement. */
export function prepareServiceHandover(actions: AutoUpdateServiceActions): PreparedServiceHandover | undefined {
  const preflight = actions.preflight;
  if (!preflight) return undefined;
  const supervised = actions.isSupervised();
  const operation = supervised ? actions.restartService : actions.adoptIntoService;
  const assertCurrent = () => {
    if (actions.isSupervised() !== supervised) throw new ServiceHandoverPreflightError('Service supervision changed before unattended handover.');
    const support = preflight.call(actions, supervised);
    if (support && (typeof support === 'object' || typeof support === 'function') && 'then' in support) {
      drainOwned(support);
      throw new ServiceHandoverPreflightError('Service handover preflight must complete synchronously.');
    }
    if (actions.isSupervised() !== supervised) throw new ServiceHandoverPreflightError('Service supervision changed during unattended handover preflight.');
    if (support?.supported !== true) throw new ServiceHandoverPreflightError(support?.detail
      ?? 'No supported unattended service handover is available.');
  };
  assertCurrent();
  return Object.freeze({ supervised, assertCurrent, request(signal?: AbortSignal) {
    assertCurrent(); return operation.call(actions, signal);
  } });
}
