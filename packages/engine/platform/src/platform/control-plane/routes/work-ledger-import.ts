import { createNativeLegacyImportHost, NATIVE_IMPORT_SCOPES, type NativeLegacyImportDependencies } from '../../workflow/work-ledger/native-import.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { WORK_LEDGER_IMPORT_SCOPE, WORK_LEDGER_READ_SCOPE } from '../method-catalog-work-ledger.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { requireNativeOwner } from './native-owner.js';
import { LEGACY_IMPORT_MAX_BYTES, prepareLegacyWorkLedgerMigration, workLedgerCommandSchema } from '../../workflow/work-ledger/index.js';

/** Trusted selected-host composition only. No path, authority or actor from request data. */
export function registerWorkLedgerImportGatewayMethods(catalog: GatewayMethodCatalog, host: NativeLegacyImportDependencies): { close(): Promise<void> } {
  const native = createNativeLegacyImportHost(host);
  const attach = (id: string, handler: (invocation: GatewayMethodInvocation) => Promise<unknown>) => {
    const descriptor = catalog.get(id);
    if (!descriptor) throw new Error(`Missing legacy import descriptor: ${id}`);
    catalog.register(descriptor, handler, { replace: true });
  };
  const run = async (invocation: GatewayMethodInvocation, prepare: boolean): Promise<unknown> => {
    const context = invocation.context;
    const operationScope = prepare ? WORK_LEDGER_READ_SCOPE : WORK_LEDGER_IMPORT_SCOPE;
    if (!context.admin || !context.principalId || !context.scopes?.some(scope => scope === '*' || scope === operationScope)
      || !context.scopes?.some(scope => scope === '*' || scope === 'read:knowledge')
      || typeof invocation.isAuthorized !== 'function' || invocation.isAuthorized([operationScope, 'read:knowledge']) !== true) throw new GatewayVerbError(`Legacy import requires current admin authorization, ${operationScope} and read:knowledge`, 'FORBIDDEN', 403);
    const input = readInvocationParams(invocation);
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > LEGACY_IMPORT_MAX_BYTES) throw new GatewayVerbError('Legacy import exceeds request limit', 'WORK_LEDGER_IMPORT_LIMIT', 413);
    if (!prepare) {
      const authority = requireNativeOwner(invocation, NATIVE_IMPORT_SCOPES, 'Legacy import');
      const parsed = workLedgerCommandSchema.safeParse(input);
      if (!parsed.success || parsed.data.type !== 'import_legacy') throw new GatewayVerbError('Invalid exact import command', 'INVALID_ARGUMENT', 400);
      const result = await native.run(parsed.data, authority, { signal: invocation.signal, isAuthorized: () => invocation.isAuthorized?.(NATIVE_IMPORT_SCOPES) === true });
      if (invocation.isAuthorized(NATIVE_IMPORT_SCOPES) !== true) {
        // An accepted import is already durable, so the refusal must not read as "nothing happened".
        const applied = (result as { readonly kind?: unknown }).kind === 'accepted';
        throw new GatewayVerbError(applied
          ? 'Owner authorization changed after the import was applied. The import was not rolled back; read the work ledger to see its result before sending it again.'
          : 'Owner authorization changed', 'FORBIDDEN', 403);
      }
      return result;
    }
    const actor = host.authority.issueActor({ projectId: host.projectId, role: 'coordinator',
      actorId: `host:work-ledger-import:${randomUUID()}` });
    try {
      if (prepare) {
        const parsed = z.strictObject({ projectId: z.string().min(1).max(200), sourceIds: z.array(z.string().min(1).max(200)).max(500) }).safeParse(input);
        if (!parsed.success) throw new GatewayVerbError('Invalid source capture request', 'INVALID_ARGUMENT', 400);
        if (parsed.data.projectId !== host.projectId) throw new GatewayVerbError('Selected host project mismatch', 'FORBIDDEN', 403);
        const snapshot = await host.service.readSnapshot(actor);
        if (invocation.isAuthorized() !== true) throw new GatewayVerbError('Owner authorization changed', 'FORBIDDEN', 403);
        // The project's work-plan tasks are rows of their own, not knowledge sources, so the client cannot list them: the host adds them.
        const selected = new Set(parsed.data.sourceIds);
        const ids = [...parsed.data.sourceIds, ...(host.workPlanTaskImportIds?.(host.projectId) ?? []).filter(id => !selected.has(id))];
        if (ids.length === 0) return { kind: 'blocked', code: 'invalid-source', reason: `No saved planning sources or work-plan tasks for project ${host.projectId}; nothing to import.` };
        const sources = ids.map(id => host.readSource(id));
        if (sources.some(source => source.generation === null)) throw new GatewayVerbError('A persisted source is unavailable', 'WORK_LEDGER_SOURCE_UNAVAILABLE', 409);
        return prepareLegacyWorkLedgerMigration({ hostId: host.hostId, projectId: host.projectId,
          expectedLedgerRevision: snapshot.revision, pendingLocalChanges: false,
          sources: sources as { source: unknown; generation: string }[], occupiedWorkIds: snapshot.works.map(view => view.work.id) }, invocation.signal);
      }
    } finally { host.authority.revokeActor(actor); }
  };
  attach('workLedger.prepareLegacyImport', invocation => run(invocation, true));
  attach('workLedger.importLegacy', invocation => run(invocation, false));
  return { close: native.close };
}
