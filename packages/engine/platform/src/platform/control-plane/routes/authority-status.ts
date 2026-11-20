/**
 * routes/authority-status.ts
 *
 * Handler for authority.status: the record's head and per-kind counts, read
 * from the view the record file already keeps (one lstat, no read unless the
 * file moved). The group layer supplies which members are behind.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { AUTHORITY_KINDS } from '../../cluster/authority-record.js';
import type { AuthorityRecordFile } from '../../cluster/authority-record-file.js';

export interface AuthorityStatusPeers {
  /** Members whose gossiped head differs from this node's, and whether one is ahead. */
  divergence(): { readonly behindOn: readonly string[]; readonly behind: boolean };
}

export function createAuthorityStatusHandler(file: Pick<AuthorityRecordFile, 'view' | 'nodeId'>, peers?: () => AuthorityStatusPeers | null): GatewayMethodHandler {
  return async () => {
    const view = file.view();
    const divergence = peers?.()?.divergence() ?? { behindOn: [], behind: false };
    if (!view) {
      return { readable: false, nodeId: file.nodeId, groupId: '', revision: 0, digest: '', revocationFloor: 0, kinds: [], behindOn: [...divergence.behindOn], behind: divergence.behind, userConflicts: [] };
    }
    const kinds = AUTHORITY_KINDS.map((kind) => {
      const entries = view.list(kind);
      const revoked = entries.filter((entry) => view.isRevoked(`${kind}:${entry.id}`)).length;
      return { kind, live: entries.length - revoked, revoked };
    }).filter((count) => count.live + count.revoked > 0);
    return {
      readable: true,
      nodeId: file.nodeId,
      groupId: view.record.scope.groupId ?? '',
      revision: view.head.revision,
      digest: view.head.digest,
      revocationFloor: view.record.revocationFloor,
      kinds,
      behindOn: [...divergence.behindOn],
      behind: divergence.behind,
      // Owner decision D2: a username made separately on two machines is reported, never overwritten.
      userConflicts: view.userConflicts().map((conflict) => ({
        username: conflict.username,
        accounts: conflict.incarnations.length,
        madeOn: [...new Set(conflict.incarnations.map((incarnation) => incarnation.origin))].sort(),
      })),
    };
  };
}

/** Attach the authority.status handler. Missing descriptor is a silent no-op. */
export function registerAuthorityStatusGatewayMethods(catalog: GatewayMethodCatalog, file: Pick<AuthorityRecordFile, 'view' | 'nodeId'>, peers?: () => AuthorityStatusPeers | null): void {
  const descriptor = catalog.get('authority.status');
  if (descriptor) catalog.register(descriptor, createAuthorityStatusHandler(file, peers), { replace: true });
}
