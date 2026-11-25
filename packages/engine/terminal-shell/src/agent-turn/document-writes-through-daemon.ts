/**
 * A turn's `agent_documents` writes, made by the daemon's document capabilities (capabilities/builtin/documents.ts,
 * the ones the Drafts tab runs) instead of in the process the turn runs in, so every program's open Drafts list
 * follows them. Reads (list, show) stay where the turn is: the same files. The call's own admission holds before
 * anything is sent, as it does for the tool's own writes.
 */
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolInvocation } from '@goodvibes/engine/platform/platform/tools';
import type { AgentLocalRegistryCapabilityRun } from './local-registry-tool.js';
import { toolErrorText } from './tool-error-text.js';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const list = (value: unknown): string | undefined => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').join(', ') || undefined : text(value));

/** The capability and its inputs for one write mode of `agent_documents`; undefined for a read. */
function writeOf(args: Record<string, unknown>): { readonly id: string; readonly inputs: Readonly<Record<string, string | undefined>> } | undefined {
  const document = text(args['documentId']);
  switch (args['mode']) {
    case 'create': return { id: 'documents.create', inputs: { title: text(args['title']), body: text(args['body']), tags: list(args['tags']), note: text(args['changeSummary']) } };
    case 'update': return { id: 'documents.revise', inputs: { document, title: text(args['title']), body: text(args['body']), status: text(args['status']), tags: list(args['tags']), note: text(args['changeSummary']) } };
    case 'review': return { id: 'documents.mark-reviewed', inputs: { document } };
    case 'comment': return { id: 'documents.comment', inputs: { document, comment: text(args['comment']) } };
    case 'resolveComment': return { id: 'documents.resolve-comment', inputs: { document, comment: text(args['commentId']) } };
    case 'suggest': return {
      id: 'documents.suggest',
      inputs: { document, body: text(args['body']), title: text(args['title']), status: text(args['status']), tags: list(args['tags']), note: text(args['changeSummary']), why: text(args['suggestionRationale']) },
    };
    case 'acceptSuggestion': return { id: 'documents.accept-suggestion', inputs: { document, suggestion: text(args['suggestionId']) } };
    case 'rejectSuggestion': return { id: 'documents.reject-suggestion', inputs: { document, suggestion: text(args['suggestionId']) } };
    case 'insertArtifact': return {
      id: 'documents.insert-artifact',
      inputs: { document, artifact: text(args['artifactId']), placement: text(args['placement']), heading: text(args['sectionTitle']), content: args['includeContent'] === false ? 'no' : undefined, note: text(args['changeSummary']) },
    };
    case 'attachArtifact': return { id: 'documents.attach-artifact', inputs: { document, artifact: text(args['artifactId']), name: text(args['attachmentLabel']), why: text(args['attachmentNote']) } };
    case 'export': return { id: 'documents.export', inputs: { document } };
    default: return undefined;
  }
}

/** Every mode of `agent_documents`: a read (list, show) or a write routed to the daemon's document capability. */
const ROUTED_OR_READ_MODES: readonly string[] = ['list', 'show', 'create', 'update', 'review', 'comment', 'resolveComment', 'suggest', 'acceptSuggestion', 'rejectSuggestion', 'insertArtifact', 'attachArtifact', 'export'];

/**
 * The tool with its writes made by the daemon; what the model sees is the same. Its own call reads or routes one
 * document capability (a nested capability_run call, judged by that capability's risk), so it is classed a read: the
 * capability's question is the only one.
 */
export function documentWritesThroughDaemon(tool: Tool, run: AgentLocalRegistryCapabilityRun): Tool {
  return {
    ...tool,
    definition: { ...tool.definition, readModes: { field: 'mode', values: ROUTED_OR_READ_MODES, defaultValue: 'list' } },
    execute: async (rawArgs, options) => {
      const write = writeOf(rawArgs);
      if (!write) return tool.execute(rawArgs, options);
      try {
        // Only this exact call's currency: the nested call is decided and admitted as the document capability.
        options?.signal?.throwIfAborted();
        if (!assertCurrentToolInvocation(rawArgs, options)) throw new Error('This action requires a current admitted tool call.');
        const inputs = Object.fromEntries(Object.entries(write.inputs).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        // Run as a nested capability_run call of this one: judged by that document capability's own risk.
        const answer = await run(write.id, inputs, options);
        if (!answer.ok) return { success: false, error: answer.error };
        return { success: true, output: answer.text || `${write.id}: done.` };
      } catch (error) {
        return { success: false, error: toolErrorText(error, options?.signal) };
      }
    },
  };
}
