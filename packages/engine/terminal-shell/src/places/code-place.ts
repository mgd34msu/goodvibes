/**
 * code-place.ts, Code and changes: the project's files as this program sees
 * them. Changed files (git status) with their diff in the Changes view, the
 * recent commits, the project's worktrees, the code index, code intelligence
 * (readiness, the files with problems, and the lookups), and the last
 * lookup's results. Every list but one is the program's own (the working
 * folder is the program's), read when the place opens, again after each
 * action, and again when this program announces a checkpoint (after every turn
 * that changed files); the Results list follows the lookups as they answer.
 * The web view, which holds no project folder, lists the chosen project's
 * worktrees (`worktrees.snapshot` with its `project`) under the same tab, with
 * the same controls.
 * Every action is a code capability (capabilities/builtin/code.ts) shown only
 * on the item it acts on, in the states it applies to; opening the Changes
 * view on a file, or on this session's changes, is the program's own screen.
 */
// The program's readers of these lists and its Changes view are in code-sources.ts, so a browser loads this declaration.
import { definePlace, type PlaceItem, type PlaceProgramName } from './place-types.js';

export type ChangeState = 'staged' | 'changed' | 'new' | 'deleted';

export interface ChangeItem extends PlaceItem {
  readonly state: ChangeState | 'no-repository';
  readonly path: string;
}

export interface CommitItem extends PlaceItem {
  readonly state: 'commit';
  readonly hash: string;
  readonly date: string;
  readonly message: string;
}

