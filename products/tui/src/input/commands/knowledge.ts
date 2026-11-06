import { readKnowledgeTaskArguments, readKnowledgeAskArguments } from '@goodvibes-jev/engine/terminal-shell/command-arguments';
import { createKnowledgeAnswerRenderer } from '@goodvibes-jev/engine/terminal-shell/knowledge-answer';
import { readFlag, readStringListFlag, readJsonObjectFlag, positionalArgs } from '@goodvibes-jev/engine/terminal-shell/command-arguments';
import { createKnowledgeLabels } from '@goodvibes-jev/engine/terminal-shell/knowledge-labels';
const { nodeLabel } = createKnowledgeLabels(' confidence=');
import type { KnowledgeService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';

const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'] as const;

type KnowledgeReviewAction = (typeof KNOWLEDGE_REVIEW_ACTIONS)[number];
type KnowledgeAskInput = Parameters<KnowledgeService['ask']>[0];
type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;
type KnowledgeAskMode = NonNullable<KnowledgeAskInput['mode']>;

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

      case 'status': {
        const status = await knowledge.status.get();
        print(
          [
            '[knowledge] Structured knowledge status',
            `  ready: ${status.ready ? 'yes' : 'no'}`,
            `  storage: ${status.storagePath}`,
            `  sources: ${status.sourceCount}`,
            `  nodes: ${status.nodeCount}`,
            `  edges: ${status.edgeCount}`,
            `  issues: ${status.issueCount}`,
          ].join('\n'),
        );
        break;
      }

      case 'ingest-url': {
        const [url] = positionalArgs(rest, ['--title', '--tags', '--folder']);
        if (!url) {
          print('[knowledge] Usage: /knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>]');
          return;
        }
        const result = await knowledge.ingest.url({
          url,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          sourceType: 'url',
          connectorId: 'url',
        });
        print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? url}`);
        if (result.source.summary) print(`  ${result.source.summary}`);
        if (result.artifactId) print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'import-bookmarks': {
        const [path] = positionalArgs(rest);
        if (!path) {
          print('[knowledge] Usage: /knowledge import-bookmarks <path>');
          return;
        }
        const result = await knowledge.ingest.bookmarksFile({ path, sessionId: context.session.runtime.sessionId });
        print(`[knowledge] Imported bookmarks: ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) print(`  error: ${error}`);
        }
        break;
      }

      case 'import-urls': {
        const [path] = positionalArgs(rest);
        if (!path) {
          print('[knowledge] Usage: /knowledge import-urls <path>');
          return;
        }
        const result = await knowledge.ingest.urlsFile({ path, sessionId: context.session.runtime.sessionId });
        print(`[knowledge] Imported URL list: ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) print(`  error: ${error}`);
        }
        break;
      }

      case 'list': {
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const kind = (readFlag(rest, '--kind') ?? 'sources').toLowerCase();
        if (kind === 'nodes') {
          const nodes = await knowledge.graph.nodes.list(limit, readingOptions);
          assertCurrent();
          if (nodes.length === 0) {
            print('[knowledge] No nodes.');
            return;
          }
          print(`[knowledge] ${nodes.length} node(s):`);
          for (const node of nodes) {
            print(`  ${node.id} [${node.kind}] ${node.title}`);
            if (node.summary) print(`    ${node.summary}`);
          }
          return;
        }
        if (kind === 'issues') {
          const issues = await knowledge.graph.issues.list(limit, readingOptions);
          assertCurrent();
          if (issues.length === 0) {
            print('[knowledge] No issues.');
            return;
          }
          print(`[knowledge] ${issues.length} issue(s):`);
          for (const issue of issues) {
            print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
            print(`    ${issue.message}`);
          }
          return;
        }
        const sources = await knowledge.sources.list(limit, readingOptions);
        assertCurrent();
        if (sources.length === 0) {
          print('[knowledge] No sources.');
          return;
        }
        print(`[knowledge] ${sources.length} source(s):`);
        for (const source of sources) {
          print(
            `  ${source.id} [${source.sourceType}/${source.status}] ${source.title ?? source.canonicalUri ?? source.sourceUri ?? 'untitled'}`,
          );
          if (source.summary) print(`    ${source.summary}`);
        }
        break;
      }

      case 'search': {
        const valuedFlags = ['--limit'];
        const query = positionalArgs(rest, valuedFlags).join(' ').trim();
        if (!query) {
          print('[knowledge] Usage: /knowledge search <query> [--limit <n>]');
          return;
        }
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const results = await knowledge.graph.items.search(query, limit);
        assertCurrent();
        if (results.length === 0) {
          print('[knowledge] No results.');
          return;
        }
        print(`[knowledge] ${results.length} result(s):`);
        for (const result of results) {
          const title = result.source?.title ?? result.source?.canonicalUri ?? result.node?.title ?? result.id;
          print(`  ${result.id} [${result.kind}] score=${result.score} ${title}`);
          print(`    ${result.reason}`);
        }
        break;
      }

      case 'get': {
        const [id] = positionalArgs(rest);
        if (!id) {
          print('[knowledge] Usage: /knowledge get <id>');
          return;
        }
        const item = await knowledge.graph.items.get(id, {}, readingOptions);
        assertCurrent();
        if (!item) {
          print(`[knowledge] Unknown item: ${id}`);
          return;
        }
        if (item.source) {
          print(`[knowledge] source ${item.source.id}`);
          print(`  title: ${item.source.title ?? 'untitled'}`);
          print(`  uri: ${item.source.canonicalUri ?? item.source.sourceUri ?? 'n/a'}`);
          print(`  status: ${item.source.status}`);
          if (item.source.summary) print(`  summary: ${item.source.summary}`);
        } else if (item.node) {
          print(`[knowledge] node ${item.node.id}`);
          print(`  kind: ${item.node.kind}`);
          print(`  title: ${item.node.title}`);
          if (item.node.summary) print(`  summary: ${item.node.summary}`);
        } else if (item.issue) {
          print(`[knowledge] issue ${item.issue.id}`);
          print(`  severity: ${item.issue.severity}`);
          print(`  code: ${item.issue.code}`);
          print(`  message: ${item.issue.message}`);
        }
        if (item.relatedEdges.length > 0) {
          print('  relations:');
          for (const edge of item.relatedEdges.slice(0, 12)) {
            print(`    ${edge.fromKind}:${edge.fromId} -[${edge.relation}]-> ${edge.toKind}:${edge.toId}`);
          }
        }
        break;
      }

      case 'lint': {
        const issues = await knowledge.status.lint();
        if (issues.length === 0) {
          print('[knowledge] No lint issues.');
          return;
        }
        print(`[knowledge] ${issues.length} lint issue(s):`);
        for (const issue of issues) {
          print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          print(`    ${issue.message}`);
        }
        break;
      }

      case 'queue': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const issues = await knowledge.graph.issues.list(limit, readingOptions);
        assertCurrent();
        if (issues.length === 0) {
          print('Knowledge review queue is empty.');
          return;
        }
        print(`[knowledge] Review queue (${issues.length}):`);
        for (const issue of issues) {
          print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          print(`    ${issue.message}`);
        }
        break;
      }

      case 'review-issue':
      case 'issue-review': {
        const [issueId, actionValue] = positionalArgs(rest, ['--reviewer', '--value']);
        const action = actionValue?.toLowerCase();
        if (!issueId || !action || !KNOWLEDGE_REVIEW_ACTIONS.includes(action as KnowledgeReviewAction)) {
          print(
            '[knowledge] Usage: /knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>]',
          );
          return;
        }
        const value = readJsonObjectFlag(rest, '--value');
        if (value === null) {
          print('[knowledge] --value must be a JSON object.');
          return;
        }
        try {
          const result = await knowledge.graph.issues.review({
            issueId,
            action: action as KnowledgeReviewAction,
            reviewer: readFlag(rest, '--reviewer') ?? 'tui',
            ...(value ? { value } : {}),
          });
          print(
            [
              `[knowledge] Reviewed issue ${result.issue.id}`,
              `  action: ${action}`,
              `  status: ${result.issue.status}`,
              ...(result.node ? [`  node: ${result.node.id} ${result.node.title}`] : []),
              ...(result.source
                ? [
                    `  source: ${result.source.id} ${result.source.title ?? result.source.canonicalUri ?? result.source.sourceUri ?? 'untitled'}`,
                  ]
                : []),
              ...(result.appliedFacts ? [`  applied facts: ${Object.keys(result.appliedFacts).join(', ') || 'none'}`] : []),
            ].join('\n'),
          );
        } catch (error) {
          print(`[knowledge] ${summarizeError(error)}`);
        }
        break;
      }

      case 'candidates': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const candidates = knowledge.consolidation.candidates(limit);
        if (candidates.length === 0) {
          print('[knowledge] No consolidation candidates.');
          return;
        }
        print(`[knowledge] Consolidation candidates (${candidates.length}):`);
        for (const candidate of candidates) {
          print(`  ${candidate.id} [${candidate.status}] score=${candidate.score} ${candidate.title}`);
          print(`    ${candidate.candidateType}`);
        }
        break;
      }

      case 'reports': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const reports = knowledge.consolidation.reports(limit);
        if (reports.length === 0) {
          print('[knowledge] No consolidation reports.');
          return;
        }
        print(`[knowledge] Consolidation reports (${reports.length}):`);
        for (const report of reports) {
          print(`  ${report.id} [${report.kind}] ${report.title}`);
          print(`    ${report.summary}`);
        }
        break;
      }

      case 'schedules': {
        const schedules = knowledge.jobs.schedules.list(20);
        if (schedules.length === 0) {
          print('[knowledge] No knowledge schedules.');
          return;
        }
        print(`[knowledge] Managed schedules (${schedules.length}):`);
        for (const schedule of schedules) {
          print(`  ${schedule.id} [${schedule.enabled ? 'enabled' : 'disabled'}] ${schedule.jobId}`);
          print(`    ${schedule.label}`);
        }
        break;
      }

      case 'packet': {
        const { scopeValues, query } = readKnowledgeTaskArguments(rest);
        if (!query) {
          print('[knowledge] Usage: /knowledge packet <task...> [--scope <path> ...]');
          return;
        }
        const prompt = await knowledge.packets.buildPrompt(query, scopeValues);
        print(prompt ?? '[knowledge] No structured knowledge matched that task.');
        break;
      }

      case 'explain': {
        const { scopeValues, query } = readKnowledgeTaskArguments(rest);
        if (!query) {
          print('[knowledge] Usage: /knowledge explain <task...> [--scope <path> ...]');
          return;
        }
        const prompt = await knowledge.packets.buildPrompt(query, scopeValues);
        print(prompt ?? '[knowledge] No structured knowledge matched that task.');
        break;
      }

      case 'reindex': {
        const result = await knowledge.status.reindex();
        print(
          [
            '[knowledge] Reindex complete',
            `  sources: ${result.status.sourceCount}`,
            `  nodes: ${result.status.nodeCount}`,
            `  edges: ${result.status.edgeCount}`,
            `  issues: ${result.status.issueCount}`,
          ].join('\n'),
        );
        break;
      }

      case 'consolidate': {
        const mode = (positionalArgs(rest)[0] ?? 'light').toLowerCase();
        const jobId = mode === 'deep' ? 'knowledge-deep-consolidation' : 'knowledge-light-consolidation';
        const run = await knowledge.jobs.run(jobId, { mode: 'inline' });
        print(`[knowledge] Consolidation run ${run.id} finished with status ${run.status}.`);
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
