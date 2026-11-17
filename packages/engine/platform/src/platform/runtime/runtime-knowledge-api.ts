import { createKnowledgeApi, type CodeIndexApiRegistry, type CreateKnowledgeApiOptions, type KnowledgeApi } from '../knowledge/knowledge-api.js';
import type { RuntimeServices } from './services.js';

export interface RuntimeKnowledgeApiServices
  extends Pick<RuntimeServices, 'knowledgeService' | 'memoryRegistry' | 'codeIndexStore'> {}

export function createRuntimeKnowledgeApi(
  runtimeServices: RuntimeKnowledgeApiServices,
): KnowledgeApi {
  // The store is read at each call, not here: a graph that opens its code index
  // on demand opens it when the index is first used, not when this API is built.
  const codeIndex = (): CodeIndexApiRegistry => runtimeServices.codeIndexStore;
  const options: CreateKnowledgeApiOptions = {
    memoryRegistry: runtimeServices.memoryRegistry,
    codeIndexStore: {
      search: (query, opts) => codeIndex().search(query, opts),
      stats: () => codeIndex().stats(),
      buildFull: () => codeIndex().buildFull(),
      scheduleBuild: () => codeIndex().scheduleBuild(),
      reindexFile: (absPath) => codeIndex().reindexFile(absPath),
      describeDegradation: () => codeIndex().describeDegradation(),
    },
  };
  return createKnowledgeApi(runtimeServices.knowledgeService, options);
}
