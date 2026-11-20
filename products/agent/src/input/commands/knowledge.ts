/**
 * `/knowledge` in the Agent (terminal-shell/knowledge-command.ts): Agent
 * Knowledge only, over the Agent-owned routes. It never uses the default
 * knowledge or another product's knowledge space, and nothing falls back to
 * them: a question naming a knowledge space is refused. Every write checks
 * that the session it belongs to is still the one open.
 */
import { registerKnowledgeCommand, knowledgeIngestLine } from '@goodvibes/engine/terminal-shell/knowledge-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';
import { parseBrowserImportScope } from './knowledge-browser-flags.ts';
import { formatKnowledgeMap, renderKnowledgeAskResult } from './knowledge-format.ts';

function knowledgeOf(context: CommandContext) {
  const knowledge = context.clients?.agentKnowledgeApi;
  if (!knowledge) throw commandRefusal('[knowledge] Agent Knowledge is not available here. Nothing falls back to the default knowledge or another knowledge space.');
  return knowledge;
}

/** The input a connector takes: JSON when it reads as JSON, else the text as typed. */
function connectorInput(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) as unknown; } catch { return trimmed; }
  }
  return trimmed;
}

function tagsOf(value: string): string[] | undefined {
  const tags = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

export function registerKnowledgeRuntimeCommands(registry: CommandRegistry): void {
  /** A write is sent only while the session it belongs to is still the one open. */
  const guard = (ctx: CommandContext) => {
    const sessionId = ctx.session.runtime.sessionId;
    return {
      sessionId,
      same(): void {
        if (ctx.session.runtime.sessionId !== sessionId) throw new Error('The session changed before this write was sent, so nothing was written. Run the command again in the session it belongs to.');
      },
    };
  };
  registerKnowledgeCommand<CommandContext>(registry, {
    ports(ctx) {
      const knowledge = knowledgeOf(ctx);
      const session = guard(ctx);
      const reading = { signal: ctx.judgmentReadingOptions?.signal };
      const service = ctx.extensions.agentKnowledgeService;
      return {
        status: () => knowledge.status.get({}, reading),
        nodes: (limit) => knowledge.graph.nodes.list(limit, reading),
        issues: (limit) => knowledge.graph.issues.list(limit, reading),
        sources: (limit) => knowledge.sources.list(limit, reading),
        search: (query, limit) => knowledge.graph.items.search(query, limit, reading),
        get: (id) => knowledge.graph.items.get(id, {}, reading),
        lint: () => knowledge.status.lint(),
        candidates: (limit) => knowledge.consolidation.candidates(limit),
        reports: (limit) => knowledge.consolidation.reports(limit),
        schedules: (limit) => knowledge.jobs.schedules.list(limit),
        packet: (query, scopes) => knowledge.packets.buildPrompt(query, scopes, undefined, reading),
        url: (input) => { session.same(); return knowledge.ingest.url(input); },
        bookmarksFile: (input) => { session.same(); return knowledge.ingest.bookmarksFile(input); },
        urlsFile: (input) => { session.same(); return knowledge.ingest.urlsFile(input); },
        review: (input) => { session.same(); return knowledge.graph.issues.review(input); },
        reindex: () => { session.same(); return knowledge.status.reindex(); },
        run: (id, options) => { session.same(); return knowledge.jobs.run(id, options); },
        runs: (limit, jobId) => knowledge.jobs.runs(limit, jobId),
        cancelRun: (runId) => { session.same(); return knowledge.jobs.cancelRun(runId); },
        ask: service?.ask ? (input) => service.ask(input) : undefined,
        sessionId: () => session.sessionId,
      };
    },
    open(ctx) {
      if (!ctx.openAgentWorkspace) throw commandRefusal('The Agent workspace needs the interactive shell.', '/knowledge status shows how it stands.');
      ctx.openAgentWorkspace('knowledge');
    },
    presentation: {
      statusTitle: '[knowledge] Agent Knowledge',
      headingSuffix: '',
      fieldSeparator: ' ',
      scoreSeparator: ' ',
      nodeKind: 'type',
      reviewer: 'agent',
      sourceLabel: 'knowledge source',
      renderAsk: renderKnowledgeAskResult,
    },
    spacesRefused: '[knowledge] Agent Knowledge is isolated: a question cannot name another knowledge space, and nothing falls back to the default knowledge.',
    more: {
      async ingestFile(ctx, input) {
        const knowledge = knowledgeOf(ctx);
        const session = guard(ctx);
        session.same();
        const result = await knowledge.ingest.artifact({ path: input.path, title: input.title || undefined, tags: tagsOf(input.tags), folderPath: input.folder || undefined, sessionId: session.sessionId, connectorId: 'goodvibes-agent-file' });
        return [knowledgeIngestLine(result.source, input.path), ...(result.source.summary ? [`  ${result.source.summary}`] : []), ...(result.artifactId ? [`  artifact: ${result.artifactId}`] : [])].join('\n');
      },
      async ingestArtifact(ctx, input) {
        const knowledge = knowledgeOf(ctx);
        const session = guard(ctx);
        session.same();
        const result = await knowledge.ingest.artifact({ artifactId: input.artifact, title: input.title || undefined, tags: tagsOf(input.tags), folderPath: input.folder || undefined, sessionId: session.sessionId, connectorId: 'goodvibes-agent-artifact-browser' });
        return [knowledgeIngestLine(result.source, input.artifact), ...(result.source.summary ? [`  ${result.source.summary}`] : []), ...(result.artifactId ? [`  artifact: ${result.artifactId}`] : [])].join('\n');
      },
      async browserHistory(ctx, input) {
        // The same validation the shell-less command uses: a narrower choice that resolves to nothing is refused, not widened.
        const scope = parseBrowserImportScope([
          ...(input.browsers ? ['--browsers', input.browsers] : []),
          ...(input.sources ? ['--sources', input.sources] : []),
          ...(input.limit ? ['--limit', input.limit] : []),
          ...(input.days ? ['--since-days', input.days] : []),
        ], Date.now());
        if (!scope.ok) throw commandRefusal(`[knowledge] ${scope.message}`);
        const knowledge = knowledgeOf(ctx);
        const session = guard(ctx);
        session.same();
        const result = await knowledge.ingest.browserHistory({
          browsers: scope.scope.browsers, sourceKinds: scope.scope.sourceKinds, limit: scope.scope.limit, sinceMs: scope.scope.sinceMs,
          connectorId: 'goodvibes-agent-browser-history', sessionId: session.sessionId,
        });
        return [
          `[knowledge] Added from your browsers: ${result.imported} ok, ${result.failed} failed`,
          ...(result.profiles.length > 0 ? [`  browser profiles ${result.profiles.length}`] : []),
          ...result.errors.slice(0, 10).map((error) => `  error ${error}`),
        ].join('\n');
      },
      async connector(ctx, input) {
        const given = connectorInput(input.input);
        if (given === undefined && !input.path && !input.content) throw commandRefusal('[knowledge] Give the connector something to read: an input, a file or text. Nothing was added.');
        const knowledge = knowledgeOf(ctx);
        const session = guard(ctx);
        session.same();
        const result = await knowledge.ingest.connectorInput({
          connectorId: input.connector, input: given, path: input.path || undefined, content: input.content || undefined, sessionId: session.sessionId,
          fetchMode: input.allowPrivate ? 'allow-private-hosts' : 'public-only',
        });
        return [`[knowledge] Added through ${input.connector}: ${result.imported} ok, ${result.failed} failed`, ...result.errors.slice(0, 10).map((error) => `  error ${error}`)].join('\n');
      },
      async map(ctx, query, limit) {
        const reading = { signal: ctx.judgmentReadingOptions?.signal };
        return formatKnowledgeMap(await knowledgeOf(ctx).graph.map({ limit, ...(query ? { query } : {}) }, reading));
      },
      connectors(ctx) {
        return knowledgeOf(ctx).connectors.list().map((connector) => ({ id: connector.id, name: connector.displayName ?? connector.id, sourceType: connector.sourceType, description: connector.description }));
      },
      connectorDetail(ctx, id) {
        const connector = knowledgeOf(ctx).connectors.get(id);
        if (!connector) throw commandRefusal(`[knowledge] No connector ${id}.`, '/knowledge connectors lists them.');
        return [
          `[knowledge] Connector ${connector.id}`,
          `  name ${connector.displayName ?? connector.id}`,
          `  reads ${connector.sourceType}`,
          `  ${connector.description}`,
          `  can: ${connector.capabilities?.join(', ') || 'nothing more'}`,
        ].join('\n');
      },
      async doctor(ctx, id) {
        const report = await knowledgeOf(ctx).connectors.doctor(id);
        if (!report) throw commandRefusal(`[knowledge] No check is available for connector ${id}.`);
        return [
          `[knowledge] Connector ${report.connectorId}`,
          `  ready: ${report.ready ? 'yes' : 'no'}`,
          `  ${report.summary}`,
          ...(report.checks.length > 0 ? ['  checks:', ...report.checks.slice(0, 10).map((check) => `    - ${check.id} [${check.status}] ${check.label} - ${check.detail}`)] : []),
          ...(report.hints.length > 0 ? ['  to fix:', ...report.hints.slice(0, 8).map((hint) => `    - ${hint}`)] : []),
        ].join('\n');
      },
    },
  });
}
