import type { GatewayMethodCatalog } from '../method-catalog.js';
import { builtinTriggerSupervisorMethodDescriptors } from '../method-catalog-trigger-supervisor.js';
import { triggerOperatorStatus, TriggerOperatorError, type TriggerOperatorSupervisor } from '../../triggers/operator.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
function authenticate(invocation: GatewayMethodInvocation, scope: string): void {
  if (!invocation.context.principalId || invocation.context.admin !== true || !(invocation.context.scopes?.includes('*') || invocation.context.scopes?.includes(scope))
    || invocation.isAuthorized && !invocation.isAuthorized([scope])) throw new GatewayVerbError('Reading supervised triggers requires a current administrative operator with watcher access.', 'TRIGGER_OPERATOR_REQUIRED', 403);
  invocation.signal?.throwIfAborted();
}
function translate(error: unknown): never {
  if (error instanceof TriggerOperatorError) throw new GatewayVerbError(error.message, `TRIGGER_${error.kind.toUpperCase().replaceAll('-', '_')}`, error.kind === 'unavailable' ? 503 : 409);
  throw error;
}
export function registerTriggerSupervisorGatewayMethods(catalog: GatewayMethodCatalog, supervisor: TriggerOperatorSupervisor): void {
  for (const descriptor of builtinTriggerSupervisorMethodDescriptors) catalog.register(descriptor, invocation => {
    authenticate(invocation, 'read:watchers');
    try { return triggerOperatorStatus(supervisor); } catch (error) { translate(error); }
  }, { replace: true });
}
