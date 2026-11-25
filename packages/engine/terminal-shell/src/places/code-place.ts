/**
 * code-place.ts, Code and changes: the project's files as this program sees
 * them. Changed files (git status) with their diff in the Changes view, the
 * recent commits, the project's worktrees, the code index, code intelligence
 * (readiness, the files with problems, and the lookups), and the last
 * lookup's results. Every list is the program's own (the working folder is
 * the program's), read when the place opens, again after each action and on
 * the read-again key; the Results list follows the lookups as they answer.
 * Every action is a code capability (capabilities/builtin/code.ts) shown only
 * on the item it acts on, in the states it applies to; opening the Changes
 * view on a file, or on this session's changes, is the program's own screen.
 */
import {
  CapabilityRefusal, WORKTREE_REVIEW, codeIndexStatusLines, type CodeResultRow, type CodeServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { codeResults } from '../code-capabilities.js';
import type { PlacePrograms, PlaceProgramSource } from './place-host.js';
import { definePlace, type PlaceItem } from './place-types.js';

type ChangeState = 'staged' | 'changed' | 'new' | 'deleted';

interface ChangeItem extends PlaceItem {
  readonly state: ChangeState | 'no-repository';
  readonly path: string;
}

interface CommitItem extends PlaceItem {
  readonly state: 'commit';
  readonly hash: string;
  readonly date: string;
  readonly message: string;
}

interface WorktreeItem extends PlaceItem {
  readonly state: 'main' | 'active' | 'paused' | 'kept' | 'gone' | 'not-kept';
  readonly path: string;
  readonly branch: string;
  readonly kind: string;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly setup?: string | undefined;
  readonly setupWords?: readonly string[] | undefined;
  readonly kept?: string | undefined;
  readonly updatedAt?: number | undefined;
}

interface IndexItem extends PlaceItem {
  readonly state: 'empty' | 'built' | 'building' | 'not-kept';
  readonly lines: readonly string[];
}

interface IntelligenceItem extends PlaceItem {
  /** `ready`/`not-ready`/`not-kept`: the readiness row; `errors`/`warnings`: a file with problems. */
  readonly state: 'ready' | 'not-ready' | 'not-kept' | 'errors' | 'warnings';
  readonly title: string;
  readonly lines: readonly string[];
  readonly file?: string | undefined;
  /** The first problem's place (from 1), for a lookup at it. */
  readonly line?: string | undefined;
  readonly column?: string | undefined;
}

interface ResultItem extends PlaceItem {
  readonly state: 'result';
  readonly title: string;
  readonly detail: readonly string[];
  readonly lookup: string;
}

type Item = ChangeItem | CommitItem | WorktreeItem | IndexItem | IntelligenceItem | ResultItem;

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) || path;
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const text = (value: unknown): string => typeof value === 'string' ? value : '';

function codeOf(services: () => CodeServices | undefined): CodeServices {
  const code = services();
  if (!code) throw new Error('this program has no project folder open');
  return code;
}

async function readChanges(code: CodeServices): Promise<readonly ChangeItem[]> {
  if (!code.git.isRepo()) return [{ id: 'no-repository', state: 'no-repository', path: code.workingDirectory }];
  const status = await code.git.status();
  const of = (state: ChangeState, files: readonly string[]): ChangeItem[] => files.map((path) => ({ id: `${state}:${path}`, state, path }));
  return [...of('staged', status.staged), ...of('changed', status.modified), ...of('new', status.notAdded), ...of('deleted', status.deleted)];
}

async function readCommits(code: CodeServices): Promise<readonly CommitItem[]> {
  if (!code.git.isRepo()) return [];
  return (await code.git.log(10)).map((entry) => ({ id: entry.hash, state: 'commit', hash: entry.hash, date: entry.date, message: entry.message }));
}

