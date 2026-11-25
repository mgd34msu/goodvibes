/**
 * Knowledge: your structured knowledge (pages and files you added, the
 * entries and links built from them, and the issues found in them), ONE store
 * for every program: the daemon's (`knowledge-wiki.sqlite` in its state
 * folder). The Agent kept a second one ("Agent Knowledge"); it is carried into
 * this one once (knowledge/agent-knowledge-carry.ts), so everything it held
 * is found here, and the ways in only the Agent had (a file, a saved
 * artifact, browser history, a connector, the map) act on this store too.
 * Every capability runs in the daemon; a file or folder path is the caller's
 * project's.
 */
import { resolve } from 'node:path';
import type { KnowledgeApi } from '../../knowledge/knowledge-api.js';
import type { KnowledgeService } from '../../knowledge/service.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

export interface KnowledgeCapabilityServices {
  /** The daemon's knowledge (the one store). */
  readonly knowledge: KnowledgeApi;
  /** Answering a question from it (a model call that reads the sources). */
  readonly knowledgeAsk: KnowledgeService['ask'];
}

type KnowledgeDefinition = CapabilityDefinition<KnowledgeCapabilityServices>;
type AskResult = Awaited<ReturnType<KnowledgeService['ask']>>;

const daemon = (id: string, repeat: 'safe' | 'unsafe') => ({ id, group: 'memory' as const, home: 'daemon' as const, repeat });
const fold = (lines: readonly string[]): string => lines.join('\n');
const limitOf = (value: string | undefined, fallback: number): number => Math.max(1, Number.parseInt(value ?? '', 10) || fallback);
const tagsOf = (value: string | undefined): string[] | undefined => {
  const tags = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
};
const inline = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const fetchMode = (values: Readonly<Record<string, string>>) => values.private === 'yes' ? 'allow-private-hosts' as const : 'public-only' as const;
/** A path the caller named, in the caller's project (the daemon reads it there). */
const pathIn = (path: string, caller: CapabilityCaller): string => caller.workingDirectory ? resolve(caller.workingDirectory, path) : resolve(path);

/** One report for every ingest: a stored source whose fetch failed is a failure, not an ingest. */
export function knowledgeIngestLine(source: { readonly id: string; readonly status: string; readonly canonicalUri?: string | undefined; readonly sourceUri?: string | undefined; readonly crawlError?: string | undefined }, fallbackSubject: string): string {
  const subject = source.canonicalUri ?? source.sourceUri ?? fallbackSubject;
  if (source.status === 'failed') {
    throw new CapabilityRefusal(`The page was not added: ${source.id} ${subject}: ${source.crawlError ?? 'no reason recorded'}. The source is stored with status failed; no content was added to knowledge.`);
  }
  return `Added ${source.id} ${subject}.`;
}

function importLines(what: string, result: { readonly imported: number; readonly failed: number; readonly errors: readonly string[] }): string {
  return fold([`Added ${what}: ${result.imported} ok, ${result.failed} failed.`, ...result.errors.slice(0, 10).map((error) => `  error: ${error}`)]);
}

function sourceLabel(source: { readonly id?: string | undefined; readonly sourceType?: string | undefined; readonly title?: string | undefined; readonly canonicalUri?: string | undefined; readonly sourceUri?: string | undefined; readonly summary?: string | undefined; readonly status?: string | undefined }): string {
  const title = inline(source.title) || inline(source.canonicalUri) || inline(source.sourceUri) || inline(source.id) || 'untitled';
  const type = inline(source.sourceType) || 'source';
  const status = inline(source.status);
  const summary = inline(source.summary);
  return `[${type}${status ? `/${status}` : ''}] ${title}${summary ? ` - ${summary}` : ''}`;
}
function nodeLabel(node: { readonly kind?: string | undefined; readonly title?: string | undefined; readonly summary?: string | undefined; readonly confidence?: number | undefined }): string {
  const summary = inline(node.summary);
  const confidence = typeof node.confidence === 'number' ? ` confidence: ${node.confidence}` : '';
  return `[${inline(node.kind) || 'entry'}] ${inline(node.title) || 'untitled'}${confidence}${summary ? ` - ${summary}` : ''}`;
}

/** An answer from your knowledge, with what it used. */
export function renderKnowledgeAnswer(result: AskResult): string {
  const answer = result.answer;
  const lines = [answer.text, '', `How sure: ${answer.confidence}; ${answer.synthesized ? 'written from the sources' : 'quoted from the sources'} (${answer.mode}).`];
  const section = (title: string, rows: readonly string[]) => { if (rows.length > 0) lines.push('', title, ...rows.map((row) => `  - ${row}`)); };
  section('Sources:', answer.sources.map(sourceLabel));
  section('Facts:', answer.facts.map(nodeLabel));
  section('Linked entries:', answer.linkedObjects.map(nodeLabel));
  section('Gaps:', answer.gaps.map(nodeLabel));
  return lines.join('\n');
}

