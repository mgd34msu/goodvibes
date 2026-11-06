import { createRecallBundleCommands } from '@goodvibes-jev/engine/terminal-shell/recall-bundle';
import type { CommandContext } from '../command-registry.ts';
import { getMemoryApi } from './recall-query.ts';
import { requireShellPaths } from './runtime-services.ts';
export const { handleRecallExport, handleRecallImport, handleRecallHandoffExport, handleRecallHandoffInspect, handleRecallHandoffImport } =
  createRecallBundleCommands<CommandContext>(getMemoryApi, requireShellPaths, {
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
