/**
 * surface-registry.ts, which inbound surfaces THIS node can actually serve.
 *
 * The registry is the answer to the question the ruling turns on: a node must
 * never win an election for something it cannot serve. Winning a surface with
 * no credential for it, or with that surface switched off locally, starves the
 * node that could have served it, the loser stands down, the winner reads
 * nothing, and the topic goes unread by anybody on the network.
 *
 * So membership is not a configuration list. A surface is in here only because
 * a working consumer for it was registered: the composition root resolved the
 * credential, found the surface enabled, built something that can start, and
 * handed it over. A node with no inbound surfaces registers nothing here,
 * joins no elections, and claims nothing.
 *
 * (Not to be confused with `channels/surface-registry.ts`, which is about
 * message routing between channel surfaces. This one is only about who on the
 * LAN is allowed to contest which inbound consumer.)
 */
import { ClusterConsumerStopError, OwnedClusterDrainError } from './owned-drain-error.js';
import { surfaceIdFor, surfaceLabel, type ClusterSurfaceKey } from './surface-id.js';
import type { ClusterConsumerGate, ClusterConsumerStartContext, ClusterLogger } from './types.js';

/** One servable surface and every consumer registered against it. */
export interface RegisteredClusterSurface {
  readonly surfaceId: string;
  readonly key: ClusterSurfaceKey;
  /** Digest-derived label, safe for logs. */
  readonly label: string;
  readonly gates: readonly ClusterConsumerGate[];
}

interface MutableSurface {
  readonly surfaceId: string;
  readonly key: ClusterSurfaceKey;
  readonly label: string;
  readonly gates: ClusterConsumerGate[];
}

export class ClusterSurfaceRegistry {
  private readonly ownedGates = new WeakSet<ClusterConsumerGate>();
  private readonly surfaces = new Map<string, MutableSurface>();
  /**
   * Consumers that are running. Starting a surface skips these, so asking
   * again after a sibling was registered, or after a partial failure, starts
   * only what is not already reading rather than a second copy of it.
   */
  private readonly startedGates = new WeakSet<ClusterConsumerGate>();
  /**
   * Surfaces whose last consumer has been unregistered but whose election has
   * not finished standing down yet.
   *
   * They must stay reachable for exactly one more `stopSurface`. Leaving with
   * a RESIGN means asserting to the whole network that this node has stopped
   * reading, and if the gate were already unreachable there would be nothing
   * to stop, so the assertion would be false and the successor would start
   * against a consumer still running. They are dropped by `forget` once the
   * election has actually stopped.
   */
  private readonly retiring = new Map<string, MutableSurface>();
  private readonly listeners = new Set<(surfaceId: string) => void>();

  constructor(private readonly logger: ClusterLogger) {}

  /**
   * Add a consumer. Returns an unregister function.
   *
   * Several gates may share one surface, the ntfy stream and a diagnostic
   * tap on the same topic, say. They start in registration order and stop in
   * the reverse, so a consumer another depends on is up first and down last.
   */
  register(gate: ClusterConsumerGate): () => void {
    const withdraw = this.registerConsumer(gate);
    return () => { void withdraw().catch(() => {}); };
  }

  /** Removal is immediate; completion includes the exact listener retirement. */
  registerOwned(gate: ClusterConsumerGate): () => Promise<void> {
    this.ownedGates.add(gate);
    return this.registerConsumer(gate);
  }

  private registerConsumer(gate: ClusterConsumerGate): () => Promise<void> {
    const surfaceId = surfaceIdFor(gate.surface);
    // A surface re-registered before its stand-down completed is servable
    // again. Its retiring consumers stay reachable until that stand-down has
    // stopped them (see stopSurface); `forget` drops them afterwards.
    let surface = this.surfaces.get(surfaceId);
    if (!surface) {
      surface = {
        surfaceId,
        key: gate.surface,
        label: surfaceLabel(gate.surface),
        gates: [],
      };
      this.surfaces.set(surfaceId, surface);
    }
    surface.gates.push(gate);
    void this.notify(surfaceId);
    return async () => {
      const current = this.surfaces.get(surfaceId);
      if (!current) return;
      const index = current.gates.indexOf(gate);
      if (index < 0) return;
      if (current.gates.length > 1) {
        current.gates.splice(index, 1);
        await this.notify(surfaceId);
        return;
      }
      // The LAST consumer for this surface. It leaves the servable set and,
      // through the listener, leaves the election, because holding a seat
      // with nothing behind it is the starvation case this file exists to
      // prevent. It moves to `retiring` with its gate STILL ATTACHED: the
      // ordered stand-down that follows has to actually stop the consumer
      // before it broadcasts a RESIGN saying it did.
      this.surfaces.delete(surfaceId);
      const earlier = this.retiring.get(surfaceId);
      this.retiring.set(surfaceId, earlier ? { ...current, gates: [...earlier.gates, ...current.gates] } : current);
      await this.notify(surfaceId);
    };
  }

