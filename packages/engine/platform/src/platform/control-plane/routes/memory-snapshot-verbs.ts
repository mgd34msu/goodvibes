/**
 * routes/memory-snapshot-verbs.ts
 *
 * memory.snapshots.list and memory.snapshots.restore over the daemon's
 * canonical MemoryRegistry, for the web UI and an attached terminal app. The
 * restore is the owner's act: the host-handler confirmation gate admits it only
 * with `confirm: true` on an explicit request the transport established as the
 * owner's (a login session, a paired device, or an app on this machine); an
 * agent's call is refused before the handler runs.
 *
 * Registered from register-gateway-verb-groups.ts beside the other memory
 * verbs; a missing descriptor is a silent no-op, as for those.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { HandlerError, registerCatalogHandler } from '../host-handlers.js';
import type { MemoryRegistry } from '../../state/memory-registry.js';

/** What the two verbs read from the memory owner. */
export type MemorySnapshotSource = Pick<MemoryRegistry, 'listSnapshots' | 'restoreSnapshot'>;

export function registerMemorySnapshotGatewayMethods(catalog: GatewayMethodCatalog, source: MemorySnapshotSource): void {
  if (catalog.get('memory.snapshots.list')) {
    registerCatalogHandler(catalog, 'memory.snapshots.list', async () => ({ snapshots: source.listSnapshots() }));
  }
  if (catalog.get('memory.snapshots.restore')) {
    registerCatalogHandler<{ readonly snapshot?: unknown }, unknown>(catalog, 'memory.snapshots.restore', async ({ body, context }) => {
      const snapshot = typeof body?.snapshot === 'string' ? body.snapshot.trim() : '';
      if (!snapshot) {
        throw new HandlerError('Name the copy to restore (`snapshot`: a name from memory.snapshots.list, or latest); nothing was changed.', 'INVALID_ARGUMENT', 400, 'snapshot');
      }
      return source.restoreSnapshot(snapshot, context.signal ? { signal: context.signal } : undefined);
    }, { confirm: true });
  }
}
