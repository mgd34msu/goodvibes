/**
 * memory-place.ts, the Memory and knowledge place: what the project remembers,
 * your knowledge, what is known about you, and your templates. `/memory`
 * opens it, and the menu's Memory and knowledge row.
 *
 *  - Memory: the records (`memory.records.list`), followed on the `memory`
 *    list's changes; a record waiting for review is marked. Enter shows one
 *    in full; correct it, say whether it is still right, change where it
 *    applies, link it, forget it; remember something, search, see what a
 *    task or a turn was given, remember an incident or a setting's state.
 *  - Copies and files: the copies of memory (`memory.snapshots.list`); one
 *    replaces all memory; memory saved to a file, read, loaded, kept as files
 *    in the project, compared and taken back; the search index.
 *  - Sources, Entries, Issues, Jobs, Connectors: your knowledge, the one
 *    store (`knowledge.*`), followed on the `knowledge` domain.
 *  - About you: your profile (`profile.read`), followed on the `profile`
 *    list's changes: facts, lines and people; a profile that cannot be read
 *    says so on its one row.
 *  - Templates: your prompt templates (`template.list` through
 *    `capabilities.run`, the caller's project); use one as your next message.
 *
 * Every action is a capability (capabilities/builtin/memory.ts,
 * memory-session.ts, knowledge.ts, profile.ts, templates.ts), the same the
 * model, an outside agent and a script run.
 */
import { definePlace, type PlaceAction, type PlaceDetailLine, type PlaceFollow, type PlaceItem, type PlaceList, type PlaceRow } from './place-types.js';
import { MEMORY_STORE_ACTIONS, MEMORY_STORE_LISTS } from './memory-stores-entries.js';

const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => Array.isArray(value) ? value.map(record) : [];
/** Text from another process, with control characters taken out before it is shown. */
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ') : '';
const time = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'not said';
const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

interface RecordItem extends PlaceItem {
  readonly kind: 'record';
  readonly state: 'fresh' | 'reviewed' | 'stale' | 'contradicted';
  readonly summary: string;
  readonly cls: string;
  readonly scope: string;
  readonly confidence: number;
  readonly tags: readonly string[];
  readonly detail: string;
  readonly origin: readonly string[];
  readonly createdAt?: number | undefined;
  readonly staleReason: string;
}
interface CopyItem extends PlaceItem {
  readonly kind: 'copy';
  readonly state: 'copy';
  readonly reason: string;
  readonly createdAt?: number | undefined;
  readonly records: number | null;
  readonly size: number;
}
interface SourceItem extends PlaceItem {
  readonly kind: 'source';
  readonly title: string;
  readonly address: string;
  readonly summary: string;
  readonly sourceType: string;
  readonly tags: readonly string[];
  readonly error: string;
  readonly updatedAt?: number | undefined;
}
interface EntryItem extends PlaceItem {
  readonly kind: 'entry';
  readonly title: string;
  readonly entryKind: string;
  readonly summary: string;
  readonly confidence?: number | undefined;
}
interface IssueItem extends PlaceItem {
  readonly kind: 'issue';
  readonly state: 'open' | 'resolved';
  readonly severity: string;
  readonly code: string;
  readonly message: string;
}
interface JobItem extends PlaceItem {
  readonly kind: 'job';
  readonly job: string;
  readonly requestedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly error: string;
}
interface ConnectorItem extends PlaceItem {
  readonly kind: 'connector';
  readonly state: 'connector';
  readonly name: string;
  readonly reads: string;
  readonly description: string;
}
interface FactItem extends PlaceItem {
  readonly kind: 'fact';
  /** A fact (a field), a line of a section, a line about a person, or the profile that could not be read. */
  readonly state: 'fact' | 'line' | 'person' | 'unreadable' | 'off';
  readonly label: string;
  readonly value: string;
  readonly section: string;
  readonly origin: string;
  readonly problem: string;
}
interface TemplateItem extends PlaceItem {
  readonly kind: 'template';
  readonly state: 'project' | 'global';
  readonly preview: string;
  readonly shadows: boolean;
}

