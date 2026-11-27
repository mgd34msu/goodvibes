/**
 * routes/acp.ts
 *
 * Handlers for the acp.* verbs over the AcpHostService: read-only discovery of
 * installed third-party coding agents, and the one-act spawn that hosts one as
 * a daemon session / fleet row. Same registration pattern as push/pairing.
 */
import { existsSync, statSync } from 'node:fs';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { AcpFleetCapacityError, type AcpHostService, type DiscoveredAcpAgent } from '../../acp/host.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import type { TurnInputParty } from '../../security/turn-input-party.js';
import { isTheUser } from '../../daemon/method-owner-decision.js';

export interface AcpGatewayDeps {
  readonly host: Pick<AcpHostService, 'spawnAgent' | 'list'>;
  /** Discovery seam (the real discoverAcpAgents in production; injectable for tests). */
  readonly discover: () => DiscoveredAcpAgent[];
}

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('Sign in first: connecting an outside coding agent needs a signed-in user or a paired device', 'UNAUTHENTICATED', 401);
  }
}

/**
 * Whose input an outside coding agent acts on, from the caller the transport established (never from the body): the
 * user's when any credential of the user started it (not a model acting for them), anyone else's otherwise: its asks
 * are then decided as someone else's turn, which runs reads only (security/turn-input-party.ts).
 */
function startedBy(invocation: GatewayMethodInvocation): TurnInputParty {
  const actor = invocation.context.actor;
  if (isTheUser(actor)) return { party: 'owner' };
  return { party: 'other', who: actor ? `an outside coding agent started by ${actor.class} ${actor.id}` : 'an outside coding agent started by a caller with no identity' };
}

function createAgentsListHandler(deps: AcpGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    return { agents: deps.discover() };
  };
}

function createSessionsCreateHandler(deps: AcpGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const agentId = requireStringValue(params.agentId, 'agentId');
    const cwd = requireStringValue(params.cwd, 'cwd');
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new GatewayVerbError(`cwd is not an existing directory: ${cwd}`, 'INVALID_ARGUMENT', 400, 'cwd');
    }
    const agent = deps.discover().find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new GatewayVerbError(`No installed agent with id "${agentId}", see acp.agents.list`, 'AGENT_NOT_FOUND', 404);
    }
    const hosted = await deps.host.spawnAgent({
      agent,
      cwd,
      title: typeof params.title === 'string' && params.title.trim().length > 0 ? params.title : undefined,
      prompt: typeof params.prompt === 'string' && params.prompt.trim().length > 0 ? params.prompt : undefined,
      inputParty: startedBy(invocation),
    }).catch((error: unknown) => {
      if (error instanceof AcpFleetCapacityError) throw new GatewayVerbError(error.message, 'FLEET_CAPACITY', 409);
      throw error;
    });
    // A handshake failure is an HONEST OUTCOME (structured error on the
    // record), not a transport throw, the surface renders which binary
    // failed at which stage.
    return { hosted, started: hosted.state !== 'failed' };
  };
}

const ACP_HANDLER_FACTORIES: Readonly<Record<string, (deps: AcpGatewayDeps) => GatewayMethodHandler>> = {
  'acp.agents.list': createAgentsListHandler,
  'acp.sessions.create': createSessionsCreateHandler,
};

/** Attach the acp.* handlers to their cataloged descriptors. Missing descriptors are silent no-ops. */
export function registerAcpGatewayMethods(catalog: GatewayMethodCatalog, deps: AcpGatewayDeps): void {
  for (const [methodId, factory] of Object.entries(ACP_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(deps), { replace: true });
    }
  }
}
