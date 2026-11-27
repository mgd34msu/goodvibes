/**
 * The reviewer readiness checklist as the Agent's model tools read it: the same computation the daemon reports
 * (`documents.readiness`, terminal-shell agent-turn/review-packet-report.ts), over this project's drafts and the
 * artifact store this program opened.
 */
import type { CommandContext } from '../input/command-registry.ts';
import { AgentDocumentRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/document-registry';
import {
  buildReviewerReadinessChecklist as buildChecklist, readPacketArtifacts, readPacketDocuments, type DocumentOpsSources,
} from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-report';
import type { ReviewerReadinessChecklist } from './agent-harness-document-ops-types.ts';

export type { DocumentOpsSources, StoreRead } from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-report';

export function readDocumentOpsSources(context: CommandContext): DocumentOpsSources {
  const shellPaths = context.workspace?.shellPaths;
  const store = context.platform.artifactStore;
  return {
    documents: readPacketDocuments(shellPaths ? () => AgentDocumentRegistry.fromShellPaths(shellPaths).list() : undefined),
    artifacts: readPacketArtifacts(store?.list ? { list: (limit?: number) => store.list(limit) } : undefined),
    artifactsListable: Boolean(store?.list),
  };
}

export function buildReviewerReadinessChecklist(
  context: CommandContext,
  options: { readonly documentsReady: boolean; readonly modelCompareReady: boolean; readonly artifactBrowserReady: boolean },
  sources: DocumentOpsSources = readDocumentOpsSources(context),
): ReviewerReadinessChecklist {
  return buildChecklist(options, sources);
}
