import { readRefusal } from '@goodvibes-jev/engine/errors';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { builtinTriggerOperationMethodDescriptors, builtinTriggerSupervisorMethodDescriptors } from '../method-catalog-trigger-supervisor.js';
import { triggerOperatorStatus, TriggerOperatorError, type TriggerOperatorSupervisor } from '../../triggers/operator.js';
import { localTriggerOperations } from '../../triggers/operations.js';
import { TriggerDefinitionError } from '../../triggers/validation.js';
import type { TriggerManager } from '../../triggers/manager.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import { missingScopes } from '@goodvibes-jev/engine/daemon-api/route-helpers';
function authenticate(invocation: GatewayMethodInvocation, scope: string): void {
  if (!invocation.context.principalId || invocation.context.admin !== true || missingScopes(invocation.context.scopes, [scope]).length > 0
    || invocation.isAuthorized && !invocation.isAuthorized([scope])) {
    throw new GatewayVerbError(`${scope === 'read:watchers' ? 'Reading' : 'Changing'} supervised triggers requires a current administrative operator with watcher access.`, 'TRIGGER_OPERATOR_REQUIRED', 403);
  }
  invocation.signal?.throwIfAborted();
}
function translate(error: unknown): never {
  if (error instanceof TriggerOperatorError) throw new GatewayVerbError(error.message, `TRIGGER_${error.kind.toUpperCase().replaceAll('-', '_')}`, error.kind === 'unavailable' ? 503 : 409);
  throw error;
}
/** A trigger operation's failure as the coded refusal the caller reads: a refusal keeps its code, a refused field says which. */
function translateOperation(error: unknown): never {
  if (error instanceof GatewayVerbError) throw error;
  if (error instanceof TriggerDefinitionError) throw new GatewayVerbError(error.message, 'TRIGGER_DEFINITION_INVALID', 400, error.field);
  const carried = readRefusal(error);
  if (carried) throw new GatewayVerbError([carried.reason, ...carried.next].join('. '), carried.code, carried.status);
  throw error;
}
function optionalStrings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new GatewayVerbError(`${field} must be a list of strings`, 'INVALID_ARGUMENT', 400, field);
  return value as string[];
}
export function registerTriggerSupervisorGatewayMethods(
  catalog: GatewayMethodCatalog,
  supervisor: TriggerOperatorSupervisor & Partial<TriggerManager>,
): void {
  for (const descriptor of builtinTriggerSupervisorMethodDescriptors) catalog.register(descriptor, invocation => {
    authenticate(invocation, 'read:watchers');
    try { return triggerOperatorStatus(supervisor); } catch (error) { translate(error); }
  }, { replace: true });
  // The operations need the supervisor itself; a host that hands over only the status view serves only status.
  if (typeof supervisor.create !== 'function' || typeof supervisor.registerGrant !== 'function') return;
  const operations = localTriggerOperations(supervisor as TriggerManager);
  const handlers: Record<string, (invocation: GatewayMethodInvocation, params: Record<string, unknown>) => Promise<unknown>> = {
    'watchers.triggers.list': async () => operations.list(),
    'watchers.triggers.history': async (_invocation, params) => {
      const limit = params['limit'];
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) throw new GatewayVerbError('limit must be a positive whole number', 'INVALID_ARGUMENT', 400, 'limit');
      return operations.history(requireString(params, 'id'), limit as number | undefined);
    },
    'watchers.triggers.create': async (_invocation, params) => {
      const definition = params['definition'];
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new GatewayVerbError('definition is required: { id, label, spec, action? }', 'INVALID_ARGUMENT', 400, 'definition');
      return { trigger: await operations.create(definition as Record<string, unknown>) };
    },
    'watchers.triggers.cancel': async (_invocation, params) => ({ trigger: await operations.cancel(requireString(params, 'id')) }),
    'watchers.triggers.reset': async (_invocation, params) => ({ trigger: await operations.reset(requireString(params, 'id')) }),
    'watchers.triggers.grant.list': async () => ({ grants: await operations.listGrants() }),
    'watchers.triggers.grant.register': async (invocation, params) => {
      refuseNonUserRequest(invocation, 'watchers.triggers.grant.register');
      const args = optionalStrings(params['args'], 'args');
      const cwd = params['cwd'];
      if (cwd !== undefined && typeof cwd !== 'string') throw new GatewayVerbError('cwd must be a string', 'INVALID_ARGUMENT', 400, 'cwd');
      try {
        return {
          grant: await operations.registerGrant({
            id: requireString(params, 'id'),
            description: requireString(params, 'description'),
            command: requireString(params, 'command', { verbatim: true }),
            ...(args !== undefined ? { args } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
            // Who approved it is the authenticated operator, never a field the caller sends.
            confirmedBy: invocation.context.principalId ?? 'owner',
          }),
        };
      } catch (error) {
        if (error instanceof GatewayVerbError || readRefusal(error)) throw error;
        throw new GatewayVerbError(error instanceof Error ? error.message : String(error), 'TRIGGER_DEFINITION_INVALID', 400);
      }
    },
  };
  for (const descriptor of builtinTriggerOperationMethodDescriptors) {
    const handler = handlers[descriptor.id];
    if (!handler) continue;
    const scope = descriptor.scopes[0] ?? 'write:watchers';
    catalog.register(descriptor, async (invocation) => {
      authenticate(invocation, scope);
      try { return await handler(invocation, readInvocationParams(invocation)); } catch (error) { translateOperation(error); }
    }, { replace: true });
  }
}
