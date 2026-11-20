/**
 * roles.ts, work the group runs on exactly ONE machine at a time.
 *
 * Some work is the same on every machine by construction: the payments
 * capability (one budget, one card, one place a purchase can start), the
 * scheduled check-in (its job is made from the replicated `checkin.*`
 * settings on every machine), the occasion reminders (made from the
 * replicated `occasions.*` settings and the owner's profile) and the
 * schedules, reminders and url watchers kept on the group's record
 * (automation/group-jobs.ts). Run on every machine, each of them happens once
 * per machine.
 *
 * A role is an ordinary surface in the existing per-surface election, so it
 * is decided, handed over on a clean stop, and taken over after a crash
 * exactly as an inbox is. Its gate consumes nothing: holding the role IS the
 * permission, and the code that does the work asks `holdsRole` at the moment
 * it would act. A machine that does not hold a role names the one that does
 * (`roleHolder`), so a caller can be referred there.
 *
 * With clustering off, or a machine coordinating with nobody, every role is
 * held here: there is nobody else to run it.
 */
import { providerSurface, type ClusterSurfaceKey } from './surface-id.js';
import type { ClusterConsumerGate } from './types.js';

/** The roles the group elects one machine for. */
export type ClusterRoleName = 'payments' | 'checkin' | 'occasions' | 'automation';

/** Every role, for naming a held one in `cluster status`. */
export const CLUSTER_ROLE_NAMES: readonly ClusterRoleName[] = Object.freeze(['payments', 'checkin', 'occasions', 'automation']);

/** The election surface for one role. The same on every machine, so they contest the same election. */
export function clusterRoleSurface(role: ClusterRoleName): ClusterSurfaceKey {
  return providerSurface('custom', `role:${role}`);
}

/**
 * The gate a machine registers to contest a role. `onGained` runs when this
 * machine takes the role, before the election reports it as consuming, for
 * work that must happen once on the new holder (payments recovers checkouts
 * interrupted on the previous one; the automation role arms the timers of the
 * group's schedules). Losing the role needs no work from a worker that asks
 * `holdsRole` before every act; `onLost` runs, while the role is still held,
 * for one that armed something to drop (the automation role's timers).
 */
export function clusterRoleGate(role: ClusterRoleName, onGained?: () => Promise<void>, onLost?: () => Promise<void>): ClusterConsumerGate {
  return {
    id: `role:${role}`,
    surface: clusterRoleSurface(role),
    start: async () => { await onGained?.(); },
    stop: async () => { await onLost?.(); },
  };
}

/** What the role holder reads from the coordinator. */
export interface ClusterRoleSource {
  holdsRole(role: ClusterRoleName): boolean;
  roleHolder(role: ClusterRoleName): string | null;
  /** False when clustering is off: every role is then held here and nothing is shared. */
  readonly enabled?: boolean | undefined;
}

/**
 * The runtime's view of which roles this machine holds.
 *
 * Made with the runtime graph, before the daemon has built its coordinator,
 * and bound to that coordinator when it is: the work that asks (the check-in,
 * the occasions sweep) is composed before the coordinator exists. Unbound, as
 * in a process that runs no daemon, every role is held here.
 */
export class ClusterRoles {
  private source: ClusterRoleSource | null = null;
  private readonly listeners = new Map<ClusterRoleName, Set<(held: boolean) => void>>();

  bind(source: ClusterRoleSource): void {
    this.source = source;
  }

  /**
   * True when this machine coordinates with others (bound to a coordinator
   * with clustering on). Work kept on the group's record is shared only then;
   * otherwise it stays this machine's own and costs nothing more.
   */
  coordinated(): boolean {
    return this.source !== null && this.source.enabled !== false;
  }

  /** Hear when this machine takes (`true`) or gives up (`false`) a role. */
  onRoleChange(role: ClusterRoleName, listener: (held: boolean) => void): () => void {
    const set = this.listeners.get(role) ?? new Set();
    set.add(listener);
    this.listeners.set(role, set);
    return () => { set.delete(listener); };
  }

  /** Called by the role's gate when the election gives this machine the role or takes it away. */
  announce(role: ClusterRoleName, held: boolean): void {
    for (const listener of this.listeners.get(role) ?? []) {
      try { listener(held); } catch { /* one listener cannot stop the others */ }
    }
  }

  holds(role: ClusterRoleName): boolean {
    return this.source ? this.source.holdsRole(role) : true;
  }

  holder(role: ClusterRoleName): string | null {
    return this.source?.roleHolder(role) ?? null;
  }
}
