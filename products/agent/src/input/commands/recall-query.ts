import { createRecallQueryCommands } from '@goodvibes-jev/engine/terminal-shell/recall-query';
import type { CommandContext } from '../command-registry.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemorySpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { formatAgentRecordReference, formatAgentRecordReferences } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

export function getMemoryApi(context: CommandContext): MemoryApi | null {
  const memoryApi = context.clients?.agentKnowledgeApi?.memory;
  if (!memoryApi) {
    context.print('[memory] Agent Memory API is not available in this runtime.');
    context.print('[memory] Refusing to use default knowledge or non-Agent knowledge fallback.');
    return null;
  }
  return memoryApi;
}

/**
 * The cross-surface memory spine, when the runtime wired it into the command clients: local when
 * embedded, over the wire once a host is adopted. The model's tools and vibe import write through
 * it, so these commands must read and write the same store instead of a divergent local copy.
 */
export function getMemorySpine(context: CommandContext): MemorySpineClient | null {
  return context.clients?.memorySpine ?? null;
}

export const { handleRecallSearch, handleRecallVector, handleRecallGet, handleRecallLink, handleRecallRemove, handleRecallList } =
  createRecallQueryCommands<CommandContext>(
    (context) => {
      const spine = getMemorySpine(context);
      if (spine) return spine;
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
