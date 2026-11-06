import { createRecallBundleCommands } from '@goodvibes-jev/engine/terminal-shell/recall-bundle';
import type { CommandContext } from '../command-registry.ts';
import { getMemorySpine } from './recall-query.ts';
import { requireShellPaths } from './runtime-services.ts';
export const { handleRecallExport, handleRecallImport, handleRecallHandoffExport, handleRecallHandoffInspect, handleRecallHandoffImport } =
  createRecallBundleCommands<CommandContext>(getMemorySpine, requireShellPaths, {
    tag: '[recall]',
    command: 'recall',
    validValuesLabel: 'Valid:',
    validValuesSuffix: '',
    confirmMutations: false,
    errorSeparator: ': ',
    fieldSeparator: ': ',
    recordsLabel: 'Records: ',
    linksLabel: 'Links:   ',
  });
