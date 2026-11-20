/**
 * `/knowledge` in the terminal app (terminal-shell/knowledge-command.ts): the
 * app's own structured knowledge, its knowledge view, and its way of printing.
 */
import { registerKnowledgeCommand } from '@goodvibes-jev/engine/terminal-shell/knowledge-command';
import { createKnowledgeAnswerRenderer } from '@goodvibes-jev/engine/terminal-shell/knowledge-answer';
import { createKnowledgeLabels } from '@goodvibes-jev/engine/terminal-shell/knowledge-labels';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { KnowledgeService } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

const { nodeLabel } = createKnowledgeLabels(' confidence=');

type KnowledgeAskInput = Parameters<KnowledgeService['ask']>[0];
type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;

function askOf(context: CommandContext): ((input: KnowledgeAskInput) => Promise<KnowledgeAskResult>) | undefined {
  const serviceAsk = context.extensions.knowledgeService?.ask?.bind(context.extensions.knowledgeService);
  if (serviceAsk) return serviceAsk;
  return (context.clients?.knowledgeApi as unknown as { ask?: (input: KnowledgeAskInput) => Promise<KnowledgeAskResult> } | undefined)?.ask;
}

export function registerKnowledgeRuntimeCommands(registry: CommandRegistry): void {
  registerKnowledgeCommand<CommandContext>(registry, {
    ports(ctx) {
      const knowledge = ctx.clients?.knowledgeApi;
      if (!knowledge) throw commandRefusal('[knowledge] Knowledge is not available in this session.');
      // A knowledge answer is printed once, in the session that asked for it.
      const sessionId = ctx.session.runtime.sessionId;
      return {
        status: () => knowledge.status.get(),
        nodes: (limit) => knowledge.graph.nodes.list(limit),
        issues: (limit) => knowledge.graph.issues.list(limit),
        sources: (limit) => knowledge.sources.list(limit),
        search: (query, limit) => knowledge.graph.items.search(query, limit),
        get: (id) => knowledge.graph.items.get(id),
        lint: () => knowledge.status.lint(),
        candidates: (limit) => knowledge.consolidation.candidates(limit),
        reports: (limit) => knowledge.consolidation.reports(limit),
        schedules: (limit) => knowledge.jobs.schedules.list(limit),
        packet: (query, scopes) => knowledge.packets.buildPrompt(query, scopes),
        url: (input) => knowledge.ingest.url(input),
        bookmarksFile: (input) => knowledge.ingest.bookmarksFile(input),
        urlsFile: (input) => knowledge.ingest.urlsFile(input),
        review: (input) => knowledge.graph.issues.review(input),
        reindex: () => knowledge.status.reindex(),
        run: (id, options) => knowledge.jobs.run(id, options),
        runs: (limit, jobId) => knowledge.jobs.runs(limit, jobId),
        cancelRun: (runId) => knowledge.jobs.cancelRun(runId),
        ask: askOf(ctx),
        sessionId: () => sessionId,
      };
    },
    open(ctx) {
      if (!ctx.openKnowledgeView) throw commandRefusal('The knowledge view is not available in this session.', '/knowledge status shows how it stands.');
      ctx.openKnowledgeView();
    },
    presentation: {
      statusTitle: '[knowledge] Structured knowledge',
      headingSuffix: ':',
      fieldSeparator: ': ',
      scoreSeparator: '=',
      nodeKind: 'kind',
      reviewer: 'tui',
      sourceLabel: 'source',
      renderAsk: createKnowledgeAnswerRenderer({ nodeLabel, separator: ': ' }),
    },
    spacesRefused: undefined,
    more: { unavailable: 'Files, artifacts, browser history, connectors and the map are Agent Knowledge\'s; in the terminal app add pages with /knowledge ingest-url or import-urls.' },
  });
}
