/**
 * `/knowledge`, described once (command-actions/) for both terminal apps:
 * the structured knowledge store. Ask it and search it, read its sources,
 * entries and issues, add web pages and lists of them, review what it flags,
 * rebuild and tidy it. The terminal app works on its own knowledge; the Agent
 * on Agent Knowledge, which is isolated (no other knowledge space, no
 * fallback), and adds files, artifacts, browser history and connectors. Each
 * app installs where its knowledge is and how it prints; the actions and
 * their words are the same.
 */
import type { KnowledgeApi, KnowledgeService } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';
import { choiceInput, doAction, listInput, readAction, textInput } from './described-command-kit.js';

type AskInput = Parameters<KnowledgeService['ask']>[0];
type AskResult = Awaited<ReturnType<KnowledgeService['ask']>>;

/** One app's way to its knowledge; writes already carry the app's guards. */
export interface KnowledgePorts {
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
  readonly url: KnowledgeApi['ingest']['url'];
  readonly bookmarksFile: KnowledgeApi['ingest']['bookmarksFile'];
  readonly urlsFile: KnowledgeApi['ingest']['urlsFile'];
  readonly review: KnowledgeApi['graph']['issues']['review'];
  readonly reindex: KnowledgeApi['status']['reindex'];
  readonly run: KnowledgeApi['jobs']['run'];
  readonly runs: KnowledgeApi['jobs']['runs'];
  readonly cancelRun: KnowledgeApi['jobs']['cancelRun'];
  readonly ask: ((input: AskInput) => Promise<AskResult>) | undefined;
  readonly sessionId: () => string;
}

/** How one app prints knowledge (each keeps its own spacing). */
export interface KnowledgePresentation {
  readonly statusTitle: string;
  readonly headingSuffix: string;
  readonly fieldSeparator: string;
  readonly scoreSeparator: string;
  readonly nodeKind: string;
  readonly reviewer: string;
  readonly sourceLabel: string;
  readonly renderAsk: (result: AskResult) => string;
}

/** The Agent's further ways in: files, artifacts, browser history, connectors and the map. */
export interface KnowledgeMoreHost<Ctx> {
  ingestFile(ctx: Ctx, input: { readonly path: string; readonly title: string; readonly tags: string; readonly folder: string }): Promise<string>;
  ingestArtifact(ctx: Ctx, input: { readonly artifact: string; readonly title: string; readonly tags: string; readonly folder: string }): Promise<string>;
  browserHistory(ctx: Ctx, input: { readonly browsers: string; readonly sources: string; readonly limit: string; readonly days: string }): Promise<string>;
  connector(ctx: Ctx, input: { readonly connector: string; readonly input: string; readonly path: string; readonly content: string; readonly allowPrivate: boolean }): Promise<string>;
  map(ctx: Ctx, query: string, limit: number): Promise<string>;
  connectors(ctx: Ctx): readonly { readonly id: string; readonly name: string; readonly sourceType: string; readonly description: string }[];
  connectorDetail(ctx: Ctx, id: string): string;
  doctor(ctx: Ctx, id: string): Promise<string>;
}

export interface KnowledgeHost<Ctx> {
  /** The app's knowledge, or a refusal saying why there is none here (never another knowledge space). */
  readonly ports: (ctx: Ctx) => KnowledgePorts;
  /** Open the app's knowledge view; throws a refusal when it cannot. */
  readonly open: (ctx: Ctx) => void;
  readonly presentation: KnowledgePresentation;
  /** Why a question may not name a knowledge space here, or undefined where it may. */
  readonly spacesRefused: string | undefined;
  readonly more: { readonly unavailable: string } | KnowledgeMoreHost<Ctx>;
}

let installed: KnowledgeHost<CommandActionContext> | undefined;
function hostOf(): KnowledgeHost<CommandActionContext> {
  if (!installed) throw commandRefusal('Knowledge is not available in this session.');
  return installed;
}
function moreOf(): KnowledgeMoreHost<CommandActionContext> {
  const more = hostOf().more;
  if ('unavailable' in more) throw commandRefusal(more.unavailable);
  return more;
}
const fold = (lines: readonly string[]): string => lines.join('\n');
const limitOf = (value: string | undefined, fallback: number): number => Math.max(1, Number.parseInt(value ?? '', 10) || fallback);
const tagsOf = (value: string | undefined): string[] | undefined => {
  const tags = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
};

