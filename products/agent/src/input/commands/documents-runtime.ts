/**
 * `/documents` in the Agent, with the actions still the Agent's own: the
 * review packet's readiness, steps and timeline, told in plain words from the
 * Agent workspace's own view of the review packet. The drafts, their
 * comments, suggestions, artifacts, export and presets are the daemon's
 * (capabilities/builtin/documents.ts), controls in Memory and knowledge.
 */
import { defineCommand, type ActionDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import { readAction } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { readDocumentOpsLane } from '../../tools/agent-harness-document-ops.ts';
import type { DocumentOpsLane, DocumentOpsLaneId } from '../../tools/agent-harness-document-ops-types.ts';
import { formatReviewPacketSteps, formatReviewPacketTimeline, formatReviewReadiness } from './documents-review-report.ts';

const LOCAL_ONLY = { terminalOnly: 'The review packet report is the Agent workspace\'s own.' } as const;

/**
 * A review packet lane told in plain words. A model is sent to agent_harness
 * mode:"document_ops_lane" laneId:"<laneId>", which answers the same lane as JSON.
 */
function laneRead(id: string, label: string, word: string, sentence: string, laneId: DocumentOpsLaneId, report: (lane: DocumentOpsLane | undefined) => string): ActionDescription<CommandContext> {
  return {
    ...readAction<CommandContext>({
      id, label, word, sentence, operator: LOCAL_ONLY,
      async run(_values, ctx) { return report(readDocumentOpsLane(ctx, laneId)); },
    }),
    ownerOnly: { reason: 'it is your plain-words report of the lane', instead: `Call agent_harness mode:"document_ops_lane" laneId:"${laneId}", which answers the same lane as JSON.` },
  };
}

/**
 * `/documents` in the Agent: the review packet reports, read from the Agent workspace's own view of the packet. The
 * drafts themselves are the daemon's (capabilities/builtin/documents.ts), reached in Memory and knowledge.
 */
export function registerReviewPacketReportCommand(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'documents',
    title: 'Documents',
    summary: 'How far the review packet of your drafts is: what still stands in the way, its steps and its timeline',
    group: 'Agent',
    report: 'list',
    actions: [
      laneRead('readiness', 'Check a draft is ready for review', 'readiness',
        'Lists what still stands in the way of review (open comments, suggestions waiting, missing sources, hidden comparisons, the handoff), each with the line that settles it.', 'reviewer_readiness', formatReviewReadiness),
      laneRead('packet-steps', 'See the review packet steps', 'packet-steps',
        'Shows the review packet\'s steps in order (review, export, compare and judge, hand off, decide, archive), which are done, and the line for the next one.', 'review_packet_wizard', formatReviewPacketSteps),
      laneRead('timeline', 'See the review packet timeline', 'timeline',
        'Lists, oldest first and dated, what happened to the review packet: drafts, comments, suggestions, attachments, exports, comparisons, judgments, model decisions, presets and handoffs.', 'review_packet_timeline', formatReviewPacketTimeline),
    ],
  }));
}