export interface WorktreeItem extends PlaceItem {
  readonly state: 'main' | 'active' | 'paused' | 'kept' | 'gone';
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

export interface IndexItem extends PlaceItem {
  readonly state: 'empty' | 'built' | 'building' | 'not-kept';
  readonly lines: readonly string[];
}

export interface IntelligenceItem extends PlaceItem {
  /** `ready`/`not-ready`/`not-kept`: the readiness row; `errors`/`warnings`: a file with problems. */
  readonly state: 'ready' | 'not-ready' | 'not-kept' | 'errors' | 'warnings';
  readonly title: string;
  readonly lines: readonly string[];
  readonly file?: string | undefined;
  /** The first problem's place (from 1), for a lookup at it. */
  readonly line?: string | undefined;
  readonly column?: string | undefined;
}

export interface ResultItem extends PlaceItem {
  readonly state: 'result';
  readonly title: string;
  readonly detail: readonly string[];
  readonly lookup: string;
}

type Item = ChangeItem | CommitItem | WorktreeItem | IndexItem | IntelligenceItem | ResultItem;

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) || path;
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** The worktrees the daemon keeps (`worktrees.snapshot`), read defensively, as the program's own list shows them. */
function daemonWorktrees(output: unknown): readonly WorktreeItem[] {
  const records = output !== null && typeof output === 'object' && Array.isArray((output as { records?: unknown }).records)
    ? (output as { records: readonly unknown[] }).records : [];
  return records.flatMap((entry): WorktreeItem[] => {
    const row = entry !== null && typeof entry === 'object' ? entry as Readonly<Record<string, unknown>> : {};
    const path = text(row.path);
    if (!path) return [];
    const setup = row.setup !== null && typeof row.setup === 'object' ? row.setup as Readonly<Record<string, unknown>> : {};
    const state = (['active', 'paused', 'kept'].includes(text(row.state)) ? text(row.state) : 'active') as WorktreeItem['state'];
    return [{
      id: path, state, path, branch: text(row.branch), kind: text(row.kind),
      ...(text(row.sessionId) ? { sessionId: text(row.sessionId) } : {}),
      ...(text(row.taskId) ? { taskId: text(row.taskId) } : {}),
      ...(text(setup.state) ? { setup: text(setup.state) } : {}),
      ...(text(setup.error) ? { setupWords: [text(setup.state), text(setup.error)] } : {}),
      ...(typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
    }];
  });
}

const STATE_WORDS: Readonly<Record<ChangeState, string>> = { staged: 'staged', changed: 'changed', new: 'new', deleted: 'deleted' };
const WORKTREE_WORDS: Readonly<Record<WorktreeItem['state'], string>> = { main: 'this checkout', active: 'active', paused: 'paused', kept: 'kept', gone: 'gone from disk' };
const MADE_BY: Readonly<Record<string, string>> = { manual: 'by hand', agent: 'by an agent', orchestrator: 'by work' };
const LIVE_WORKTREE = ['active', 'paused', 'kept'];
/** The programs that change the worktree register (the Agent only reads it). */
const REGISTER_WRITERS: readonly PlaceProgramName[] = ['tui', 'web'];
const LOOKUP_STATES = ['ready', 'not-ready', 'not-kept', 'errors', 'warnings'];

/** A lookup's file and place from a problem file's row; nothing from the readiness row (the form asks). */
const fromProblem = (field: 'file' | 'line' | 'column') => (item: Item): string => text((item as IntelligenceItem)[field]);
/** A worktree's session or task, for the worktrees tied to it. */
const tiedKind = (item: Item): string => (item as WorktreeItem).taskId ? 'task' : (item as WorktreeItem).sessionId ? 'session' : '';
const tiedId = (item: Item): string => (item as WorktreeItem).taskId ?? (item as WorktreeItem).sessionId ?? '';

/** A worktree's row and detail, for the program's list and the web view's alike. */
function worktreeRow(item: Item): { readonly title: string; readonly right?: string; readonly mark: 'attention' | 'paused' | 'ok' } {
  const worktree = item as WorktreeItem;
  const title = worktree.branch || fileName(worktree.path);
  const failed = worktree.setup === 'failed';
  return {
    title,
    ...(worktree.state !== 'active' ? { right: WORKTREE_WORDS[worktree.state] } : failed ? { right: 'setup failed' } : {}),
    mark: worktree.state === 'gone' || failed ? 'attention' : worktree.state === 'paused' ? 'paused' : 'ok',
  };
}

function worktreeDetail(item: Item) {
  const worktree = item as WorktreeItem;
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
}

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
      // This program's own register writes say so in this process (code-sources.ts); a write the daemon makes (a setup
      // run or a removal, from any door) reaches it as the daemon's LIST_CHANGED `worktrees`.
      follows: { domains: [], events: [], lists: ['worktrees'] },
      empty: 'No worktrees: this folder is not a git repository.',
      programs: ['tui', 'agent'],
      row: worktreeRow,
      detail: worktreeDetail,
    },
    // The web view's worktrees: the ones the daemon keeps, under the same tab and with the same controls.
    {
      id: 'worktrees',
      label: 'Worktrees',
      noun: 'the worktrees of this project',
      // The chosen project's register, read again whenever the daemon changes a register (LIST_CHANGED `worktrees`,
      // runtime/worktree/registry.ts: a setup run or a removal, from any door).
      source: { kind: 'daemon', method: 'worktrees.snapshot', input: {}, projectAs: 'project', items: daemonWorktrees },
      follows: { domains: [], events: [], lists: ['worktrees'] },
      empty: 'No worktrees in this project: parallel work makes them in a git repository.',
      programs: ['web'],
      row: worktreeRow,
      detail: worktreeDetail,
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
    // Worktrees. The Agent reads the register and does not change it (its policy refuses), so the controls that change
    // a worktree's state, ties or record are the terminal app's and the web view's; setup and removal are the daemon's.
    { key: 'p', id: 'pause', list: 'worktrees', states: ['active'], capability: 'worktree.pause', label: 'pause', fill: { worktree: 'id' }, programs: REGISTER_WRITERS },
    { key: 'p', id: 'resume', list: 'worktrees', states: ['paused', 'kept'], capability: 'worktree.resume', label: 'resume', fill: { worktree: 'id' }, programs: REGISTER_WRITERS },
    { key: 'k', id: 'keep', list: 'worktrees', states: ['active', 'paused'], capability: 'worktree.keep', label: 'keep', fill: { worktree: 'id' }, programs: REGISTER_WRITERS },
    { key: 's', id: 'setup-again', list: 'worktrees', states: LIVE_WORKTREE, capability: 'worktree.setup', label: 'run setup again', fill: { worktree: 'id' } },
    { key: 'a', id: 'tie', list: 'worktrees', states: LIVE_WORKTREE, capability: 'worktree.attach', label: 'tie to a session or task', fill: { worktree: 'id' }, programs: REGISTER_WRITERS },
    { key: 'o', id: 'tied-together', list: 'worktrees', states: [...LIVE_WORKTREE, 'gone'], capability: 'worktree.attached', label: 'worktrees of a task or session', fill: { kind: tiedKind, id: tiedId } },
    { key: 'b', id: 'bring-back', list: 'worktrees', states: [...LIVE_WORKTREE, 'gone'], capability: 'worktree.recover', label: 'how to bring them back', fill: { kind: tiedKind, id: tiedId } },
    { key: 'x', id: 'remove', list: 'worktrees', states: LIVE_WORKTREE, capability: 'worktree.discard', label: 'remove', fill: { worktree: 'id' } },
    { key: 'u', id: 'stop-tracking', list: 'worktrees', states: ['gone'], capability: 'worktree.cleanup', label: 'stop tracking', fill: { worktree: 'id' }, programs: REGISTER_WRITERS },
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
