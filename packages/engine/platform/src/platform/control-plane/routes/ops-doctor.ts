/**
 * ops.doctor gateway handler over the daemon's live runtime state.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { runDoctor, type OpsCheckContext } from '../../runtime/ops/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

export function registerOpsDoctorGatewayMethod(catalog: GatewayMethodCatalog, context: OpsCheckContext): void {
  const descriptor = catalog.get('ops.doctor');
  if (!descriptor) return;
  catalog.register(descriptor, async (invocation) => {
    const symptom = readInvocationParams(invocation)['symptom'];
    if (typeof symptom !== 'string' || !symptom.trim()) {
      throw new GatewayVerbError('Name the symptom, for example "stuck turn"', 'INVALID_ARGUMENT', 400, 'symptom');
    }
    return runDoctor(symptom, context);
  }, { replace: true });
}
