/**
 * routes/register-fleet-checkpoints-search.ts
 *
 * Single composite entry point for the fleet.*, contracts.*, checkpoints.*, sessions.search
 * verb-registration calls (see CHANGELOG 1.0.0), so ../../runtime/services.ts,
 * already at its line-cap ceiling, only needs one import and one call
 * instead of three of each. See routes/fleet.ts, routes/checkpoints.ts, and
 * routes/session-search.ts for what each registration actually does and why
 * it's a catalog.register(descriptor, handler) call rather than a daemon-api
 * REST route or a router.ts change.
 *
 * Call once, at RuntimeServices construction time, after processRegistry,
 * workspaceCheckpointManager, and sessionBroker all exist (processRegistry
 * is constructed last of the three, so the call site is right after it).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { registerFleetGatewayMethods, type FleetQueryOnlyRegistry, type FleetSteerApprovals, type FleetSteerCapableRegistry, type FleetAttemptsController } from './fleet.js';
import { registerFleetControlGatewayMethods, type FleetControlRegistry } from './fleet-control.js';
import { registerCheckpointGatewayMethods, registerSessionCheckpointNotice, type CheckpointsGatewayManager, type CheckpointsEventSink, type SessionCheckpointNoticeBroker } from './checkpoints.js';
import { registerSessionSearchGatewayMethod, type SessionOwnersLookup, type SessionSearchBroker } from './session-search.js';
import { createEventEnvelope } from '../../runtime/events/index.js';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../../runtime/events/index.js';
import type { WorkspaceEvent } from '../../../events/workspace.js';
import type { ContractOperatorService } from '../../contract/operator-service.js';
import { registerContractGatewayMethods } from './contracts.js';

export interface FleetCheckpointsSearchGatewayDeps {
  readonly processRegistry: FleetQueryOnlyRegistry & FleetSteerCapableRegistry & FleetControlRegistry;
  readonly workspaceCheckpointManager: CheckpointsGatewayManager;
  /** Searched by sessions.search; asked by sessions.checkpoints.changed whether a session is known. */
  readonly sessionBroker: SessionSearchBroker & SessionCheckpointNoticeBroker;
  /** The owners of a hosted session, so sessions.search lists a hosted row only to a caller that may read it. */
  readonly sessionOwners?: SessionOwnersLookup | undefined;
  /**
   * Optional runtime event bus. When present, checkpoints.revertHunk's receipt
   * (HUNK_REVERTED) fans out on the workspace domain; absent → the verb still
   * works, it just emits no event (graceful degrade, like every runtimeBus-gated
   * source in register-gateway-verb-groups).
   */
  readonly runtimeBus?: Pick<RuntimeEventBus, 'emit'> | undefined;
  /**
   * Optional best-of-N controller (the orchestration engine's held-merge
   * methods). When present, the fleet.attempts.* verbs are registered; absent →
   * they stay cataloged-but-unhandled (graceful degrade for embeds with no
   * orchestration engine).
   */
  readonly attemptsController?: FleetAttemptsController | undefined;
  /**
   * The contracts operator surface. When present, the contracts.* verbs are
   * registered; absent, they stay cataloged-but-unhandled, like the attempts verbs.
   */
  readonly contractOperator?: ContractOperatorService | undefined;
  /**
   * The approval broker `fleet.observed.steer` asks the owner through. Absent,
   * a steer into a foreign agent is refused unsent.
   */
  readonly approvalRaise?: FleetSteerApprovals | undefined;
}

export function registerFleetCheckpointsSearchGatewayMethods(catalog: GatewayMethodCatalog, deps: FleetCheckpointsSearchGatewayDeps): void {
  registerFleetGatewayMethods(catalog, deps.processRegistry, deps.attemptsController, deps.approvalRaise);
  registerFleetControlGatewayMethods(catalog, deps.processRegistry);
  if (deps.contractOperator) registerContractGatewayMethods(catalog, deps.contractOperator);
  const bus = deps.runtimeBus;
  const checkpointsEmit: CheckpointsEventSink | undefined = bus
    ? (event: WorkspaceEvent, sessionId: string): void => {
      const envelope = createEventEnvelope(event.type, event, { sessionId, source: 'checkpoints-revert-hunk' });
      bus.emit<'workspace'>('workspace', envelope as RuntimeEventEnvelope<WorkspaceEvent['type'], WorkspaceEvent>);
    }
    : undefined;
  registerCheckpointGatewayMethods(catalog, deps.workspaceCheckpointManager, checkpointsEmit);
  registerSessionCheckpointNotice(catalog, deps.sessionBroker);
  registerSessionSearchGatewayMethod(catalog, deps.sessionBroker, deps.sessionOwners);
}
