/** Native transfer capabilities are construction-only and never reconstructed from watch JSON. */
import type { ExternalOperationSource } from '../permissions/external-request.js';
import type { CiWatchSubscription, FixSessionBrief, FixSessionStartOutcome } from './types.js';

export interface NativeCiWatchOwner {
  readonly id: string;
  bindWatch(watch: CiWatchSubscription): Promise<void>;
  startRepair(brief: FixSessionBrief): Promise<FixSessionStartOutcome>;
  revoke(): Promise<void>;
}
const applyOwner = Reflect.apply, ownerGet = WeakMap.prototype.get, ownerSet = WeakMap.prototype.set, ownerHas = WeakMap.prototype.has;
const issuers = new WeakMap<object, (operation: ExternalOperationSource) => ExternalOperationSource>();
const owners = new WeakMap<ExternalOperationSource, NativeCiWatchOwner>();

/** Installed only by the current native contract host on its exact source getter. */
export function bindNativeCiSourceIssuer<T extends object>(source: T,
  issue: (operation: ExternalOperationSource) => ExternalOperationSource): T {
  applyOwner(ownerSet, issuers, [source, issue]); return source;
}
export function captureNativeCiWatchOwner(operation: ExternalOperationSource): ExternalOperationSource | undefined {
  if (applyOwner(ownerHas, owners, [operation])) return operation;
  const issue = (applyOwner(ownerGet, issuers, [operation.sourceOf]) ?? applyOwner(ownerGet, issuers, [operation.sourceOf()])) as ((operation: ExternalOperationSource) => ExternalOperationSource) | undefined;
  return issue?.(operation);
}
export function bindNativeCiWatchOwner(operation: ExternalOperationSource, owner: NativeCiWatchOwner): ExternalOperationSource {
  applyOwner(ownerSet, owners, [operation, owner]); return operation;
}
export function nativeCiWatchOwner(operation: ExternalOperationSource | undefined): NativeCiWatchOwner | undefined {
  return operation ? applyOwner(ownerGet, owners, [operation]) as NativeCiWatchOwner | undefined : undefined;
}