interface ProposalItem extends PlaceItem {
  readonly kind: 'proposal';
  readonly reason: string;
  readonly records: readonly string[];
}

const PROPOSAL_WORDS: Readonly<Record<string, string>> = {
  contradiction: 'two records disagree', 'cross-scope-duplicate': 'the same record twice', 'stale-delete': 'out of date, could go',
};

function proposals(output: unknown): readonly ProposalItem[] {
  return rows(record(output).pendingProposals).map((entry, index): ProposalItem => {
    const ids = Array.isArray(entry.ids) ? entry.ids.map(plain).filter(Boolean) : [];
    return { kind: 'proposal', id: plain(entry.id) || ids.join('+') || String(index), state: plain(entry.kind) || 'proposal', reason: plain(entry.reason) || 'not said', records: ids };
  });
}

type Item = ProposalItem | RecordItem | CopyItem | SourceItem | EntryItem | IssueItem | JobItem | ConnectorItem | FactItem | TemplateItem;

const CLASS_WORDS: Readonly<Record<string, string>> = {
  decision: 'a decision', constraint: 'a constraint', incident: 'an incident', pattern: 'a pattern', fact: 'a fact',
  risk: 'a risk', runbook: 'a runbook', architecture: 'architecture', ownership: 'who owns what',
};
const SCOPE_WORDS: Readonly<Record<string, string>> = { session: 'this session', project: 'this project', team: 'the team' };
const REVIEW_WORDS: Readonly<Record<RecordItem['state'], string>> = {
  fresh: 'not reviewed yet', reviewed: 'reviewed and right', stale: 'out of date', contradicted: 'contradicted by something newer',
};
const REVIEW_STATES = new Set<RecordItem['state']>(['fresh', 'reviewed', 'stale', 'contradicted']);

