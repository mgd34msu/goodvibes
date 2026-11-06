import { handleKnowledgeMutationCommand } from '@goodvibes-jev/engine/terminal-shell/knowledge-mutation-command';
import { handleKnowledgeReadCommand } from '@goodvibes-jev/engine/terminal-shell/knowledge-read-command';
import { readKnowledgeAskArguments } from '@goodvibes-jev/engine/terminal-shell/command-arguments';
import { readFlag, readStringListFlag, readPositiveIntFlag, positionalArgs } from '@goodvibes-jev/engine/terminal-shell/command-arguments';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { toBrowserKinds, toBrowserSourceKinds } from './knowledge-browser-flags.ts';
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

function readFirstStringListFlag(args: string[], names: readonly string[]): string[] {
  for (const name of names) {
    const values = readStringListFlag(args, name);
    if (values.length > 0) return values;
  }
  return [];
}

function readSinceMsFlag(args: string[]): number | undefined {
  const raw = readFlag(args, '--since-days');
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Date.now() - parsed * 24 * 60 * 60 * 1000;
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

function retainKnowledgeCommand(
  context: CommandContext,
  args: readonly string[],
  knowledge: NonNullable<NonNullable<CommandContext['clients']>['agentKnowledgeApi']>,
) {
  const session = context.session,
    runtime = session.runtime,
    sessionId = runtime.sessionId;
  const conversation = session.conversationManager,
    getSnapshot = conversation.getMessageSnapshot;
  const messages = typeof getSnapshot === 'function' ? JSON.stringify(getSnapshot.call(conversation)) : undefined;
  const clients = context.clients,
    extensions = context.extensions,
    output = context.print,
    invokedByModel = context.invokedByModel;
  const service = extensions.agentKnowledgeService;
  const originalArgs = [...args];
  const supplied = context.judgmentReadingOptions,
    signal = supplied?.signal;
  const callerCurrent = supplied?.assertCurrent,
    shouldStop = supplied?.shouldStop;
  const operations: (() => void)[] = [];
  const changed = () => new Error('Agent Knowledge command is no longer current.');
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const current: unknown = callerCurrent?.();
    if (current !== undefined) {
      drainOwned(current);
      throw changed();
    }
    if (shouldStop) {
      const stopped: unknown = shouldStop();
      if (stopped !== false) {
        drainOwned(stopped);
        throw changed();
      }
    }
    signal?.throwIfAborted();
    if (
      context.judgmentReadingOptions !== supplied ||
      supplied?.signal !== signal ||
      supplied?.assertCurrent !== callerCurrent ||
      supplied?.shouldStop !== shouldStop ||
      context.session !== session ||
      session.runtime !== runtime ||
      runtime.sessionId !== sessionId ||
      session.conversationManager !== conversation ||
      conversation.getMessageSnapshot !== getSnapshot ||
      (typeof getSnapshot === 'function' && JSON.stringify(getSnapshot.call(conversation)) !== messages) ||
      context.clients !== clients ||
      clients?.agentKnowledgeApi !== knowledge ||
      context.extensions !== extensions ||
      extensions.agentKnowledgeService !== service ||
      context.print !== output ||
      context.invokedByModel !== invokedByModel ||
      args.length !== originalArgs.length ||
      args.some((arg, index) => arg !== originalArgs[index])
    )
      throw changed();
    for (const check of operations) check();
    signal?.throwIfAborted();
  };
  const options = { signal, assertCurrent, shouldStop };
  return {
    assertCurrent,
    print(text: string) {
      assertCurrent();
      output.call(context, text);
    },
    retain<Owner extends object, Key extends keyof Owner>(owner: Owner, key: Key, getOwner: () => Owner | undefined) {
      const method = owner[key];
      operations.push(() => {
        if (getOwner() !== owner || owner[key] !== method) throw changed();
      });
      assertCurrent();
      return { owner, method, options, assertCurrent };
    },
  };
}

