/**
 * fleet-control.ts, the wire verbs that end, pause and resume a fleet node.
 *
 * The fleet snapshot tells every client which nodes are killable, interruptible
 * and resumable (`node.capabilities`), and the process registry already holds the
 * per-kind control for each (`kill`, `interrupt`, `resume`, runtime/fleet/registry.ts).
 * These verbs are thin routes over those functions so a client away from the
 * terminal (the web UI, a phone over the relay, an agent on the operator API)
 * can act on what the snapshot offers. The snapshot's capabilities stay the one
 * source for which controls a client draws; a node that does not offer an action
 * is answered with a refusal that says so.
 *
 * `write:fleet` is not a read scope, so a relayed call needs the passkey step-up
 * like every other mutation; `access: 'admin'` keeps them owner-scoped.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodDescriptor, GatewayMethodHandler } from '../method-catalog-shared.js';
import { BOOLEAN_SCHEMA, STRING_SCHEMA, arraySchema, methodDescriptor, objectSchema } from '../method-catalog-shared.js';
import type { ProcessNode, ProcessRegistry } from '../../runtime/fleet/types.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

export type FleetControlAction = 'stop' | 'interrupt' | 'resume';

const FLEET_CONTROL_INPUT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  cascade: BOOLEAN_SCHEMA,
}, ['id']);

const FLEET_CONTROL_OUTPUT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  action: STRING_SCHEMA,
  affected: arraySchema(STRING_SCHEMA),
}, ['id', 'action', 'affected']);

export const builtinGatewayFleetControlMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'fleet.stop',
    title: 'Stop a Fleet Node',
    description: 'Hard-stop one fleet node through its owning manager (agent cancel, background process stop, watcher stop, workflow cancel, trigger or schedule remove, contract cancel, hosted ACP agent stop). `cascade: true` stops its descendants first. Answers the node ids actually acted on. A node whose capabilities do not include killable is refused with FLEET_ACTION_UNAVAILABLE; an unknown id with FLEET_NODE_NOT_FOUND.',
    category: 'fleet',
    scopes: ['write:fleet'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: FLEET_CONTROL_INPUT_SCHEMA,
    outputSchema: FLEET_CONTROL_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'fleet.interrupt',
    title: 'Interrupt a Fleet Node',
    description: 'Gracefully interrupt one fleet node: an agent ends its current turn, a trigger or schedule is paused. Answers the node ids acted on. A node whose capabilities do not include interruptible is refused with FLEET_ACTION_UNAVAILABLE; an unknown id with FLEET_NODE_NOT_FOUND.',
    category: 'fleet',
    scopes: ['write:fleet'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: FLEET_CONTROL_INPUT_SCHEMA,
    outputSchema: FLEET_CONTROL_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'fleet.resume',
    title: 'Resume a Fleet Node',
    description: 'Re-arm one paused trigger or schedule (for a trigger with an open breaker, this is the reset the breaker waits for). Answers the node ids acted on. A node whose capabilities do not include resumable is refused with FLEET_ACTION_UNAVAILABLE; an unknown id with FLEET_NODE_NOT_FOUND.',
    category: 'fleet',
    scopes: ['write:fleet'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: FLEET_CONTROL_INPUT_SCHEMA,
    outputSchema: FLEET_CONTROL_OUTPUT_SCHEMA,
  }),
];

export type FleetControlRegistry = Pick<ProcessRegistry, 'getNode' | 'kill' | 'interrupt' | 'resume'>;

const CAPABILITY_FOR: Readonly<Record<FleetControlAction, keyof ProcessNode['capabilities']>> = {
  stop: 'killable',
  interrupt: 'interruptible',
  resume: 'resumable',
};

const VERB_FOR: Readonly<Record<FleetControlAction, string>> = { stop: 'stopped', interrupt: 'interrupted', resume: 'resumed' };

function readTarget(registry: FleetControlRegistry, invocation: Parameters<GatewayMethodHandler>[0], action: FleetControlAction): { id: string; node: ProcessNode; cascade: boolean } {
  const params = readInvocationParams(invocation);
  const id = typeof params.id === 'string' ? params.id.trim() : '';
  if (!id) throw new GatewayVerbError('id is required', 'INVALID_ARGUMENT', 400, 'id');
  const node = registry.getNode(id);
  if (!node) {
    throw new GatewayVerbError(`No fleet node ${id} on this daemon. List the fleet with fleet.snapshot and use a current id.`, 'FLEET_NODE_NOT_FOUND', 404);
  }
  if (!node.capabilities[CAPABILITY_FOR[action]]) {
    throw new GatewayVerbError(`Fleet node ${id} (${node.kind}, ${node.state}) cannot be ${VERB_FOR[action]} now; its capabilities in fleet.snapshot list what it offers.`, 'FLEET_ACTION_UNAVAILABLE', 409);
  }
  return { id, node, cascade: params.cascade === true };
}

function refusedByOwner(id: string, action: FleetControlAction): never {
  throw new GatewayVerbError(`The manager that owns fleet node ${id} did not accept the request; nothing was ${VERB_FOR[action]}. Read fleet.snapshot for its current state.`, 'FLEET_ACTION_REFUSED', 409);
}

export function createFleetControlHandler(registry: FleetControlRegistry, action: FleetControlAction): GatewayMethodHandler {
  return (invocation) => {
    const { id, cascade } = readTarget(registry, invocation, action);
    if (action === 'stop') {
      const affected = registry.kill(id, cascade ? { cascade: true } : undefined);
      if (affected.length === 0) refusedByOwner(id, action);
      return { id, action, affected: [...affected] };
    }
    const accepted = action === 'interrupt' ? registry.interrupt(id) : registry.resume(id);
    if (!accepted) refusedByOwner(id, action);
    return { id, action, affected: [id] };
  };
}

/** Attach the three handlers to descriptors the catalog already lists. */
export function registerFleetControlGatewayMethods(catalog: GatewayMethodCatalog, registry: FleetControlRegistry): void {
  for (const [id, action] of [['fleet.stop', 'stop'], ['fleet.interrupt', 'interrupt'], ['fleet.resume', 'resume']] as const) {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, createFleetControlHandler(registry, action), { replace: true });
  }
}