function records(output: unknown): readonly RecordItem[] {
  return rows(record(output).records).filter((entry) => plain(entry.id)).map((entry): RecordItem => {
    const state = REVIEW_STATES.has(entry.reviewState as RecordItem['state']) ? entry.reviewState as RecordItem['state'] : 'fresh';
    return {
      kind: 'record', id: plain(entry.id), state, summary: plain(entry.summary) || plain(entry.id), cls: plain(entry.cls), scope: plain(entry.scope),
      confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
      tags: Array.isArray(entry.tags) ? entry.tags.map(plain).filter(Boolean) : [],
      detail: plain(entry.detail),
      origin: rows(entry.provenance).map((link) => `${plain(link.kind)} ${plain(link.ref)}${plain(link.label) ? ` (${plain(link.label)})` : ''}`),
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : undefined,
      staleReason: plain(entry.staleReason),
    };
  }).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function copies(output: unknown): readonly CopyItem[] {
  return rows(record(output).snapshots).filter((entry) => plain(entry.name)).map((entry): CopyItem => ({
    kind: 'copy', id: plain(entry.name), state: 'copy', reason: plain(entry.reason),
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : undefined,
    records: typeof entry.recordCount === 'number' ? entry.recordCount : null,
    size: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0,
  }));
}

function sources(output: unknown): readonly SourceItem[] {
  return rows(record(output).sources).filter((entry) => plain(entry.id)).map((entry): SourceItem => ({
    kind: 'source', id: plain(entry.id), state: plain(entry.status) || 'stored',
    title: plain(entry.title) || plain(entry.canonicalUri) || plain(entry.sourceUri) || 'untitled',
    address: plain(entry.canonicalUri) || plain(entry.sourceUri), summary: plain(entry.summary), sourceType: plain(entry.sourceType),
    tags: Array.isArray(entry.tags) ? entry.tags.map(plain).filter(Boolean) : [], error: plain(entry.crawlError),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : undefined,
  }));
}

function entries(output: unknown): readonly EntryItem[] {
  return rows(record(output).nodes).filter((entry) => plain(entry.id)).map((entry): EntryItem => ({
    kind: 'entry', id: plain(entry.id), state: plain(entry.status) || 'active', title: plain(entry.title) || 'untitled',
    entryKind: plain(entry.kind), summary: plain(entry.summary), confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
  }));
}

function issues(output: unknown): readonly IssueItem[] {
  return rows(record(output).issues).filter((entry) => plain(entry.id)).map((entry): IssueItem => ({
    kind: 'issue', id: plain(entry.id), state: entry.status === 'resolved' ? 'resolved' : 'open',
    severity: plain(entry.severity), code: plain(entry.code), message: plain(entry.message) || plain(entry.code),
  }));
}

function jobs(output: unknown): readonly JobItem[] {
  return rows(record(output).runs).filter((entry) => plain(entry.id)).map((entry): JobItem => ({
    kind: 'job', id: plain(entry.id), state: plain(entry.status) || 'queued', job: plain(entry.jobId),
    requestedAt: typeof entry.requestedAt === 'number' ? entry.requestedAt : undefined,
    completedAt: typeof entry.completedAt === 'number' ? entry.completedAt : undefined,
    error: plain(entry.error),
  }));
}

function connectors(output: unknown): readonly ConnectorItem[] {
  return rows(record(output).connectors).filter((entry) => plain(entry.id)).map((entry): ConnectorItem => ({
    kind: 'connector', id: plain(entry.id), state: 'connector', name: plain(entry.displayName) || plain(entry.id),
    reads: plain(entry.sourceType), description: plain(entry.description),
  }));
}

function origin(value: unknown): string {
  const from = record(value);
  return plain(from.surface) ? `${plain(from.surface)}, ${plain(from.date)}: you said "${plain(from.said)}"` : 'written by hand';
}

function facts(output: unknown): readonly FactItem[] {
  const document = record(output);
  const state = record(document.state);
  // A profile that cannot be read is never shown as empty.
  if (state.kind === 'unavailable') {
    return [{ kind: 'fact', id: 'profile', state: 'unreadable', label: 'Your profile could not be read', value: '', section: '', origin: '', problem: `${plain(state.reason) || 'no reason given'} (${plain(state.path)})` }];
  }
  if (state.kind === 'disabled') {
    return [{ kind: 'fact', id: 'profile', state: 'off', label: 'Your profile is turned off', value: '', section: '', origin: '', problem: plain(state.path) }];
  }
  return rows(document.sections).flatMap((section) => {
    const heading = plain(section.heading);
    const people = heading.trim().toLowerCase() === 'people';
    return [
      ...rows(section.fields).map((field): FactItem => ({
        kind: 'fact', id: plain(field.fieldId), state: 'fact', label: plain(field.label) || plain(field.fieldId), value: plain(field.value), section: heading,
        origin: origin(field.provenance), problem: field.valid === false ? plain(field.invalidReason) || 'it did not parse' : '',
      })),
      ...rows(section.prose).map((line, index): FactItem => ({
        kind: 'fact', id: `${heading}\n${index}\n${plain(line.text)}`, state: people ? 'person' : 'line', label: plain(line.text), value: plain(line.text),
        section: heading, origin: origin(line.provenance), problem: '',
      })),
    ];
  });
}

function templates(output: unknown): readonly TemplateItem[] {
  return rows(record(record(output).data).templates).filter((entry) => plain(entry.name)).map((entry): TemplateItem => ({
    kind: 'template', id: plain(entry.name), state: entry.scope === 'global' ? 'global' : 'project', preview: plain(entry.preview),
    shadows: entry.shadowsGlobal === true,
  }));
}

// LIST_CHANGED notices travel on the `workspace` domain: a list that follows one names that domain too.
const MEMORY_FOLLOWS: PlaceFollow = { domains: ['workspace'], events: [], lists: ['memory'] };
const KNOWLEDGE_FOLLOWS: PlaceFollow = { domains: ['knowledge'], events: ['knowledge'] };
const PROFILE_FOLLOWS: PlaceFollow = { domains: ['workspace'], events: [], lists: ['profile'] };
const TEMPLATE_FOLLOWS: PlaceFollow = { domains: ['workspace'], events: [], lists: ['templates'] };

const JOB_WORDS: Readonly<Record<string, string>> = { queued: 'waiting to start', running: 'running', completed: 'finished', failed: 'failed', cancelled: 'stopped' };

export const MEMORY_PLACE = definePlace<Item>({
  id: 'memory',
  group: 'memory',
  title: 'Memory and knowledge',
  lists: [
    {
      id: 'memory',
      label: 'Memory',
      noun: 'what the project remembers',
      // A body of its own: the method is a POST, and the daemon refuses one sent with none.
      source: { kind: 'daemon', method: 'memory.records.list', input: { limit: 5000 }, items: records },
      follows: MEMORY_FOLLOWS,
      empty: 'Nothing remembered yet: what you or the model remember about this project shows here.',
      row: (item): PlaceRow => {
        const entry = item as RecordItem;
        return {
          title: entry.summary,
          ...(entry.state === 'stale' || entry.state === 'contradicted' ? { right: REVIEW_WORDS[entry.state] } : entry.state === 'fresh' ? { right: 'not reviewed' } : {}),
          mark: entry.state === 'reviewed' ? 'ok' : entry.state === 'fresh' ? 'waiting' : 'attention',
        };
      },
      detail: (item): readonly PlaceDetailLine[] => {
        const entry = item as RecordItem;
        return [
          { label: 'What it is', text: CLASS_WORDS[entry.cls] ?? entry.cls },
          { label: 'Applies to', text: SCOPE_WORDS[entry.scope] ?? entry.scope },
          { label: 'Review', text: `${REVIEW_WORDS[entry.state]}, ${entry.confidence}% sure`, ...(entry.state === 'stale' || entry.state === 'contradicted' ? { tone: 'warning' as const } : {}) },
          ...(entry.staleReason ? [{ label: 'Why', text: entry.staleReason, tone: 'muted' as const }] : []),
          ...(entry.tags.length > 0 ? [{ label: 'Tags', text: entry.tags.join(', ') }] : []),
          { label: 'Remembered', text: time(entry.createdAt) },
          ...(entry.origin.length > 0 ? [{ label: 'Came from', text: entry.origin.join('; ') }] : []),
          { label: 'Id', text: entry.id, tone: 'muted' as const },
          ...(entry.detail ? [{ text: '' }, { text: entry.detail }] : []),
        ];
      },
    },
    {
      id: 'proposals',
      label: 'Proposals',
      noun: 'what tidying memory proposes',
      source: { kind: 'daemon', method: 'memory.consolidation.receipts', input: {}, items: proposals },
      follows: MEMORY_FOLLOWS,
      empty: 'Nothing proposed: when memory is tidied while you are away, records that disagree or repeat each other show here.',
      row: (item) => {
        const proposal = item as ProposalItem;
        return { title: proposal.reason, right: PROPOSAL_WORDS[proposal.state] ?? proposal.state, mark: 'waiting' };
      },
      detail: (item) => {
        const proposal = item as ProposalItem;
        return [
          { label: 'What it is', text: PROPOSAL_WORDS[proposal.state] ?? proposal.state },
          { label: 'Records', text: proposal.records.join(', ') },
          { text: '' },
          { text: proposal.reason },
        ];
      },
    },
    {
      id: 'copies',
      label: 'Copies and files',
      noun: 'the copies of memory',
      source: { kind: 'daemon', method: 'memory.snapshots.list', input: {}, items: copies },
      follows: MEMORY_FOLLOWS,
      empty: 'No copies of memory yet: the first daily copy is taken within an hour of start.',
      row: (item) => {
        const copy = item as CopyItem;
        return { title: copy.id, right: copy.records === null ? 'records unreadable' : plural(copy.records, 'record'), mark: copy.records === null ? 'attention' : 'ok' };
      },
      detail: (item) => {
        const copy = item as CopyItem;
        return [
          { label: 'Taken', text: time(copy.createdAt) },
          { label: 'Why', text: copy.reason || 'not said' },
          { label: 'Records', text: copy.records === null ? 'the copy could not be read' : String(copy.records), ...(copy.records === null ? { tone: 'warning' as const } : {}) },
          { label: 'Size', text: copy.size < 1024 ? `${copy.size} B` : copy.size < 1024 * 1024 ? `${(copy.size / 1024).toFixed(1)} KB` : `${(copy.size / (1024 * 1024)).toFixed(1)} MB` },
        ];
      },
    },
    {
      id: 'sources',
      label: 'Sources',
      noun: 'the sources of your knowledge',
      source: { kind: 'daemon', method: 'knowledge.sources.list', input: { limit: 200 }, items: sources },
      follows: KNOWLEDGE_FOLLOWS,
      empty: 'No sources yet: add a web page, a file or your bookmarks to your knowledge.',
      row: (item) => {
        const source = item as SourceItem;
        return { title: source.title, ...(source.state === 'failed' ? { right: 'could not be read' } : {}), mark: source.state === 'failed' ? 'attention' : 'ok' };
      },
      detail: (item) => {
        const source = item as SourceItem;
        return [
          ...(source.address ? [{ label: 'Address', text: source.address }] : []),
          { label: 'Kind', text: source.sourceType || 'not said' },
          { label: 'State', text: source.state, ...(source.state === 'failed' ? { tone: 'warning' as const } : {}) },
          ...(source.error ? [{ label: 'What went wrong', text: source.error, tone: 'warning' as const }] : []),
          ...(source.tags.length > 0 ? [{ label: 'Tags', text: source.tags.join(', ') }] : []),
          ...(source.updatedAt ? [{ label: 'Changed', text: time(source.updatedAt) }] : []),
          { label: 'Id', text: source.id, tone: 'muted' as const },
          ...(source.summary ? [{ text: '' }, { text: source.summary }] : []),
        ];
      },
    },
    {
      id: 'entries',
      label: 'Entries',
      noun: 'the entries of your knowledge',
      source: { kind: 'daemon', method: 'knowledge.nodes.list', input: { limit: 200 }, items: entries },
      follows: KNOWLEDGE_FOLLOWS,
      empty: 'No entries yet: they are built from the sources you add.',
      row: (item) => {
        const entry = item as EntryItem;
        return { title: entry.title, ...(entry.entryKind ? { right: entry.entryKind } : {}), mark: 'ok' };
      },
      detail: (item) => {
        const entry = item as EntryItem;
        return [
          { label: 'Kind', text: entry.entryKind || 'not said' },
          { label: 'State', text: entry.state },
          ...(entry.confidence !== undefined ? [{ label: 'How sure', text: `${entry.confidence}%` }] : []),
          { label: 'Id', text: entry.id, tone: 'muted' as const },
          ...(entry.summary ? [{ text: '' }, { text: entry.summary }] : []),
        ];
      },
    },
    {
      id: 'issues',
      label: 'Issues',
      noun: 'the issues found in your knowledge',
      source: { kind: 'daemon', method: 'knowledge.issues.list', input: { limit: 200 }, items: issues },
      follows: KNOWLEDGE_FOLLOWS,
      empty: 'No issues: nothing in your knowledge waits for a review.',
      row: (item) => {
        const issue = item as IssueItem;
        return { title: issue.message, right: issue.state === 'resolved' ? 'resolved' : issue.severity, mark: issue.state === 'resolved' ? 'ok' : 'waiting' };
      },
      detail: (item) => {
        const issue = item as IssueItem;
        return [
          { label: 'State', text: issue.state === 'resolved' ? 'resolved' : 'waiting for your review' },
          { label: 'How serious', text: issue.severity || 'not said' },
          { label: 'Kind', text: issue.code },
          { label: 'Id', text: issue.id, tone: 'muted' as const },
          { text: '' },
          { text: issue.message },
        ];
      },
    },
    {
      id: 'jobs',
      label: 'Jobs',
      noun: 'the knowledge jobs',
      source: { kind: 'daemon', method: 'knowledge.job-runs.list', input: { limit: 50 }, items: jobs },
      follows: KNOWLEDGE_FOLLOWS,
      empty: 'No knowledge jobs have run yet: tidying and refreshing show here as they run.',
      row: (item) => {
        const job = item as JobItem;
        return {
          title: job.job, right: JOB_WORDS[job.state] ?? job.state,
          mark: job.state === 'failed' ? 'attention' : job.state === 'running' || job.state === 'queued' ? 'running' : 'ok',
        };
      },
      detail: (item) => {
        const job = item as JobItem;
        return [
          { label: 'State', text: JOB_WORDS[job.state] ?? job.state },
          ...(job.requestedAt ? [{ label: 'Asked for', text: time(job.requestedAt) }] : []),
          ...(job.completedAt ? [{ label: 'Ended', text: time(job.completedAt) }] : []),
          ...(job.error ? [{ label: 'What went wrong', text: job.error, tone: 'warning' as const }] : []),
          { label: 'Id', text: job.id, tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'connectors',
      label: 'Connectors',
      noun: 'the knowledge connectors',
      source: { kind: 'daemon', method: 'knowledge.connectors.list', input: {}, items: connectors },
      empty: 'No knowledge connectors.',
      row: (item) => {
        const connector = item as ConnectorItem;
        return { title: connector.name, ...(connector.reads ? { right: connector.reads } : {}), mark: 'ok' };
      },
      detail: (item) => {
        const connector = item as ConnectorItem;
        return [
          { label: 'Reads', text: connector.reads || 'not said' },
          { label: 'Id', text: connector.id, tone: 'muted' as const },
          ...(connector.description ? [{ text: '' }, { text: connector.description }] : []),
        ];
      },
    },
    {
      id: 'about-you',
      label: 'About you',
      noun: 'what is known about you',
      source: { kind: 'daemon', method: 'profile.read', input: {}, items: facts },
      follows: PROFILE_FOLLOWS,
      empty: 'Nothing is known about you yet: record a fact or add a line about you.',
      row: (item) => {
        const fact = item as FactItem;
        if (fact.state === 'unreadable') return { title: fact.label, right: 'could not be read', mark: 'attention' };
        if (fact.state === 'off') return { title: fact.label, right: 'off', mark: 'paused' };
        return {
          title: fact.state === 'fact' ? `${fact.label}: ${fact.value}` : fact.label,
          right: fact.problem ? 'did not parse' : fact.section,
          mark: fact.problem ? 'attention' : 'ok',
        };
      },
      detail: (item) => {
        const fact = item as FactItem;
        if (fact.state === 'unreadable' || fact.state === 'off') return [{ text: fact.problem, tone: fact.state === 'unreadable' ? 'warning' as const : 'muted' as const }];
        return [
          { label: 'Section', text: fact.section },
          ...(fact.state === 'fact' ? [{ label: 'Value', text: fact.value }, { label: 'Fact', text: fact.id, tone: 'muted' as const }] : [{ label: 'Line', text: fact.value }]),
          { label: 'Where it came from', text: fact.origin },
          ...(fact.problem ? [{ label: 'Did not parse', text: `${fact.problem}; kept as written, treated as unset`, tone: 'warning' as const }] : []),
        ];
      },
    },
    {
      id: 'templates',
      label: 'Templates',
      noun: 'your templates',
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'template.list', inputs: {} }, items: templates },
      follows: TEMPLATE_FOLLOWS,
      empty: 'No templates yet: keep your last message as one, and use it again as a message.',
      row: (item) => {
        const template = item as TemplateItem;
        return { title: template.id, right: template.state === 'project' ? (template.shadows ? 'this project (hides the shared one)' : 'this project') : 'every project', mark: 'ok' };
      },
      detail: (item) => {
        const template = item as TemplateItem;
        return [
          { label: 'For', text: template.state === 'project' ? 'this project' : 'every project on this computer' },
          { text: '' },
          { text: template.preview || '(empty)' },
        ];
      },
    },
    // Notes, personas, routines, document drafts and saved artifacts (memory-stores-entries.ts): their own item kinds.
    ...(MEMORY_STORE_LISTS as unknown as readonly PlaceList<Item>[]),
  ],
  actions: [
    // Notes, personas, routines, drafts and saved artifacts (memory-stores-entries.ts), each on its own tab.
    ...(MEMORY_STORE_ACTIONS as unknown as readonly PlaceAction<Item>[]),
    // Everywhere in the place.
    { key: 'n', capability: 'memory.add', label: 'remember' },
    { key: 'a', capability: 'knowledge.ingest-url', label: 'add a page' },
    { key: 'q', capability: 'knowledge.ask', label: 'ask your knowledge' },
    // Memory.
    { key: 'enter', list: 'memory', capability: 'memory.show', label: 'see it all', fill: { record: 'id' } },
    { key: 'e', id: 'correct-record', list: 'memory', capability: 'memory.edit', label: 'correct', fill: { record: 'id' } },
    { key: 'v', list: 'memory', capability: 'memory.review', label: 'still right?', fill: { record: 'id' } },
    { key: 'p', list: 'memory', capability: 'memory.promote', label: 'where it applies', fill: { record: 'id' } },
    { key: 'l', list: 'memory', capability: 'memory.link', label: 'link', fill: { from: 'id' } },
    { key: 'x', id: 'forget-record', list: 'memory', capability: 'memory.remove', label: 'forget', fill: { record: 'id' } },
    { key: 's', id: 'search-memory', list: 'memory', whole: true, capability: 'memory.search', label: 'search' },
    { key: 'w', id: 'memory-for-a-task', list: 'memory', whole: true, capability: 'memory.explain', label: 'what a task gets' },
    { key: 'i', list: 'memory', whole: true, capability: 'memory.injections', label: 'what turns got' },
    { key: 'c', list: 'memory', whole: true, capability: 'memory.capture', label: 'remember an incident' },
    { key: 'g', list: 'memory', whole: true, capability: 'setup.memory', label: 'memory settings' },
    // Proposals: the first record it names, in full.
    { key: 'enter', list: 'proposals', capability: 'memory.show', label: 'see the record', fill: { record: (item) => (item as ProposalItem).records[0] ?? '' } },
    // Copies and files.
    { key: 'u', list: 'copies', capability: 'memory.restore', label: 'replace memory with this copy', fill: { copy: 'id' } },
    { key: 'o', list: 'copies', whole: true, capability: 'memory.export', label: 'save to a file' },
    { key: 'k', list: 'copies', whole: true, capability: 'memory.inspect', label: 'read a file' },
    { key: 'm', list: 'copies', whole: true, capability: 'memory.import', label: 'load a file' },
    { key: 'f', list: 'copies', whole: true, capability: 'memory.sync-files', label: 'keep as files' },
    { key: 'd', list: 'copies', whole: true, capability: 'memory.review-files', label: 'what file edits change' },
    { key: 't', list: 'copies', whole: true, capability: 'memory.apply-files', label: 'take file edits in' },
    { key: 'h', list: 'copies', whole: true, capability: 'memory.index', label: 'search index' },
    { key: 'b', list: 'copies', whole: true, capability: 'memory.rebuild-index', label: 'rebuild the index' },
    // Sources.
    { key: 'enter', list: 'sources', capability: 'knowledge.get', label: 'see it all', fill: { item: 'id' } },
    { key: 's', id: 'search-knowledge', list: 'sources', whole: true, capability: 'knowledge.search', label: 'search' },
    { key: 't', list: 'sources', whole: true, capability: 'knowledge.status', label: 'how it stands' },
    { key: 'f', list: 'sources', whole: true, capability: 'knowledge.ingest-file', label: 'add a file' },
    { key: 'u', list: 'sources', whole: true, capability: 'knowledge.import-urls', label: 'add a list of pages' },
    { key: 'b', list: 'sources', whole: true, capability: 'knowledge.import-bookmarks', label: 'add bookmarks' },
    { key: 'h', list: 'sources', whole: true, capability: 'knowledge.import-browser-history', label: 'add browser history' },
    { key: 'j', list: 'sources', whole: true, capability: 'knowledge.ingest-artifact', label: 'add a saved artifact' },
    // Entries.
    { key: 'enter', list: 'entries', capability: 'knowledge.get', label: 'see it all', fill: { item: 'id' } },
    { key: 'm', list: 'entries', whole: true, capability: 'knowledge.map', label: 'the map' },
    { key: 'k', id: 'knowledge-for-a-task', list: 'entries', whole: true, capability: 'knowledge.packet', label: 'what a task gets' },
    { key: 'c', list: 'entries', whole: true, capability: 'knowledge.candidates', label: 'could be merged' },
    { key: 'z', list: 'entries', whole: true, capability: 'knowledge.consolidate', label: 'tidy' },
    { key: 'o', list: 'entries', whole: true, capability: 'knowledge.reports', label: 'what tidying did' },
    { key: 'w', list: 'entries', whole: true, capability: 'knowledge.schedules', label: 'when it is tidied' },
    { key: 'i', list: 'entries', whole: true, capability: 'knowledge.reindex', label: 'rebuild' },
    // Issues.
    { key: 'enter', list: 'issues', capability: 'knowledge.get', label: 'see it all', fill: { item: 'id' } },
    { key: 'v', list: 'issues', states: ['open'], capability: 'knowledge.review-issue', label: 'review', fill: { issue: 'id' } },
    { key: 'l', list: 'issues', whole: true, capability: 'knowledge.lint', label: 'check for problems' },
    // Jobs.
    { key: 'x', list: 'jobs', states: ['queued', 'running'], capability: 'knowledge.cancel-run', label: 'stop', fill: { run: 'id' } },
    // Connectors.
    { key: 'enter', list: 'connectors', capability: 'knowledge.connector', label: 'see it all', fill: { connector: 'id' } },
    { key: 'd', list: 'connectors', capability: 'knowledge.connector-doctor', label: 'check it', fill: { connector: 'id' } },
    { key: 'g', list: 'connectors', capability: 'knowledge.ingest-connector', label: 'add through it', fill: { connector: 'id' } },
    // About you.
    { key: 'enter', list: 'about-you', states: ['fact'], capability: 'about-me.where', label: 'where it came from', fill: { field: 'id' } },
    { key: 'c', id: 'correct-fact', list: 'about-you', states: ['fact'], capability: 'about-me.set', label: 'correct', fill: { field: 'id' } },
    { key: 'u', list: 'about-you', states: ['fact'], capability: 'about-me.undo', label: 'put back the earlier value', fill: { field: 'id' } },
    { key: 'x', id: 'forget-fact', list: 'about-you', states: ['fact'], capability: 'about-me.forget', label: 'forget', fill: { field: 'id' } },
    { key: 'x', list: 'about-you', states: ['line', 'person'], capability: 'about-me.forget-line', label: 'forget the line', fill: { section: (item) => (item as FactItem).section, line: (item) => (item as FactItem).value } },
    { key: 'f', list: 'about-you', whole: true, capability: 'about-me.set', label: 'record a fact' },
    { key: 'o', list: 'about-you', whole: true, capability: 'about-me.note', label: 'add a line' },
    { key: 'y', list: 'about-you', whole: true, capability: 'about-me.person', label: 'about a person' },
    { key: 't', list: 'about-you', whole: true, capability: 'about-me.status', label: 'does it load' },
    { key: 'w', list: 'about-you', whole: true, capability: 'about-me.show', label: 'all of it' },
    // Templates.
    { key: 'enter', list: 'templates', capability: 'template.show', label: 'see it', fill: { template: 'id' } },
    { key: 'u', list: 'templates', capability: 'template.use', label: 'use as your next message', fill: { template: 'id' } },
    { key: 'e', list: 'templates', capability: 'template.edit', label: 'edit', fill: { template: 'id' } },
    { key: 'x', list: 'templates', capability: 'template.delete', label: 'delete', fill: { template: 'id', scope: (item) => (item as TemplateItem).state } },
    { key: 's', list: 'templates', whole: true, capability: 'template.save', label: 'keep your last message' },
  ],
  count: (lists) => {
    const waiting = (lists.memory ?? []).filter((item) => item.state === 'stale' || item.state === 'contradicted').length;
    const issuesOpen = (lists.issues ?? []).filter((item) => item.state === 'open').length;
    const unreadable = (lists['about-you'] ?? []).some((item) => item.state === 'unreadable');
    if (unreadable) return { count: 1, words: 'profile could not be read', tone: 'wrong' };
    if (waiting + issuesOpen === 0) return undefined;
    const words = [waiting > 0 ? `${waiting} out of date` : '', issuesOpen > 0 ? `${issuesOpen} to review` : ''].filter(Boolean).join(', ');
    return { count: waiting + issuesOpen, words, tone: 'waiting' };
  },
});
