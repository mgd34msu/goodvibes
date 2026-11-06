import { createRecallCaptureCommands } from '@goodvibes-jev/engine/terminal-shell/recall-capture';
import type { CommandContext } from '../command-registry.ts';
import { getMemorySpine } from './recall-query.ts';
export const { handleRecallAdd, handleRecallCapture } = createRecallCaptureCommands<CommandContext>(getMemorySpine, {
  tag: '[recall]',
  command: 'recall',
  validValuesLabel: 'Valid:',
  validValuesSuffix: '',
  missingItemSeparator: ': ',
  printAdded(context, record, cls) {
    context.print(`[recall] Added ${cls}: ${record.id}`);
    context.print(`  Scope:   ${record.scope}`);
    context.print(`  Summary: ${record.summary}`);
    if (record.tags.length) context.print(`  Tags: ${record.tags.join(', ')}`);
    if (record.provenance.length) {
      context.print(`  Provenance: ${record.provenance.map((entry) => `${entry.kind}:${entry.ref}`).join(', ')}`);
    }
  },
});