const LIMIT = (fallback: number, typed: InputDescription['typed'] = { flag: '--limit' }): InputDescription => ({
  id: 'limit', label: 'How many', help: 'The most to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: String(fallback) }, typed,
});
const PRIVATE: InputDescription = {
  id: 'private', label: 'Addresses on your network', help: 'Whether it may fetch from your local network or this machine', kind: 'choice',
  choices: [{ value: 'no', label: 'Public addresses only' }, { value: 'yes', label: 'Allow your network and this machine', risk: 'loosens-a-protection' }],
  required: { default: 'no', defaultMeans: 'public addresses only' }, typed: { flag: '--allow-private-hosts', switchOn: 'yes' },
};
const text = (id: string, label: string, help: string, why: string, typed: InputDescription['typed'], optional?: { default: string; means: string }, kind: InputDescription['kind'] = 'text'): InputDescription => ({
  id, label, help, kind, freeTextReason: why, required: optional ? { default: optional.default, defaultMeans: optional.means } : true, typed,
});
const TITLE = text('title', 'Title', 'What to call it', 'your own words', { flag: '--title' }, { default: '', means: 'its own title' });
const TAGS = text('tags', 'Tags', 'Words to find it by, separated by commas', 'your own words', { flag: '--tags' }, { default: '', means: 'none' });
const FOLDER = text('folder', 'Folder', 'Where it goes in your knowledge', 'a folder path you choose', { flag: '--folder' }, { default: '', means: 'the top' });
const FILE = text('path', 'File', 'A file on this machine', 'a file path', { position: 1 }, undefined, 'path');
const CONNECTOR: InputDescription = {
  id: 'connector', label: 'Connector', help: 'The knowledge connectors', kind: 'choice',
  choices: { list: 'knowledge.connectors' as ListName, allowOther: { reason: 'a connector id' } }, required: true, typed: { position: 1 },
};
const REVIEW_VERDICTS: readonly FixedChoice[] = [
  { value: 'accept', label: 'Accept what it proposes' },
  { value: 'reject', label: 'Reject what it proposes' },
  { value: 'resolve', label: 'Mark it resolved' },
  { value: 'reopen', label: 'Open it again' },
  { value: 'edit', label: 'Accept it with my changes', help: 'Give the changed facts as a JSON object' },
  { value: 'forget', label: 'Forget what it is about', risk: 'cannot-be-undone' },
];

