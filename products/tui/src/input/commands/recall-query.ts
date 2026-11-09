import { createRecallQueryCommands } from '@goodvibes-jev/engine/terminal-shell/recall-query';
import type { CommandContext } from '../command-registry.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemorySpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';

/**
 * The local, host-only `MemoryApi`, kept for `/recall explain` and `/recall
 * vector` only. Both are ruled explicitly out of the wire catalog in
 * docs/decisions/2026-07-06-memory-wire-full-detach.md (platform repo): `explain`
 * is a client-side projection over whatever read surface is active, not a
 * store operation, and vector-index rebuild is host/admin maintenance a wire
 * client does not own. Every other `/recall` subcommand reads/writes through
 * {@link getMemorySpine} instead, so it detaches fully from the local store
 * file when a daemon is adopted.
 */
export function getMemoryApi(context: CommandContext): MemoryApi | null {
  const memoryApi = context.clients?.knowledgeApi?.memory;
  if (!memoryApi) {
    context.print('[recall] Memory API is not available in this runtime.');
    return null;
  }
  return memoryApi;
}

/**
 * The cross-surface memory spine client, routes local when offline/embedded,
 * over the wire when a daemon has been adopted, never both. `/recall`'s
 * browse/link/queue/export/import subcommands use this so they never read a
 * divergent local copy while a daemon owns the canonical store.
 */
export function getMemorySpine(context: CommandContext): MemorySpineClient | null {
  const memorySpine = context.clients?.memorySpine;
  if (!memorySpine) {
    context.print('[recall] Memory spine is not available in this runtime.');
    return null;
  }
  return memorySpine;
}

export const { handleRecallSearch, handleRecallVector, handleRecallGet, handleRecallLink, handleRecallRemove, handleRecallList } =
  createRecallQueryCommands<CommandContext>(getMemorySpine, getMemoryApi, {
    tag: '[recall]',
    command: 'recall',
    validValuesLabel: 'Valid:',
    validValuesSuffix: '',
    listSuffix: ':',
    temporal: true,
    originLabel: 'via:',
    provenance: (refs) => refs.map((entry) => `${entry.kind}:${entry.ref}`).join(', '),
    provenanceEntry: (ref) => `${ref.kind}: ${ref.ref}${ref.label ? ` (${ref.label})` : ''}`,
    label: (label) =>
      ({
        scope: 'Scope:   ',
        class: 'Class:   ',
        summary: 'Summary: ',
        detail: 'Detail:  ',
        tags: 'Tags:    ',
        created: 'Created: ',
        origin: 'Provenance:',
        links: 'Links:',
      })[label],
    missingSeparator: ': ',
    confirmMutations: false,
    linkFailure: '[recall] Link failed: check that both IDs exist.',
    printLinked(context, fromId, toId, relation) {
      context.print(`[recall] Linked: ${fromId} -> ${toId} [${relation}]`);
    },
    printDeleted(context, id) {
      context.print(`[recall] Deleted: ${id}`);
    },
  });
