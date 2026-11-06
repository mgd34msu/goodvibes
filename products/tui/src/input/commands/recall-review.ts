import { createRecallReviewCommands } from '@goodvibes-jev/engine/terminal-shell/recall-review';
import type { CommandContext } from '../command-registry.ts';
import { getMemoryApi, getMemorySpine } from './recall-query.ts';
import { buildMainSessionTurnInjectionsText, buildTurnInjectionsText } from '../../renderer/turn-injection.ts';
export const { handleRecallQueue, handleRecallReview, handleRecallExplain, handleRecallPromote } =
  createRecallReviewCommands<CommandContext>(getMemorySpine, getMemoryApi, {
    tag: '[recall]',
    command: 'recall',
    validValuesLabel: 'Valid:',
    validValuesSuffix: '',
    scopedQueue: true,
    temporal: true,
    staleSeparator: ': ',
    confirmPromote: false,
    reviewState: (state) => state,
  });
export function handleRecallInjections(args: string[], context: CommandContext): void {
  const agentId = args[0];
  if (!agentId) {
    const mainSessionInjections = context.session.getMainSessionTurnInjections?.() ?? [];
    context.print(buildMainSessionTurnInjectionsText(mainSessionInjections));
    return;
  }
  const records = context.ops.agentManager?.exportState() ?? [];
  const record = records.find((candidate) => candidate.id === agentId);
  if (!record) {
    context.print(`[recall] Agent not found: ${agentId}`);
    return;
  }
  context.print(buildTurnInjectionsText(agentId, record.turnInjections ?? []));
}