async function readWorktrees(code: CodeServices): Promise<readonly WorktreeItem[]> {
  const worktrees = code.worktrees;
  // A program that keeps no worktrees (the Agent hands build work to the terminal app) says so in one row.
  if (!worktrees) return [{ id: 'codeworktreesrow', state: 'not-kept', path: '', branch: 'Worktrees are kept by the terminal app', kind: '' }];
  if (!code.git.isRepo()) return [];
  const reviewed = await WORKTREE_REVIEW.run({}, { code }, {});
  const rows = Array.isArray(reviewed.data?.worktrees) ? reviewed.data.worktrees as Readonly<Record<string, unknown>>[] : [];
  const present = new Set(rows.map((row) => text(row.path)));
  // The checkout this program works in: the listed worktree whose folder holds the working folder (the deepest one).
  const holds = (path: string): boolean => path !== '' && (code.workingDirectory === path || code.workingDirectory.startsWith(`${path}/`));
  const main = rows.filter((row) => holds(text(row.path))).sort((a, b) => text(b.path).length - text(a.path).length)[0];
  const listed = rows.map((row): WorktreeItem => {
    const path = text(row.path);
    const state = row === main ? 'main' : (['active', 'paused', 'kept'].includes(text(row.state)) ? text(row.state) : 'active') as WorktreeItem['state'];
    return {
      id: path, state, path, branch: text(row.branch), kind: text(row.kind),
      ...(text(row.sessionId) ? { sessionId: text(row.sessionId) } : {}),
      ...(text(row.taskId) ? { taskId: text(row.taskId) } : {}),
      ...(text(row.setup) ? { setup: text(row.setup) } : {}),
      ...(Array.isArray(row.setupWords) ? { setupWords: row.setupWords.map(text) } : {}),
      ...(text(row.kept) ? { kept: text(row.kept) } : {}),
      ...(typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
    };
  });
  // A record the register keeps for a worktree that is no longer on disk: only "stop tracking" applies.
  const gone = worktrees.records().filter((record) => !present.has(record.path)).map((record): WorktreeItem => ({
    id: record.path, state: 'gone', path: record.path, branch: '', kind: record.kind,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    updatedAt: record.updatedAt,
  }));
  return [...listed, ...gone];
}

function readIndex(code: CodeServices): readonly IndexItem[] {
  const index = code.codeIndex;
  // The one row's id is no word a sentence uses: the place puts an item's title in place of its id in what it says.
  if (!index) return [{ id: 'codeindexrow', state: 'not-kept', lines: ['This program keeps no code index for the project; the terminal app does.'] }];
  const stats = index.stats();
  return [{ id: 'codeindexrow', state: stats.building ? 'building' : stats.indexedChunks === 0 ? 'empty' : 'built', lines: codeIndexStatusLines(index) }];
}

function readIntelligence(code: CodeServices): readonly IntelligenceItem[] {
  const intelligence = code.intelligence;
  if (!intelligence) return [];
  const reading = intelligence.reading?.();
  if (!reading) {
    return [{
      id: 'codereadinessrow', state: 'not-kept', title: 'Code lookups',
      lines: ['Lookups (symbols, outline, where a symbol is defined and used, what it is) work here; this program keeps no reading of problems, the terminal app does.'],
    }];
  }
  const notReady = [reading.diagnosticsStatus, reading.symbolSearchStatus, reading.hoverStatus].filter((status) => status !== 'ready').length;
  const readiness: IntelligenceItem = {
    id: 'codereadinessrow', state: notReady === 0 ? 'ready' : 'not-ready', title: 'Code intelligence',
    lines: [
      `Problems: ${reading.diagnosticsStatus}`,
      `Symbols: ${reading.symbolSearchStatus}`,
      `Hover: ${reading.hoverStatus}`,
      `Language servers: ${reading.languageServers.length > 0 ? reading.languageServers.map((server) => `${server.language} ${server.state}`).join(', ') : 'none set up'}`,
      `Errors: ${reading.errorCount}, warnings: ${reading.warningCount}`,
    ],
  };
  const files = [...reading.problems.entries()]
    .map(([file, problems]) => ({ file, problems, errors: problems.filter((entry) => entry.severity === 'error').length, warnings: problems.filter((entry) => entry.severity === 'warning').length }))
    .filter((entry) => entry.problems.length > 0)
    .sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.file.localeCompare(b.file))
    .map((entry): IntelligenceItem => {
      const first = entry.problems[0]!;
      return {
        id: entry.file, state: entry.errors > 0 ? 'errors' : 'warnings', title: fileName(entry.file), file: entry.file,
        line: String(first.line + 1), column: String(first.column + 1),
        lines: [
          `File: ${entry.file}`,
          `${plural(entry.errors, 'error')}, ${plural(entry.warnings, 'warning')}`,
          ...entry.problems.slice(0, 8).map((problem) => `${problem.line + 1}:${problem.column + 1} ${problem.severity}: ${problem.message}`),
        ],
      };
    });
  return [readiness, ...files];
}