export const knowledgeCommand: SlashCommand = {
  name: 'knowledge',
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
    const command = retainKnowledgeCommand(context, args, knowledge);
    const print = command.print;

    try {
      command.assertCurrent();
      command.assertCurrent();
      if (
        await handleKnowledgeReadCommand(
          sub,
          rest,
          print,
          {
            status: async () => {
              const read = command.retain(knowledge.status, 'get', () => knowledge.status);
              const result = await read.method.call(read.owner, {}, read.options);
              read.assertCurrent();
              return result;
            },
            nodes: async (limit) => {
              const read = command.retain(knowledge.graph.nodes, 'list', () => knowledge.graph.nodes);
              const result = await read.method.call(read.owner, limit, read.options);
              read.assertCurrent();
              return result;
            },
            issues: async (limit) => {
              const read = command.retain(knowledge.graph.issues, 'list', () => knowledge.graph.issues);
              const result = await read.method.call(read.owner, limit, read.options);
              read.assertCurrent();
              return result;
            },
            sources: async (limit) => {
              const read = command.retain(knowledge.sources, 'list', () => knowledge.sources);
              const result = await read.method.call(read.owner, limit, read.options);
              read.assertCurrent();
              return result;
            },
            search: async (query, limit) => {
              const read = command.retain(knowledge.graph.items, 'search', () => knowledge.graph.items);
              const result = await read.method.call(read.owner, query, limit, read.options);
              read.assertCurrent();
              return result;
            },
            get: async (id) => {
              const read = command.retain(knowledge.graph.items, 'get', () => knowledge.graph.items);
              const result = await read.method.call(read.owner, id, {}, read.options);
              read.assertCurrent();
              return result;
            },
            lint: async () => {
              const read = command.retain(knowledge.status, 'lint', () => knowledge.status);
              const result = await read.method.call(read.owner);
              read.assertCurrent();
              return result;
            },
            packet: async (query, scopes) => {
              const read = command.retain(knowledge.packets, 'buildPrompt', () => knowledge.packets);
              const result = await read.method.call(read.owner, query, scopes, undefined, read.options);
              read.assertCurrent();
              return result;
            },
            candidates: (limit) => knowledge.consolidation.candidates(limit),
            reports: (limit) => knowledge.consolidation.reports(limit),
            schedules: (limit) => knowledge.jobs.schedules.list(limit),
            assertCurrent: command.assertCurrent,
          },
          {
            statusTitle: '[knowledge] Agent Knowledge status',
            headingSuffix: '',
            fieldSeparator: ' ',
            scoreSeparator: ' ',
            nodeKind: 'type',
          },
        )
      )
        return;
      command.assertCurrent();
      if (
        await handleKnowledgeMutationCommand(
          sub,
          rest,
          print,
          {
            sessionId: () => context.session.runtime.sessionId,
            url: async (input) => {
              const operation = command.retain(knowledge.ingest, 'url', () => knowledge.ingest);
              const result = await operation.method.call(operation.owner, input);
              operation.assertCurrent();
              return result;
            },
            bookmarksFile: async (input) => {
              const operation = command.retain(knowledge.ingest, 'bookmarksFile', () => knowledge.ingest);
              const result = await operation.method.call(operation.owner, input);
              operation.assertCurrent();
              return result;
            },
            urlsFile: async (input) => {
              const operation = command.retain(knowledge.ingest, 'urlsFile', () => knowledge.ingest);
              const result = await operation.method.call(operation.owner, input);
              operation.assertCurrent();
              return result;
            },
            review: async (input) => {
              const operation = command.retain(knowledge.graph.issues, 'review', () => knowledge.graph.issues);
              const result = await operation.method.call(operation.owner, input);
              operation.assertCurrent();
              return result;
            },
            reindex: async () => {
              const operation = command.retain(knowledge.status, 'reindex', () => knowledge.status);
              const result = await operation.method.call(operation.owner);
              operation.assertCurrent();
              return result;
            },
            run: async (id, options) => {
              const operation = command.retain(knowledge.jobs, 'run', () => knowledge.jobs);
              const result = await operation.method.call(operation.owner, id, options);
              operation.assertCurrent();
              return result;
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
      command.assertCurrent();
      switch (sub) {
        case 'ask': {
          const service = context.extensions.agentKnowledgeService;
          if (!service?.ask) {
            print(
              '[knowledge] Agent Knowledge ask is not available in this runtime. Refusing to use default knowledge or non-Agent knowledge fallback.',
            );
            return;
          }
          const ask = command.retain(service, 'ask', () => context.extensions.agentKnowledgeService);
          const input = readKnowledgeAskArguments(rest, false);
          const query = input.query;
          if (!query) {
            print('[knowledge] Usage: /knowledge ask <query> [--limit <n>] [--mode <concise|standard|detailed>]');
            return;
          }
          const result = await ask.method.call(ask.owner, input);
          ask.assertCurrent();
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
          const ingest = command.retain(knowledge.ingest, 'artifact', () => knowledge.ingest);
          const result = await ingest.method.call(ingest.owner, {
            path,
            title: readFlag(rest, '--title'),
            tags: readStringListFlag(rest, '--tags'),
            folderPath: readFlag(rest, '--folder'),
            sessionId: context.session.runtime.sessionId,
            connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-file',
          });
          ingest.assertCurrent();
          print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? path}`);
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
          const ingest = command.retain(knowledge.ingest, 'artifact', () => knowledge.ingest);
          const result = await ingest.method.call(ingest.owner, {
            artifactId,
            title: readFlag(rest, '--title'),
            tags: readStringListFlag(rest, '--tags'),
            folderPath: readFlag(rest, '--folder'),
            sessionId: context.session.runtime.sessionId,
            connectorId: readFlag(rest, '--connector') ?? 'goodvibes-agent-artifact-browser',
          });
          ingest.assertCurrent();
          print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? artifactId}`);
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
          const ingest = command.retain(knowledge.ingest, 'browserHistory', () => knowledge.ingest);
          const result = await ingest.method.call(ingest.owner, {
            browsers: toBrowserKinds(readFirstStringListFlag(rest, ['--browsers', '--browser'])),
            sourceKinds: toBrowserSourceKinds(readFirstStringListFlag(rest, ['--sources', '--source-kinds', '--source-kind'])),
            homeOverride: readFlag(rest, '--home'),
            limit: readPositiveIntFlag(rest, '--limit', 250),
            sinceMs: readSinceMsFlag(rest),
            connectorId: 'goodvibes-agent-browser-history',
            sessionId: context.session.runtime.sessionId,
          });
          ingest.assertCurrent();
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
          const ingest = command.retain(knowledge.ingest, 'connectorInput', () => knowledge.ingest);
          const result = await ingest.method.call(ingest.owner, {
            connectorId,
            input,
            path,
            content,
            sessionId: context.session.runtime.sessionId,
            allowPrivateHosts: rest.includes('--allow-private-hosts'),
          });
          ingest.assertCurrent();
          print(`[knowledge] Imported connector input: ${result.imported} ok, ${result.failed} failed`);
          if (result.errors.length > 0) {
            for (const error of result.errors.slice(0, 10)) print(`  error ${error}`);
          }
          break;
        }

        case 'map': {
          const limit = readPositiveIntFlag(rest, '--limit', 50);
          const query = positionalArgs(rest, ['--limit']).join(' ').trim();
          const read = command.retain(knowledge.graph, 'map', () => knowledge.graph);
          const result = await read.method.call(
            read.owner,
            {
              limit,
              ...(query.length > 0 ? { query } : {}),
            },
            read.options,
          );
          read.assertCurrent();
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
            const read = command.retain(knowledge.connectors, 'doctor', () => knowledge.connectors);
            const report = await read.method.call(read.owner, second);
            read.assertCurrent();
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
      try {
        command.assertCurrent();
      } catch {
        return;
      }
      print(`[knowledge] ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
