import { readProfileDelegation, type ProfileMutationOptions } from '../owner-profile/delegation.js';
import { assertCurrent as assertRevisionsCurrent, captureRevisions, revisionSource, type RevisionToken } from '../utils/revision.js';
import type { OccasionsConfigAccess } from './policy.js';
import type { DeliveryLifetime } from '../utils/delivery-lifetime.js';
import type { OccasionNudge } from './types.js';

export interface OccasionMutationOptions extends ProfileMutationOptions {
  readonly onStateWriteIntent?: (() => void) | undefined;
  readonly onStateEffect?: ((published?: boolean) => void) | undefined;
  readonly withNudgeDelivery?: ((request: { readonly channel: string; readonly nudge: OccasionNudge },
    operation: (lifetime: DeliveryLifetime) => Promise<string | undefined>) => Promise<string | undefined>) | undefined;
}
const stateReceipts = new WeakMap<() => void, OccasionMutationOptions>();
export function retainOccasionStateReceipts(assertCurrent: () => void, options: OccasionMutationOptions): void {
  stateReceipts.set(assertCurrent, options);
}
export function occasionStateReceipts(assertCurrent: () => void): OccasionMutationOptions | undefined {
  return stateReceipts.get(assertCurrent);
}

/** The settings' own revision, as one integer the occasions path compares. */
export function captureSettingsRevision(config: Pick<OccasionsConfigAccess, 'getConfigurationIncarnation'>): RevisionToken {
  return captureRevisions([revisionSource('settings', () => config.getConfigurationIncarnation?.() ?? 0)]);
}

/**
 * The restriction one occasions operation carries to its writes: the caller's
 * signal and its own check, the delegation it was admitted under, and the
 * settings revision captured at entry. Integer and identity compares only; the
 * store's write queue orders the writes themselves.
 */
export function captureOccasionOperation(
  deps: { readonly signal?: AbortSignal | undefined; readonly config: Pick<OccasionsConfigAccess, 'getConfigurationIncarnation'> },
  options: OccasionMutationOptions,
): OccasionMutationOptions {
  if (!options.assertCurrent && !options.signal && !options.delegation && !options.withPublication) return options;
  const settings = captureSettingsRevision(deps.config);
  const signal = AbortSignal.any([...(deps.signal ? [deps.signal] : []), ...(options.signal ? [options.signal] : [])]);
  const assertCurrent = () => {
    options.assertCurrent?.();
    readProfileDelegation(options.delegation);
    assertRevisionsCurrent(settings, signal);
  };
  retainOccasionStateReceipts(assertCurrent, options);
  assertCurrent();
  return { ...options, signal, assertCurrent };
}
