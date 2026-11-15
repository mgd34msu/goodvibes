/**
 * routes/power.ts, handlers for the sleep-ownership verbs over the live
 * PowerManager (see platform/power/manager.ts for the policy).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { keepAwakeCondition, type PowerManager, type PowerState } from '../../power/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The narrow PowerManager slice the verbs need. */
export type PowerGatewayService = Pick<PowerManager, 'getState' | 'setKeepAwake'>;

/** The served state plus what keep-awake is actually doing, named once for every surface. */
function servedState(state: PowerState): PowerState & { readonly keepAwake: PowerState['keepAwake'] & { readonly state: ReturnType<typeof keepAwakeCondition> } } {
  return { ...state, keepAwake: { ...state.keepAwake, state: keepAwakeCondition(state.keepAwake) } };
}

export function createPowerStatusHandler(service: PowerGatewayService): GatewayMethodHandler {
  return () => servedState(service.getState());
}

export function createPowerKeepAwakeSetHandler(service: PowerGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    if (typeof params.enabled !== 'boolean') {
      throw new GatewayVerbError('enabled (boolean) is required', 'INVALID_ARGUMENT', 400, 'enabled');
    }
    return servedState(await service.setKeepAwake(params.enabled));
  };
}

/** Attach the power handlers to their registered descriptors (missing = no-op). */
export function registerPowerGatewayMethods(catalog: GatewayMethodCatalog, service: PowerGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('power.status.get', createPowerStatusHandler(service));
  attach('power.keepAwake.set', createPowerKeepAwakeSetHandler(service));
}
