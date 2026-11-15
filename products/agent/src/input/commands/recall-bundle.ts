import { createRecallBundleCommands } from '@goodvibes-jev/engine/terminal-shell/recall-bundle';
import type { CommandContext } from '../command-registry.ts';
import { getMemoryApi, getMemorySpine } from './recall-query.ts';
import { requireShellPaths } from './runtime-services.ts';

// Export and import use the store a connected host owns; the local registry is only the embedded fallback.
const getMemoryBundleStore = (context: CommandContext) => getMemorySpine(context) ?? getMemoryApi(context);
export const { handleRecallExport, handleRecallImport, handleRecallHandoffExport, handleRecallHandoffInspect, handleRecallHandoffImport } =
  createRecallBundleCommands<CommandContext>(getMemoryBundleStore, requireShellPaths, {
    tag: '[memory]',
    command: 'memory',
    validValuesLabel: 'Valid values',
    validValuesSuffix: '.',
    confirmMutations: true,
    errorSeparator: ' ',
    fieldSeparator: ' ',
    recordsLabel: 'records ',
    linksLabel: 'links ',
  });
