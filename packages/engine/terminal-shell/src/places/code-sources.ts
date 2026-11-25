/**
 * code-sources.ts, what Code and changes (code-place.ts) reads in a terminal
 * program: the project's changed files, commits, worktrees, code index, code
 * intelligence and the last lookup's results, over the program's own code
 * services, and the program's own Changes view. Kept apart from the
 * declaration so the web UI loads the declaration without the program's code.
 */
import {
  CapabilityRefusal, WORKTREE_REVIEW, codeIndexStatusLines, type CodeResultRow, type CodeServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { onListChanged } from '@goodvibes/engine/platform/platform/runtime/emitters';
import { codeResults } from '../code-capabilities.js';
import type { PlacePrograms, PlaceProgramSource } from './place-host.js';
import type { ChangeItem, ChangeState, CommitItem, IndexItem, IntelligenceItem, ResultItem, WorktreeItem } from './code-place.js';

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
  // Both terminal programs read the project's one register (the Agent without changing it).
  const worktrees = code.worktrees;
  if (!worktrees || !code.git.isRepo()) return [];
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

/**
 * The project's files changed: this program announces a workspace checkpoint after every turn or agent run that
 * changed files, and when one is made by hand, restored to or removed (workspace/checkpoint/manager.ts, through
 * runtime/list-changes.ts); and a turn's file writes are told by the session's change tracker as they land, also in a
 * folder where no checkpoint is taken (the Agent in a folder it has not registered). The file lists read again on
 * either, with no key and no timer.
 */
function filesChanged(services: (() => CodeServices | undefined) | undefined, alsoLists: readonly string[] = []): (onChange: () => void) => (() => void) {
  return (onChange) => {
    const offLists = onListChanged((change) => { if (change.list === 'checkpoints' || alsoLists.includes(change.list)) onChange(); });
    let turns: CodeServices['turnChanges'];
    try { turns = services?.()?.turnChanges; } catch { turns = undefined; }
    const offTurns = turns?.subscribe(onChange);
    return () => { offLists(); offTurns?.(); };
  };
}

/** The place's program sources, over this program's code services (session-capabilities.ts). */
export function codePlaceSources(services: () => CodeServices | undefined): Readonly<Record<string, PlaceProgramSource>> {
  // A file a turn writes changes the changed files and what the code readers say, not the commits or the worktrees.
  const follow = filesChanged(services);
  const checkpointsOnly = filesChanged(undefined);
  return {
    'code.changes': { read: () => readChanges(codeOf(services)), subscribe: follow },
    'code.commits': { read: () => readCommits(codeOf(services)), subscribe: checkpointsOnly },
    // The register this program writes (pause, keep, tie, stop tracking) says so itself (runtime/worktree/registry.ts).
    'code.worktrees': { read: () => readWorktrees(codeOf(services)), subscribe: filesChanged(undefined, ['worktrees']) },
    // The code index also says when a build begins and ends (state/code-index-store.ts), so "building" goes by itself.
    'code.index': { read: () => readIndex(codeOf(services)), subscribe: filesChanged(services, ['code-index']) },
    'code.intelligence': { read: () => readIntelligence(codeOf(services)), subscribe: follow },
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
