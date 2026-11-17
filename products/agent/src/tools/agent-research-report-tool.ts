import type { AgentResearchReportSource as ResearchSource } from '../agent/research-report-input.ts';
import { prepareProtectedResearchReport, createAgentResearchReportProjector, bindAgentResearchSourceOwner, bindAgentResearchReportSourceOwner, type PreparedResearchReport } from '../agent/protected-research-report.ts';
import { AgentResearchRunRegistry } from '../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry, type AgentResearchSourceRecord } from '../agent/research-source-registry.ts';
import { bindResearchArtifacts, researchLedgers } from '../agent/research-ledgers.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type { ProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import type { ArtifactDescriptor, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolEffect, assertCurrentToolInvocation, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';

export interface AgentResearchReportToolArgs {
  readonly runId?: unknown;
  readonly id?: unknown;
  readonly title?: unknown;
  readonly question?: unknown;
  readonly summary?: unknown;
  readonly reportMarkdown?: unknown;
  readonly sources?: unknown;
  readonly sourceIds?: unknown;
  readonly findings?: unknown;
  readonly gaps?: unknown;
  readonly recommendations?: unknown;
  readonly methodology?: unknown;
  readonly confidence?: unknown;
  readonly tags?: unknown;
  readonly requireCitationCoverage?: unknown;
  readonly visualReport?: unknown;
  readonly preview?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type AgentResearchReportArtifactStore = Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'get'>>;
type ResearchLedgerPaths = Pick<ShellPathService, 'resolveProjectPath'>;

interface CitationCoverage {
  readonly sourceCount: number;
  readonly citedSourceIds: readonly string[];
  readonly missingSourceIds: readonly string[];
  readonly unknownCitationIds: readonly string[];
  readonly repairSuggestions: readonly string[];
  readonly coverageRatio: number;
  readonly pass: boolean;
}


function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function readList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(readString).filter(Boolean);
  return readString(value)
    .split(/\n/)
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function readTags(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(readString).filter(Boolean);
  return readString(value).split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function previewText(value: string, limit = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 64) || 'research-report';
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function routeString(value: string): string {
  return JSON.stringify(value);
}

/** Every check a save makes before it writes, so a clean preview predicts a save that is not refused for content. */
function validateResearchReport(args: AgentResearchReportToolArgs, sources: readonly ResearchSource[]): CitationCoverage {
  if (!readString(args.title)) throw new Error('title is required.');
  if (!readString(args.question)) throw new Error('question is required.');
  if (sources.length === 0) throw new Error('At least one reviewed source is required for a research report artifact.');
  if (!readString(args.summary) && !readString(args.reportMarkdown) && readList(args.findings).length === 0) {
    throw new Error('summary, reportMarkdown, or findings are required.');
  }
  const coverage = citationCoverage(args, sources);
  if (readBoolean(args.requireCitationCoverage) && !coverage.pass) {
    throw new Error([
      `Citation coverage check failed. Missing body citations: ${coverage.missingSourceIds.join(', ') || '(none)'}. Unknown citations: ${coverage.unknownCitationIds.join(', ') || '(none)'}.`,
      `Repair suggestions: ${coverage.repairSuggestions.join(' ') || '(none)'}`,
    ].join('\n'));
  }
  return coverage;
}

function preview(args: AgentResearchReportToolArgs, sources: readonly ResearchSource[]): string {
  const coverage = validateResearchReport(args, sources);
  return [
    'Agent research report preview (nothing saved; the save would pass these content checks)',
    `  title ${readString(args.title)}`,
    `  question ${readString(args.question)}`,
    `  sources ${sources.length}`,
    `  confidence ${readString(args.confidence) || '(unspecified)'}`,
    `  citationCoverage ${coverage.citedSourceIds.length}/${coverage.sourceCount} cited; uncited ${coverage.missingSourceIds.length}; unknown ${coverage.unknownCitationIds.length}`,
    '  policy saving a sourced report artifact requires current recorded effect admission',
  ].join('\n');
}

function listSection(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return [`## ${title}`, '', ...items.map((item) => `- ${item}`), ''].join('\n');
}

function markdownCell(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return (text || '(none)').replace(/\|/g, '\\|');
}

function citationIdsInText(value: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of value.matchAll(/\[S(\d+)\]/gi)) ids.add(`S${Number(match[1] ?? 0)}`);
  return Array.from(ids).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function evidenceLabel(value: string): string {
  return citationIdsInText(value).join(', ') || 'needs citation';
}

function visualReportSection(
  args: AgentResearchReportToolArgs,
  sources: readonly ResearchSource[],
  coverage: CitationCoverage,
): string {
  const summary = readString(args.summary);
  const findings = readList(args.findings);
  const gaps = readList(args.gaps);
  const recommendations = readList(args.recommendations);
  const datedSources = sources
    .map((source, index) => ({ id: `S${index + 1}`, source, date: source.publishedAt || source.accessedAt || '' }))
    .filter((entry) => entry.date);
  const sourceUse = new Set(coverage.citedSourceIds);
  const lines = [
    '## Visual Report Packet',
    '',
    '### At A Glance',
    '',
    `- Answer: ${summary ? previewText(summary) : '(summary not provided)'}`,
    `- Confidence: ${readString(args.confidence) || 'unspecified'}`,
    `- Sources: ${coverage.sourceCount}`,
    `- Citation coverage: ${coverage.citedSourceIds.length}/${coverage.sourceCount} cited`,
    `- Needs repair: ${coverage.repairSuggestions.join(' ') || 'none'}`,
    '',
    '### Evidence Matrix',
    '',
    '| Source | Credibility | Publisher | Evidence Note | Report Use |',
    '| --- | --- | --- | --- | --- |',
    ...sources.map((source, index) => {
      const id = `S${index + 1}`;
      return [
        `| ${markdownCell(`${id} ${source.title}`)}`,
        markdownCell(source.credibility),
        markdownCell(source.publisher ?? ''),
        markdownCell(previewText(source.note ?? '', 180)),
        `${sourceUse.has(id) ? 'cited in body' : 'needs body citation'} |`,
      ].join(' | ');
    }),
    '',
  ];
  if (findings.length > 0) {
    lines.push(
      '### Findings Board',
      '',
      '| Finding | Evidence |',
      '| --- | --- |',
      ...findings.map((finding) => `| ${markdownCell(finding)} | ${markdownCell(evidenceLabel(finding))} |`),
      '',
    );
  }
  if (datedSources.length > 0) {
    lines.push(
      '### Dated Sources',
      '',
      '| Date | Source | Use |',
      '| --- | --- | --- |',
      ...datedSources.map((entry) => `| ${markdownCell(entry.date)} | ${markdownCell(`${entry.id} ${entry.source.title}`)} | ${markdownCell(sourceUse.has(entry.id) ? 'cited' : 'needs citation')} |`),
      '',
    );
  } else {
    lines.push(
      '### Dated Sources',
      '',
      'No dated sources were provided. Treat this as a comparison packet rather than a chronology.',
      '',
    );
  }
  if (gaps.length > 0) lines.push('### Open Questions', '', ...gaps.map((gap) => `- ${gap}`), '');
  if (recommendations.length > 0) {
    lines.push(
      '### Next Actions',
      '',
      '| Action | Evidence |',
      '| --- | --- |',
      ...recommendations.map((recommendation) => `| ${markdownCell(recommendation)} | ${markdownCell(evidenceLabel(recommendation))} |`),
      '',
    );
  }
  lines.push(
    '### Handoff Checklist',
    '',
    '- Review citation coverage and repair suggestions before sharing.',
    '- Inspect the saved artifact with `agent_artifacts mode:"show" includeContent:true`.',
    '- Archive the report with related research source artifacts through `agent_artifacts mode:"archive"`.',
    '- Promote to Knowledge only through a separately admitted `agent_knowledge_ingest sourceKind:"artifact"` call.',
    '',
  );
  return lines.join('\n');
}

function sourceMapSection(sources: readonly ResearchSource[]): string {
  const lines = ['## Source Map', ''];
  sources.forEach((source, index) => {
    const id = `S${index + 1}`;
    lines.push(`- [${id}] ${source.title}`);
    if (source.url) lines.push(`  - URL: ${source.url}`);
    if (source.urlOmitted) lines.push('  - URL status: withheld before transmission; the original reference was not retained.');
    if (source.publisher) lines.push(`  - Publisher: ${source.publisher}`);
    if (source.publishedAt) lines.push(`  - Published: ${source.publishedAt}`);
    if (source.accessedAt) lines.push(`  - Accessed: ${source.accessedAt}`);
    lines.push(`  - Credibility: ${source.credibility}`);
    if (source.note) lines.push(`  - Note: ${source.note}`);
  });
  lines.push('');
  return lines.join('\n');
}

function reportBodyText(args: AgentResearchReportToolArgs): string {
  return [
    readString(args.summary),
    readString(args.reportMarkdown),
    ...readList(args.findings),
    ...readList(args.gaps),
    ...readList(args.recommendations),
    readString(args.methodology),
  ].filter(Boolean).join('\n');
}

function citationCoverage(args: AgentResearchReportToolArgs, sources: readonly ResearchSource[]): CitationCoverage {
  const sourceIds = sources.map((_, index) => `S${index + 1}`);
  const valid = new Set(sourceIds);
  const cited = new Set<string>();
  const unknown = new Set<string>();
  for (const match of reportBodyText(args).matchAll(/\[S(\d+)\]/gi)) {
    const id = `S${Number(match[1] ?? 0)}`;
    if (valid.has(id)) cited.add(id);
    else unknown.add(id);
  }
  const citedSourceIds = sourceIds.filter((id) => cited.has(id));
  const missingSourceIds = sourceIds.filter((id) => !cited.has(id));
  const unknownCitationIds = Array.from(unknown).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const sourceTitleById = new Map(sourceIds.map((id, index) => [id, sources[index]?.title ?? id]));
  const validRange = sourceIds.length > 1 ? `${sourceIds[0]}-${sourceIds[sourceIds.length - 1]}` : sourceIds[0] ?? '(none)';
  const repairSuggestions = [
    ...missingSourceIds.map((id) => `Add body citation for ${id} (${sourceTitleById.get(id) ?? id}).`),
    ...unknownCitationIds.map((id) => `Replace or remove unknown citation ${id}. Valid source ids are ${validRange}.`),
  ];
  return {
    sourceCount: sourceIds.length,
    citedSourceIds,
    missingSourceIds,
    unknownCitationIds,
    repairSuggestions,
    coverageRatio: sourceIds.length > 0 ? Number((citedSourceIds.length / sourceIds.length).toFixed(3)) : 1,
    pass: missingSourceIds.length === 0 && unknownCitationIds.length === 0,
  };
}

function citationCoverageSection(coverage: CitationCoverage): string {
  return [
    '## Citation Coverage',
    '',
    `- Sources: ${coverage.sourceCount}`,
    `- Cited in body: ${coverage.citedSourceIds.join(', ') || '(none)'}`,
    `- Uncited in body: ${coverage.missingSourceIds.join(', ') || '(none)'}`,
    `- Unknown citations: ${coverage.unknownCitationIds.join(', ') || '(none)'}`,
    `- Repair suggestions: ${coverage.repairSuggestions.join(' ') || '(none)'}`,
    '',
  ].join('\n');
}

function buildMarkdown(args: AgentResearchReportToolArgs, sources: readonly ResearchSource[], includeVisualReport: boolean): string {
  const title = readString(args.title);
  const question = readString(args.question);
  const summary = readString(args.summary);
  const reportMarkdown = readString(args.reportMarkdown);
  const findings = readList(args.findings);
  const gaps = readList(args.gaps);
  const recommendations = readList(args.recommendations);
  const methodology = readString(args.methodology);
  const confidence = readString(args.confidence);
  const coverage = citationCoverage(args, sources);
  const generatedAt = new Date().toISOString();
  const lines = [
    `# ${title}`,
    '',
    `Question: ${question}`,
    `Generated: ${generatedAt}`,
    `Confidence: ${confidence || 'unspecified'}`,
    '',
  ];
  if (summary) lines.push('## Summary', '', summary, '');
  if (reportMarkdown) lines.push('## Report', '', reportMarkdown, '');
  const findingSection = listSection('Findings', findings);
  if (findingSection) lines.push(findingSection);
  const gapSection = listSection('Gaps And Caveats', gaps);
  if (gapSection) lines.push(gapSection);
  const recommendationSection = listSection('Recommendations', recommendations);
  if (recommendationSection) lines.push(recommendationSection);
  if (methodology) lines.push('## Method', '', methodology, '');
  lines.push(citationCoverageSection(coverage));
  if (includeVisualReport) lines.push(visualReportSection(args, sources, coverage));
  lines.push(sourceMapSection(sources));
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

function sourceMetadata(sources: readonly ResearchSource[]): readonly Record<string, unknown>[] {
  return sources.map((source, index) => ({
    id: `S${index + 1}`,
    title: source.title,
    ...(source.url ? { url: source.url } : {}),
    ...(source.urlOmitted ? { urlOmitted: true } : {}),
    ...(source.publisher ? { publisher: source.publisher } : {}),
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    ...(source.accessedAt ? { accessedAt: source.accessedAt } : {}),
    credibility: source.credibility,
    ...(source.note ? { note: source.note } : {}),
  }));
}

function visualReportMetadata(
  args: AgentResearchReportToolArgs,
  sources: readonly ResearchSource[],
  coverage: CitationCoverage,
): Record<string, unknown> {
  const findingCount = readList(args.findings).length;
  const gapCount = readList(args.gaps).length;
  const recommendationCount = readList(args.recommendations).length;
  return {
    format: 'markdown-visual-report-packet',
    sections: [
      'at-a-glance',
      'evidence-matrix',
      ...(findingCount > 0 ? ['findings-board'] : []),
      'dated-sources-or-comparison',
      'citation-coverage',
      'source-map',
      ...(gapCount > 0 ? ['open-questions'] : []),
      ...(recommendationCount > 0 ? ['next-actions'] : []),
      'handoff-checklist',
    ],
    sourceCount: sources.length,
    findingCount,
    gapCount,
    recommendationCount,
    datedSourceCount: sources.filter((source) => source.publishedAt || source.accessedAt).length,
    citationCoveragePass: coverage.pass,
    missingSourceIds: coverage.missingSourceIds,
    unknownCitationIds: coverage.unknownCitationIds,
    routes: {
      inspect: 'agent_artifacts mode:"show" artifactId:"..." includeContent:true',
      archive: 'agent_artifacts mode:"archive" artifactIds:["..."] destinationPath:"exports/research-report.zip"',
      promoteKnowledge: 'agent_knowledge_ingest sourceKind:"artifact" artifactId:"..."',
    },
  };
}

function runIdFromArgs(args: AgentResearchReportToolArgs): string {
  return readString(args.runId) || readString(args.id);
}

function reportNextRouteLines(descriptor: ArtifactDescriptor, args: AgentResearchReportToolArgs, runOpen: boolean): readonly string[] {
  const filename = descriptor.filename ?? `${descriptor.id}.md`;
  const title = readString(args.title);
  const runId = runOpen ? runIdFromArgs(args) : '';
  return [
    `  inspect research action:"report_artifact" artifactId:${routeString(descriptor.id)}`,
    `  artifact agent_artifacts mode:"show" artifactId:${routeString(descriptor.id)} includeContent:true`,
    `  export agent_artifacts mode:"export" artifactId:${routeString(descriptor.id)} destinationPath:${routeString(`exports/${filename}`)}`,
    `  archive agent_artifacts mode:"archive" artifactIds:[${routeString(descriptor.id)}] destinationPath:"exports/research-report.zip"`,
    `  promoteKnowledge agent_knowledge_ingest sourceKind:"artifact" artifactId:${routeString(descriptor.id)}`,
    ...(runId ? [
      `  completeRun research action:"complete" id:${routeString(runId)} reportArtifactId:${routeString(descriptor.id)}`,
      `  note run ${runId} is still open`,
    ] : []),
    `  reports research action:"reports"${title ? ` query:${routeString(title)}` : ''}`,
  ];
}

async function saveResearchReport(
  artifactStore: AgentResearchReportArtifactStore,
  args: AgentResearchReportToolArgs & { readonly sources: readonly ResearchSource[] },
  assertWrite: () => void,
): Promise<ArtifactDescriptor> {
  const sources = args.sources;
  const coverage = validateResearchReport(args, sources);
  const title = readString(args.title);
  const question = readString(args.question);
  const explicitUserRequest = readString(args.explicitUserRequest);
  const includeVisualReport = readBoolean(args.visualReport);
  const markdown = buildMarkdown(args, sources, includeVisualReport);
  assertWrite();
  return artifactStore.create({
    kind: 'document',
    mimeType: 'text/markdown',
    filename: `${slug(title)}.md`,
    text: markdown,
    metadata: {
      purpose: 'agent-research-report',
      source: 'agent-research-report',
      title,
      question,
      confidence: readString(args.confidence) || 'unspecified',
      tags: readTags(args.tags),
      sourceCount: sources.length,
      sources: sourceMetadata(sources),
      ...(readList(args.sourceIds).length > 0 ? { sourceIds: readList(args.sourceIds) } : {}),
      citationCoverage: coverage,
      ...(includeVisualReport ? { visualReport: visualReportMetadata(args, sources, coverage) } : {}),
      explicitUserRequest,
    },
  }, { assertCurrent: assertWrite });
}

function coverageFromMetadata(metadata: ArtifactDescriptor['metadata']): CitationCoverage | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).citationCoverage;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sourceCount !== 'number') return null;
  return {
    sourceCount: record.sourceCount,
    citedSourceIds: Array.isArray(record.citedSourceIds) ? record.citedSourceIds.filter((entry): entry is string => typeof entry === 'string') : [],
    missingSourceIds: Array.isArray(record.missingSourceIds) ? record.missingSourceIds.filter((entry): entry is string => typeof entry === 'string') : [],
    unknownCitationIds: Array.isArray(record.unknownCitationIds) ? record.unknownCitationIds.filter((entry): entry is string => typeof entry === 'string') : [],
    repairSuggestions: Array.isArray(record.repairSuggestions) ? record.repairSuggestions.filter((entry): entry is string => typeof entry === 'string') : [],
    coverageRatio: typeof record.coverageRatio === 'number' ? record.coverageRatio : 0,
    pass: record.pass === true,
  };
}

