import { createRecallQueryCommands } from '@goodvibes-jev/engine/terminal-shell/recall-query';
import type { CommandContext } from '../command-registry.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { formatAgentRecordReference, formatAgentRecordReferences } from '../../agent/record-labels.ts';

export function getMemoryApi(context: CommandContext): MemoryApi | null {
  const memoryApi = context.clients?.agentKnowledgeApi?.memory;
  if (!memoryApi) {
    context.print('[memory] Agent Memory API is not available in this runtime.');
    context.print('[memory] Refusing to use default knowledge or non-Agent knowledge fallback.');
    return null;
  }
  return memoryApi;
}

export const { handleRecallSearch, handleRecallVector, handleRecallGet, handleRecallLink, handleRecallRemove, handleRecallList } =
  createRecallQueryCommands<CommandContext>(
    (context) => {
      const memory = getMemoryApi(context);
      return memory
        ? {
            list: (filter) => memory.search(filter),
            searchSemantic: (filter) => memory.searchSemantic(filter),
            get: (id) => memory.get(id),
            linksFor: (id) => memory.linksFor(id),
            link: (from, to, relation) => memory.link(from, to, relation),
            delete: (id) => memory.delete(id),
          }
        : null;
    },
    getMemoryApi,
    {
      tag: '[memory]',
      command: 'memory',
      validValuesLabel: 'Valid values',
      validValuesSuffix: '.',
      listSuffix: '',
      temporal: false,
      originLabel: 'origin',
      provenance: formatAgentRecordReferences,
      provenanceEntry: formatAgentRecordReference,
      label: (label) =>
        ({
          scope: 'scope ',
          class: 'class ',
          summary: 'summary ',
          detail: 'detail ',
          tags: 'tags ',
          created: 'created ',
          origin: 'origin',
          links: 'links',
        })[label],
      missingSeparator: ' ',
      confirmMutations: true,
      linkFailure: '[memory] Link failed, check that both IDs exist.',
      printLinked(context, fromId, toId, relation) {
        context.print(['[memory] Linked', `  from ${fromId}`, `  to ${toId}`, `  relation ${relation}`].join('\n'));
      },
      printDeleted(context, id) {
        context.print(['[memory] Deleted', `  id ${id}`].join('\n'));
      },
    },
  );
