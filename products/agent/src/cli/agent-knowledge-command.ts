import { resolve } from 'node:path';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import {
  commandValues,
  delegationTaskValues,
  hasAnyFlag,
  hasFlag,
  parseConnectorInput,
  readOptionValue,
  readPositiveInt,
  readStringList,
  stripCommandFlag,
} from './agent-knowledge-args.ts';
import { parseBrowserImportScope } from '../input/commands/knowledge-browser-flags.ts';
import {
  formatAsk,
  formatAgentKnowledgeFailureKind,
  formatBatchIngest,
  formatConnector,
  formatConnectorDoctor,
  formatConnectors,
  formatEntityList,
  formatFailure,
  formatIngest,
  formatItem,
  formatMap,
  formatReindex,
  reindexFailures,
  formatSearch,
  formatStatus,
  isAgentKnowledgeRecord as isRecord,
  AGENT_KNOWLEDGE_METHODS,
  DELEGATION_METHOD,
  createAgentPlatform,
  findDisallowedKnowledgeScopeFlag,
  formatScopeFlagRejection,
  getAgentKnowledgeJson,
  postAgentKnowledgeJson,
  runKnowledgeCall,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { inspectCliExternalRuntime } from './external-runtime.ts';
import { VERSION } from '../version.ts';
import { formatJsonOrText, yesNo } from '@goodvibes-jev/engine/terminal-shell/cli-output';

interface DelegationResult {
  readonly sessionId: string;
  readonly message: unknown;
  readonly task: string;
  readonly reviewRequested: boolean;
}

function itemWasFound(data: unknown): boolean {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  return Boolean(record.source || record.node || record.issue);
}

function buildDelegationBody(task: string, reviewRequested: boolean): string {
  return [
    'GoodVibes Agent explicit build delegation.',
    '',
    'Original user ask',
    task,
    '',
    'Agent policy',
    '- GoodVibes Agent is not the coding TUI.',
    '- Preserve the full original ask.',
    '- GoodVibes TUI owns file edits, git/worktree flows, execution isolation UX, and any delegated review owner chain.',
    reviewRequested
      ? '- Delegated review was explicitly requested by the Agent user for this build/fix/review handoff.'
      : '- Delegated review was not explicitly requested; do not add review solely because this came from Agent.',
  ].join('\n');
}

export async function handleAgentKnowledgeCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'status', ...rawRest] = runtime.cli.commandArgs;
  const confirmation = stripCommandFlag(rawRest, '--yes');
  const rest = confirmation.rest;
  const normalized = sub.toLowerCase();
  const json = runtime.cli.flags.outputFormat === 'json';
  const disallowedScopeFlag = findDisallowedKnowledgeScopeFlag(rest);
  if (disallowedScopeFlag) {
    const failure = {
      ok: false,
      kind: 'agent_knowledge_scope_rejected',
      error: formatScopeFlagRejection(disallowedScopeFlag),
      route: '/api/goodvibes-agent/knowledge/*',
    };
    return {
      output: json ? JSON.stringify(failure, null, 2) : failure.error,
      exitCode: 2,
    };
  }

  if (normalized === 'status') {
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.status, async (connection) => (
      await createAgentPlatform(connection).knowledge.status()
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatStatus(result.data)),
      exitCode: 0,
    };
  }

  if (normalized === 'ask') {
    const query = commandValues(rest).join(' ').trim();
    if (!query) return { output: 'Usage: goodvibes-agent knowledge ask <question> [--limit <n>] [--mode concise|standard|detailed]', exitCode: 2 };
    const mode = readOptionValue(rest, '--mode');
    if (mode !== undefined && mode !== 'concise' && mode !== 'standard' && mode !== 'detailed') {
      return { output: `Unknown --mode ${mode}. Use concise, standard or detailed.\nUsage: goodvibes-agent knowledge ask <question> [--limit <n>] [--mode concise|standard|detailed]`, exitCode: 2 };
    }
    const selectedMode = mode ?? 'standard';
    const limit = readPositiveInt(rest, '--limit', 8);
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.ask, async (connection) => (
      await createAgentPlatform(connection).knowledge.ask({
        query,
        limit,
        mode: selectedMode,
        includeSources: true,
        includeConfidence: true,
        includeLinkedObjects: true,
      })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatAsk(result.data, query)),
      exitCode: 0,
    };
  }

  if (normalized === 'search') {
    const query = commandValues(rest).join(' ').trim();
    if (!query) return { output: 'Usage: goodvibes-agent knowledge search <query> [--limit <n>]', exitCode: 2 };
    const limit = readPositiveInt(rest, '--limit', 10);
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.search, async (connection) => (
      await createAgentPlatform(connection).knowledge.search({ query, limit })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatSearch(result.data, query)),
      exitCode: 0,
    };
  }

  if (normalized === 'list' || normalized === 'sources' || normalized === 'nodes' || normalized === 'issues') {
    const requestedKind = normalized === 'list' ? (readOptionValue(rest, '--kind') ?? 'sources').toLowerCase() : normalized;
    const kind = requestedKind === 'nodes' || requestedKind === 'issues' ? requestedKind : 'sources';
    const limit = readPositiveInt(rest, '--limit', 10);
    const method = kind === 'sources'
      ? AGENT_KNOWLEDGE_METHODS.sourcesList
      : kind === 'nodes'
        ? AGENT_KNOWLEDGE_METHODS.nodesList
        : AGENT_KNOWLEDGE_METHODS.issuesList;
    const result = await runKnowledgeCall(runtime, method, async (connection) => (
      await getAgentKnowledgeJson(connection, method.route, { limit })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatEntityList(result.data, kind, limit)),
      exitCode: 0,
    };
  }

  if (normalized === 'get') {
    const [id] = commandValues(rest);
    if (!id) return { output: 'Usage: goodvibes-agent knowledge get <source|node|issue id>', exitCode: 2 };
    const route = `/api/goodvibes-agent/knowledge/items/${encodeURIComponent(id)}`;
    const result = await runKnowledgeCall(runtime, { ...AGENT_KNOWLEDGE_METHODS.itemGet, route }, async (connection) => (
      await getAgentKnowledgeJson(connection, route)
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatItem(result.data, id)),
      exitCode: itemWasFound(result.data) ? 0 : 1,
    };
  }

  if (normalized === 'map') {
    const limit = readPositiveInt(rest, '--limit', 50);
    const query = commandValues(rest).join(' ').trim();
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.map, async (connection) => (
      await getAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.map.route, { limit, query, includeIssues: true })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatMap(result.data)),
      exitCode: 0,
    };
  }

  if (normalized === 'connectors') {
    const values = commandValues(rest);
    if (values[0] === 'doctor') {
      const id = values[1];
      if (!id) return { output: 'Usage: goodvibes-agent knowledge connectors doctor <connectorId>', exitCode: 2 };
      const route = `/api/goodvibes-agent/knowledge/connectors/${encodeURIComponent(id)}/doctor`;
      const result = await runKnowledgeCall(runtime, { ...AGENT_KNOWLEDGE_METHODS.connectorDoctor, route }, async (connection) => (
        await getAgentKnowledgeJson(connection, route)
      ));
      if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
      return {
        output: formatJsonOrText(runtime.cli)(result, formatConnectorDoctor(result.data, id)),
        exitCode: 0,
      };
    }
    const id = values[0];
    if (id) {
      const route = `/api/goodvibes-agent/knowledge/connectors/${encodeURIComponent(id)}`;
      const result = await runKnowledgeCall(runtime, { ...AGENT_KNOWLEDGE_METHODS.connectorGet, route }, async (connection) => (
        await getAgentKnowledgeJson(connection, route)
      ));
      if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
      return {
        output: formatJsonOrText(runtime.cli)(result, formatConnector(result.data, id)),
        exitCode: 0,
      };
    }
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.connectorsList, async (connection) => (
      await getAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.connectorsList.route)
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatConnectors(result.data)),
      exitCode: 0,
    };
  }

  if (normalized === 'connector' || normalized === 'connector-get') {
    const [id] = commandValues(rest);
    if (!id) return { output: 'Usage: goodvibes-agent knowledge connector <connectorId>', exitCode: 2 };
    const route = `/api/goodvibes-agent/knowledge/connectors/${encodeURIComponent(id)}`;
    const result = await runKnowledgeCall(runtime, { ...AGENT_KNOWLEDGE_METHODS.connectorGet, route }, async (connection) => (
      await getAgentKnowledgeJson(connection, route)
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatConnector(result.data, id)),
      exitCode: 0,
    };
  }

  if (normalized === 'connector-doctor' || normalized === 'doctor-connector') {
    const [id] = commandValues(rest);
    if (!id) return { output: 'Usage: goodvibes-agent knowledge connector-doctor <connectorId>', exitCode: 2 };
    const route = `/api/goodvibes-agent/knowledge/connectors/${encodeURIComponent(id)}/doctor`;
    const result = await runKnowledgeCall(runtime, { ...AGENT_KNOWLEDGE_METHODS.connectorDoctor, route }, async (connection) => (
      await getAgentKnowledgeJson(connection, route)
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatConnectorDoctor(result.data, id)),
      exitCode: 0,
    };
  }

  if (normalized === 'ingest-url') {
    const values = commandValues(rest);
    const url = values[0];
    if (!url) return { output: 'Usage: goodvibes-agent knowledge ingest-url <url> [--title <title>] [--tags a,b] --yes', exitCode: 2 };
    if (!confirmation.present) {
      const failure = {
        ok: false,
        kind: 'confirmation_required',
        error: `Refusing to ingest URL into Agent Knowledge ${url} without --yes.`,
        route: AGENT_KNOWLEDGE_METHODS.ingestUrl.route,
      };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge ingest-url <url> [--title <title>] [--tags a,b] --yes`,
        exitCode: 2,
      };
    }
    const title = readOptionValue(rest, '--title');
    const tags = readStringList(rest, '--tags');
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.ingestUrl, async (connection) => (
      await postAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.ingestUrl.route, {
        url,
        title,
        tags,
        sourceType: 'url',
        connectorId: 'goodvibes-agent-cli',
      })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatIngest(result.data, url)),
      exitCode: 0,
    };
  }

  if (normalized === 'ingest-file') {
    const values = commandValues(rest);
    const path = values[0];
    if (!path) return { output: 'Usage: goodvibes-agent knowledge ingest-file <path> [--title <title>] [--tags a,b] [--folder <path>] --yes', exitCode: 2 };
    if (!confirmation.present) {
      const failure = {
        ok: false,
        kind: 'confirmation_required',
        error: `Refusing to ingest file into Agent Knowledge ${path} without --yes.`,
        route: AGENT_KNOWLEDGE_METHODS.ingestArtifact.route,
      };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge ingest-file <path> [--title <title>] [--tags a,b] [--folder <path>] --yes`,
        exitCode: 2,
      };
    }
    const title = readOptionValue(rest, '--title');
    const tags = readStringList(rest, '--tags');
    const folderPath = readOptionValue(rest, '--folder');
    const connectorId = readOptionValue(rest, '--connector') ?? 'goodvibes-agent-file';
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.ingestArtifact, async (connection) => (
      await postAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.ingestArtifact.route, {
        // The host resolves a relative path against its own directory, so send
        // the one this command was started in.
        path: resolve(runtime.workingDirectory, path),
        title,
        tags,
        folderPath,
        connectorId,
        allowPrivateHosts: hasFlag(rest, '--allow-private-hosts'),
        metadata: { originSurface: 'goodvibes-agent-cli' },
      })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatIngest(
        result.data,
        path,
        'ingest-file',
        '/api/goodvibes-agent/knowledge/ingest/artifact',
        'file',
      )),
      exitCode: 0,
    };
  }

  if (normalized === 'ingest-artifact') {
    const values = commandValues(rest);
    const artifactId = values[0];
    if (!artifactId) return { output: 'Usage: goodvibes-agent knowledge ingest-artifact <artifactId> [--title <title>] [--tags a,b] [--folder <path>] --yes', exitCode: 2 };
    if (!confirmation.present) {
      const failure = {
        ok: false,
        kind: 'confirmation_required',
        error: `Refusing to ingest artifact into Agent Knowledge ${artifactId} without --yes.`,
        route: AGENT_KNOWLEDGE_METHODS.ingestArtifact.route,
      };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge ingest-artifact <artifactId> [--title <title>] [--tags a,b] [--folder <path>] --yes`,
        exitCode: 2,
      };
    }
    const title = readOptionValue(rest, '--title');
    const tags = readStringList(rest, '--tags');
    const folderPath = readOptionValue(rest, '--folder');
    const connectorId = readOptionValue(rest, '--connector') ?? 'goodvibes-agent-artifact-browser';
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.ingestArtifact, async (connection) => (
      await postAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.ingestArtifact.route, {
        artifactId,
        title,
        tags,
        folderPath,
        connectorId,
        metadata: { originSurface: 'goodvibes-agent-cli' },
      })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatIngest(
        result.data,
        artifactId,
        'ingest-artifact',
        '/api/goodvibes-agent/knowledge/ingest/artifact',
        'artifact',
      )),
      exitCode: 0,
    };
  }

  if (normalized === 'import-urls' || normalized === 'import-bookmarks') {
    const values = commandValues(rest);
    const path = values[0];
    const method = normalized === 'import-urls'
      ? AGENT_KNOWLEDGE_METHODS.ingestUrls
      : AGENT_KNOWLEDGE_METHODS.ingestBookmarks;
    if (!path) {
      return {
        output: `Usage: goodvibes-agent knowledge ${normalized} <path> [--allow-private-hosts] --yes`,
        exitCode: 2,
      };
    }
    if (!confirmation.present) {
      const failure = {
        ok: false,
        kind: 'confirmation_required',
        error: `Refusing to import ${path} into Agent Knowledge without --yes.`,
        route: method.route,
      };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge ${normalized} <path> [--allow-private-hosts] --yes`,
        exitCode: 2,
      };
    }
    const result = await runKnowledgeCall(runtime, method, async (connection) => (
      await postAgentKnowledgeJson(connection, method.route, {
        path: resolve(runtime.workingDirectory, path),
        allowPrivateHosts: hasFlag(rest, '--allow-private-hosts'),
        metadata: { originSurface: 'goodvibes-agent-cli' },
      })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatBatchIngest(result.data, normalized)),
      exitCode: 0,
    };
  }

  if (normalized === 'import-browser-history' || normalized === 'sync-browser-history') {
    if (!confirmation.present) {
      const failure = {
        ok: false,
        kind: 'confirmation_required',
        error: 'Refusing to import browser history into Agent Knowledge without --yes.',
        route: AGENT_KNOWLEDGE_METHODS.ingestBrowserHistory.route,
      };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] [--limit <n>] [--since-days <n>] --yes`,
        exitCode: 2,
      };
    }
    // The same reading as /knowledge import-browser-history: a typo in a flag that
    // narrows the import is refused, never widened to every browser or all time.
    const scope = parseBrowserImportScope(rest, Date.now());
    if (!scope.ok) {
      const failure = { ok: false, kind: 'invalid_import_scope', error: scope.message, route: AGENT_KNOWLEDGE_METHODS.ingestBrowserHistory.route };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] [--limit <n>] [--since-days <n>] --yes`,
        exitCode: 2,
      };
    }
    const homeOverride = readOptionValue(rest, '--home');
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.ingestBrowserHistory, async (connection) => (
      await postAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.ingestBrowserHistory.route, {
        browsers: scope.scope.browsers,
        sourceKinds: scope.scope.sourceKinds,
        homeOverride,
        limit: scope.scope.limit,
        sinceMs: scope.scope.sinceMs,
        connectorId: 'goodvibes-agent-browser-history',
      })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatBatchIngest(result.data, 'browser-history')),
      exitCode: 0,
    };
  }

  if (normalized === 'ingest-connector') {
    const values = commandValues(rest);
    const connectorId = values[0];
    if (!connectorId) return { output: 'Usage: goodvibes-agent knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes', exitCode: 2 };
    const input = parseConnectorInput(readOptionValue(rest, '--input'));
    const path = readOptionValue(rest, '--path');
    const content = readOptionValue(rest, '--content');
    if (input === undefined && !path && !content) {
      return { output: 'Usage: goodvibes-agent knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes', exitCode: 2 };
    }
    if (!confirmation.present) {
      const failure = {
        ok: false,
        kind: 'confirmation_required',
        error: `Refusing to ingest connector input into Agent Knowledge for ${connectorId} without --yes.`,
        route: AGENT_KNOWLEDGE_METHODS.ingestConnector.route,
      };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes`,
        exitCode: 2,
      };
    }
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.ingestConnector, async (connection) => (
      await postAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.ingestConnector.route, {
        connectorId,
        input,
        // The host resolves a relative path against its own directory, so send
        // the one this command was run from.
        path: path ? resolve(runtime.workingDirectory, path) : path,
        content,
        allowPrivateHosts: hasFlag(rest, '--allow-private-hosts'),
        sessionId: 'goodvibes-agent-cli',
      })
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatBatchIngest(result.data, `connector ${connectorId}`)),
      exitCode: 0,
    };
  }

  if (normalized === 'reindex') {
    if (!confirmation.present) {
      const failure = {
        ok: false,
        kind: 'confirmation_required',
        error: 'Refusing to reindex Agent Knowledge without --yes.',
        route: AGENT_KNOWLEDGE_METHODS.reindex.route,
      };
      return {
        output: json ? JSON.stringify(failure, null, 2) : `${failure.error}\nUsage: goodvibes-agent knowledge reindex --yes`,
        exitCode: 2,
      };
    }
    const result = await runKnowledgeCall(runtime, AGENT_KNOWLEDGE_METHODS.reindex, async (connection) => (
      await postAgentKnowledgeJson(connection, AGENT_KNOWLEDGE_METHODS.reindex.route, {})
    ));
    if (!result.ok) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: formatJsonOrText(runtime.cli)(result, formatReindex(result.data)),
      // A partial reindex is not a success: scripts must see the failed sources.
      exitCode: isRecord(result.data) && reindexFailures(result.data).length > 0 ? 1 : 0,
    };
  }

  return {
    output: 'Usage: goodvibes-agent knowledge [status|ask <question>|search <query>|list|sources|nodes|issues|get <id>|map|connectors|ingest-url <url> --yes|ingest-file <path> --yes|ingest-artifact <artifactId> --yes|ingest-connector <id> --yes|import-urls <path> --yes|import-bookmarks <path> --yes|import-browser-history --yes|reindex --yes]',
    exitCode: 2,
  };
}

export async function handleAgentKnowledgeShortcutCommand(
  runtime: CliCommandRuntime,
  subcommand: 'ask' | 'search',
): Promise<CliCommandOutput> {
  return handleAgentKnowledgeCommand({
    ...runtime,
    cli: {
      ...runtime.cli,
      command: 'knowledge',
      rawCommand: 'knowledge',
      commandArgs: [subcommand, ...runtime.cli.commandArgs],
    },
  });
}

/**
 * Whether the connected host is reachable and serves the Agent Knowledge routes:
 * the same inspection `status` and `doctor` print, with its deadline, so the
 * two never disagree about one host.
 */
export async function handleCompatCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const metadata = { version: VERSION };
  const inspected = await inspectCliExternalRuntime({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory });
  const knowledgeRouteReady = inspected.agentKnowledge.ready;
  const hostCompatible = inspected.reachable && inspected.compatible;
  const next = !inspected.reachable
    ? 'start the GoodVibes daemon (goodvibes-daemon) or check controlPlane.host and controlPlane.port.'
    : !inspected.operatorToken.present
      ? 'pair this Agent with the host (goodvibes-agent setup pair --apply).'
      : hostCompatible
        ? null
        : 'update the connected GoodVibes host so its public Agent routes are compatible.';
  const value = {
    ok: hostCompatible && knowledgeRouteReady,
    packageVersion: metadata.version,
    connectedHost: {
      baseUrl: inspected.baseUrl,
      status: inspected.statusCode ?? 0,
      reachable: inspected.reachable,
      compatible: hostCompatible,
    },
    auth: {
      tokenPresent: inspected.operatorToken.present,
      tokenPath: inspected.operatorToken.path,
    },
    agentKnowledge: {
      route: inspected.agentKnowledge.route,
      ready: knowledgeRouteReady,
      kind: inspected.agentKnowledge.kind,
    },
    ...(inspected.error ? { error: inspected.error } : {}),
    ...(next ? { next: [next] } : {}),
  };
  const text = [
    'GoodVibes Agent compatibility',
    `  package ${metadata.version}`,
    `  connected host ${inspected.baseUrl} (${inspected.reachable ? 'reachable' : 'unreachable'})`,
    `  host compatible ${yesNo(hostCompatible)}`,
    `  operator token ${inspected.operatorToken.present ? 'present' : 'missing'} (${inspected.operatorToken.path})`,
    `  Agent Knowledge route ${knowledgeRouteReady ? 'ready' : `not ready (${formatAgentKnowledgeFailureKind(inspected.agentKnowledge.kind)})`}`,
    ...(inspected.error ? [`  error ${inspected.error}`] : []),
    ...(next ? [`  next ${next}`] : []),
  ].join('\n');
  return {
    output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text,
    exitCode: value.ok ? 0 : 1,
  };
}

export async function handleDelegateCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const reviewRequested = hasAnyFlag(runtime.cli.commandArgs, ['--review', '--wrfc']);
  const task = delegationTaskValues(runtime.cli.commandArgs).join(' ').trim();
  if (!task) {
    return {
      output: 'Usage: goodvibes-agent delegate [--review] <build/fix/review task>',
      exitCode: 2,
    };
  }
  let createdSessionId: string | null = null;
  const result = await runKnowledgeCall<DelegationResult>(runtime, DELEGATION_METHOD, async (connection) => {
    const platformClient = createAgentPlatform(connection);
    const created = await platformClient.operator.invoke('sessions.create', {
      title: `Agent delegation: ${task.slice(0, 72)}`,
      surfaceKind: 'goodvibes-agent',
      surfaceId: 'goodvibes-agent-cli',
    });
    const sessionId = isRecord(created.session) && typeof created.session.id === 'string'
      ? created.session.id
      : null;
    if (!sessionId) throw new Error('sessions.create returned no session id.');
    createdSessionId = sessionId;
    const message = await platformClient.operator.invoke('sessions.messages.create', {
      sessionId,
      body: buildDelegationBody(task, reviewRequested),
      surfaceKind: 'goodvibes-agent',
      surfaceId: 'goodvibes-agent-cli',
      kind: 'task',
      metadata: {
        reviewRequested,
        wrfcRequested: reviewRequested,
      },
      routing: {
        executionIntent: {
          riskClass: 'elevated',
          requiresApproval: true,
          networkPolicy: 'inherit',
          filesystemPolicy: 'workspace-write',
        },
      },
    });
    return { sessionId, message, task, reviewRequested };
  });
  if (!result.ok) {
    const json = runtime.cli.flags.outputFormat === 'json';
    // The session exists on the host even though the task message did not land;
    // name it so the caller can reuse or close it instead of leaving an orphan.
    if (createdSessionId === null) return { output: formatFailure(result, json), exitCode: 1 };
    return {
      output: json
        ? JSON.stringify({ ...result, sessionId: createdSessionId }, null, 2)
        : [
          formatFailure(result, false),
          `  session ${createdSessionId} was created on the host but the task message was not accepted; no task is running.`,
        ].join('\n'),
      exitCode: 1,
    };
  }
  const text = [
    'Delegation submitted to GoodVibes TUI/shared-session routes.',
    `  session ${result.data.sessionId}`,
    `  mode ${result.data.reviewRequested ? 'delegated review requested' : 'direct build delegation'}`,
    `  task ${result.data.task}`,
    '  next check GoodVibes TUI shared-session/task status for the result.',
  ].join('\n');
  return {
    output: formatJsonOrText(runtime.cli)(result, text),
    exitCode: 0,
  };
}