function readResults(): readonly ResultItem[] {
  const { title, rows } = codeResults.read();
  return rows.map((row: CodeResultRow, index) => ({ id: `${index}:${row.id}`, state: 'result', title: row.title, detail: row.detail, lookup: title }));
}

/** The place's program sources, over this program's code services (session-capabilities.ts). */
export function codePlaceSources(services: () => CodeServices | undefined): Readonly<Record<string, PlaceProgramSource>> {
  const none = (): (() => void) => () => {};
  return {
    'code.changes': { read: () => readChanges(codeOf(services)), subscribe: none },
    'code.commits': { read: () => readCommits(codeOf(services)), subscribe: none },
    'code.worktrees': { read: () => readWorktrees(codeOf(services)), subscribe: none },
    'code.index': { read: () => readIndex(codeOf(services)), subscribe: none },
    'code.intelligence': { read: () => readIntelligence(codeOf(services)), subscribe: none },
    'code.results': { read: () => readResults(), subscribe: (onChange) => codeResults.subscribe(onChange) },
  };
}

/** The Changes view on a changed file's diff, or on this session's changes: the program's own screen. */
export function codePlacePrograms(services: () => CodeServices | undefined): Readonly<Record<string, (itemId: string, place: PlacePrograms) => Promise<string | undefined>>> {
  const view = (): NonNullable<CodeServices['changesView']> => {
    const changes = services()?.changesView;
    if (!changes) throw new CapabilityRefusal('The Changes view is a screen of the terminal app.');
    return changes;
  };
  // A program with no Changes view (the Agent) gets no such control.
  let present = false;
  try { present = services()?.changesView !== undefined; } catch { present = false; }
  if (!present) return {};
  return {
    async 'code.see-diff'(itemId) {
      const state = itemId.slice(0, itemId.indexOf(':'));
      view().open(state === 'staged' ? 'staged' : 'working');
      return undefined;
    },
    async 'code.review-session'() {
      view().open('session');
      return undefined;
    },
  };
}

const STATE_WORDS: Readonly<Record<ChangeState, string>> = { staged: 'staged', changed: 'changed', new: 'new', deleted: 'deleted' };
const WORKTREE_WORDS: Readonly<Record<WorktreeItem['state'], string>> = { main: 'this checkout', active: 'active', paused: 'paused', kept: 'kept', gone: 'gone from disk', 'not-kept': 'not kept here' };
const MADE_BY: Readonly<Record<string, string>> = { manual: 'by hand', agent: 'by an agent', orchestrator: 'by work' };
const LIVE_WORKTREE = ['active', 'paused', 'kept'];
const LOOKUP_STATES = ['ready', 'not-ready', 'not-kept', 'errors', 'warnings'];

