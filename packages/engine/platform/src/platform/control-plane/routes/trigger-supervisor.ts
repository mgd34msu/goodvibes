import { readRefusal } from '@goodvibes/engine/errors';
import { isAbsolute, resolve } from 'node:path';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { builtinTriggerOperationMethodDescriptors, builtinTriggerSupervisorMethodDescriptors } from '../method-catalog-trigger-supervisor.js';
import { triggerOperatorStatus, TriggerOperatorError, type TriggerOperatorSupervisor } from '../../triggers/operator.js';
import { localTriggerOperations } from '../../triggers/operations.js';
import { TriggerDefinitionError } from '../../triggers/validation.js';
import { describeWatchValues, watchDefinitionFromValues, WatchValuesError } from '../../triggers/watch-definition.js';
import type { TriggerManager } from '../../triggers/manager.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';
import { sharedKindReached, sharedKindRefusalWords } from '../shared-kinds.js';
/**
 * `projectAct`: a trigger of a project (listed, read, previewed, made, cancelled, reset: effect-authority.ts
 * `triggers.read`, `triggers.write`) is open below an admin holding the scope; the dispatch's project check and the one
 * reach rule hold such a caller to the projects the owner gave it and to triggers it made. The supervisor's status (every
 * project's triggers at once) and the owner's list of commands triggers may run stay an admin's.
 */
function authenticate(invocation: GatewayMethodInvocation, scope: string, projectAct = false): void {
  if (!invocation.context.principalId || (invocation.context.admin !== true && !projectAct) || missingScopes(invocation.context.scopes, [scope]).length > 0
    || invocation.isAuthorized && !invocation.isAuthorized([scope])) {
    throw new GatewayVerbError(`${scope === 'read:watchers' ? 'Reading' : 'Changing'} ${projectAct ? 'a project\'s triggers requires watcher access' : 'supervised triggers requires a current administrative operator with watcher access'}.`, 'TRIGGER_OPERATOR_REQUIRED', 403);
  }
  invocation.signal?.throwIfAborted();
}

/** The trigger operations open below an admin (see `authenticate`). */
const PROJECT_TRIGGER_OPERATIONS: ReadonlySet<string> = new Set([
  'watchers.triggers.list', 'watchers.triggers.history', 'watchers.triggers.create', 'watchers.triggers.preview',
  'watchers.triggers.cancel', 'watchers.triggers.reset',
]);

/**
 * A trigger made below an admin whose turn's answer goes to a channel of the owner's (`action.deliverTo`: telegram,
 * slack:C123) uses the owner's channels, a shared kind (control-plane/shared-kinds.ts): only with the owner's gift of
 * channels. Refused otherwise, before anything is kept; an answer left in the owner's inbox needs none.
 */