/** One knowledge call; a failure that is not a refusal is the command's failed result. */
async function knowing<T>(work: (ports: KnowledgePorts, presentation: KnowledgePresentation) => Promise<T>, ctx: CommandActionContext): Promise<T> {
  const host = hostOf();
  try {
    return await work(host.ports(ctx), host.presentation);
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`[knowledge] ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}

/** One report for every ingest: a stored source whose fetch failed is a failure, not an ingest. */
export function knowledgeIngestLine(source: { readonly id: string; readonly status: string; readonly canonicalUri?: string | undefined; readonly sourceUri?: string | undefined; readonly crawlError?: string | undefined }, fallbackSubject: string): string {
  const subject = source.canonicalUri ?? source.sourceUri ?? fallbackSubject;
  if (source.status === 'failed') {
    throw commandRefusal(`[knowledge] Ingest failed ${source.id} ${subject}: ${source.crawlError ?? 'no reason recorded'}. The source is stored with status failed; no content was added to knowledge`, undefined, 'COMMAND_FAILED');
  }
  return `[knowledge] Ingested ${source.id} ${subject}`;
}

function importLines(what: string, result: { readonly imported: number; readonly failed: number; readonly errors: readonly string[] }, separator: string): string {
  return fold([`[knowledge] Imported ${what}${separator}${result.imported} ok, ${result.failed} failed`, ...result.errors.slice(0, 10).map((error) => `  error${separator}${error}`)]);
}

const ISSUES = defineList<CommandActionContext>({
  name: 'knowledge.issues',
  async read(ctx) {
    return (await hostOf().ports(ctx).issues(50)).map((issue): ListRow => ({ value: issue.id, label: issue.message, detail: issue.code, state: issue.severity }));
  },
  operator: { method: 'knowledge.issues.list', input: {}, rows: { from: 'issues', value: 'id', label: 'message', detail: 'code', state: 'severity' } },
});
const ACTIVE_RUNS = defineList<CommandActionContext>({
  name: 'knowledge.runs.active',
  async read(ctx) {
    return hostOf().ports(ctx).runs(100).filter((run) => run.status === 'queued' || run.status === 'running').map((run): ListRow => ({ value: run.id, label: run.jobId, state: run.status }));
  },
  operator: { method: 'knowledge.job-runs.list', input: {}, rows: { from: 'runs', value: 'id', label: 'jobId', state: 'status' } },
});
const CONNECTORS = defineList<CommandActionContext>({
  name: 'knowledge.connectors',
  async read(ctx) {
    const more = installed?.more;
    if (!more || 'unavailable' in more) return [];
    return more.connectors(ctx).map((connector): ListRow => ({ value: connector.id, label: connector.name, detail: connector.description, state: connector.sourceType }));
  },
  operator: { method: 'knowledge.connectors.list', input: {}, rows: { from: 'connectors', value: 'id', label: 'displayName', detail: 'description' } },
});

const LIMIT = (fallback: number, typed: InputDescription['typed'] = { flag: '--limit' }): InputDescription => ({
  id: 'limit', label: 'How many', help: 'The most to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: String(fallback) }, typed,
});
const PRIVATE: InputDescription = choiceInput({
  id: 'private', label: 'Addresses on your network', help: 'Whether it may fetch from your local network or this machine',
  choices: [{ value: 'no', label: 'Public addresses only' }, { value: 'yes', label: 'Allow your network and this machine', risk: 'loosens-a-protection' }],
  typed: { flag: '--allow-private-hosts', switchOn: 'yes' }, optional: { default: 'no', means: 'public addresses only' },
});
const TITLE: InputDescription = textInput({ id: 'title', label: 'Title', help: 'What to call it', why: 'your own words', typed: { flag: '--title' }, optional: { default: '', means: 'its own title' } });
const TAGS: InputDescription = textInput({ id: 'tags', label: 'Tags', help: 'Words to find it by, separated by commas', why: 'your own words', typed: { flag: '--tags' }, optional: { default: '', means: 'none' } });
const FOLDER: InputDescription = textInput({ id: 'folder', label: 'Folder', help: 'Where it goes in your knowledge', why: 'a folder path you choose', typed: { flag: '--folder' }, optional: { default: '', means: 'the top' } });
const FILE: InputDescription = textInput({ id: 'path', label: 'File', help: 'A file on this machine', why: 'a file path', kind: 'path', typed: { position: 1 } });
const REVIEW_VERDICTS: readonly FixedChoice[] = [
  { value: 'accept', label: 'Accept what it proposes' },
  { value: 'reject', label: 'Reject what it proposes' },
  { value: 'resolve', label: 'Mark it resolved' },
  { value: 'reopen', label: 'Open it again' },
  { value: 'edit', label: 'Accept it with my changes', help: 'Give the changed facts as a JSON object' },
  { value: 'forget', label: 'Forget what it is about', risk: 'cannot-be-undone' },
];
const KNOWLEDGE_METHOD = (method: string, fields: Readonly<Record<string, string>>) => ({ method, fields });
const AGENT_ONLY = { terminalOnly: 'It reaches Agent Knowledge through the Agent.' } as const;

type KnowledgeAction = ActionDescription<CommandActionContext>;
function change(fields: Pick<KnowledgeAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run' | 'operator'> & Partial<Pick<KnowledgeAction, 'risk' | 'lasts' | 'touches' | 'ownerOnly'>>): KnowledgeAction {
  return { done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', ...fields };
}

async function readList(kind: string, limit: number, ctx: CommandActionContext): Promise<string> {
  return knowing(async (ports, presentation) => {
    if (kind === 'nodes') {
      const nodes = await ports.nodes(limit);
      if (nodes.length === 0) return '[knowledge] No entries.';
      return fold([`[knowledge] ${nodes.length} entr${nodes.length === 1 ? 'y' : 'ies'}${presentation.headingSuffix}`, ...nodes.flatMap((node) => [`  ${node.id} [${node.kind}] ${node.title}`, ...(node.summary ? [`    ${node.summary}`] : [])])]);
    }
    if (kind === 'issues') {
      const issues = await ports.issues(limit);
      if (issues.length === 0) return '[knowledge] No issues.';
      return fold([`[knowledge] ${issues.length} issue(s)${presentation.headingSuffix}`, ...issues.flatMap((issue) => [`  ${issue.id} [${issue.severity}] ${issue.code}`, `    ${issue.message}`])]);
    }
    const sources = await ports.sources(limit);
    if (sources.length === 0) return '[knowledge] No sources.';
    return fold([`[knowledge] ${sources.length} source(s)${presentation.headingSuffix}`, ...sources.flatMap((source) => [
      `  ${source.id} [${source.sourceType}/${source.status}] ${source.title ?? source.canonicalUri ?? source.sourceUri ?? 'untitled'}`,
      ...(source.summary ? [`    ${source.summary}`] : []),
    ])]);
  }, ctx);
}

export const KNOWLEDGE_COMMAND: CommandDescription<CommandActionContext> = {
  name: 'knowledge',
  title: 'Knowledge',
  summary: 'Your structured knowledge: ask it, search it, add pages and files, review what it flags, and keep it tidy',
  group: 'Knowledge',
  report: 'status',
  firstScreenRows: [
    'status', 'ask', 'search', 'ingest-url', 'open',
    { label: 'Read sources, entries and issues…', actions: ['list', 'get', 'queue', 'map', 'packet', 'lint'] },
    { label: 'Add to it…', actions: ['import-urls', 'import-bookmarks', 'ingest-file', 'ingest-artifact', 'import-browser-history', 'ingest-connector'] },
    { label: 'Review and tidy…', actions: ['review-issue', 'candidates', 'reports', 'consolidate', 'reindex', 'schedules', 'cancel-run'] },
    { label: 'Connectors…', actions: ['connectors', 'connector', 'connector-doctor'] },
  ],
  actions: [
    doAction<CommandActionContext>({
      id: 'open', label: 'Open your knowledge', word: 'open', touches: 'reads',
      sentence: 'Opens the knowledge view: sources, entries, issues and what is being added.',
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(_values, ctx) { hostOf().open(ctx); },
    }),
    readAction<CommandActionContext>({
      id: 'status', label: 'See how your knowledge stands', word: 'status',
      sentence: 'Shows whether knowledge is ready, where it is kept, and how many sources, entries, links and issues it has.',
      operator: KNOWLEDGE_METHOD('knowledge.status', {}),
      async run(_values, ctx) {
        return knowing(async (ports, presentation) => {
          const status = await ports.status();
          return fold([presentation.statusTitle, `  ready: ${status.ready ? 'yes' : 'no'}`, `  storage: ${status.storagePath}`, `  sources: ${status.sourceCount}`, `  entries: ${status.nodeCount}`, `  links: ${status.edgeCount}`, `  issues: ${status.issueCount}`]);
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'ask', label: 'Ask your knowledge a question', word: 'ask',
      inputs: [
        textInput({ id: 'question', label: 'Question', help: 'What you want to know', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
        choiceInput({ id: 'mode', label: 'Answer', help: 'How long an answer', choices: [{ value: 'concise', label: 'Short' }, { value: 'standard', label: 'Usual' }, { value: 'detailed', label: 'Detailed' }], typed: { flag: '--mode' }, optional: { default: 'standard', means: 'usual' } }),
        LIMIT(10),
        textInput({ id: 'space', label: 'Knowledge space', help: 'One knowledge space only (the terminal app)', why: 'a knowledge space id', typed: { flag: '--space' }, optional: { default: '', means: 'the usual one' } }),
      ],
      sentence: 'Answers {question} from your knowledge, with the sources, facts and linked entries it used.', example: { question: 'what did we decide about retries', mode: 'concise' },
      operator: KNOWLEDGE_METHOD('knowledge.ask', { query: 'question', mode: 'mode' }),
      async run(values, ctx) {
        const host = hostOf();
        if (values.space && host.spacesRefused) throw commandRefusal(host.spacesRefused);
        return knowing(async (ports, presentation) => {
          if (!ports.ask) throw commandRefusal('Asking knowledge is not available here; nothing else was asked in its place.');
          const mode = (values.mode || 'standard') as 'concise' | 'standard' | 'detailed';
          return presentation.renderAsk(await ports.ask({
            query: values.question!, limit: limitOf(values.limit, 10), mode, includeSources: true, includeConfidence: true, includeLinkedObjects: true,
            ...(values.space ? { knowledgeSpaceId: values.space } : {}),
          } as AskInput));
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'search', label: 'Search your knowledge', word: 'search',
      inputs: [textInput({ id: 'words', label: 'Words', help: 'What to look for', why: 'your own words', typed: { tail: true } }), LIMIT(10)],
      sentence: 'Lists the sources and entries that match {words}, best first, with why each matched.', example: { words: 'retry policy' },
      operator: KNOWLEDGE_METHOD('knowledge.search', { query: 'words' }),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => {
          const results = await ports.search(values.words!, limitOf(values.limit, 10));
          if (results.length === 0) return '[knowledge] No results.';
          return fold([`[knowledge] ${results.length} result(s)${presentation.headingSuffix}`, ...results.flatMap((result) => [
            `  ${result.id} [${result.kind}] score${presentation.scoreSeparator}${result.score} ${result.source?.title ?? result.source?.canonicalUri ?? result.node?.title ?? result.id}`,
            `    ${result.reason}`,
          ])]);
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'list', label: 'See sources, entries or issues', word: 'list',
      inputs: [
        choiceInput({ id: 'kind', label: 'Which', help: 'What to list', choices: [{ value: 'sources', label: 'Sources' }, { value: 'nodes', label: 'Entries' }, { value: 'issues', label: 'Issues' }], typed: { flag: '--kind' }, optional: { default: 'sources', means: 'sources' } }),
        LIMIT(10),
      ],
      sentence: 'Lists your knowledge\'s sources, entries or issues, newest first.', example: { kind: 'nodes' },
      operator: KNOWLEDGE_METHOD('knowledge.sources.list', {}),
      async run(values, ctx) { return readList(values.kind || 'sources', limitOf(values.limit, 10), ctx); },
    }),
    readAction<CommandActionContext>({
      id: 'get', label: 'See one source, entry or issue', word: 'get',
      inputs: [textInput({ id: 'item', label: 'Item', help: 'Its id, as a list or search shows it', why: 'an id from a list or search', typed: { position: 1 } })],
      sentence: 'Shows {item} in full, with what it links to.', example: { item: 'src-1a2b' },
      operator: KNOWLEDGE_METHOD('knowledge.item.get', { id: 'item' }),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => {
          const item = await ports.get(values.item!);
          if (!item) throw commandRefusal(`[knowledge] No item ${values.item}.`);
          const s = presentation.fieldSeparator;
          const lines: string[] = [];
          if (item.source) lines.push(`[knowledge] source ${item.source.id}`, `  title${s}${item.source.title ?? 'untitled'}`, `  uri${s}${item.source.canonicalUri ?? item.source.sourceUri ?? 'n/a'}`, `  status${s}${item.source.status}`, ...(item.source.summary ? [`  summary${s}${item.source.summary}`] : []));
          else if (item.node) lines.push(`[knowledge] entry ${item.node.id}`, `  ${presentation.nodeKind}${s}${item.node.kind}`, `  title${s}${item.node.title}`, ...(item.node.summary ? [`  summary${s}${item.node.summary}`] : []));
          else if (item.issue) lines.push(`[knowledge] issue ${item.issue.id}`, `  severity${s}${item.issue.severity}`, `  code${s}${item.issue.code}`, `  message${s}${item.issue.message}`);
          if (item.relatedEdges.length > 0) lines.push(`  links${presentation.headingSuffix}`, ...item.relatedEdges.slice(0, 12).map((edge) => `    ${edge.fromKind}:${edge.fromId} -[${edge.relation}]-> ${edge.toKind}:${edge.toId}`));
          return fold(lines);
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'queue', label: 'See issues waiting for review', word: 'queue', inputs: [LIMIT(10, { position: 1 })],
      sentence: 'Lists the knowledge issues waiting for you to review.', example: { limit: '5' },
      operator: KNOWLEDGE_METHOD('knowledge.issues.list', {}),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => {
          const issues = await ports.issues(limitOf(values.limit, 10));
          if (issues.length === 0) return 'Nothing waits for review.';
          return fold([`[knowledge] Waiting for review (${issues.length})${presentation.headingSuffix}`, ...issues.flatMap((issue) => [`  ${issue.id} [${issue.severity}] ${issue.code}`, `    ${issue.message}`])]);
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'packet', label: 'See the knowledge a task would get', word: 'packet',
      inputs: [
        textInput({ id: 'task', label: 'Task', help: 'The task, as you would ask for it', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
        { ...textInput({ id: 'scope', label: 'Only about', help: 'A path the knowledge must be about; one per --scope', why: 'a path in this project', typed: { flag: '--scope' }, optional: { default: '', means: 'anything' } }), typed: { flag: '--scope', repeats: true } },
      ],
      sentence: 'Shows the compact knowledge a model would be given for {task}.', example: { task: 'add retries to the uploader' },
      operator: KNOWLEDGE_METHOD('knowledge.packet', { task: 'task' }),
      async run(values, ctx) {
        return knowing(async (ports) => (await ports.packet(values.task!, (values.scope ?? '').split('\n').map((entry) => entry.trim()).filter(Boolean))) ?? '[knowledge] No knowledge matched that task.', ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'lint', label: 'Check your knowledge for problems', word: 'lint',
      sentence: 'Lists the problems found in your knowledge: broken links, duplicates, missing facts.',
      operator: KNOWLEDGE_METHOD('knowledge.lint', {}),
      async run(_values, ctx) {
        return knowing(async (ports, presentation) => {
          const issues = await ports.lint();
          if (issues.length === 0) return '[knowledge] No problems found.';
          return fold([`[knowledge] ${issues.length} problem(s)${presentation.headingSuffix}`, ...issues.flatMap((issue) => [`  ${issue.id} [${issue.severity}] ${issue.code}`, `    ${issue.message}`])]);
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'candidates', label: 'See entries that could be merged', word: 'candidates', inputs: [LIMIT(10, { position: 1 })],
      sentence: 'Lists the entries tidying found that could be merged, best first.', example: { limit: '5' },
      operator: KNOWLEDGE_METHOD('knowledge.candidates.list', {}),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => {
          const candidates = await ports.candidates(limitOf(values.limit, 10));
          if (candidates.length === 0) return '[knowledge] Nothing could be merged.';
          return fold([`[knowledge] Could be merged (${candidates.length})${presentation.headingSuffix}`, ...candidates.flatMap((candidate) => [`  ${candidate.id} [${candidate.status}] score${presentation.scoreSeparator}${candidate.score} ${candidate.title}`, `    ${candidate.candidateType}`])]);
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'reports', label: 'See what tidying did', word: 'reports', inputs: [LIMIT(10, { position: 1 })],
      sentence: 'Lists the reports of past tidying runs, newest first.', example: { limit: '5' },
      operator: KNOWLEDGE_METHOD('knowledge.reports.list', {}),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => {
          const reports = await ports.reports(limitOf(values.limit, 10));
          if (reports.length === 0) return '[knowledge] No tidying reports yet.';
          return fold([`[knowledge] Tidying reports (${reports.length})${presentation.headingSuffix}`, ...reports.flatMap((report) => [`  ${report.id} [${report.kind}] ${report.title}`, `    ${report.summary}`])]);
        }, ctx);
      },
    }),
    readAction<CommandActionContext>({
      id: 'schedules', label: 'See when knowledge is tidied', word: 'schedules',
      sentence: 'Lists the schedules that tidy and refresh your knowledge, and whether each is on.',
      operator: KNOWLEDGE_METHOD('knowledge.schedules.list', {}),
      async run(_values, ctx) {
        return knowing(async (ports, presentation) => {
          const schedules = await ports.schedules(20);
          if (schedules.length === 0) return '[knowledge] No knowledge schedules.';
          return fold([`[knowledge] Schedules (${schedules.length})${presentation.headingSuffix}`, ...schedules.flatMap((schedule) => [`  ${schedule.id} [${schedule.enabled ? 'on' : 'off'}] ${schedule.jobId}`, `    ${schedule.label}`])]);
        }, ctx);
      },
    }),
    change({
      id: 'ingest-url', label: 'Add a web page', word: 'ingest-url',
      inputs: [textInput({ id: 'url', label: 'Address', help: 'The page\'s web address', why: 'a web address', typed: { position: 1 } }), TITLE, TAGS, FOLDER, PRIVATE],
      sentence: 'The page at {url} is fetched and added to your knowledge, until you change it.', example: { url: 'https://example.com/guide', tags: 'docs' },
      operator: KNOWLEDGE_METHOD('knowledge.ingest.url', { url: 'url', title: 'title', folderPath: 'folder' }),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => {
          const result = await ports.url({
            url: values.url!, title: values.title || undefined, tags: tagsOf(values.tags), folderPath: values.folder || undefined, sessionId: ports.sessionId(),
            sourceType: 'url', connectorId: 'url', fetchMode: values.private === 'yes' ? 'allow-private-hosts' : 'public-only',
          });
          return fold([knowledgeIngestLine(result.source, values.url!), ...(result.source.summary ? [`  ${result.source.summary}`] : []), ...(result.artifactId ? [`  artifact${presentation.fieldSeparator}${result.artifactId}`] : [])]);
        }, ctx);
      },
    }),
    change({
      id: 'import-urls', label: 'Add pages from a list of addresses', word: 'import-urls', inputs: [FILE, PRIVATE],
      sentence: 'Every address in {path} is fetched and added to your knowledge, until you change it.', example: { path: 'links.txt' },
      operator: KNOWLEDGE_METHOD('knowledge.ingest.urls', { path: 'path' }),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => importLines('URL list', await ports.urlsFile({ path: values.path!, sessionId: ports.sessionId(), fetchMode: values.private === 'yes' ? 'allow-private-hosts' : 'public-only' }), presentation.fieldSeparator), ctx);
      },
    }),
    change({
      id: 'import-bookmarks', label: 'Add pages from a bookmarks file', word: 'import-bookmarks', inputs: [FILE, PRIVATE],
      sentence: 'Every bookmark in {path} is fetched and added to your knowledge, until you change it.', example: { path: 'bookmarks.html' },
      operator: KNOWLEDGE_METHOD('knowledge.ingest.bookmarks', { path: 'path' }),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => importLines('bookmarks', await ports.bookmarksFile({ path: values.path!, sessionId: ports.sessionId(), fetchMode: values.private === 'yes' ? 'allow-private-hosts' : 'public-only' }), presentation.fieldSeparator), ctx);
      },
    }),
    change({
      id: 'ingest-file', label: 'Add a file', word: 'ingest-file', inputs: [FILE, TITLE, TAGS, FOLDER],
      sentence: 'File {path} is added to Agent Knowledge, until you change it.', example: { path: 'notes/plan.md' }, operator: AGENT_ONLY,
      async run(values, ctx) { return moreOf().ingestFile(ctx, { path: values.path!, title: values.title ?? '', tags: values.tags ?? '', folder: values.folder ?? '' }); },
    }),
    change({
      id: 'ingest-artifact', label: 'Add a saved artifact', word: 'ingest-artifact',
      inputs: [textInput({ id: 'artifact', label: 'Artifact', help: 'Its id, as the artifact browser shows it', why: 'an artifact id', typed: { position: 1 } }), TITLE, TAGS, FOLDER],
      sentence: 'Artifact {artifact} is added to Agent Knowledge, until you change it.', example: { artifact: 'art-1a2b' }, operator: AGENT_ONLY,
      async run(values, ctx) { return moreOf().ingestArtifact(ctx, { artifact: values.artifact!, title: values.title ?? '', tags: values.tags ?? '', folder: values.folder ?? '' }); },
    }),
    change({
      id: 'import-browser-history', label: 'Add your browser history', word: 'import-browser-history',
      inputs: [
        textInput({ id: 'browsers', label: 'Browsers', help: 'Which browsers, separated by commas (chrome, firefox, safari ...)', why: 'browser names', typed: { flag: '--browsers' }, optional: { default: '', means: 'every installed browser' } }),
        choiceInput({ id: 'sources', label: 'What', help: 'History, bookmarks or both', choices: [{ value: 'history', label: 'History only' }, { value: 'bookmark', label: 'Bookmarks only' }], typed: { flag: '--sources' }, optional: { default: '', means: 'history and bookmarks' } }),
        LIMIT(250),
        { id: 'days', label: 'From the last', help: 'How many days back', kind: 'number', freeTextReason: 'a number of days', required: { default: '', defaultMeans: 'all of it' }, typed: { flag: '--since-days' } },
      ],
      sentence: 'Pages from your browsers\' history and bookmarks are added to Agent Knowledge, until you change it.', example: { browsers: 'firefox', days: '30' },
      ownerOnly: { reason: 'it reads your browser history', instead: 'Ask the owner to import it with /knowledge import-browser-history.' }, operator: AGENT_ONLY,
      async run(values, ctx) { return moreOf().browserHistory(ctx, { browsers: values.browsers ?? '', sources: values.sources ?? '', limit: values.limit ?? '', days: values.days ?? '' }); },
    }),
    change({
      id: 'ingest-connector', label: 'Add something through a connector', word: 'ingest-connector',
      inputs: [
        listInput({ id: 'connector', label: 'Connector', help: 'The knowledge connectors', list: CONNECTORS, other: 'a connector id' }),
        textInput({ id: 'input', label: 'Input', help: 'What the connector reads: JSON or text', why: 'what the connector takes', kind: 'long-text', typed: { flag: '--input' }, optional: { default: '', means: 'none' } }),
        textInput({ id: 'path', label: 'File', help: 'A file the connector reads', why: 'a file path', kind: 'path', typed: { flag: '--path' }, optional: { default: '', means: 'none' } }),
        textInput({ id: 'content', label: 'Text', help: 'Text the connector reads', why: 'your own text', kind: 'long-text', typed: { flag: '--content' }, optional: { default: '', means: 'none' } }),
        PRIVATE,
      ],
      sentence: 'What connector {connector} reads from the input, file or text given is added to Agent Knowledge, until you change it.', example: { connector: 'rss', input: 'https://example.com/feed' }, operator: AGENT_ONLY,
      async run(values, ctx) { return moreOf().connector(ctx, { connector: values.connector!, input: values.input ?? '', path: values.path ?? '', content: values.content ?? '', allowPrivate: values.private === 'yes' }); },
    }),
    readAction<CommandActionContext>({
      id: 'map', label: 'See the knowledge map', word: 'map',
      inputs: [textInput({ id: 'about', label: 'About', help: 'Only the part about these words', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'all of it' } }), LIMIT(50)],
      sentence: 'Shows how many entries and links Agent Knowledge has, and for what is asked about.', example: { about: 'billing' }, operator: AGENT_ONLY,
      async run(values, ctx) { return moreOf().map(ctx, values.about ?? '', limitOf(values.limit, 50)); },
    }),
    readAction<CommandActionContext>({
      id: 'connectors', label: 'See knowledge connectors', word: 'connectors',
      sentence: 'Lists the connectors that can add to Agent Knowledge, and what each reads.', operator: AGENT_ONLY,
      async run(_values, ctx) {
        const connectors = moreOf().connectors(ctx);
        if (connectors.length === 0) return '[knowledge] No connectors.';
        return fold([`[knowledge] Connectors (${connectors.length})`, ...connectors.flatMap((connector) => [`  ${connector.id} [${connector.sourceType}] ${connector.name}`, `    ${connector.description}`])]);
      },
    }),
    readAction<CommandActionContext>({
      id: 'connector', label: 'See one connector', word: 'connector',
      inputs: [listInput({ id: 'connector', label: 'Connector', help: 'The knowledge connectors', list: CONNECTORS, other: 'a connector id' })],
      sentence: 'Shows connector {connector}: what it reads and what it can do.', example: { connector: 'rss' }, operator: AGENT_ONLY,
      async run(values, ctx) { return moreOf().connectorDetail(ctx, values.connector!); },
    }),
    readAction<CommandActionContext>({
      id: 'connector-doctor', label: 'Check a connector', word: 'connector-doctor',
      inputs: [listInput({ id: 'connector', label: 'Connector', help: 'The knowledge connectors', list: CONNECTORS, other: 'a connector id' })],
      sentence: 'Checks whether connector {connector} is ready, and what to fix when it is not.', example: { connector: 'rss' }, operator: AGENT_ONLY,
      async run(values, ctx) { return moreOf().doctor(ctx, values.connector!); },
    }),
    change({
      id: 'review-issue', label: 'Review an issue', word: 'review-issue',
      inputs: [
        listInput({ id: 'issue', label: 'Issue', help: 'Issues waiting for review', list: ISSUES, other: 'an issue id' }),
        choiceInput({ id: 'verdict', label: 'Verdict', help: 'What to do with it', choices: REVIEW_VERDICTS, typed: { position: 2 } }),
        textInput({ id: 'value', label: 'Changed facts', help: 'With "Accept it with my changes": the facts as a JSON object', why: 'a JSON object', kind: 'long-text', typed: { flag: '--value' }, optional: { default: '', means: 'none' } }),
        textInput({ id: 'reviewer', label: 'Reviewed by', help: 'The name recorded as the reviewer', why: 'a name', typed: { flag: '--reviewer' }, optional: { default: '', means: 'this app' } }),
      ],
      sentence: 'Issue {issue} is answered with {verdict}, until you change it.', example: { issue: 'iss-1a2b', verdict: 'accept' },
      operator: KNOWLEDGE_METHOD('knowledge.issue.review', { issueId: 'issue', action: 'verdict' }),
      async run(values, ctx) {
        let value: Record<string, unknown> | undefined;
        if (values.value) {
          try { value = JSON.parse(values.value) as Record<string, unknown>; } catch { value = undefined; }
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw commandRefusal('[knowledge] The changed facts must be a JSON object. Nothing was reviewed.', undefined, 'USAGE');
        }
        return knowing(async (ports, presentation) => {
          const s = presentation.fieldSeparator;
          const result = await ports.review({ issueId: values.issue!, action: values.verdict as Parameters<KnowledgePorts['review']>[0]['action'], reviewer: values.reviewer || presentation.reviewer, ...(value ? { value } : {}) });
          return fold([
            `[knowledge] Reviewed issue ${result.issue.id}`,
            `  verdict${s}${values.verdict}`,
            `  status${s}${result.issue.status}`,
            ...(result.node ? [`  entry${s}${result.node.id} ${result.node.title}`] : []),
            ...(result.source ? [`  ${presentation.sourceLabel}${s}${result.source.id} ${result.source.title ?? result.source.canonicalUri ?? result.source.sourceUri ?? 'untitled'}`] : []),
            ...(result.appliedFacts ? [`  facts applied${s}${Object.keys(result.appliedFacts).join(', ') || 'none'}`] : []),
          ]);
        }, ctx);
      },
    }),
    change({
      id: 'consolidate', label: 'Tidy your knowledge', word: 'consolidate',
      inputs: [choiceInput({ id: 'depth', label: 'How thorough', help: 'A quick pass or a deep one', choices: [{ value: 'light', label: 'A quick pass' }, { value: 'deep', label: 'A deep pass', help: 'Slower; merges and rewrites more.' }], typed: { position: 1 }, optional: { default: 'light', means: 'a quick pass' } })],
      sentence: 'A tidying pass merges duplicates and fills gaps in your knowledge now, until you change it.', example: { depth: 'deep' },
      operator: KNOWLEDGE_METHOD('knowledge.job.run', {}),
      async run(values, ctx) {
        return knowing(async (ports) => {
          const run = await ports.run(values.depth === 'deep' ? 'knowledge-deep-consolidation' : 'knowledge-light-consolidation', { mode: 'inline' });
          return `[knowledge] Tidying run ${run.id} finished: ${run.status}.`;
        }, ctx);
      },
    }),
    change({
      id: 'reindex', label: 'Rebuild the knowledge index', word: 'reindex', inputs: [],
      sentence: 'Every source is read again and the entries and links are rebuilt from them, until you change it.', example: {},
      operator: KNOWLEDGE_METHOD('knowledge.reindex', {}),
      async run(_values, ctx) {
        return knowing(async (ports, presentation) => {
          const result = await ports.reindex();
          const s = presentation.fieldSeparator;
          const failures = result.recompileFailures ?? [];
          return fold([
            failures.length > 0 ? `[knowledge] Rebuilt, with ${failures.length} source${failures.length === 1 ? '' : 's'} not rebuilt` : '[knowledge] Rebuilt',
            `  sources${s}${result.status.sourceCount}`, `  entries${s}${result.status.nodeCount}`, `  links${s}${result.status.edgeCount}`, `  issues${s}${result.status.issueCount}`,
            ...failures.map((failure) => `  not rebuilt${s}${failure.sourceId} - ${failure.error}`),
          ]);
        }, ctx);
      },
    }),
    change({
      id: 'cancel-run', label: 'Stop a knowledge job', word: 'cancel-run',
      inputs: [listInput({ id: 'run', label: 'Job', help: 'Knowledge jobs waiting or running', list: ACTIVE_RUNS, other: 'a job run id' })],
      sentence: 'Knowledge job {run} is stopped.', example: { run: 'run-1a2b' }, risk: 'cannot-be-undone', lasts: 'not-a-change',
      operator: KNOWLEDGE_METHOD('knowledge.job-run.cancel', { runId: 'run' }),
      async run(values, ctx) {
        return knowing(async (ports, presentation) => {
          const run = await ports.cancelRun(values.run!);
          return `[knowledge] Job ${run.id} (${run.jobId}) stopped; status ${run.status}${run.error ? `${presentation.fieldSeparator}${run.error}` : ''}.`;
        }, ctx);
      },
    }),
  ],
};

const KNOWLEDGE_SLASH_COMMAND = defineCommand(KNOWLEDGE_COMMAND);

/** Register `/knowledge` (the one description) with this app's knowledge. */
export function registerKnowledgeCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: KnowledgeHost<Ctx>): void {
  installed = host as unknown as KnowledgeHost<CommandActionContext>;
  registry.register(KNOWLEDGE_SLASH_COMMAND as never);
}

