import type { CommandContext } from './command-registry.ts';
import { AgentDocumentRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/document-registry';
import { type AgentDocumentRecord } from '@goodvibes/engine/terminal-shell/agent-turn/document-registry-types';

// The review packet's timeline, defaults and steps are computed from the stores by shared code, which the daemon
// reports too (documents.timeline, packet-steps; terminal-shell agent-turn/review-packet-report.ts).
export {
  buildReviewPacketDefaults, buildReviewPacketTimeline, buildReviewPacketWizard, type ReviewPacketArtifactListInfo,
} from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-report';

export function readDocumentDrafts(context: CommandContext, failures?: Map<string, string>): readonly AgentDocumentRecord[] {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return [];
    return AgentDocumentRegistry.fromShellPaths(shellPaths).list();
  } catch (error) {
    failures?.set('documents', error instanceof Error ? error.message : String(error));
    return [];
  }
}
