import { createRecallCaptureCommands } from '@goodvibes-jev/engine/terminal-shell/recall-capture';
import type { CommandContext } from '../command-registry.ts';
import { formatAgentRecordReferences } from '../../agent/record-labels.ts';
import { getMemoryApi, getMemorySpine } from './recall-query.ts';

// The spine writes the store a connected host owns; the local registry is only the embedded fallback.
const getMemoryWriter = (context: CommandContext) => getMemorySpine(context) ?? getMemoryApi(context);
export const { handleRecallAdd, handleRecallCapture } = createRecallCaptureCommands<CommandContext>(getMemoryWriter, {
  tag: '[memory]',
  command: 'memory',
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
