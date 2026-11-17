import { handleKnowledgeMutationCommand, printKnowledgeIngestResult } from '@goodvibes-jev/engine/terminal-shell/knowledge-mutation-command';
import { handleKnowledgeReadCommand } from '@goodvibes-jev/engine/terminal-shell/knowledge-read-command';
import { readKnowledgeAskArguments } from '@goodvibes-jev/engine/terminal-shell/command-arguments';
import { readFlag, readStringListFlag, readPositiveIntFlag, positionalArgs } from '@goodvibes-jev/engine/terminal-shell/command-arguments';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { parseBrowserImportScope } from './knowledge-browser-flags.ts';
import { formatKnowledgeMap, renderKnowledgeAskResult } from './knowledge-format.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireAgentKnowledgeApi(context: CommandContext) {
  const knowledgeApi = context.clients?.agentKnowledgeApi;
  if (!knowledgeApi) {
    context.print(
      '[knowledge] Agent Knowledge API is not available in this runtime. Refusing to use default knowledge or non-Agent knowledge fallback.',
    );
    return null;
  }
  return knowledgeApi;
}

function findDisallowedKnowledgeScopeFlag(args: readonly string[]): string | null {
  const disallowed = [
    '--space',
    '--knowledge-space',
    '--knowledge-space-id',
    ['--knowledge', 'SpaceId'].join(''),
    '--include-all-spaces',
    ['--include', 'AllSpaces'].join(''),
    ['--home', 'graph'].join(''),
    ['--home', '-graph'].join(''),
  ];
  for (const token of args) {
    for (const flag of disallowed) {
      if (token === flag || token.startsWith(`${flag}=`)) return flag;
    }
  }
  return null;
}

function printScopeFlagRejection(context: CommandContext, flag: string): void {
  context.print(
    [
      `[knowledge] Agent Knowledge is isolated; ${flag} is not accepted.`,
      '[knowledge] GoodVibes Agent must not use default knowledge or non-Agent product spaces.',
      '[knowledge] Use only /api/goodvibes-agent/knowledge/* Agent-owned routes.',
    ].join('\n'),
  );
}