  /** Called whenever the servable set changes, with the surface that moved. */
  onChange(listener: (surfaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True when this node has a working consumer for the surface right now. */
  canServe(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  get(surfaceId: string): RegisteredClusterSurface | undefined {
    return this.surfaces.get(surfaceId);
  }

  /** Every servable surface, in a stable order. */
  list(): RegisteredClusterSurface[] {
    return [...this.surfaces.values()].sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1));
  }

  get size(): number {
    return this.surfaces.size;
  }

  /** True when a registered consumer for the surface has not been started yet. */
  hasUnstartedConsumers(surfaceId: string): boolean {
    const surface = this.surfaces.get(surfaceId);
    return surface !== undefined && surface.gates.some((gate) => !this.startedGates.has(gate));
  }

  /**
   * Start every consumer for one surface that is not already running, in
   * registration order, and say how many started and how many failed, so a
   * holder whose consumers all failed does not report itself as reading the
   * surface.
   */
  async startSurface(
    surfaceId: string,
    context: ClusterConsumerStartContext,
  ): Promise<{ readonly started: number; readonly failed: number }> {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return { started: 0, failed: 0 };
    let started = 0;
    let failed = 0;
    for (const gate of [...surface.gates]) {
      if (this.startedGates.has(gate)) continue;
      try {
        await gate.start(context);
        this.startedGates.add(gate);
        started += 1;
      } catch (error) {
        failed += 1;
        // One consumer failing must not strand the others, and must not leave
        // the node believing it is not responsible when it is.
        this.logger.error('cluster: an inbound consumer failed to start on taking its surface', {
          surface: surface.label,
          consumer: gate.id,
          reason: context.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { started, failed };
  }

  /**
   * Stop every consumer for one surface, newest first, and do not resolve
   * until they have all settled. The RESIGN that follows this is a claim that
   * consumption has genuinely ceased, so it must not be sent a moment early.
   *
   * A surface re-registered while its old election was still standing down
   * has both: the retiring consumers that election started, and the new ones.
   * Both are stopped, because stopping only the new ones would let the RESIGN
   * go out while the old consumer still reads.
   */
  async stopSurface(surfaceId: string, reason: string): Promise<void> {
    const current = this.surfaces.get(surfaceId);
    const retiring = this.retiring.get(surfaceId);
    const surface = current ?? retiring;
    if (!surface) return;
    const gates = [...new Set([...(retiring?.gates ?? []), ...(current?.gates ?? [])])];
    let ownedFailure = false;
    let legacyFailure = false;
    for (const gate of gates.reverse()) {
      // Whatever the outcome, the next start asks this consumer afresh: a stop
      // that failed part-way may have left nothing running, and a consumer that
      // is still up is for its own stop() to refuse a second start.
      this.startedGates.delete(gate);
      try {
        await gate.stop(reason);
      } catch (error) {
        if (this.ownedGates.has(gate)) ownedFailure = true;
        else legacyFailure = true;
        this.logger.error('cluster: an inbound consumer did not stop cleanly', {
          surface: surface.label,
          consumer: gate.id,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (ownedFailure) throw new OwnedClusterDrainError();
    if (legacyFailure) throw new ClusterConsumerStopError();
  }

  /** Drop a retired surface once its election has finished standing down. */
  forget(surfaceId: string): void {
    this.retiring.delete(surfaceId);
  }

  private async notify(surfaceId: string): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => {
      try {
        await listener(surfaceId);
      } catch (error) {
        this.logger.error('cluster: a surface registry listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }
}
