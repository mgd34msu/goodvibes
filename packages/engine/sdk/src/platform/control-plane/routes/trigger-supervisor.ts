import type { GatewayMethodCatalog } from '../method-catalog.js';
import { builtinTriggerSupervisorMethodDescriptors } from '../method-catalog-trigger-supervisor.js';
import { migrateOperatorTriggers, triggerOperatorStatus, TriggerOperatorError, type TriggerOperatorSupervisor } from '../../triggers/operator.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import { readInvocationParams } from './invocation-params.js';
function authenticate(invocation: GatewayMethodInvocation, scope: string): void {
  if (!invocation.context.principalId || invocation.context.admin !== true || !(invocation.context.scopes?.includes('*') || invocation.context.scopes?.includes(scope))
    || invocation.isAuthorized && !invocation.isAuthorized([scope])) throw new GatewayVerbError('Trigger recovery requires a current administrative operator with watcher access.', 'TRIGGER_OPERATOR_REQUIRED', 403);
  invocation.signal?.throwIfAborted();
}
function translate(error: unknown): never {
  if (error instanceof TriggerOperatorError) throw new GatewayVerbError(error.message, `TRIGGER_${error.kind.toUpperCase().replaceAll('-', '_')}`, error.kind === 'unavailable' ? 503 : 409);
  throw error;
}
export function registerTriggerSupervisorGatewayMethods(catalog: GatewayMethodCatalog, supervisor: TriggerOperatorSupervisor): void {
  for (const descriptor of builtinTriggerSupervisorMethodDescriptors) catalog.register(descriptor, invocation => {
    const migrating = descriptor.id === 'watchers.triggers.migrate'; authenticate(invocation, migrating ? 'write:watchers' : 'read:watchers');
    try {
      if (!migrating) return triggerOperatorStatus(supervisor);
      const input = readInvocationParams(invocation);
      if (input['confirm'] !== true) throw new GatewayVerbError('Confirm trigger migration explicitly.', 'CONFIRM_REQUIRED', 400, 'confirm');
      if (input['olderInstancesClosed'] !== true) throw new GatewayVerbError('Acknowledge that older GoodVibes instances are closed before migrating.', 'OLDER_INSTANCES_ACKNOWLEDGEMENT_REQUIRED', 400, 'olderInstancesClosed');
      refuseNonUserRequest(invocation, 'Trigger migration');
      authenticate(invocation, 'write:watchers'); return migrateOperatorTriggers(supervisor, { olderInstancesClosed: true });
    } catch (error) { translate(error); }
  });
}