/** A stored source as a report source: the same fields a caller would type. */
function reportSource(record: AgentResearchSourceRecord): Record<string, unknown> {
  return {
    title: record.title,
    ...(record.url ? { url: record.url } : {}),
    ...(record.publisher ? { publisher: record.publisher } : {}),
    ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    ...(record.accessedAt ? { accessedAt: record.accessedAt } : {}),
    credibility: record.credibility,
    ...(record.note || record.summary ? { note: record.note || record.summary } : {}),
  };
}

function hasGivenSources(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : readString(value) !== '';
}

/**
 * A report for a run takes its sources from the source store: the ids given in
 * `sourceIds`, or with none given the run's reviewed sources. Sources typed in
 * `sources` are used as given (this also leaves arguments that were already
 * prepared untouched). Details are fixed sentences: they name no value.
 */
export function withStoredReportSources(args: Record<string, unknown>, paths: ResearchLedgerPaths | undefined): Record<string, unknown> {
  const runId = readString(args.runId) || readString(args.id);
  const ids = readList(args.sourceIds);
  // Typed sources are cited as given; sourceIds beside them name the stored sources to mark used.
  if (hasGivenSources(args.sources)) return args;
  if (!runId && ids.length === 0) return args;
  if (!paths) throw new ToolInputProjectionError('unconfigured', 'The research source store is not available in this session; give the sources in `sources`.');
  const store = AgentResearchSourceRegistry.fromShellPaths(paths);
  let records: AgentResearchSourceRecord[];
  if (ids.length > 0) {
    records = ids.map(id => store.get(id) ?? (() => { throw new ToolInputProjectionError('invalid', 'A source id in sourceIds is not in the research source store. List sources with research action:"sources".'); })());
  } else {
    const run = AgentResearchRunRegistry.fromShellPaths(paths).get(runId);
    if (!run) throw new ToolInputProjectionError('invalid', 'The run named by runId is not in the research run ledger. List runs with research action:"runs".');
    records = run.sourceIds.map(id => store.get(id)).filter((record): record is AgentResearchSourceRecord => record?.status === 'reviewed');
    if (records.length === 0) throw new ToolInputProjectionError('invalid', 'The run has no reviewed sources. Review its sources with research action:"review_source", or give sources or sourceIds.');
  }
  return { ...args, sources: records.map(reportSource), sourceIds: records.map(record => record.id) };
}

