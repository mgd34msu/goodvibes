import type { KnowledgeApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { readFlag, positionalArgs, readKnowledgeTaskArguments } from './command-arguments.js';
export interface KnowledgeReadPorts {
  readonly status: () => ReturnType<KnowledgeApi['status']['get']>;
  readonly nodes: (limit: number) => ReturnType<KnowledgeApi['graph']['nodes']['list']>;
  readonly issues: (limit: number) => ReturnType<KnowledgeApi['graph']['issues']['list']>;
  readonly sources: (limit: number) => ReturnType<KnowledgeApi['sources']['list']>;
  readonly search: (query: string, limit: number) => ReturnType<KnowledgeApi['graph']['items']['search']>;
  readonly get: (id: string) => ReturnType<KnowledgeApi['graph']['items']['get']>;
  readonly lint: () => ReturnType<KnowledgeApi['status']['lint']>;
  readonly candidates: (limit: number) => ReturnType<KnowledgeApi['consolidation']['candidates']>;
  readonly reports: (limit: number) => ReturnType<KnowledgeApi['consolidation']['reports']>;
  readonly schedules: (limit: number) => ReturnType<KnowledgeApi['jobs']['schedules']['list']>;
  readonly packet: (query: string, scopes: string[]) => ReturnType<KnowledgeApi['packets']['buildPrompt']>;
  readonly assertCurrent: () => void;
}
/** Read commands share behavior without resolving any knowledge segment or granting mutation authority. */
export async function handleKnowledgeReadCommand(
  sub: string,
  rest: string[],
  print: (text: string) => void,
  ports: KnowledgeReadPorts,
  presentation: {
    readonly statusTitle: string;
    readonly headingSuffix: string;
    readonly fieldSeparator: string;
    readonly scoreSeparator: string;
    readonly nodeKind: string;
  },
): Promise<boolean> {
  switch (sub) {
    case 'status': {
      const status = await ports.status();
      print(
        [
          presentation.statusTitle,
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
    case 'list': {
      const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
      const kind = (readFlag(rest, '--kind') ?? 'sources').toLowerCase();
      if (kind === 'nodes') {
        const nodes = await ports.nodes(limit);
        ports.assertCurrent();
        if (nodes.length === 0) {
          print('[knowledge] No nodes.');
          return true;
        }
        print(`[knowledge] ${nodes.length} node(s)${presentation.headingSuffix}`);
        for (const node of nodes) {
          print(`  ${node.id} [${node.kind}] ${node.title}`);
          if (node.summary) print(`    ${node.summary}`);
        }
        return true;
      }
      if (kind === 'issues') {
        const issues = await ports.issues(limit);
        ports.assertCurrent();
        if (issues.length === 0) {
          print('[knowledge] No issues.');
          return true;
        }
        print(`[knowledge] ${issues.length} issue(s)${presentation.headingSuffix}`);
        for (const issue of issues) {
          print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          print(`    ${issue.message}`);
        }
        return true;
      }
      const sources = await ports.sources(limit);
      ports.assertCurrent();
      if (sources.length === 0) {
        print('[knowledge] No sources.');
        return true;
      }
      print(`[knowledge] ${sources.length} source(s)${presentation.headingSuffix}`);
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
        return true;
      }
      const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
      const results = await ports.search(query, limit);
      ports.assertCurrent();
      if (results.length === 0) {
        print('[knowledge] No results.');
        return true;
      }
      print(`[knowledge] ${results.length} result(s)${presentation.headingSuffix}`);
      for (const result of results) {
        const title = result.source?.title ?? result.source?.canonicalUri ?? result.node?.title ?? result.id;
        print(`  ${result.id} [${result.kind}] score${presentation.scoreSeparator}${result.score} ${title}`);
        print(`    ${result.reason}`);
      }
      break;
    }
    case 'get': {
      const [id] = positionalArgs(rest);
      if (!id) {
        print('[knowledge] Usage: /knowledge get <id>');
        return true;
      }
      const item = await ports.get(id);
      ports.assertCurrent();
      if (!item) {
        print(`[knowledge] Unknown item${presentation.fieldSeparator}${id}`);
        return true;
      }
      if (item.source) {
        print(`[knowledge] source ${item.source.id}`);
        print(`  title${presentation.fieldSeparator}${item.source.title ?? 'untitled'}`);
        print(`  uri${presentation.fieldSeparator}${item.source.canonicalUri ?? item.source.sourceUri ?? 'n/a'}`);
        print(`  status${presentation.fieldSeparator}${item.source.status}`);
        if (item.source.summary) print(`  summary${presentation.fieldSeparator}${item.source.summary}`);
      } else if (item.node) {
        print(`[knowledge] node ${item.node.id}`);
        print(`  ${presentation.nodeKind}${presentation.fieldSeparator}${item.node.kind}`);
        print(`  title${presentation.fieldSeparator}${item.node.title}`);
        if (item.node.summary) print(`  summary${presentation.fieldSeparator}${item.node.summary}`);
      } else if (item.issue) {
        print(`[knowledge] issue ${item.issue.id}`);
        print(`  severity${presentation.fieldSeparator}${item.issue.severity}`);
        print(`  code${presentation.fieldSeparator}${item.issue.code}`);
        print(`  message${presentation.fieldSeparator}${item.issue.message}`);
      }
      if (item.relatedEdges.length > 0) {
        print('  relations' + presentation.headingSuffix);
        for (const edge of item.relatedEdges.slice(0, 12)) {
          print(`    ${edge.fromKind}:${edge.fromId} -[${edge.relation}]-> ${edge.toKind}:${edge.toId}`);
        }
      }
      break;
    }
    case 'lint': {
      const issues = await ports.lint();
      if (issues.length === 0) {
        print('[knowledge] No lint issues.');
        return true;
      }
      print(`[knowledge] ${issues.length} lint issue(s)${presentation.headingSuffix}`);
      for (const issue of issues) {
        print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
        print(`    ${issue.message}`);
      }
      break;
    }
    case 'queue': {
      const [limitArg] = positionalArgs(rest);
      const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
      const issues = await ports.issues(limit);
      ports.assertCurrent();
      if (issues.length === 0) {
        print('Knowledge review queue is empty.');
        return true;
      }
      print(`[knowledge] Review queue (${issues.length})${presentation.headingSuffix}`);
      for (const issue of issues) {
        print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
        print(`    ${issue.message}`);
      }
      break;
    }
    case 'candidates': {
      const [limitArg] = positionalArgs(rest);
      const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
      const candidates = ports.candidates(limit);
      if (candidates.length === 0) {
        print('[knowledge] No consolidation candidates.');
        return true;
      }
      print(`[knowledge] Consolidation candidates (${candidates.length})${presentation.headingSuffix}`);
      for (const candidate of candidates) {
        print(`  ${candidate.id} [${candidate.status}] score${presentation.scoreSeparator}${candidate.score} ${candidate.title}`);
        print(`    ${candidate.candidateType}`);
      }
      break;
    }
    case 'reports': {
      const [limitArg] = positionalArgs(rest);
      const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
      const reports = ports.reports(limit);
      if (reports.length === 0) {
        print('[knowledge] No consolidation reports.');
        return true;
      }
      print(`[knowledge] Consolidation reports (${reports.length})${presentation.headingSuffix}`);
      for (const report of reports) {
        print(`  ${report.id} [${report.kind}] ${report.title}`);
        print(`    ${report.summary}`);
      }
      break;
    }
    case 'schedules': {
      const schedules = ports.schedules(20);
      if (schedules.length === 0) {
        print('[knowledge] No knowledge schedules.');
        return true;
      }
      print(`[knowledge] Managed schedules (${schedules.length})${presentation.headingSuffix}`);
      for (const schedule of schedules) {
        print(`  ${schedule.id} [${schedule.enabled ? 'enabled' : 'disabled'}] ${schedule.jobId}`);
        print(`    ${schedule.label}`);
      }
      break;
    }
    case 'packet':
    case 'explain': {
      const { scopeValues, query } = readKnowledgeTaskArguments(rest);
      if (!query) {
        print(`[knowledge] Usage: /knowledge ${sub} <task...> [--scope <path> ...]`);
        return true;
      }
      const prompt = await ports.packet(query, scopeValues);
      print(prompt ?? '[knowledge] No structured knowledge matched that task.');
      break;
    }
    default:
      return false;
  }
  return true;
}