function refuseChannelDelivery(invocation: GatewayMethodInvocation, definition: Record<string, unknown>): void {
  if (invocation.context.admin === true) return;
  const action = definition['action'];
  const deliverTo = action !== null && typeof action === 'object' && !Array.isArray(action) ? (action as Record<string, unknown>)['deliverTo'] : undefined;
  if (typeof deliverTo !== 'string' || !deliverTo.trim()) return;
  if (invocation.context.principalId && sharedKindReached({ ownersOwn: false, daemonTurn: false, othersInput: false, principalId: invocation.context.principalId }, 'channels')) return;
  throw new GatewayVerbError(`Not done: its answer would go to ${deliverTo}, and ${sharedKindRefusalWords('channels', false)}. Leave deliverTo out to have it in the owner's inbox. Nothing was set up.`,
    'SHARED_KIND_NOT_GIVEN', 403, 'definition.action.deliverTo');
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
  if (carried) throw new GatewayVerbError([carried.reason, ...carried.next].join('. '), carried.code, carried.status ?? 409);
  throw error;
}
/** The project a trigger call is made in: its call context's (checked by the dispatch), else the folder it names. */
export function triggerCallProject(invocation: Pick<GatewayMethodInvocation, 'context'>, params: Record<string, unknown>): string | undefined {
  const named = invocation.context.call?.project ?? params['workingDirectory'];
  return typeof named === 'string' && named.trim() ? named.trim() : undefined;
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
  // A name typed in a project is that project's trigger of the name its people chose (TriggerManager `resolveName`),
  // the same resolution the one check of what a caller may reach makes (control-plane/caller-reach.ts).
  const named = (invocation: GatewayMethodInvocation, params: Record<string, unknown>): string =>
    (supervisor as TriggerManager).resolveName?.(requireString(params, 'id'), triggerCallProject(invocation, params)) ?? requireString(params, 'id');
  const handlers: Record<string, (invocation: GatewayMethodInvocation, params: Record<string, unknown>) => Promise<unknown>> = {
    'watchers.triggers.list': async () => operations.list(),
    'watchers.triggers.history': async (invocation, params) => {
      const limit = params['limit'];
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) throw new GatewayVerbError('limit must be a positive whole number', 'INVALID_ARGUMENT', 400, 'limit');
      return operations.history(named(invocation, params), limit as number | undefined);
    },
    'watchers.triggers.create': async (invocation, params) => {
      const definition = params['definition'];
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new GatewayVerbError('definition is required: { id, label, spec, action? }', 'INVALID_ARGUMENT', 400, 'definition');
      refuseChannelDelivery(invocation, definition as Record<string, unknown>);
      // It works in a project: the folder of the program or caller that makes it (sent beside the definition or in it).
      const given = typeof params['workingDirectory'] === 'string' ? params['workingDirectory'].trim()
        : typeof (definition as Record<string, unknown>)['workingDirectory'] === 'string' ? String((definition as Record<string, unknown>)['workingDirectory']).trim() : '';
      if (!given || !isAbsolute(given)) {
        throw new GatewayVerbError('Nothing was set up: no project folder came with the request, and a trigger\'s turns and commands work in a project. Send workingDirectory, the absolute path of the project folder.',
          'TRIGGER_PROJECT_REQUIRED', 422, 'workingDirectory');
      }
      return { trigger: await operations.create({ ...(definition as Record<string, unknown>), workingDirectory: resolve(given) }) };
    },
    'watchers.triggers.preview': async (_invocation, params) => {
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) {
        if (typeof value !== 'string') throw new GatewayVerbError(`${key} must be text`, 'INVALID_ARGUMENT', 400, key);
        values[key] = value;
      }
      const grant = values['then'] === 'run' ? (await operations.listGrants()).find((entry) => entry.id === values['grant']) : undefined;
      try {
        return { summary: describeWatchValues(values, grant), input: { definition: watchDefinitionFromValues(values, grant) } };
      } catch (error) {
        if (error instanceof WatchValuesError) throw new GatewayVerbError([error.message, error.next].filter(Boolean).join(' '), 'TRIGGER_DEFINITION_INVALID', 400);
        throw error;
      }
    },
    'watchers.triggers.cancel': async (invocation, params) => ({ trigger: await operations.cancel(named(invocation, params)) }),
    'watchers.triggers.reset': async (invocation, params) => ({ trigger: await operations.reset(named(invocation, params)) }),
    'watchers.triggers.grant.list': async () => ({ grants: await operations.listGrants() }),
    'watchers.triggers.grant.register': async (invocation, params) => {
      // Its descriptor's confirmation (`not-declined`) was checked by the catalog before this handler ran.
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
            // Who approved it is the authenticated operator, never a field the caller sends; a call naming no caller is never
            // written down as the owner's.
            confirmedBy: invocation.context.principalId ?? 'a caller this daemon did not name',
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
      authenticate(invocation, scope, PROJECT_TRIGGER_OPERATIONS.has(descriptor.id));
      try { return await handler(invocation, readInvocationParams(invocation)); } catch (error) { translateOperation(error); }
    }, { replace: true });
  }
}
