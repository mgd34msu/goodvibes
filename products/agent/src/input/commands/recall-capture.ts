import { createRecallCaptureCommands } from '@goodvibes-jev/engine/terminal-shell/recall-capture';
import type { CommandContext } from '../command-registry.ts';
import { formatAgentRecordReferences } from '../../agent/record-labels.ts';
import { getMemoryApi } from './recall-query.ts';
export const { handleRecallAdd, handleRecallCapture } = createRecallCaptureCommands<CommandContext>(getMemoryApi, {
  tag: '[memory]',
  command: 'memory',
  validValuesLabel: 'Valid values',
  validValuesSuffix: '.',
  missingItemSeparator: ' ',
  printAdded(context, record, cls) {
    context.print(`[memory] Added ${cls}`);
    context.print(`  id ${record.id}`);
    context.print(`  scope ${record.scope}`);
    context.print(`  summary ${record.summary}`);
    if (record.tags.length) context.print(`  tags ${record.tags.join(', ')}`);
    if (record.provenance.length) {
      context.print(`  origin ${formatAgentRecordReferences(record.provenance)}`);
    }
  },
});
