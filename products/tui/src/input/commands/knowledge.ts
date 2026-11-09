import { handleKnowledgeMutationCommand } from '@goodvibes-jev/engine/terminal-shell/knowledge-mutation-command';
import { handleKnowledgeReadCommand } from '@goodvibes-jev/engine/terminal-shell/knowledge-read-command';
import { readKnowledgeAskArguments } from '@goodvibes-jev/engine/terminal-shell/command-arguments';
import { createKnowledgeAnswerRenderer } from '@goodvibes-jev/engine/terminal-shell/knowledge-answer';
import '@goodvibes-jev/engine/terminal-shell/command-arguments';
import { createKnowledgeLabels } from '@goodvibes-jev/engine/terminal-shell/knowledge-labels';
const { nodeLabel } = createKnowledgeLabels(' confidence=');
import type { KnowledgeService } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';

type KnowledgeAskInput = Parameters<KnowledgeService['ask']>[0];
type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;

function requireKnowledgeApi(context: CommandContext) {
  const knowledgeApi = context.clients?.knowledgeApi;
  if (!knowledgeApi) {
    context.print('[knowledge] Knowledge API is not available in this runtime.');
    return null;
  }
  return knowledgeApi;
}

function requireKnowledgeAsk(context: CommandContext): ((input: KnowledgeAskInput) => Promise<KnowledgeAskResult>) | null {
  const serviceAsk = context.extensions.knowledgeService?.ask?.bind(context.extensions.knowledgeService);
  if (serviceAsk) return serviceAsk;

  const clientAsk = (
    context.clients?.knowledgeApi as unknown as { ask?: (input: KnowledgeAskInput) => Promise<KnowledgeAskResult> } | undefined
  )?.ask;
  if (clientAsk) return clientAsk;

  context.print('[knowledge] Knowledge ask is not available in this runtime.');
  return null;
}

const renderKnowledgeAskResult = createKnowledgeAnswerRenderer({ nodeLabel, separator: ': ' });

export const knowledgeCommand: SlashCommand = {
  name: 'knowledge',
  aliases: ['know'],
  description: 'Structured knowledge graph: ingest URLs/bookmarks, inspect issues, and build compact prompt packets',
  usage: '<subcommand> [args]',
  argsHint:
    'status|ask|ingest-url|import-bookmarks|import-urls|list|search|get|queue|review-issue|candidates|reports|schedules|lint|packet|explain|reindex|consolidate',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const knowledge = requireKnowledgeApi(context);
    if (!knowledge) {
      return;
    }
    const conversation = context.session.conversationManager;
    const sessionId = context.session.runtime.sessionId;
    const lifetime = conversation.captureHistoryReadingLifetime();
    const assertCurrent = () => {
      lifetime.assertCurrent();
      if (
        context.session.conversationManager !== conversation ||
        context.session.runtime.sessionId !== sessionId ||
        context.clients?.knowledgeApi !== knowledge
      )
        throw new JudgmentAuthorityRetiredError();
    };
    const readingOptions = { signal: lifetime.signal, assertCurrent };
    const print = (text: string) => {
      assertCurrent();
      context.print(text);
    };
    if (args.length === 0 && context.openKnowledgeView) {
      context.openKnowledgeView();
      return;
    }
    const sub = (args[0] ?? 'status').toLowerCase();
    const rest = args.slice(1);

    assertCurrent();
    if (
      await handleKnowledgeReadCommand(
        sub,
        rest,
        print,
        {
          status: () => knowledge.status.get(),
          nodes: (limit) => knowledge.graph.nodes.list(limit, readingOptions),
          issues: (limit) => knowledge.graph.issues.list(limit, readingOptions),
          sources: (limit) => knowledge.sources.list(limit, readingOptions),
          search: (query, limit) => knowledge.graph.items.search(query, limit),
          get: (id) => knowledge.graph.items.get(id, {}, readingOptions),
          lint: () => knowledge.status.lint(),
          candidates: (limit) => knowledge.consolidation.candidates(limit),
          reports: (limit) => knowledge.consolidation.reports(limit),
          schedules: (limit) => knowledge.jobs.schedules.list(limit),
          packet: (query, scopes) => knowledge.packets.buildPrompt(query, scopes),
          assertCurrent,
        },
        {
          statusTitle: '[knowledge] Structured knowledge status',
          headingSuffix: ':',
          fieldSeparator: ': ',
          scoreSeparator: '=',
          nodeKind: 'kind',
        },
      )
    )
      return;
    assertCurrent();
    if (
      await handleKnowledgeMutationCommand(
        sub,
        rest,
        print,
        {
          sessionId: () => context.session.runtime.sessionId,
          url: (input) => knowledge.ingest.url(input),
          bookmarksFile: (input) => knowledge.ingest.bookmarksFile(input),
          urlsFile: (input) => knowledge.ingest.urlsFile(input),
          review: (input) => knowledge.graph.issues.review(input),
          reindex: () => knowledge.status.reindex(),
          run: (id, options) => knowledge.jobs.run(id, options),
          allow: () => true,
          describeError: summarizeError,
        },
        { fieldSeparator: ': ', reviewer: 'tui', confirmationSuffix: '', sourceLabel: 'source' },
      )
    )
      return;
    assertCurrent();
    switch (sub) {
      case 'ask': {
        const ask = requireKnowledgeAsk(context);
        if (!ask) return;
        const input = readKnowledgeAskArguments(rest, true);
        const query = input.query;
        if (!query) {
          print(
            '[knowledge] Usage: /knowledge ask <query> [--space <knowledgeSpaceId>] [--limit <n>] [--mode <concise|standard|detailed>]',
          );
          return;
        }
        const result = await ask(input);
        print(renderKnowledgeAskResult(result));
        break;
      }

      default:
        print(
          [
            'Usage: /knowledge <subcommand>',
            '  status',
            '  ask <query> [--space <knowledgeSpaceId>] [--limit <n>] [--mode <concise|standard|detailed>]',
            '  ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>]',
            '  import-bookmarks <path>',
            '  import-urls <path>',
            '  list [--kind <sources|nodes|issues>] [--limit <n>]',
            '  search <query> [--limit <n>]',
            '  get <id>',
            '  queue [limit]',
            '  review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>]',
            '  candidates [limit]',
            '  reports [limit]',
            '  schedules',
            '  lint',
            '  packet <task...> [--scope <path> ...]',
            '  explain <task...> [--scope <path> ...]',
            '  reindex',
            '  consolidate [light|deep]',
          ].join('\n'),
        );
    }
  },
};