/**
 * After the save: the named sources are marked used by this report and the run
 * is completed with it. Each outcome is reported by name; a refusal here never
 * turns the saved report into a failure.
 */
function settleResearchRun(paths: ResearchLedgerPaths, runId: string, sourceIds: readonly string[], artifactId: string): { readonly lines: readonly string[]; readonly runOpen: boolean } {
  const lines: string[] = [];
  const used: string[] = [];
  if (sourceIds.length > 0) {
    const store = AgentResearchSourceRegistry.fromShellPaths(paths);
    for (const id of sourceIds) {
      try { used.push(store.markUsed(id, { reportArtifactId: artifactId }).id); }
      catch (error) { lines.push(`  source ${id} not marked used: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (used.length > 0) lines.push(`  sources marked used by this report: ${used.join(', ')}`);
  }
  try {
    const run = AgentResearchRunRegistry.fromShellPaths(paths).complete(runId, { reportArtifactId: artifactId, sourceIds: used });
    lines.push(`  run ${run.id} completed with this report`);
    return { lines, runOpen: false };
  } catch (error) {
    lines.push(`  run ${runId} not completed: ${error instanceof Error ? error.message : String(error)}`);
    return { lines, runOpen: true };
  }
}

export function createAgentResearchReportTool(
  artifactStore?: AgentResearchReportArtifactStore,
  sourceOwner?: ProtectedSourceOwner,
  ledgers: () => ResearchLedgerPaths | undefined = () => undefined,
): Tool {
  return {
    definition: {
      name: 'agent_research_report',
      activity: { doing: 'Writing', did: 'wrote', object: 'a research report', objects: 'research reports' },
      description: 'Save one sourced research report artifact under current recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Optional research run id. Without sources, the report uses the run\'s reviewed sources; after the save those sources are marked used and the run is completed with this report.' },
          id: { type: 'string', description: 'Alias for runId when saving through the high-level research adapter.' },
          title: { type: 'string', description: 'Report title.' },
          question: { type: 'string', description: 'Research question answered by the report.' },
          summary: { type: 'string', description: 'Short executive summary. At least one of summary, reportMarkdown or findings is required.' },
          reportMarkdown: { type: 'string', description: 'Full report markdown. At least one of summary, reportMarkdown or findings is required.' },
          sources: {
            type: 'array',
            items: { type: 'object' },
            description: 'Reviewed sources with title, url, and credibility, when they are not in the source store. Credential-redacted, userinfo-bearing or malformed URLs are withheld in full with urlOmitted:true; ordinary query and section references are preserved.',
          },
          sourceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Source store ids to cite instead of typing sources; omit both with runId to cite the run\'s reviewed sources.',
          },
          findings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Key findings.',
          },
          gaps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Open questions or caveats.',
          },
          recommendations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Recommended next actions.',
          },
          methodology: { type: 'string', description: 'How sources were selected and judged.' },
          confidence: { type: 'string', description: 'Overall confidence label.' },
          requireCitationCoverage: { type: 'boolean', description: 'Fail save unless all sources are cited in body.' },
          visualReport: { type: 'boolean', description: 'Append a visual report packet section.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional report tags.',
          },
          preview: { type: 'boolean', description: 'Read a privacy-qualified report preview without saving an artifact.' },
          confirm: { type: 'boolean', description: 'Optional legacy audit field; does not authorize report writes.' },
          explicitUserRequest: { type: 'string', description: 'Optional request text retained with report metadata.' },
        },
        required: ['title', 'question'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>, options) => {
      if (!artifactStore?.create) return failure('Research report export is unavailable because this runtime did not provide an artifact store.');
      let prepared: PreparedResearchReport | undefined;
      try {
        const assertWrite = () => {
          options?.signal?.throwIfAborted();
          const admitted = rawArgs.preview === true ? assertCurrentToolInvocation(rawArgs, options) : assertCurrentToolEffect(rawArgs, options, 'write');
          if (!admitted) throw new Error('Research report writes require current recorded effect admission.');
        };
        assertWrite();
        prepared = await prepareProtectedResearchReport(sourceOwner, withStoredReportSources(rawArgs, ledgers()), { signal: options?.signal, assertCurrent: assertWrite });
        const args = prepared.args as unknown as AgentResearchReportToolArgs & { readonly sources: readonly ResearchSource[] };
        if (args.preview === true) return output(preview(args, args.sources));
        // One check before the write; once the store has written, the result is the save.
        const descriptor = await saveResearchReport(artifactStore, args, prepared.assertCurrent);
        const runId = runIdFromArgs(args);
        const paths = ledgers();
        const settled = runId && paths ? settleResearchRun(paths, runId, readList(args.sourceIds), descriptor.id) : undefined;
        const coverage = coverageFromMetadata(descriptor.metadata);
        const lines = [
          'Saved Agent research report artifact',
          `  artifact ${descriptor.id}`,
          `  filename ${descriptor.filename ?? '(none)'}`,
          `  bytes ${descriptor.sizeBytes}`,
          `  mime ${descriptor.mimeType}`,
          `  sources ${args.sources.length}`,
          readBoolean(args.visualReport) ? '  visualReport markdown-visual-report-packet' : '',
          coverage ? `  citationCoverage ${coverage.citedSourceIds.length}/${coverage.sourceCount} cited; uncited ${coverage.missingSourceIds.length}; unknown ${coverage.unknownCitationIds.length}` : '',
          coverage && coverage.repairSuggestions.length > 0 ? `  citationRepair ${coverage.repairSuggestions.join(' ')}` : '',
          ...(descriptor.sha256 ? [`  recorded checksum ${descriptor.sha256}`] : []),
          ...(settled?.lines ?? []),
          '  nextRoutes',
          ...reportNextRouteLines(descriptor, args, settled ? settled.runOpen : Boolean(runId)),
          '  policy sourced markdown saved as artifact; content not printed',
          `  inspect agent_artifacts mode:"show" artifactId:"${descriptor.id}" includeContent:true`,
        ].filter(Boolean);
        return output(lines.join('\n'));
      } catch (error) {
        if (error instanceof ToolInputProjectionError) throw error;
        return failure(error instanceof Error ? error.message : String(error));
      } finally { await prepared?.release(); }
    },
  };
}

export function registerAgentResearchReportTool(
  registry: ToolRegistry,
  artifactStore?: AgentResearchReportArtifactStore,
  sourceOwner?: ProtectedSourceOwner,
  ownerScope: 'shared' | 'report-only' = 'shared',
  sharedSourceOwner?: ProtectedSourceOwner,
): void {
  if (sharedSourceOwner) bindAgentResearchSourceOwner(registry, sharedSourceOwner);
  if (sourceOwner) {
    if (ownerScope === 'report-only') bindAgentResearchReportSourceOwner(registry, sourceOwner);
    else bindAgentResearchSourceOwner(registry, sourceOwner);
  }
  bindResearchArtifacts(registry, artifactStore);
  const ledgers = () => researchLedgers(registry);
  registry.register(createAgentResearchReportTool(artifactStore, sourceOwner, ledgers),
    { inputProjection: createAgentResearchReportProjector(sourceOwner, undefined, args => withStoredReportSources(args, ledgers())) });
}
