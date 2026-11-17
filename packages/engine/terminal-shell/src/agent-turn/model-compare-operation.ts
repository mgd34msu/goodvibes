import { assertCurrentToolEffect, assertCurrentToolExecution } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ToolExecuteOptions } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import type { AgentModelCompareArtifactStore, AgentModelCompareToolDeps } from './model-compare-types.js';
import { agentResearchSourceOwner } from './protected-research-report.js';

/** One comparison run: its dependencies bound to the owner frame, and the checks every step repeats. */
export interface ComparisonOperation {
  deps: AgentModelCompareToolDeps;
  sourceOwner: ProtectedSourceOwner | undefined;
  assertCurrent: () => void;
  assertWrite: () => void;
  assertSend: () => void;
}

/** Every asynchronous comparison dependency stays inside its original owner frame. */
export function createComparisonOperation(source: AgentModelCompareToolDeps, args: Record<string, unknown>, options?: ToolExecuteOptions): ComparisonOperation {
  // Only the artifacts this operation read are pinned, by id and size: a listing pins nothing, so the
  // cost of a check does not grow with the store, and an unrelated artifact cannot fail the call.
  const read = new Map<string, number>();
  const pin = (descriptor: ArtifactDescriptor) => {
    const prior = read.get(descriptor.id);
    if (prior !== undefined && prior !== descriptor.sizeBytes) throw new Error(`Comparison artifact ${descriptor.id} changed during this operation; nothing was saved. Run the mode again.`);
    read.set(descriptor.id, descriptor.sizeBytes);
  };
  const store = source.artifactStore;
  const storeChecks = new Map<string, () => void>();
  const registry = source.toolRegistry;
  const sourceOwner = agentResearchSourceOwner(registry);
  const get = store?.get; const list = store?.list; const readContent = store?.readContent; const create = store?.create;
  const catalog = source.modelCatalog;
  const listModels = catalog.listModels; const getCurrentModel = catalog.getCurrentModel; const recordModelUsage = catalog.recordModelUsage;
  const providers = source.providerRegistry;
  const getForModel = providers.getForModel; const applyModelRoute = source.applyModelRoute;
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    assertCurrentToolExecution(args, options);
    if (source.toolRegistry !== registry || agentResearchSourceOwner(registry) !== sourceOwner || source.artifactStore !== store || store?.get !== get || store?.list !== list || store?.readContent !== readContent || store?.create !== create
      || source.modelCatalog !== catalog || catalog.listModels !== listModels || catalog.getCurrentModel !== getCurrentModel || catalog.recordModelUsage !== recordModelUsage
      || source.providerRegistry !== providers || providers.getForModel !== getForModel || source.applyModelRoute !== applyModelRoute) throw new Error('Comparison dependency owner changed.');
    if (get) {
      for (const [id, size] of read) {
        const current = get.call(store, id);
        if (!current || current.sizeBytes !== size) throw new Error(`Comparison artifact ${id} changed or expired during this operation; nothing was saved. Run the mode again.`);
      }
    }
    for (const check of storeChecks.values()) check();
  };
  const assertEffect = (effect: 'write' | 'send') => {
    assertCurrent();
    if (!assertCurrentToolEffect(args, options, effect)) throw new Error('Comparison effects require current recorded effect admission.');
  };
  const assertWrite = () => assertEffect('write');
  const assertSend = () => assertEffect('send');
  const artifactStore: AgentModelCompareArtifactStore | undefined = store && create && {
    async create(input, ownership) {
      assertWrite();
      ownership?.signal?.throwIfAborted(); ownership?.assertCurrent?.();
      const result = await create.call(store, input, { signal: options?.signal, assertCurrent: () => { assertWrite(); ownership?.assertCurrent?.(); } });
      assertCurrent();
      return result;
    },
    ...(list ? { list(limit?: number) { assertCurrent(); return list.call(store, limit); } } : {}),
    ...(get ? { get(id: string) { assertCurrent(); return get.call(store, id); } } : {}),
    ...(readContent ? { async readContent(id: string) {
      assertCurrent();
      const result = await readContent.call(store, id);
      if (result.record.id !== id) throw new Error('Comparison source artifact does not match the requested owner record.');
      const readCurrent = result.assertCurrent?.bind(result); readCurrent?.();
      if (result.buffer.byteLength !== result.record.sizeBytes) throw new Error(`Comparison artifact ${id} is not the size its record states; it was not used.`);
      pin(result.record);
      if (readCurrent) storeChecks.set(id, readCurrent);
      assertCurrent();
      return { record: result.record, buffer: Buffer.from(result.buffer), assertCurrent: () => { assertCurrent(); readCurrent?.(); } };
    } } : {}),
  };
  const deps: AgentModelCompareToolDeps = {
    ...source,
    modelCatalog: {
      async listModels(query) { assertCurrent(); const result = await listModels.call(catalog, query); assertCurrent(); return result; },
      ...(getCurrentModel ? { async getCurrentModel() { assertCurrent(); const result = await getCurrentModel.call(catalog); assertCurrent(); return result; } } : {}),
      ...(recordModelUsage ? { async recordModelUsage(key: string) { assertWrite(); const result = await recordModelUsage.call(catalog, key, { signal: options?.signal, assertCurrent: assertWrite }); assertCurrent(); return result; } } : {}),
    },
    ...(artifactStore ? { artifactStore } : {}),
    ...(applyModelRoute ? { async applyModelRoute(key: string) { assertWrite(); const result = await applyModelRoute.call(source, key, options, { signal: options?.signal, assertCurrent }); return result; } } : {}),
  };
  return { deps, sourceOwner, assertCurrent, assertWrite, assertSend };
}
