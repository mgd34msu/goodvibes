import type { MemorySpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { MemoryRestoreResult, MemorySnapshotInfo } from '@goodvibes-jev/engine/platform/platform/state';
import type { CommandConfirmation } from './command-confirmation.js';

/** Shared memory verb aliases and argument rewriting; product handlers retain storage/confirmation authority. */
export function createRecallDispatch<Context>(ports: {
  readonly add: (args: string[], context: Context) => unknown;
  readonly search: (args: string[], context: Context) => unknown;
  readonly vector: (args: string[], context: Context) => unknown;
  readonly capture: (args: string[], context: Context) => unknown;
  readonly get: (args: string[], context: Context) => unknown;
  readonly queue: (args: string[], context: Context) => unknown;
  readonly review: (args: string[], context: Context) => unknown;
  readonly explain: (args: string[], context: Context) => unknown;
  readonly promote: (args: string[], context: Context) => unknown;
  readonly link: (args: string[], context: Context) => unknown;
  readonly list: (args: string[], context: Context) => unknown;
  readonly remove: (args: string[], context: Context) => unknown;
  readonly export: (args: string[], context: Context) => unknown;
  readonly import: (args: string[], context: Context) => unknown;
  readonly handoffExport: (args: string[], context: Context) => unknown;
  readonly handoffInspect: (args: string[], context: Context) => unknown;
  readonly handoffImport: (args: string[], context: Context) => unknown;
}) {
  // `stale <id> <reason words> [--by <name>]`: the words after the id are the reason, read by the review grammar.
  const reviewAs = (state: 'stale' | 'contradicted') => (args: string[], context: Context): unknown => {
    const [id = '', ...rest] = args;
    const reasonFirst = rest.length > 0 && !rest[0]!.startsWith('--');
    return ports.review([id, state, ...(reasonFirst ? ['--reason'] : []), ...rest], context);
  };
  const handlers = new Map<string, (args: string[], context: Context) => unknown>([
    ['add', ports.add],
    ['search', ports.search],
    ['find', ports.search],
    ['vector', ports.vector],
    ['vectors', ports.vector],
    ['capture', ports.capture],
    ['get', ports.get],
    ['show', ports.get],
    ['queue', ports.queue],
    ['review', ports.review],
    ['stale', reviewAs('stale')],
    ['contradict', reviewAs('contradicted')],
    ['explain', ports.explain],
    ['promote', ports.promote],
    ['link', ports.link],
    ['list', ports.list],
    ['ls', ports.list],
    ['remove', ports.remove],
    ['delete', ports.remove],
    ['rm', ports.remove],
    ['export', ports.export],
    ['import', ports.import],
    ['handoff-export', ports.handoffExport],
    ['share', ports.handoffExport],
    ['handoff-inspect', ports.handoffInspect],
    ['handoff-import', ports.handoffImport],
  ]);
  return (sub: string | undefined, rest: string[], context: Context): boolean | Promise<boolean> => {
    const handler = sub === undefined ? undefined : handlers.get(sub === 'contradicted' ? 'contradict' : sub);
    if (!handler) return false;
    const result = handler(rest, context);
    return result instanceof Promise ? result.then(() => true) : true;
  };
}

/**
 * The confirmation `/memory restore <copy>` asks once, in both terminal apps:
 * it replaces every memory record. A model-run line is always put to the owner.
 */
export function memoryRestoreConfirmation(args: readonly string[], command: string): CommandConfirmation | undefined {
  if (args[0] !== 'restore' || !args[1]) return undefined;
  return {
    title: `Replace all memory with the copy ${args[1]}?`,
    detail: `Every memory record, link and pending consolidation proposal is replaced by those in ${args[1]}. The records you have now are copied first, and the line printed afterwards names that copy: /${command} restore <that copy> puts them back.`,
    confirmLabel: 'Restore',
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16);
}

/** One line per copy, newest first. */
export function formatMemorySnapshots(copies: readonly MemorySnapshotInfo[], command: string): string {
  if (copies.length === 0) return 'No memory copies yet: the first daily copy is taken within an hour of start.';
  const lines = copies.map((copy) => `  ${copy.name}  ${copy.reason}  ${formatWhen(copy.createdAt)} UTC  ${formatBytes(copy.sizeBytes)}  ${copy.recordCount === null ? 'records unreadable' : `${copy.recordCount} record${copy.recordCount === 1 ? '' : 's'}`}`);
  return [`Memory copies (newest first); /${command} restore <name|latest|date> puts one back:`, ...lines].join('\n');
}

/** What a restore did, in one paragraph. */
export function formatMemoryRestore(result: MemoryRestoreResult, command: string): string {
  return [
    `Restored memory from ${result.restored} (${result.restoredReason}, taken ${formatWhen(result.restoredCreatedAt)} UTC): ${result.recordsBefore} record${result.recordsBefore === 1 ? '' : 's'} before, ${result.recordsAfter} now, ${result.linksAfter} link${result.linksAfter === 1 ? '' : 's'}.`,
    `The records it replaced were copied to ${result.undoSnapshot}; /${command} restore ${result.undoSnapshot} undoes this.`,
    result.vectorIndex === 'updating'
      ? 'Semantic search catches up in the background: records whose text changed are embedded again.'
      : 'This store keeps no semantic index.',
  ].join('\n');
}

/**
 * `/memory snapshots` and `/memory restore <copy>`, shared by both terminal
 * apps. Both go through the memory spine, so they run where the store's writer
 * is: the adopted daemon, or this app's own store when it runs alone.
 */
export function createMemorySnapshotCommands<Context extends { print(message: string): void }>(
  getSpine: (context: Context) => MemorySpineClient | null,
  options: { readonly tag: string; readonly command: string },
): {
  readonly snapshots: (args: string[], context: Context) => Promise<void>;
  readonly restore: (args: string[], context: Context) => Promise<void>;
} {
  return {
    async snapshots(_args, context) {
      const spine = getSpine(context);
      if (!spine) { context.print(`${options.tag} Memory is not available in this runtime.`); return; }
      context.print(formatMemorySnapshots(await spine.listSnapshots(), options.command));
    },
    async restore(args, context) {
      const name = args[0]?.trim();
      if (!name) { context.print(`${options.tag} Usage: /${options.command} restore <name|latest|date>; /${options.command} snapshots lists the copies.`); return; }
      const spine = getSpine(context);
      if (!spine) { context.print(`${options.tag} Memory is not available in this runtime; nothing was changed.`); return; }
      context.print(formatMemoryRestore(await spine.restoreSnapshot(name), options.command));
    },
  };
}