function read(fields: Pick<KnowledgeDefinition, 'capability' | 'actionId' | 'label' | 'word' | 'sentence' | 'run'> & Partial<Pick<KnowledgeDefinition, 'inputs' | 'example'>>): KnowledgeDefinition {
  return { inputs: [], example: {}, done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', ...fields };
}
function change(fields: Pick<KnowledgeDefinition, 'capability' | 'actionId' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<KnowledgeDefinition, 'risk' | 'lasts' | 'touches' | 'ownerOnly'>>): KnowledgeDefinition {
  return { done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', ...fields };
}

export const KNOWLEDGE_STATUS = read({
  capability: daemon('knowledge.status', 'safe'), actionId: 'status', label: 'See how your knowledge stands', word: 'status',
  sentence: 'Shows whether knowledge is ready, where it is kept, and how many sources, entries, links and issues it has.',
  async run(_values, services) {
    const status = await services.knowledge.status.get();
    return {
      text: fold(['Your knowledge', `  ready: ${status.ready ? 'yes' : 'no'}`, `  kept at: ${status.storagePath}`, `  sources: ${status.sourceCount}`, `  entries: ${status.nodeCount}`, `  links: ${status.edgeCount}`, `  issues: ${status.issueCount}`]),
      data: { ...status },
    };
  },
});

export const KNOWLEDGE_ASK = read({
  capability: daemon('knowledge.ask', 'safe'), actionId: 'ask', label: 'Ask your knowledge a question', word: 'ask',
  inputs: [
    text('question', 'Question', 'What you want to know', 'your own words', { tail: true }, undefined, 'long-text'),
    { id: 'mode', label: 'Answer', help: 'How long an answer', kind: 'choice', choices: [{ value: 'concise', label: 'Short' }, { value: 'standard', label: 'Usual' }, { value: 'detailed', label: 'Detailed' }], required: { default: 'standard', defaultMeans: 'usual' }, typed: { flag: '--mode' } },
    LIMIT(10),
    text('space', 'Knowledge space', 'One knowledge space only', 'a knowledge space id', { flag: '--space' }, { default: '', means: 'the usual one' }),
  ],
  sentence: 'Answers {question} from your knowledge, with the sources, facts and linked entries it used.', example: { question: 'what did we decide about retries', mode: 'concise' },
  async run(values, services) {
    const result = await services.knowledgeAsk({
      query: values.question!, limit: limitOf(values.limit, 10), mode: (values.mode || 'standard') as 'concise' | 'standard' | 'detailed',
      includeSources: true, includeConfidence: true, includeLinkedObjects: true, ...(values.space ? { knowledgeSpaceId: values.space } : {}),
    });
    return { text: renderKnowledgeAnswer(result), data: { answer: result.answer } };
  },
});

export const KNOWLEDGE_SEARCH = read({
  capability: daemon('knowledge.search', 'safe'), actionId: 'search', label: 'Search your knowledge', word: 'search',
  inputs: [text('words', 'Words', 'What to look for', 'your own words', { tail: true }), LIMIT(10)],
  sentence: 'Lists the sources and entries that match {words}, best first, with why each matched.', example: { words: 'retry policy' },
  async run(values, services) {
    const results = await services.knowledge.graph.items.search(values.words!, limitOf(values.limit, 10));
    if (results.length === 0) return { text: 'Nothing in your knowledge matches.', data: { results: [] } };
    return {
      text: fold([`${results.length} result${results.length === 1 ? '' : 's'}:`, ...results.flatMap((result) => [
        `  ${result.id} [${result.kind}] score ${result.score} ${result.source?.title ?? result.source?.canonicalUri ?? result.node?.title ?? result.id}`,
        `    ${result.reason}`,
      ])]),
      data: { results: results.map((result) => ({ id: result.id, kind: result.kind, score: result.score, reason: result.reason })) },
    };
  },
});

export const KNOWLEDGE_LIST = read({
  capability: daemon('knowledge.list', 'safe'), actionId: 'list', label: 'See sources, entries or issues', word: 'list',
  inputs: [
    { id: 'kind', label: 'Which', help: 'What to list', kind: 'choice', choices: [{ value: 'sources', label: 'Sources' }, { value: 'nodes', label: 'Entries' }, { value: 'issues', label: 'Issues' }], required: { default: 'sources', defaultMeans: 'sources' }, typed: { flag: '--kind' } },
    LIMIT(10),
  ],
  sentence: 'Lists your knowledge\'s sources, entries or issues, newest first.', example: { kind: 'nodes' },
  async run(values, services) {
    const limit = limitOf(values.limit, 10);
    if (values.kind === 'nodes') {
      const nodes = await services.knowledge.graph.nodes.list(limit);
      if (nodes.length === 0) return { text: 'No entries yet.', data: { nodes: [] } };
      return { text: fold([`${nodes.length} entr${nodes.length === 1 ? 'y' : 'ies'}:`, ...nodes.flatMap((node) => [`  ${node.id} [${node.kind}] ${node.title}`, ...(node.summary ? [`    ${node.summary}`] : [])])]), data: { nodes } };
    }
    if (values.kind === 'issues') {
      const issues = await services.knowledge.graph.issues.list(limit);
      if (issues.length === 0) return { text: 'No issues.', data: { issues: [] } };
      return { text: fold([`${issues.length} issue${issues.length === 1 ? '' : 's'}:`, ...issues.flatMap((issue) => [`  ${issue.id} [${issue.severity}] ${issue.code}`, `    ${issue.message}`])]), data: { issues } };
    }
    const sources = await services.knowledge.sources.list(limit);
    if (sources.length === 0) return { text: 'No sources yet.', data: { sources: [] } };
    return {
      text: fold([`${sources.length} source${sources.length === 1 ? '' : 's'}:`, ...sources.flatMap((source) => [
        `  ${source.id} [${source.sourceType}/${source.status}] ${source.title ?? source.canonicalUri ?? source.sourceUri ?? 'untitled'}`,
        ...(source.summary ? [`    ${source.summary}`] : []),
      ])]),
      data: { sources },
    };
  },
});

export const KNOWLEDGE_GET = read({
  capability: daemon('knowledge.get', 'safe'), actionId: 'get', label: 'See one source, entry or issue', word: 'get',
  inputs: [text('item', 'Item', 'Its id, as a list or search shows it', 'an id from a list or search', { position: 1 })],
  sentence: 'Shows {item} in full, with what it links to.', example: { item: 'src-1a2b' },
  async run(values, services) {
    const item = await services.knowledge.graph.items.get(values.item!);
    if (!item) throw new CapabilityRefusal(`Nothing in your knowledge is ${values.item}.`);
    const lines: string[] = [];
    if (item.source) lines.push(`Source ${item.source.id}`, `  title: ${item.source.title ?? 'untitled'}`, `  address: ${item.source.canonicalUri ?? item.source.sourceUri ?? 'none'}`, `  state: ${item.source.status}`, ...(item.source.summary ? [`  summary: ${item.source.summary}`] : []));
    else if (item.node) lines.push(`Entry ${item.node.id}`, `  kind: ${item.node.kind}`, `  title: ${item.node.title}`, ...(item.node.summary ? [`  summary: ${item.node.summary}`] : []));
    else if (item.issue) lines.push(`Issue ${item.issue.id}`, `  severity: ${item.issue.severity}`, `  code: ${item.issue.code}`, `  message: ${item.issue.message}`);
    if (item.relatedEdges.length > 0) lines.push('  links:', ...item.relatedEdges.slice(0, 12).map((edge) => `    ${edge.fromKind}:${edge.fromId} -[${edge.relation}]-> ${edge.toKind}:${edge.toId}`));
    return { text: fold(lines), data: { item } };
  },
});

export const KNOWLEDGE_QUEUE = read({
  capability: daemon('knowledge.queue', 'safe'), actionId: 'queue', label: 'See issues waiting for review', word: 'queue', inputs: [LIMIT(10, { position: 1 })],
  sentence: 'Lists the knowledge issues waiting for you to review.', example: { limit: '5' },
  async run(values, services) {
    const issues = await services.knowledge.graph.issues.list(limitOf(values.limit, 10));
    if (issues.length === 0) return { text: 'Nothing waits for review.', data: { issues: [] } };
    return { text: fold([`Waiting for review (${issues.length}):`, ...issues.flatMap((issue) => [`  ${issue.id} [${issue.severity}] ${issue.code}`, `    ${issue.message}`])]), data: { issues } };
  },
});

export const KNOWLEDGE_PACKET = read({
  capability: daemon('knowledge.packet', 'safe'), actionId: 'packet', label: 'See the knowledge a task would get', word: 'packet',
  inputs: [
    text('task', 'Task', 'The task, as you would ask for it', 'your own words', { tail: true }, undefined, 'long-text'),
    { ...text('scope', 'Only about', 'A path the knowledge must be about; one per --scope', 'a path in this project', { flag: '--scope' }, { default: '', means: 'anything' }), typed: { flag: '--scope', repeats: true } },
  ],
  sentence: 'Shows the compact knowledge a model would be given for {task}.', example: { task: 'add retries to the uploader' },
  async run(values, services) {
    const prompt = await services.knowledge.packets.buildPrompt(values.task!, (values.scope ?? '').split('\n').map((entry) => entry.trim()).filter(Boolean));
    return { text: prompt ?? 'No knowledge matched that task.', data: { prompt: prompt ?? null } };
  },
});

export const KNOWLEDGE_LINT = read({
  capability: daemon('knowledge.lint', 'safe'), actionId: 'lint', label: 'Check your knowledge for problems', word: 'lint',
  sentence: 'Lists the problems found in your knowledge: broken links, duplicates, missing facts.',
  async run(_values, services) {
    const issues = await services.knowledge.status.lint();
    if (issues.length === 0) return { text: 'No problems found.', data: { issues: [] } };
    return { text: fold([`${issues.length} problem${issues.length === 1 ? '' : 's'}:`, ...issues.flatMap((issue) => [`  ${issue.id} [${issue.severity}] ${issue.code}`, `    ${issue.message}`])]), data: { issues } };
  },
});

export const KNOWLEDGE_CANDIDATES = read({
  capability: daemon('knowledge.candidates', 'safe'), actionId: 'candidates', label: 'See entries that could be merged', word: 'candidates', inputs: [LIMIT(10, { position: 1 })],
  sentence: 'Lists the entries tidying found that could be merged, best first.', example: { limit: '5' },
  async run(values, services) {
    const candidates = await services.knowledge.consolidation.candidates(limitOf(values.limit, 10));
    if (candidates.length === 0) return { text: 'Nothing could be merged.', data: { candidates: [] } };
    return { text: fold([`Could be merged (${candidates.length}):`, ...candidates.flatMap((candidate) => [`  ${candidate.id} [${candidate.status}] score ${candidate.score} ${candidate.title}`, `    ${candidate.candidateType}`])]), data: { candidates } };
  },
});

export const KNOWLEDGE_REPORTS = read({
  capability: daemon('knowledge.reports', 'safe'), actionId: 'reports', label: 'See what tidying did', word: 'reports', inputs: [LIMIT(10, { position: 1 })],
  sentence: 'Lists the reports of past tidying runs, newest first.', example: { limit: '5' },
  async run(values, services) {
    const reports = await services.knowledge.consolidation.reports(limitOf(values.limit, 10));
    if (reports.length === 0) return { text: 'No tidying reports yet.', data: { reports: [] } };
    return { text: fold([`Tidying reports (${reports.length}):`, ...reports.flatMap((report) => [`  ${report.id} [${report.kind}] ${report.title}`, `    ${report.summary}`])]), data: { reports } };
  },
});

export const KNOWLEDGE_SCHEDULES = read({
  capability: daemon('knowledge.schedules', 'safe'), actionId: 'schedules', label: 'See when knowledge is tidied', word: 'schedules',
  sentence: 'Lists the schedules that tidy and refresh your knowledge, and whether each is on.',
  async run(_values, services) {
    const schedules = await services.knowledge.jobs.schedules.list(20);
    if (schedules.length === 0) return { text: 'No knowledge schedules.', data: { schedules: [] } };
    return { text: fold([`Schedules (${schedules.length}):`, ...schedules.flatMap((schedule) => [`  ${schedule.id} [${schedule.enabled ? 'on' : 'off'}] ${schedule.jobId}`, `    ${schedule.label}`])]), data: { schedules } };
  },
});

export const KNOWLEDGE_INGEST_URL = change({
  capability: daemon('knowledge.ingest-url', 'safe'), actionId: 'ingest-url', label: 'Add a web page', word: 'ingest-url',
  inputs: [text('url', 'Address', 'The page\'s web address', 'a web address', { position: 1 }), TITLE, TAGS, FOLDER, PRIVATE],
  sentence: 'The page at {url} is fetched and added to your knowledge, until you change it.', example: { url: 'https://example.com/guide', tags: 'docs' },
  async run(values, services) {
    const result = await services.knowledge.ingest.url({
      url: values.url!, title: values.title || undefined, tags: tagsOf(values.tags), folderPath: values.folder || undefined,
      sourceType: 'url', connectorId: 'url', fetchMode: fetchMode(values),
    });
    return { text: fold([knowledgeIngestLine(result.source, values.url!), ...(result.source.summary ? [`  ${result.source.summary}`] : [])]), data: { source: result.source.id } };
  },
});

export const KNOWLEDGE_IMPORT_URLS = change({
  capability: daemon('knowledge.import-urls', 'safe'), actionId: 'import-urls', label: 'Add pages from a list of addresses', word: 'import-urls', inputs: [FILE, PRIVATE],
  sentence: 'Every address in {path} is fetched and added to your knowledge, until you change it.', example: { path: 'links.txt' },
  async run(values, services, caller) {
    const result = await services.knowledge.ingest.urlsFile({ path: pathIn(values.path!, caller), fetchMode: fetchMode(values) });
    return { text: importLines('the pages in the list', result), data: { imported: result.imported, failed: result.failed } };
  },
});

export const KNOWLEDGE_IMPORT_BOOKMARKS = change({
  capability: daemon('knowledge.import-bookmarks', 'safe'), actionId: 'import-bookmarks', label: 'Add pages from a bookmarks file', word: 'import-bookmarks', inputs: [FILE, PRIVATE],
  sentence: 'Every bookmark in {path} is fetched and added to your knowledge, until you change it.', example: { path: 'bookmarks.html' },
  async run(values, services, caller) {
    const result = await services.knowledge.ingest.bookmarksFile({ path: pathIn(values.path!, caller), fetchMode: fetchMode(values) });
    return { text: importLines('the bookmarked pages', result), data: { imported: result.imported, failed: result.failed } };
  },
});

export const KNOWLEDGE_INGEST_FILE = change({
  capability: daemon('knowledge.ingest-file', 'safe'), actionId: 'ingest-file', label: 'Add a file', word: 'ingest-file', inputs: [FILE, TITLE, TAGS, FOLDER],
  sentence: 'File {path} is added to your knowledge, until you change it.', example: { path: 'notes/plan.md' },
  async run(values, services, caller) {
    const result = await services.knowledge.ingest.artifact({ path: pathIn(values.path!, caller), title: values.title || undefined, tags: tagsOf(values.tags), folderPath: values.folder || undefined, connectorId: 'goodvibes-agent-file' });
    return { text: fold([knowledgeIngestLine(result.source, values.path!), ...(result.source.summary ? [`  ${result.source.summary}`] : [])]), data: { source: result.source.id } };
  },
});

export const KNOWLEDGE_INGEST_ARTIFACT = change({
  capability: daemon('knowledge.ingest-artifact', 'safe'), actionId: 'ingest-artifact', label: 'Add a saved artifact', word: 'ingest-artifact',
  inputs: [text('artifact', 'Artifact', 'Its id, as the artifact list shows it', 'an artifact id', { position: 1 }), TITLE, TAGS, FOLDER],
  sentence: 'Artifact {artifact} is added to your knowledge, until you change it.', example: { artifact: 'art-1a2b' },
  async run(values, services) {
    const result = await services.knowledge.ingest.artifact({ artifactId: values.artifact!, title: values.title || undefined, tags: tagsOf(values.tags), folderPath: values.folder || undefined, connectorId: 'goodvibes-agent-artifact-browser' });
    return { text: fold([knowledgeIngestLine(result.source, values.artifact!), ...(result.source.summary ? [`  ${result.source.summary}`] : [])]), data: { source: result.source.id } };
  },
});

const BROWSERS = ['chrome', 'chromium', 'brave', 'edge', 'vivaldi', 'arc', 'opera', 'firefox', 'zen', 'librewolf', 'waterfox', 'floorp', 'safari', 'orion', 'epiphany'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export const KNOWLEDGE_IMPORT_BROWSER_HISTORY = change({
  capability: daemon('knowledge.import-browser-history', 'safe'), actionId: 'import-browser-history', label: 'Add your browser history', word: 'import-browser-history',
  inputs: [
    text('browsers', 'Browsers', 'Which browsers, separated by commas (chrome, firefox, safari ...)', 'browser names', { flag: '--browsers' }, { default: '', means: 'every installed browser' }),
    { id: 'sources', label: 'What', help: 'History, bookmarks or both', kind: 'choice', choices: [{ value: 'history', label: 'History only' }, { value: 'bookmark', label: 'Bookmarks only' }], required: { default: '', defaultMeans: 'history and bookmarks' }, typed: { flag: '--sources' } },
    LIMIT(250),
    { id: 'days', label: 'From the last', help: 'How many days back', kind: 'number', freeTextReason: 'a number of days', required: { default: '', defaultMeans: 'all of it' }, typed: { flag: '--since-days' } },
  ],
  sentence: 'Pages from your browsers\' history and bookmarks are added to your knowledge, until you change it.', example: { browsers: 'firefox', days: '30' },
  touches: 'this-machine',
  ownerOnly: { reason: 'it reads your browser history', instead: 'Ask the owner to add it from the Memory and knowledge place.' },
  async run(values, services) {
    const browsers = (values.browsers ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    const unknown = browsers.filter((name) => !(BROWSERS as readonly string[]).includes(name));
    if (unknown.length > 0) throw new CapabilityRefusal(`Unknown browser ${unknown.join(', ')}. Browsers: ${BROWSERS.join(', ')}. Nothing was added.`);
    for (const [label, value] of [['How many', values.limit], ['From the last', values.days]] as const) {
      if (value && (!/^\d+$/.test(value) || Number(value) <= 0)) throw new CapabilityRefusal(`"${label}" takes a whole number above zero, not "${value}". Nothing was added.`);
    }
    const result = await services.knowledge.ingest.browserHistory({
      ...(browsers.length > 0 ? { browsers: browsers as never } : {}),
      ...(values.sources ? { sourceKinds: [values.sources] as never } : {}),
      limit: values.limit ? Number(values.limit) : 250,
      ...(values.days ? { sinceMs: Date.now() - Number(values.days) * DAY_MS } : {}),
      connectorId: 'goodvibes-agent-browser-history',
    });
    return {
      text: fold([`Added from your browsers: ${result.imported} ok, ${result.failed} failed.`, ...(result.profiles.length > 0 ? [`  browser profiles read: ${result.profiles.length}`] : []), ...result.errors.slice(0, 10).map((error) => `  error: ${error}`)]),
      data: { imported: result.imported, failed: result.failed },
    };
  },
});

export const KNOWLEDGE_INGEST_CONNECTOR = change({
  capability: daemon('knowledge.ingest-connector', 'safe'), actionId: 'ingest-connector', label: 'Add something through a connector', word: 'ingest-connector',
  inputs: [
    CONNECTOR,
    text('input', 'Input', 'What the connector reads: JSON or text', 'what the connector takes', { flag: '--input' }, { default: '', means: 'none' }, 'long-text'),
    text('path', 'File', 'A file the connector reads', 'a file path', { flag: '--path' }, { default: '', means: 'none' }, 'path'),
    text('content', 'Text', 'Text the connector reads', 'your own text', { flag: '--content' }, { default: '', means: 'none' }, 'long-text'),
    PRIVATE,
  ],
  sentence: 'What connector {connector} reads from the input, file or text given is added to your knowledge, until you change it.', example: { connector: 'rss', input: 'https://example.com/feed' },
  async run(values, services, caller) {
    const trimmed = (values.input ?? '').trim();
    let given: unknown = trimmed || undefined;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) { try { given = JSON.parse(trimmed) as unknown; } catch { given = trimmed; } }
    if (given === undefined && !values.path && !values.content) throw new CapabilityRefusal('Give the connector something to read: an input, a file or text. Nothing was added.');
    const result = await services.knowledge.ingest.connectorInput({
      connectorId: values.connector!, input: given, ...(values.path ? { path: pathIn(values.path, caller) } : {}), ...(values.content ? { content: values.content } : {}), fetchMode: fetchMode(values),
    });
    return { text: fold([`Added through ${values.connector}: ${result.imported} ok, ${result.failed} failed.`, ...result.errors.slice(0, 10).map((error) => `  error: ${error}`)]), data: { imported: result.imported, failed: result.failed } };
  },
});

export const KNOWLEDGE_MAP = read({
  capability: daemon('knowledge.map', 'safe'), actionId: 'map', label: 'See the knowledge map', word: 'map',
  inputs: [text('about', 'About', 'Only the part about these words', 'your own words', { tail: true }, { default: '', means: 'all of it' }), LIMIT(50)],
  sentence: 'Shows how many entries and links your knowledge has, and for what is asked about.', example: { about: 'billing' },
  async run(values, services) {
    const map = await services.knowledge.graph.map({ limit: limitOf(values.limit, 50), ...(values.about ? { query: values.about } : {}) });
    return {
      text: fold([
        values.about ? `The knowledge map about "${values.about}"` : 'The knowledge map',
        `  entries: ${map.nodeCount}${map.totalNodeCount !== undefined && map.totalNodeCount !== map.nodeCount ? ` of ${map.totalNodeCount}` : ''}`,
        `  links: ${map.edgeCount}${map.totalEdgeCount !== undefined && map.totalEdgeCount !== map.edgeCount ? ` of ${map.totalEdgeCount}` : ''}`,
      ]),
      data: { nodeCount: map.nodeCount, edgeCount: map.edgeCount },
    };
  },
});

export const KNOWLEDGE_CONNECTORS = read({
  capability: daemon('knowledge.connectors', 'safe'), actionId: 'connectors', label: 'See knowledge connectors', word: 'connectors',
  sentence: 'Lists the connectors that can add to your knowledge, and what each reads.',
  async run(_values, services) {
    const connectors = services.knowledge.connectors.list().map((connector) => ({ id: connector.id, name: connector.displayName ?? connector.id, sourceType: connector.sourceType, description: connector.description }));
    if (connectors.length === 0) return { text: 'No connectors.', data: { connectors: [] } };
    return { text: fold([`Connectors (${connectors.length}):`, ...connectors.flatMap((connector) => [`  ${connector.id} [${connector.sourceType}] ${connector.name}`, `    ${connector.description}`])]), data: { connectors } };
  },
});

export const KNOWLEDGE_CONNECTOR = read({
  capability: daemon('knowledge.connector', 'safe'), actionId: 'connector', label: 'See one connector', word: 'connector', inputs: [CONNECTOR],
  sentence: 'Shows connector {connector}: what it reads and what it can do.', example: { connector: 'rss' },
  async run(values, services) {
    const connector = services.knowledge.connectors.get(values.connector!);
    if (!connector) throw new CapabilityRefusal(`No connector is ${values.connector}.`, 'The connectors are listed in the Memory and knowledge place.');
    return {
      text: fold([`Connector ${connector.id}`, `  name: ${connector.displayName ?? connector.id}`, `  reads: ${connector.sourceType}`, `  ${connector.description}`, `  can: ${connector.capabilities?.join(', ') || 'nothing more'}`]),
      data: { id: connector.id, sourceType: connector.sourceType },
    };
  },
});

export const KNOWLEDGE_CONNECTOR_DOCTOR = read({
  capability: daemon('knowledge.connector-doctor', 'safe'), actionId: 'connector-doctor', label: 'Check a connector', word: 'connector-doctor', inputs: [CONNECTOR],
  sentence: 'Checks whether connector {connector} is ready, and what to fix when it is not.', example: { connector: 'rss' },
  async run(values, services) {
    const report = await services.knowledge.connectors.doctor(values.connector!);
    if (!report) throw new CapabilityRefusal(`No check is available for connector ${values.connector}.`);
    return {
      text: fold([
        `Connector ${report.connectorId}`, `  ready: ${report.ready ? 'yes' : 'no'}`, `  ${report.summary}`,
        ...(report.checks.length > 0 ? ['  checks:', ...report.checks.slice(0, 10).map((check) => `    - ${check.label} [${check.status}] ${check.detail}`)] : []),
        ...(report.hints.length > 0 ? ['  to fix:', ...report.hints.slice(0, 8).map((hint) => `    - ${hint}`)] : []),
      ]),
      data: { ready: report.ready },
    };
  },
});

export const KNOWLEDGE_REVIEW_ISSUE = change({
  capability: daemon('knowledge.review-issue', 'safe'), actionId: 'review-issue', label: 'Review an issue', word: 'review-issue',
  inputs: [
    { id: 'issue', label: 'Issue', help: 'Issues waiting for review', kind: 'choice', choices: { list: 'knowledge.issues' as ListName, allowOther: { reason: 'an issue id' } }, required: true, typed: { position: 1 } },
    { id: 'verdict', label: 'Verdict', help: 'What to do with it', kind: 'choice', choices: REVIEW_VERDICTS, required: true, typed: { position: 2 } },
    text('value', 'Changed facts', 'With "Accept it with my changes": the facts as a JSON object', 'a JSON object', { flag: '--value' }, { default: '', means: 'none' }, 'long-text'),
    text('reviewer', 'Reviewed by', 'The name recorded as the reviewer', 'a name', { flag: '--reviewer' }, { default: '', means: 'the program you are using' }),
  ],
  sentence: 'Issue {issue} is answered with {verdict}, until you change it.', example: { issue: 'iss-1a2b', verdict: 'accept' },
  async run(values, services, caller) {
    let value: Record<string, unknown> | undefined;
    if (values.value) {
      try { value = JSON.parse(values.value) as Record<string, unknown>; } catch { value = undefined; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CapabilityRefusal('The changed facts must be a JSON object. Nothing was reviewed.');
    }
    const result = await services.knowledge.graph.issues.review({
      issueId: values.issue!, action: values.verdict as never, reviewer: values.reviewer || caller.program || 'daemon', ...(value ? { value } : {}),
    });
    return {
      text: fold([
        `Reviewed issue ${result.issue.id}: ${values.verdict}; now ${result.issue.status}.`,
        ...(result.node ? [`  entry: ${result.node.id} ${result.node.title}`] : []),
        ...(result.source ? [`  source: ${result.source.id} ${result.source.title ?? result.source.canonicalUri ?? result.source.sourceUri ?? 'untitled'}`] : []),
        ...(result.appliedFacts ? [`  facts applied: ${Object.keys(result.appliedFacts).join(', ') || 'none'}`] : []),
      ]),
      data: { issue: result.issue.id, status: result.issue.status },
    };
  },
});

export const KNOWLEDGE_CONSOLIDATE = change({
  capability: daemon('knowledge.consolidate', 'unsafe'), actionId: 'consolidate', label: 'Tidy your knowledge', word: 'consolidate',
  inputs: [{ id: 'depth', label: 'How thorough', help: 'A quick pass or a deep one', kind: 'choice', choices: [{ value: 'light', label: 'A quick pass' }, { value: 'deep', label: 'A deep pass', help: 'Slower; merges and rewrites more.' }], required: { default: 'light', defaultMeans: 'a quick pass' }, typed: { position: 1 } }],
  sentence: 'A tidying pass merges duplicates and fills gaps in your knowledge now, until you change it.', example: { depth: 'deep' },
  async run(values, services) {
    const run = await services.knowledge.jobs.run(values.depth === 'deep' ? 'knowledge-deep-consolidation' : 'knowledge-light-consolidation', { mode: 'inline' });
    return { text: `Tidying run ${run.id} finished: ${run.status}.`, data: { run: run.id, status: run.status } };
  },
});

export const KNOWLEDGE_REINDEX = change({
  capability: daemon('knowledge.reindex', 'safe'), actionId: 'reindex', label: 'Rebuild the knowledge index', word: 'reindex', inputs: [],
  sentence: 'Every source is read again and the entries and links are rebuilt from them, until you change it.', example: {},
  async run(_values, services) {
    const result = await services.knowledge.status.reindex();
    const failures = result.recompileFailures ?? [];
    return {
      text: fold([
        failures.length > 0 ? `Rebuilt, with ${failures.length} source${failures.length === 1 ? '' : 's'} not rebuilt.` : 'Rebuilt.',
        `  sources: ${result.status.sourceCount}`, `  entries: ${result.status.nodeCount}`, `  links: ${result.status.edgeCount}`, `  issues: ${result.status.issueCount}`,
        ...failures.map((failure) => `  not rebuilt: ${failure.sourceId} - ${failure.error}`),
      ]),
      data: { failures: failures.length },
    };
  },
});

export const KNOWLEDGE_CANCEL_RUN = change({
  capability: daemon('knowledge.cancel-run', 'safe'), actionId: 'cancel-run', label: 'Stop a knowledge job', word: 'cancel-run',
  inputs: [{ id: 'run', label: 'Job', help: 'Knowledge jobs waiting or running', kind: 'choice', choices: { list: 'knowledge.runs.active' as ListName, allowOther: { reason: 'a job run id' } }, required: true, typed: { position: 1 } }],
  sentence: 'Knowledge job {run} is stopped.', example: { run: 'run-1a2b' }, risk: 'cannot-be-undone', lasts: 'not-a-change',
  async run(values, services) {
    const run = await services.knowledge.jobs.cancelRun(values.run!);
    return { text: `Job ${run.id} (${run.jobId}) stopped; it is ${run.status}${run.error ? `: ${run.error}` : ''}.`, data: { run: run.id, status: run.status } };
  },
});

/** Every knowledge capability, in the order a person meets them. */
export const KNOWLEDGE_CAPABILITIES: readonly KnowledgeDefinition[] = [
  KNOWLEDGE_STATUS, KNOWLEDGE_ASK, KNOWLEDGE_SEARCH, KNOWLEDGE_LIST, KNOWLEDGE_GET, KNOWLEDGE_QUEUE, KNOWLEDGE_PACKET, KNOWLEDGE_LINT,
  KNOWLEDGE_CANDIDATES, KNOWLEDGE_REPORTS, KNOWLEDGE_SCHEDULES, KNOWLEDGE_INGEST_URL, KNOWLEDGE_IMPORT_URLS, KNOWLEDGE_IMPORT_BOOKMARKS,
  KNOWLEDGE_INGEST_FILE, KNOWLEDGE_INGEST_ARTIFACT, KNOWLEDGE_IMPORT_BROWSER_HISTORY, KNOWLEDGE_INGEST_CONNECTOR, KNOWLEDGE_MAP,
  KNOWLEDGE_CONNECTORS, KNOWLEDGE_CONNECTOR, KNOWLEDGE_CONNECTOR_DOCTOR, KNOWLEDGE_REVIEW_ISSUE, KNOWLEDGE_CONSOLIDATE, KNOWLEDGE_REINDEX,
  KNOWLEDGE_CANCEL_RUN,
];