function parseConnectorInputFlag(args: string[]): unknown {
  const value = readFlag(args, '--input');
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export const knowledgeCommand: SlashCommand = {
  name: 'knowledge',
  effect: 'mixed',
  aliases: ['know'],
  description:
    'Agent Knowledge: isolated Agent-owned status, ask/search, source/node/issue lists, item lookup, map, connectors, ingest, and review queue.',
  hidden: true,
  usage: '<subcommand> [args]',
  argsHint:
    'status|ask|search|list|get|map|connectors|ingest-url --yes|ingest-file --yes|ingest-artifact --yes|import-urls --yes|import-bookmarks --yes|import-browser-history --yes|ingest-connector --yes|review-issue --yes|reindex --yes',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    if (args.length === 0 && context.openAgentWorkspace) {
      context.openAgentWorkspace('knowledge');
      return;
    }
    const knowledge = requireAgentKnowledgeApi(context);
    if (!knowledge) {
      return;
    }
    const sub = (args[0] ?? 'status').toLowerCase();
    const confirmation = stripYesFlag(args.slice(1));
    const rest = [...confirmation.rest];
    const disallowedScopeFlag = findDisallowedKnowledgeScopeFlag(rest);
    if (disallowedScopeFlag) {
      printScopeFlagRejection(context, disallowedScopeFlag);
      return;
    }
    // A knowledge read does not depend on the transcript: it carries the caller's
    // abort signal and its answer is printed once. A write is recorded under the
    // session it was asked in, so it is sent only while that session is still open.
    const sessionId = context.session.runtime.sessionId;
    const reading = { signal: context.judgmentReadingOptions?.signal };
    const print = (text: string): void => context.print(text);
    const sameSession = (): void => {
      if (context.session.runtime.sessionId !== sessionId)
        throw new Error('The session changed before this write was sent, so nothing was written. Run the command again in the session it belongs to.');
    };

    try {
      const answer = await handleKnowledgeReadCommand(
        sub,
        rest,
        {
          status: () => knowledge.status.get({}, reading),
          nodes: (limit) => knowledge.graph.nodes.list(limit, reading),
          issues: (limit) => knowledge.graph.issues.list(limit, reading),
          sources: (limit) => knowledge.sources.list(limit, reading),
          search: (query, limit) => knowledge.graph.items.search(query, limit, reading),
          get: (id) => knowledge.graph.items.get(id, {}, reading),
          lint: () => knowledge.status.lint(),
          packet: (query, scopes) => knowledge.packets.buildPrompt(query, scopes, undefined, reading),
          candidates: (limit) => knowledge.consolidation.candidates(limit),
          reports: (limit) => knowledge.consolidation.reports(limit),
          schedules: (limit) => knowledge.jobs.schedules.list(limit),
        },
        {
          statusTitle: '[knowledge] Agent Knowledge status',
          headingSuffix: '',
          fieldSeparator: ' ',
          scoreSeparator: ' ',
          nodeKind: 'type',
        },
      );
      if (answer) {
        // The one check of a read: the answer belongs to the session that asked.
        print(
          context.session.runtime.sessionId === sessionId
            ? answer.join('\n')
            : `[knowledge] The session changed while /knowledge ${sub} was reading, so its answer is not shown here. Run it again.`,
        );
        return;
      }
      if (
        await handleKnowledgeMutationCommand(
          sub,
          rest,
          print,
          {
            sessionId: () => sessionId,
            url: (input) => {
              sameSession();
              return knowledge.ingest.url(input);
            },
            bookmarksFile: (input) => {
              sameSession();
              return knowledge.ingest.bookmarksFile(input);
            },
            urlsFile: (input) => {
              sameSession();
              return knowledge.ingest.urlsFile(input);
            },
            review: (input) => {
              sameSession();
              return knowledge.graph.issues.review(input);
            },
            reindex: () => {
              sameSession();
              return knowledge.status.reindex();
            },
            run: (id, options) => {
              sameSession();
              return knowledge.jobs.run(id, options);
            },
            describeError: (error) => (error instanceof Error ? error.message : String(error)),
            allow(verb, subject, usage) {
              if (confirmation.yes) return true;
              const description =
                verb === 'ingest-url'
                  ? 'ingest URL into Agent Knowledge ' + subject
                  : verb === 'import-bookmarks'
                    ? 'import bookmark file into Agent Knowledge ' + subject
                    : verb === 'import-urls'
                      ? 'import URL list into Agent Knowledge ' + subject
                      : verb === 'review-issue'
                        ? 'review Agent Knowledge issue ' + subject
                        : verb === 'reindex'
                          ? 'reindex Agent Knowledge'
                          : 'run Agent Knowledge consolidation';
              requireYesFlag(context, description, usage + ' --yes');
              return false;
            },
          },
          { fieldSeparator: ' ', reviewer: 'agent', confirmationSuffix: ' --yes', sourceLabel: 'knowledge source' },
        )
      )
        return;
      switch (sub) {
        case 'ask': {
          const service = context.extensions.agentKnowledgeService;
          if (!service?.ask) {
            print(
              '[knowledge] Agent Knowledge ask is not available in this runtime. Refusing to use default knowledge or non-Agent knowledge fallback.',
            );
            return;
          }
          const input = readKnowledgeAskArguments(rest, false);
          const query = input.query;
          if (!query) {
            print('[knowledge] Usage: /knowledge ask <query> [--limit <n>] [--mode <concise|standard|detailed>]');
            return;
          }
          const result = await service.ask(input);
          print(renderKnowledgeAskResult(result));
          break;
        }

        case 'ingest-file': {
          const [path] = positionalArgs(rest, ['--title', '--tags', '--folder', '--connector']);
          if (!path) {
            print('[knowledge] Usage: /knowledge ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
            return;
          }
          if (!confirmation.yes) {
            requireYesFlag(
              context,
              `ingest file into Agent Knowledge ${path}`,
              '/knowledge ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
            );
            return;
          }
          sameSession();
          const result = await knowledge.ingest.artifact({
            path,
            title: readFlag(rest, '--title'),
            tags: readStringListFlag(rest, '--tags'),
            folderPath: readFlag(rest, '--folder'),
            sessionId,
            connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-file',
          });
          printKnowledgeIngestResult(print, result.source, path);
          if (result.source.summary) print(`  ${result.source.summary}`);
          if (result.artifactId) print(`  artifact: ${result.artifactId}`);
          break;
        }

        case 'ingest-artifact': {
          const [artifactId] = positionalArgs(rest, ['--title', '--tags', '--folder', '--connector']);
          if (!artifactId) {
            print('[knowledge] Usage: /knowledge ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes');
            return;
          }
          if (!confirmation.yes) {
            requireYesFlag(
              context,
              `ingest artifact into Agent Knowledge ${artifactId}`,
              '/knowledge ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
            );
            return;
          }
          sameSession();
          const result = await knowledge.ingest.artifact({
            artifactId,
            title: readFlag(rest, '--title'),
            tags: readStringListFlag(rest, '--tags'),
            folderPath: readFlag(rest, '--folder'),
            sessionId,
            connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-artifact-browser',
          });
          printKnowledgeIngestResult(print, result.source, artifactId);
          if (result.source.summary) print(`  ${result.source.summary}`);
          if (result.artifactId) print(`  artifact: ${result.artifactId}`);
          break;
        }

        case 'import-browser-history':
        case 'sync-browser-history': {
          if (!confirmation.yes) {
            requireYesFlag(
              context,
              'import browser history into Agent Knowledge',
              '/knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] [--limit <n>] [--since-days <n>] --yes',
            );
            return;
          }
          const scope = parseBrowserImportScope(rest, Date.now());
          if (!scope.ok) {
            print(`[knowledge] ${scope.message}`);
            return;
          }
          sameSession();
          const result = await knowledge.ingest.browserHistory({
            browsers: scope.scope.browsers,
            sourceKinds: scope.scope.sourceKinds,
            homeOverride: readFlag(rest, '--home'),
            limit: scope.scope.limit,
            sinceMs: scope.scope.sinceMs,
            connectorId: 'goodvibes-agent-browser-history',
            sessionId,
          });
          print(`[knowledge] Imported browser knowledge: ${result.imported} ok, ${result.failed} failed`);
          if (result.profiles.length > 0) print(`  profiles ${result.profiles.length}`);
          if (result.errors.length > 0) {
            for (const error of result.errors.slice(0, 10)) print(`  error ${error}`);
          }
          break;
        }

        case 'ingest-connector': {
          const [connectorId] = positionalArgs(rest, ['--input', '--path', '--content']);
          if (!connectorId) {
            print(
              '[knowledge] Usage: /knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes',
            );
            return;
          }
          const input = parseConnectorInputFlag(rest);
          const path = readFlag(rest, '--path');
          const content = readFlag(rest, '--content');
          if (input === undefined && !path && !content) {
            print(
              '[knowledge] Usage: /knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes',
            );
            return;
          }
          if (!confirmation.yes) {
            requireYesFlag(
              context,
              `ingest connector input into Agent Knowledge for ${connectorId}`,
              '/knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes',
            );
            return;
          }
          sameSession();
          const result = await knowledge.ingest.connectorInput({
            connectorId,
            input,
            path,
            content,
            sessionId,
            fetchMode: rest.includes('--allow-private-hosts') ? 'allow-private-hosts' : 'public-only',
          });
          print(`[knowledge] Imported connector input: ${result.imported} ok, ${result.failed} failed`);
          if (result.errors.length > 0) {
            for (const error of result.errors.slice(0, 10)) print(`  error ${error}`);
          }
          break;
        }

        case 'map': {
          const limit = readPositiveIntFlag(rest, '--limit', 50);
          const query = positionalArgs(rest, ['--limit']).join(' ').trim();
          const result = await knowledge.graph.map({ limit, ...(query.length > 0 ? { query } : {}) }, reading);
          print(formatKnowledgeMap(result));
          break;
        }

        case 'connectors': {
          const [first, second] = positionalArgs(rest);
          if (first === 'doctor') {
            if (!second) {
              print('[knowledge] Usage: /knowledge connectors doctor <connectorId>');
              return;
            }
            const report = await knowledge.connectors.doctor(second);
            if (!report) {
              print(`[knowledge] Connector doctor report unavailable ${second}`);
              return;
            }
            print(
              [
                `[knowledge] Connector doctor ${report.connectorId}`,
                `  ready: ${report.ready ? 'yes' : 'no'}`,
                `  summary: ${report.summary}`,
                ...(report.checks.length > 0
                  ? [
                      '  checks:',
                      ...report.checks.slice(0, 10).map((check) => `    - ${check.id} [${check.status}] ${check.label} - ${check.detail}`),
                    ]
                  : []),
                ...(report.hints.length > 0 ? ['  hints:', ...report.hints.slice(0, 8).map((hint) => `    - ${hint}`)] : []),
              ].join('\n'),
            );
            return;
          }
          if (first) {
            const connector = knowledge.connectors.get(first);
            if (!connector) {
              print(`[knowledge] Unknown connector ${first}`);
              return;
            }
            print(
              [
                `[knowledge] Connector ${connector.id}`,
                `  name ${connector.displayName ?? connector.id}`,
                `  source type ${connector.sourceType}`,
                `  description ${connector.description}`,
                `  capabilities: ${connector.capabilities?.join(', ') || 'none'}`,
              ].join('\n'),
            );
            return;
          }
          const connectors = knowledge.connectors.list();
          if (connectors.length === 0) {
            print('[knowledge] No connectors.');
            return;
          }
          print(`[knowledge] Connectors (${connectors.length})`);
          for (const connector of connectors) {
            print(`  ${connector.id} [${connector.sourceType}] ${connector.displayName ?? connector.id}`);
            print(`    ${connector.description}`);
          }
          break;
        }

        default:
          print(
            [
              'Usage: /knowledge <subcommand>',
              '  status',
              '  ask <query> [--limit <n>] [--mode <concise|standard|detailed>]',
              '  ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
              '  ingest-file <path> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
              '  ingest-artifact <artifactId> [--title <title>] [--tags <a,b>] [--folder <path>] --yes',
              '  ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes',
              '  import-bookmarks <path> --yes',
              '  import-urls <path> --yes',
              '  import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] [--limit <n>] [--since-days <n>] --yes',
              '  list [--kind <sources|nodes|issues>] [--limit <n>]',
              '  search <query> [--limit <n>]',
              '  get <id>',
              '  map [query] [--limit <n>]',
              '  queue [limit]',
              '  review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>] --yes',
              '  candidates [limit]',
              '  connectors [connectorId|doctor <connectorId>]',
              '  reports [limit]',
              '  schedules',
              '  lint',
              '  packet <task...> [--scope <path> ...]',
              '  explain <task...> [--scope <path> ...]',
              '  reindex --yes',
              '  consolidate [light|deep] --yes',
            ].join('\n'),
          );
      }
    } catch (error) {
      print(`[knowledge] ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
