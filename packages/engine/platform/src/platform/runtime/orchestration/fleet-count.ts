/**
 * fleet-count.ts, the RESPONSIBILITY-counting seam for the one fleet ceiling
 * (`fleet.maxSize`).
 *
 * One fleet, one cap: native spawned agents and their queued wakes, sibling
 * execution graphs, ACP-hosted sessions, and elastic fixers (which spawn
 * through the same native AgentManager) all count against the same ceiling,
 * through one count: `AgentManager.fleetCount()`. Spawn, batch spawn, wake,
 * the elastic pool and a hosted ACP session all read it. The cap counts RESPONSIBILITY, not visibility (owner
 * rider, 2026-07-13): this interface accepts ONLY owned sources, agents the
 * daemon spawned or hosts. Externally-launched agents observed on the host
 * have no seam here BY CONSTRUCTION; when the observed-row capability ships
 * (the following surface round), its rows are structurally unable to enter
 * this count.
 */
import { FLEET_MAX_SIZE_KEY } from './spawn-policy.js';
import { fleetConfigDefaults } from '../../config/schema-domain-fleet.js';
import type { FleetCapacityProbe } from '../../orchestration/elastic-pool.js';

/** The OWNED agent sources, and only those, that count against fleet.maxSize. */
export interface OwnedAgentSources {
  /** Active (pending/running) agents the daemon's AgentManager spawned, including elastic fixers, which spawn through it. */
  countNativeActive(): number;
  /** Live ACP-hosted agent sessions this daemon hosts. Absent when no ACP host is composed. */
  countAcpHosted?: (() => number) | undefined;
}

/** Agents the daemon is responsible for right now. */
export function countOwnedActiveAgents(sources: OwnedAgentSources): number {
  return sources.countNativeActive() + (sources.countAcpHosted?.() ?? 0);
}

/** Build the live fleet-capacity probe the elastic pool gates claims against. */
export function fleetCapacityProbeFrom(deps: {
  readonly readConfig: (key: string) => unknown;
  readonly sources: OwnedAgentSources;
}): FleetCapacityProbe {
  const raw = deps.readConfig(FLEET_MAX_SIZE_KEY);
  const maxSize = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? raw
    : fleetConfigDefaults.fleet.maxSize;
  return {
    active: countOwnedActiveAgents(deps.sources),
    maxSize,
    capKey: FLEET_MAX_SIZE_KEY,
  };
}

/** Runtime factory: the elastic pool's probe, over the same count every spawn admission reads. */
export function makeRuntimeFleetProbe(deps: {
  readonly readConfig: (key: string) => unknown;
  readonly fleet: { fleetCount(): number };
} | {
  readonly readConfig: (key: string) => unknown;
  /** A composition that has not moved to `fleet` yet: native agents by status plus hosted sessions. */
  readonly agentManager: { list(): ReadonlyArray<{ status: string }> };
  readonly acpHost: { list(): ReadonlyArray<unknown> };
}): () => FleetCapacityProbe {
  if ('fleet' in deps) {
    const fleet = deps.fleet;
    return () => fleetCapacityProbeFrom({ readConfig: deps.readConfig, sources: { countNativeActive: () => fleet.fleetCount() } });
  }
  return () => fleetCapacityProbeFrom({
    readConfig: deps.readConfig,
    sources: {
      countNativeActive: () => deps.agentManager.list().filter((agent) => agent.status === 'pending' || agent.status === 'running').length,
      countAcpHosted: () => deps.acpHost.list().length,
    },
  });
}

/**
 * Why one more owned agent would exceed fleet.maxSize, naming the key and the
 * full count, or undefined when it fits. For admissions outside the agent
 * manager (a hosted ACP session).
 */
export function fleetCeilingRefusal(readConfig: (key: string) => unknown, fleet: { fleetCount(): number }): string | undefined {
  const probe = fleetCapacityProbeFrom({ readConfig, sources: { countNativeActive: () => fleet.fleetCount() } });
  return probe.active >= probe.maxSize
    ? `agent capacity reached (${probe.active}/${probe.maxSize} agents this daemon runs or hosts), cap: ${probe.capKey}=${probe.maxSize}. Stop an agent or raise ${probe.capKey}.`
    : undefined;
}