/** A lookup's file and place from a problem file's row; nothing from the readiness row (the form asks). */
const fromProblem = (field: 'file' | 'line' | 'column') => (item: Item): string => text((item as IntelligenceItem)[field]);
/** A worktree's session or task, for the worktrees tied to it. */
const tiedKind = (item: Item): string => (item as WorktreeItem).taskId ? 'task' : (item as WorktreeItem).sessionId ? 'session' : '';
const tiedId = (item: Item): string => (item as WorktreeItem).taskId ?? (item as WorktreeItem).sessionId ?? '';

export const CODE_PLACE = definePlace<Item>({
  id: 'code',
  group: 'code',
  title: 'Code and changes',
  lists: [
    {
      id: 'changes',
      label: 'Changed files',
      noun: 'the changed files',
      source: { kind: 'session', name: 'code.changes', items: (raw) => (Array.isArray(raw) ? raw as ChangeItem[] : []) },
      empty: 'Nothing changed: the working tree is clean.',
      row: (item) => {
        const change = item as ChangeItem;
        if (change.state === 'no-repository') return { title: 'No git repository here', mark: 'paused' };
        return { title: change.path, right: STATE_WORDS[change.state], mark: change.state === 'staged' ? 'ok' : change.state === 'deleted' ? 'attention' : 'running' };
      },
      detail: (item) => {
        const change = item as ChangeItem;
        if (change.state === 'no-repository') return [{ text: `${change.path} is not inside a git repository, so nothing is tracked here.` }];
        return [
          { label: 'File', text: change.path },
          { label: 'State', text: change.state === 'new' ? 'new, not tracked yet' : STATE_WORDS[change.state] },
        ];
      },
    },
    {
      id: 'commits',
      label: 'Commits',
      noun: 'the recent commits',
      source: { kind: 'session', name: 'code.commits', items: (raw) => (Array.isArray(raw) ? raw as CommitItem[] : []) },
      empty: 'No commits yet.',
      row: (item) => {
        const commit = item as CommitItem;
        return { title: commit.message.split('\n')[0] || commit.hash.slice(0, 7), right: commit.date.slice(0, 10) };
      },
      detail: (item) => {
        const commit = item as CommitItem;
        return [{ label: 'Commit', text: commit.hash.slice(0, 7) }, { label: 'Date', text: commit.date }, { text: '' }, { text: commit.message }];
      },
    },
    {
      id: 'worktrees',
      label: 'Worktrees',
      noun: 'the worktrees',
      source: { kind: 'session', name: 'code.worktrees', items: (raw) => (Array.isArray(raw) ? raw as WorktreeItem[] : []) },
      empty: 'No worktrees: this folder is not a git repository.',
      row: (item) => {
        const worktree = item as WorktreeItem;
        const title = worktree.branch || fileName(worktree.path);
        const failed = worktree.setup === 'failed';
        return {
          title,
          ...(worktree.state !== 'active' ? { right: WORKTREE_WORDS[worktree.state] } : failed ? { right: 'setup failed' } : {}),
          mark: worktree.state === 'gone' || failed ? 'attention' : worktree.state === 'paused' || worktree.state === 'not-kept' ? 'paused' : 'ok',
        };
      },
      detail: (item) => {
        const worktree = item as WorktreeItem;
        if (worktree.state === 'not-kept') return [{ text: 'This program hands build and fix work to the terminal app, which keeps the project\'s worktrees: they are in Code and changes there.' }];
        // The short facts first: a small window shows them before the long folder.
        return [
          { label: 'State', text: WORKTREE_WORDS[worktree.state] },
          ...(worktree.kind ? [{ label: 'Made', text: MADE_BY[worktree.kind] ?? worktree.kind }] : []),
          ...(worktree.sessionId ? [{ label: 'Session', text: worktree.sessionId }] : []),
          ...(worktree.taskId ? [{ label: 'Task', text: worktree.taskId }] : []),
          ...(worktree.state !== 'main' && worktree.state !== 'gone' ? [{ label: 'Setup', text: worktree.setup ?? 'never run', ...(worktree.setup === 'failed' ? { tone: 'warning' as const } : {}) }] : []),
          ...(worktree.setupWords ?? []).slice(1).map((line) => ({ text: line.trim(), tone: 'warning' as const })),
          ...(worktree.kept ? [{ label: 'Kept', text: worktree.kept, tone: 'muted' as const }] : []),
          { label: 'Folder', text: worktree.path },
          ...(worktree.updatedAt ? [{ label: 'Changed', text: new Date(worktree.updatedAt).toLocaleString(), tone: 'muted' as const }] : []),
          ...(worktree.state === 'gone' ? [{ text: 'Its folder is gone; the register still has a record of it.', tone: 'muted' as const }] : []),
          ...(worktree.state === 'main' ? [{ text: 'The checkout this program works in: it is not paused, kept or removed from here.', tone: 'muted' as const }] : []),
        ];
      },
    },
    {
      id: 'index',
      label: 'Code index',
      noun: 'the code index',
      source: { kind: 'session', name: 'code.index', items: (raw) => (Array.isArray(raw) ? raw as IndexItem[] : []) },
      empty: 'No code index.',
      row: (item) => {
        const index = item as IndexItem;
        return { title: 'Code index', right: index.state === 'built' ? undefined : index.state === 'not-kept' ? 'not kept here' : index.state, mark: index.state === 'building' ? 'running' : index.state === 'built' ? 'ok' : 'paused' };
      },
      detail: (item) => (item as IndexItem).lines.map((line) => ({ text: line })),
    },
    {
      id: 'intelligence',
      label: 'Code intelligence',
      noun: 'code intelligence',
      source: { kind: 'session', name: 'code.intelligence', items: (raw) => (Array.isArray(raw) ? raw as IntelligenceItem[] : []) },
      empty: 'Code lookups are not available in this program.',
      row: (item) => {
        const entry = item as IntelligenceItem;
        if (entry.state === 'errors' || entry.state === 'warnings') return { title: entry.title, right: entry.state === 'errors' ? 'errors' : 'warnings', mark: entry.state === 'errors' ? 'attention' : 'waiting' };
        return { title: entry.title, ...(entry.state === 'not-ready' ? { right: 'not all ready' } : {}), mark: entry.state === 'not-ready' ? 'attention' : 'ok' };
      },
      detail: (item) => (item as IntelligenceItem).lines.map((line) => ({ text: line })),
    },
    {
      id: 'results',
      label: 'Results',
      noun: 'the results',
      source: { kind: 'session', name: 'code.results', items: (raw) => (Array.isArray(raw) ? raw as ResultItem[] : []) },
      empty: 'Nothing looked up yet: the lookups are on Code intelligence, and f finds code in the index.',
      row: (item) => ({ title: (item as ResultItem).title }),
      detail: (item) => {
        const result = item as ResultItem;
        return [{ label: 'From', text: result.lookup, tone: 'muted' as const }, ...result.detail.map((line) => ({ text: line }))];
      },
    },
  ],
  actions: [
    // Anywhere in the place.
    { key: 't', id: 'run-tests', capability: 'code.test', label: 'run the tests' },
    { key: 'f', id: 'find-code', capability: 'codebase.search', label: 'find code' },
    // Changed files.
    { kind: 'program', key: 'enter', list: 'changes', states: ['staged', 'changed', 'new', 'deleted'], label: 'see the diff', run: 'code.see-diff' },
    { key: 'd', id: 'not-staged', list: 'changes', states: ['changed', 'new', 'deleted'], capability: 'git.diff', label: 'what is not staged' },
    { key: 'c', id: 'commit', list: 'changes', states: ['staged', 'changed', 'new', 'deleted'], capability: 'git.commit', label: 'commit every change' },
    { kind: 'program', key: 'v', id: 'review-session', list: 'changes', states: ['staged', 'changed', 'new', 'deleted'], label: 'review this session\'s changes', run: 'code.review-session' },
    { key: 'i', id: 'start-repository', list: 'changes', states: ['no-repository'], capability: 'git.init', label: 'start a repository here' },
    // Worktrees.
    { key: 'p', id: 'pause', list: 'worktrees', states: ['active'], capability: 'worktree.pause', label: 'pause', fill: { worktree: 'id' } },
    { key: 'p', id: 'resume', list: 'worktrees', states: ['paused', 'kept'], capability: 'worktree.resume', label: 'resume', fill: { worktree: 'id' } },
    { key: 'k', id: 'keep', list: 'worktrees', states: ['active', 'paused'], capability: 'worktree.keep', label: 'keep', fill: { worktree: 'id' } },
    { key: 's', id: 'setup-again', list: 'worktrees', states: LIVE_WORKTREE, capability: 'worktree.setup', label: 'run setup again', fill: { worktree: 'id' } },
    { key: 'a', id: 'tie', list: 'worktrees', states: LIVE_WORKTREE, capability: 'worktree.attach', label: 'tie to a session or task', fill: { worktree: 'id' } },
    { key: 'o', id: 'tied-together', list: 'worktrees', states: [...LIVE_WORKTREE, 'gone'], capability: 'worktree.attached', label: 'worktrees of a task or session', fill: { kind: tiedKind, id: tiedId } },
    { key: 'b', id: 'bring-back', list: 'worktrees', states: [...LIVE_WORKTREE, 'gone'], capability: 'worktree.recover', label: 'how to bring them back', fill: { kind: tiedKind, id: tiedId } },
    { key: 'x', id: 'remove', list: 'worktrees', states: LIVE_WORKTREE, capability: 'worktree.discard', label: 'remove', fill: { worktree: 'id' } },
    { key: 'u', id: 'stop-tracking', list: 'worktrees', states: ['gone'], capability: 'worktree.cleanup', label: 'stop tracking', fill: { worktree: 'id' } },
    // The code index.
    { key: 'b', id: 'build-index', list: 'index', states: ['empty', 'built'], capability: 'codebase.build', label: 'build it' },
    // Code intelligence: on the readiness row the form asks for the file; on a file with problems it is that file, at its first problem.
    { key: 'y', id: 'symbols', list: 'intelligence', states: LOOKUP_STATES, capability: 'intelligence.symbols', label: 'symbols', fill: { file: fromProblem('file') } },
    { key: 'o', id: 'outline', list: 'intelligence', states: LOOKUP_STATES, capability: 'intelligence.outline', label: 'outline', fill: { file: fromProblem('file') } },
    { key: 'g', id: 'definition', list: 'intelligence', states: LOOKUP_STATES, capability: 'intelligence.definition', label: 'where it is defined', fill: { file: fromProblem('file'), line: fromProblem('line'), column: fromProblem('column') } },
    { key: 'u', id: 'uses', list: 'intelligence', states: LOOKUP_STATES, capability: 'intelligence.references', label: 'its uses', fill: { file: fromProblem('file'), line: fromProblem('line'), column: fromProblem('column') } },
    { key: 'h', id: 'about', list: 'intelligence', states: LOOKUP_STATES, capability: 'intelligence.hover', label: 'what it is', fill: { file: fromProblem('file'), line: fromProblem('line'), column: fromProblem('column') } },
    { key: 'i', id: 'install-server', list: 'intelligence', states: ['ready', 'not-ready', 'not-kept'], capability: 'intelligence.install', label: 'install a language server' },
  ],
  count: (lists) => {
    const failed = (lists.worktrees ?? []).filter((item) => (item as WorktreeItem).setup === 'failed').length;
    return failed > 0 ? { count: failed, words: `${failed} worktree setup${failed === 1 ? '' : 's'} failed`, tone: 'wrong' } : undefined;
  },
});
