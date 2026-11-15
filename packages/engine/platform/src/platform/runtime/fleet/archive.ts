/**
 * Fleet archive, moves FINISHED process subtrees out of the live fleet view
 * into a session-scoped archive, without touching the source managers.
 *
 * The registry derives nodes live from its sources (AgentManager, the
 * contract runner, …), which keep finished records for the life of the session,
 * so terminal agents/swarms otherwise accumulate in the fleet view forever.
 * `withFleetArchive` wraps a ProcessRegistry: `query()`/`subscribe()` hide
 * archived subtrees, `listArchived()` exposes them for a dedicated archive
 * view (nodes stay fully inspectable, transcripts, usage, cost all still
 * resolve through the same sources). Archiving is per-runtime (session)
 * state, mirroring the sources' own lifetime.
 *
 * Only subtrees that are ENTIRELY terminal (done / failed / killed /
 * interrupted) can be archived, a finished member of a still-running swarm
 * stays visible with its parent.
 */
import type { FleetSnapshot, ProcessNode, ProcessRegistry } from './types.js';
import { TERMINAL_PROCESS_STATES } from './terminal-states.js';

const ARCHIVE_TERMINAL_STATES = TERMINAL_PROCESS_STATES;

export interface FleetArchiveResult {
  readonly archived: boolean;
  /** Number of nodes archived (root + descendants). 0 when refused. */
  readonly count: number;
  /** Honest refusal reason when `archived` is false. */
  readonly reason?: string;
}

export interface FleetArchiveView {
  /**
   * The wrapped registry, with nothing hidden. Observers that diff the fleet over time
   * (the emit bridge) attach here: archiving hides a node from the view, it must not
   * read as that node ending, and unarchiving must not read as a new one starting.
   */
  readonly unfiltered: ProcessRegistry;
  /** Archive one finished subtree by root node id. Honest refusal for missing or still-running subtrees. */
  archive(id: string): FleetArchiveResult;
  /** Return an archived subtree to the live view. Returns the number of nodes unarchived. */
  unarchive(id: string): number;
  /** Archive every root subtree that is entirely terminal. Returns the number of nodes archived. */
  archiveFinished(): number;
  /** Snapshot of archived nodes only (same shape as query(), still live-derived from the sources). */
  listArchived(): FleetSnapshot;
  /** Number of currently archived nodes. */
  archivedCount(): number;
}

export type ArchivableProcessRegistry = ProcessRegistry & FleetArchiveView;

function collectSubtreeIds(rootId: string, nodes: readonly ProcessNode[]): string[] {
  const childrenByParent = new Map<string, ProcessNode[]>();
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  const ids: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue; // defensive: never loop on a malformed parent cycle
    seen.add(id);
    ids.push(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child.id);
  }
  return ids;
}

/** Wrap a ProcessRegistry with session-scoped archive semantics. */
export function withFleetArchive(registry: ProcessRegistry): ArchivableProcessRegistry {
  const archivedIds = new Set<string>();
  const listeners = new Set<(snapshot: FleetSnapshot) => void>();
  let underlyingUnsub: (() => void) | null = null;

  const filterSnapshot = (snapshot: FleetSnapshot): FleetSnapshot => ({
    capturedAt: snapshot.capturedAt,
    nodes: snapshot.nodes.filter((node) => !archivedIds.has(node.id)),
  });

  // Forget archived ids the sources no longer hold, so the count is honest and
  // an id the source reuses later is not born hidden. Only a full snapshot may
  // prune: a filtered query omits nodes that still exist.
  const prune = (full: FleetSnapshot): void => {
    if (archivedIds.size === 0) return;
    const present = new Set(full.nodes.map((node) => node.id));
    for (const id of archivedIds) if (!present.has(id)) archivedIds.delete(id);
  };

  const notifyAll = (source = registry.query()): void => {
    prune(source);
    const snapshot = filterSnapshot(source);
    for (const listener of listeners) listener(snapshot);
  };

  const archiveSubtree = (rootId: string, nodes: readonly ProcessNode[]): FleetArchiveResult => {
    const root = nodes.find((node) => node.id === rootId);
    if (!root) return { archived: false, count: 0, reason: `node ${rootId} not found` };
    const subtreeIds = collectSubtreeIds(rootId, nodes);
    const subtreeNodes = nodes.filter((node) => subtreeIds.includes(node.id));
    const live = subtreeNodes.filter((node) => !ARCHIVE_TERMINAL_STATES.has(node.state));
    if (live.length > 0) {
      return {
        archived: false,
        count: 0,
        reason: `${live.length} node(s) in the subtree are still active (${live[0]!.state}), only finished subtrees can be archived`,
      };
    }
    for (const id of subtreeIds) archivedIds.add(id);
    return { archived: true, count: subtreeIds.length };
  };

  return {
    ...registry,
    unfiltered: registry,

    query(filter) {
      return filterSnapshot(registry.query(filter));
    },

    subscribe(listener) {
      listeners.add(listener);
      // One shared underlying subscription fans filtered snapshots out to
      // every wrapper listener; archive/unarchive mutations notify directly.
      underlyingUnsub ??= registry.subscribe(snapshot => { notifyAll(snapshot); });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && underlyingUnsub) {
          underlyingUnsub();
          underlyingUnsub = null;
        }
      };
    },

    archive(id) {
      const result = archiveSubtree(id, registry.query().nodes);
      if (result.archived) notifyAll();
      return result;
    },

    unarchive(id) {
      // The archived set already contains the whole subtree; release the ids
      // recorded under this root (recompute from current nodes, then fall
      // back to the bare id for nodes whose descendants have since vanished).
      const subtreeIds = collectSubtreeIds(id, registry.query().nodes);
      let released = 0;
      for (const subtreeId of subtreeIds) {
        if (archivedIds.delete(subtreeId)) released++;
      }
      if (released > 0) notifyAll();
      return released;
    },

    archiveFinished() {
      const nodes = registry.query().nodes;
      const present = new Set(nodes.map((node) => node.id));
      let archivedNodes = 0;
      for (const node of nodes) {
        if (archivedIds.has(node.id)) continue;
        const isRoot = node.parentId === undefined || !present.has(node.parentId);
        if (!isRoot || !ARCHIVE_TERMINAL_STATES.has(node.state)) continue;
        const result = archiveSubtree(node.id, nodes);
        if (result.archived) archivedNodes += result.count;
      }
      if (archivedNodes > 0) notifyAll();
      return archivedNodes;
    },

    listArchived() {
      const snapshot = registry.query();
      prune(snapshot);
      return {
        capturedAt: snapshot.capturedAt,
        nodes: snapshot.nodes.filter((node) => archivedIds.has(node.id)),
      };
    },

    archivedCount() {
      prune(registry.query());
      return archivedIds.size;
    },

    dispose() {
      listeners.clear();
      if (underlyingUnsub) {
        underlyingUnsub();
        underlyingUnsub = null;
      }
      registry.dispose();
    },
  };
}
