import { createMemorySnapshotCommands, createRecallDispatch, memoryRestoreConfirmation } from '@goodvibes-jev/engine/terminal-shell/recall-dispatch';
/**
 * /memory command handler.
 *
 * Implements the Project Memory Substrate commands:
 *
 *   /memory add <class> <summary>          , Add a new memory record
 *   /memory add <class> <summary> --detail <text> --tags <tag,tag>
 *   /memory search [query]                 , Search memory records
 *   /memory search --cls <class>           , Filter by class
 *   /memory link <fromId> <toId> <relation> --yes, Link two records
 *   /memory get <id>                       , Show a single record with provenance
 *   /memory list [class]                   , List all records (optionally by class)
 *   /memory remove <id> --yes              , Delete a record
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { handleRecallAdd, handleRecallCapture } from './recall-capture.ts';
import {
  handleRecallExport,
  handleRecallHandoffExport,
  handleRecallHandoffImport,
  handleRecallHandoffInspect,
  handleRecallImport,
} from './recall-bundle.ts';
import {
  getMemorySpine,
  handleRecallGet,
  handleRecallLink,
  handleRecallList,
  handleRecallRemove,
  handleRecallSearch,
  handleRecallVector,
} from './recall-query.ts';
import { handleRecallFilesApply, handleRecallFilesReview, handleRecallFilesSync } from './recall-files.ts';
import { handleRecallExplain, handleRecallPromote, handleRecallQueue, handleRecallReview } from './recall-review.ts';
import { VALID_CLASSES } from './recall-shared.ts';

// ── Top-level command ─────────────────────────────────────────────────────────

const memoryCopies = createMemorySnapshotCommands<CommandContext>(getMemorySpine, { tag: '[memory]', command: 'memory' });

const dispatchRecall = createRecallDispatch<CommandContext>({
  add: handleRecallAdd,
  search: handleRecallSearch,
  vector: handleRecallVector,
  capture: handleRecallCapture,
  get: handleRecallGet,
  queue: handleRecallQueue,
  review: handleRecallReview,
  explain: handleRecallExplain,
  promote: handleRecallPromote,
  link: handleRecallLink,
  list: handleRecallList,
  remove: handleRecallRemove,
  export: handleRecallExport,
  import: handleRecallImport,
  handoffExport: handleRecallHandoffExport,
  handoffInspect: handleRecallHandoffInspect,
  handoffImport: handleRecallHandoffImport,
});

export const recallCommand: SlashCommand = {
  name: 'recall',
  effect: 'local-state',
  readVerbs: ['search', 'get', 'list', 'files', 'snapshots'],
  aliases: ['rc'],
  description: 'Project memory: add decisions, constraints, incidents, and patterns with provenance.',
  usage: '<subcommand> [args]',
  argsHint: 'add|search|link|get|list|remove|files',
  confirm(args) {
    const restore = memoryRestoreConfirmation(args, 'memory');
    if (restore) return restore;
    if (args[0] !== 'remove' || !args[1]) return undefined;
    return {
      title: `Delete memory record ${args[1]}?`,
      detail: `The durable memory record ${args[1]} and its links are deleted and cannot be recovered; /recall get ${args[1]} shows it first.`,
      confirmLabel: 'Delete',
    };
  },
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    const dispatched = dispatchRecall(sub, rest, context);
    if (dispatched instanceof Promise ? await dispatched : dispatched) return;

    switch (sub) {
      case 'files': {
        const [filesSub, ...filesRest] = rest;
        if (filesSub === 'sync') await handleRecallFilesSync(filesRest, context);
        else if (filesSub === 'review') await handleRecallFilesReview(filesRest, context);
        else if (filesSub === 'apply') await handleRecallFilesApply(filesRest, context);
        else context.print('[memory] Usage: /memory files <sync|review|apply> [--dir <path>]');
        break;
      }

      case 'snapshots':
        await memoryCopies.snapshots(rest, context);
        break;

      case 'restore':
        await memoryCopies.restore(rest, context);
        break;

      default: {
        const usage = [
          'Usage: /memory <subcommand>',
          '  add <class> <summary> [--scope <session|project|team>] [--detail <text>] [--tags <t,t>] [--session <id>] [--task <id>] [--file <path>]',
          `       classes: ${VALID_CLASSES.join(', ')}`,
          '  capture incident <id|latest>                   , Capture a forensics incident as durable memory',
          '  capture policy                                 , Capture the latest policy preflight review as durable memory',
          '  capture mcp <server>                           , Capture MCP trust/quarantine posture as durable memory',
          '  capture plugin <name>                          , Capture plugin trust/quarantine posture as durable memory',
          '  search [query] [--semantic] [--cls <class>] [--scope <scope>] [--limit <n>] , Full-text or sqlite-vec semantic search',
          '  vector [status|doctor|rebuild]                 , Inspect or rebuild the sqlite-vec memory index',
          '  get <id>                                      , Show record with provenance + links',
          '  link <fromId> <toId> <relation> --yes        , Create a directed relation between records',
          '  queue [limit]                                 , Show the operator review queue',
          '  review <id> <state> [--confidence <n>] [--by <name>] [--reason <text>]',
          '  stale <id> [reason...]                         , Mark a record stale with an operator reason',
          '  contradict <id> [reason...]                    , Mark a record contradicted with an operator reason',
          '  explain <task...> [--scope <path> ...]        , Show the knowledge records that would be injected for a task',
          '  promote <id> <scope> --yes                    , Promote a memory record into session|project|team scope',
          '  export <path> [--scope <scope>] [--cls <class>] --yes, Export a durable knowledge bundle',
          '  import <path> --yes                            , Import a durable knowledge bundle',
          '  handoff-export <path> [--scope <scope>] --yes  , Export a reviewable handoff bundle for team/shared use',
          '  handoff-inspect <path>                        , Inspect a handoff bundle before import',
          '  handoff-import <path> --yes                    , Import a handoff bundle into durable memory',
          '  files sync [--dir <path>]                      , Write standing memory records as markdown files and commit them in their own repository',
          '  files review [--dir <path>]                    , Show what editing or deleting those files would change; changes nothing',
          '  files apply <id>... | --all [--dir <path>]     , Apply the named proposals to memory',
          '  list [class] [--scope <scope>]                , List all records grouped by class',
          '  remove <id> --yes                             , Delete a record',
          '  snapshots                                     , List the point-in-time copies of memory (daily, before a migration, before a restore)',
          '  restore <name|latest|date>                    , Replace all memory with one copy; the current records are copied first',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
