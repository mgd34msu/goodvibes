/**
 * Code and changes: the project's files as the program holding the
 * conversation sees them, so every capability here runs in that program (home
 * `session`): what changed and the repository's commits (git), the code index,
 * code lookups over the workspace's code intelligence (the facade the model's
 * read and find tools hold), the project's tests, and the project's git
 * worktrees (one register file per project, the same one the daemon reads).
 * Re-running a worktree's setup and removing a worktree are the daemon's own
 * methods (`worktrees.setup.run`, `worktrees.discard`): those two (home
 * `daemon`) call them as the same caller, for the caller's project.
 *
 * The program hands in `code` (terminal-shell code-capabilities.ts builds it
 * from its working folder and its own stores); a piece a program does not have
 * (the Agent keeps no code index and no test runner) is absent, and the
 * capability that needs it is not offered there.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { CodeIntelligence, DocumentSymbol, LookupResult, SymbolInfo } from '../../intelligence/index.js';
import type { CodeContextResult, CodeIndexStats } from '../../state/code-index-types.js';
import type { CodeIndexReindexActivity } from '../../state/code-index-reindex.js';
import type { ManagedWorktreeMeta, ManagedWorktreeState, WorktreeAttachmentReview, WorktreeOwnershipSummary, WorktreeStatusRecord } from '../../runtime/worktree/registry.js';
import type { WorktreeSetupResult } from '../../runtime/worktree/setup.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

/** What git says changed in the working folder. */
export interface CodeGitStatus {
  readonly staged: readonly string[];
  readonly modified: readonly string[];
  readonly notAdded: readonly string[];
  readonly deleted: readonly string[];
}

export interface CodeGitCommit {
  readonly hash: string;
  readonly date: string;
  readonly message: string;
}

/** The repository the program's working folder is in. */
export interface CodeGitServices {
  isRepo(): boolean;
  status(): Promise<CodeGitStatus>;
  log(count: number): Promise<readonly CodeGitCommit[]>;
  /** The changes not yet staged, counted. */
  unstaged(): Promise<{ readonly files: number; readonly additions: number; readonly deletions: number }>;
  init(): { readonly ok: true } | { readonly ok: false; readonly error: string };
  /** What committing every change would include, in words, with nothing committed; absent where the program cannot commit. */
  commitPreview?: (() => Promise<string>) | undefined;
  /** Commit every change (only the staged files when some are staged); what was committed, in words. */
  commitAll?: (() => Promise<string>) | undefined;
}

/** The project's code index, as the program holding it keeps it. */
export interface CodeIndexServices {
  stats(): CodeIndexStats;
  isBuilding(): boolean;
  buildProgress(): { readonly scanned: number; readonly total: number } | null;
  scheduleBuild(): void;
  search(words: string, options?: { readonly limit?: number | undefined }): Promise<readonly CodeContextResult[]>;
  /** storage.codeIndexEnabled: built at start and kept current. */
  autoStart(): boolean;
  /** The agent-passive-code-injection flag. */
  passiveInjectionFlag(): boolean;
  reindexActivity(): CodeIndexReindexActivity | null;
  /** A build was asked for this session, so edits keep the index current. */
  keptCurrent(): boolean;
  keepCurrent(): void;
  readonly limits: { readonly files: number; readonly fileBytes: number; readonly totalBytes: number };
}

type IntelligenceFacade = Pick<CodeIntelligence, 'getDocumentSymbols' | 'getOutline' | 'hasTreeSitter' | 'lookupDefinition' | 'lookupReferences' | 'lookupHover'>;

/** How ready code intelligence is and the problems it tracks (the terminal app's read model). */
export interface CodeIntelligenceReading {
  readonly diagnosticsStatus: string;
  readonly symbolSearchStatus: string;
  readonly hoverStatus: string;
  readonly languageServers: readonly { readonly language: string; readonly state: string }[];
  readonly errorCount: number;
  readonly warningCount: number;
  /** Tracked problems by absolute path. */
  readonly problems: ReadonlyMap<string, readonly { readonly severity: string; readonly line: number; readonly column: number; readonly message: string }[]>;
}

export interface CodeIntelligenceServices {
  /** A file argument as an absolute workspace path. */
  resolvePath(target: string): string;
  /** Run lookups on the workspace's one facade, held for the call. */
  withFacade<T>(work: (facade: IntelligenceFacade) => Promise<T>): Promise<T>;
  /** Install the language server for a language or a file of it; what happened, in words. */
  install(target: string): Promise<string>;
  /** Absent where the program keeps no reading of readiness and problems (the Agent). */
  reading?: (() => CodeIntelligenceReading) | undefined;
}

type KeptInfo = { readonly path: string; readonly summary: string; readonly nextSteps?: readonly string[] | undefined };

/** The project's worktree register (one file, shared with the daemon). */
export interface CodeWorktreeServices {
  /** The register is read here and never changed (the Agent): pause, resume, keep, attach and cleanup are not offered. */
  readonly readOnly?: true | undefined;
  list(): Promise<readonly WorktreeStatusRecord[]>;
  /** Every record of the register, also those whose worktree is gone. */
  records(): readonly ManagedWorktreeMeta[];
  record(path: string): ManagedWorktreeMeta | null;
  summary(rows: readonly ManagedWorktreeMeta[]): WorktreeOwnershipSummary;
  kept(options: { readonly rows?: readonly WorktreeStatusRecord[] | undefined; readonly only?: string | undefined }): Promise<readonly KeptInfo[]>;
  /** What this program's start-up removed. */
  startupRemovals(): readonly { readonly path: string; readonly note: string }[];
  attachedTo(kind: 'session' | 'task', id: string): WorktreeAttachmentReview;
  setState(path: string, state: ManagedWorktreeState): void;
  attach(path: string, target: { readonly sessionId: string } | { readonly taskId: string }): void;
  cleanup(path: string): Promise<void>;
}

/** One row a lookup or a search found, for the place's Results list. */
export interface CodeResultRow {
  readonly id: string;
  readonly title: string;
  readonly detail: readonly string[];
}

export interface CodeServices {
  readonly workingDirectory: string;
  readonly git: CodeGitServices;
  readonly worktrees?: CodeWorktreeServices | undefined;
  readonly codeIndex?: CodeIndexServices | undefined;
  readonly intelligence?: CodeIntelligenceServices | undefined;
  /** Run the project's test command; what passed and failed, in words. Absent where the program runs no tests. */
  readonly tests?: { run(pattern: string): Promise<string> } | undefined;
  /** The Changes view (a screen of the terminal app). */
  readonly changesView?: { open(source: 'session' | 'working' | 'staged' | 'head'): void } | undefined;
  /** Where a lookup's rows are kept for the place's Results list. */
  readonly results?: { show(title: string, rows: readonly CodeResultRow[]): void } | undefined;
  /** Told when a turn of this program changes a file (the session's change tracker); returns the unsubscribe. */
  readonly turnChanges?: { subscribe(listener: () => void): () => void } | undefined;
}

export interface CodeCapabilityServices {
  readonly code?: CodeServices | undefined;
}

type CodeDefinition = CapabilityDefinition<CodeCapabilityServices>;

function codeOf(services: CodeCapabilityServices): CodeServices {
  if (!services.code) throw new CapabilityRefusal('No project folder is open here: code and changes belong to a terminal program working in one.', 'Run it from the terminal app or the Agent', 'UNAVAILABLE');
  return services.code;
}

function piece<K extends 'worktrees' | 'codeIndex' | 'intelligence' | 'tests'>(services: CodeCapabilityServices, key: K, missing: string): NonNullable<CodeServices[K]> {
  const value = codeOf(services)[key];
  if (!value) throw new CapabilityRefusal(missing, undefined, 'UNAVAILABLE');
  return value as NonNullable<CodeServices[K]>;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function repository(services: CodeCapabilityServices): CodeServices {
  const code = codeOf(services);
  if (!code.git.isRepo()) throw new CapabilityRefusal(`${code.workingDirectory} is not inside a git repository; nothing was read.`, 'Start one with "Start a repository here" in Code and changes', 'NOT_A_REPOSITORY');
  return code;
}

export const GIT_STATUS: CodeDefinition = {
  capability: { id: 'git.status', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'status', label: 'See what changed', word: 'status', inputs: [],
  sentence: 'Shows the files that are staged, changed, new or deleted, and what committing every change would include.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const code = repository(services);
    let status: CodeGitStatus;
    try { status = await code.git.status(); } catch (error) { throw new CapabilityRefusal(`The repository could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    const total = status.staged.length + status.modified.length + status.notAdded.length + status.deleted.length;
    if (total === 0) return { text: 'Nothing changed: the working tree is clean.', data: { ...status } };
    const lines = [`${plural(total, 'changed file')}: ${status.staged.length} staged, ${status.modified.length} changed, ${status.notAdded.length} new, ${status.deleted.length} deleted.`];
    const group = (title: string, mark: string, files: readonly string[]): void => {
      if (files.length > 0) lines.push(`${title} (${files.length}):`, ...files.map((file) => `  ${mark} ${file}`));
    };
    group('Staged', '+', status.staged);
    group('Changed', '~', status.modified);
    group('New, not tracked', '?', status.notAdded);
    group('Deleted', '-', status.deleted);
    if (code.git.commitPreview) lines.push(await code.git.commitPreview());
    return { text: lines.join('\n'), data: { ...status } };
  },
};

export const GIT_LOG: CodeDefinition = {
  capability: { id: 'git.log', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'log', label: 'See recent commits', word: 'log', inputs: [],
  sentence: 'Shows the last ten commits: short hash, date and message.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const code = repository(services);
    let entries: readonly CodeGitCommit[];
    try { entries = await code.git.log(10); } catch (error) { throw new CapabilityRefusal(`The commits could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    if (entries.length === 0) return { text: 'No commits yet.', data: { commits: [] } };
    return {
      text: [`Recent commits (${entries.length}):`, ...entries.map((entry) => `  ${entry.hash.slice(0, 7)}  ${entry.date.slice(0, 10)}  ${entry.message}`)].join('\n'),
      data: { commits: entries.map((entry) => ({ hash: entry.hash, date: entry.date, message: entry.message })) },
    };
  },
};

export const GIT_DIFF: CodeDefinition = {
  capability: { id: 'git.diff', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'diff', label: 'See changes not yet staged', word: 'diff', inputs: [],
  sentence: 'Counts the changes not yet staged and opens them in the Changes view, where hunks can be staged.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const code = repository(services);
    let counted: Awaited<ReturnType<CodeGitServices['unstaged']>>;
    try { counted = await code.git.unstaged(); } catch (error) { throw new CapabilityRefusal(`The changes could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    if (counted.files === 0) return { text: 'No changes are waiting to be staged.', data: { ...counted } };
    // Only the person's own press opens a screen on their display; a model reads the counts.
    if (caller.personAsked === true) code.changesView?.open('working');
    return { text: `Not staged: ${plural(counted.files, 'file')}, +${counted.additions} -${counted.deletions}.`, data: { ...counted } };
  },
};

export const GIT_INIT: CodeDefinition = {
  capability: { id: 'git.init', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'init', label: 'Start a repository here', word: 'init', inputs: [],
  sentence: 'A new, empty git repository is created in this folder and kept until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: {},
  async run(_values, services) {
    // Repository state is only ever created on request: the Changes view, checkpoints and commits treat any folder with a .git as one.
    const code = codeOf(services);
    if (code.git.isRepo()) throw new CapabilityRefusal(`${code.workingDirectory} is already inside a git repository; nothing was changed.`);
    const result = code.git.init();
    if (!result.ok) throw new CapabilityRefusal(`No repository was created: ${result.error}.`);
    return { text: 'Started a git repository in this folder.', data: { folder: code.workingDirectory } };
  },
};

export const GIT_COMMIT: CodeDefinition = {
  capability: { id: 'git.commit', group: 'code', home: 'session', repeat: 'unsafe' },
  actionId: 'commit', label: 'Commit every change', word: 'commit', inputs: [],
  sentence: 'Every change in this repository, new files included, is committed as one commit (only the staged files, when some are staged), which stays in its history until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  ownerOnly: { reason: 'it commits your whole working tree', instead: 'Stage and commit the files this task changed with the git tools.' },
  example: {},
  available: (services) => services.code?.git.commitAll !== undefined,
  async run(_values, services) {
    const code = repository(services);
    if (!code.git.commitAll) throw new CapabilityRefusal('This program does not commit for you.', undefined, 'UNAVAILABLE');
    return { text: await code.git.commitAll() };
  },
};

// ---------------------------------------------------------------------------
// code index
// ---------------------------------------------------------------------------

const NO_INDEX = 'This program keeps no code index for the project; the terminal app does.';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** The code index as it stands, in lines: what is indexed, how results are found, the last build and reindex. */
export function codeIndexStatusLines(index: CodeIndexServices, now = Date.now()): string[] {
  const stats = index.stats();
  const autoStart = index.autoStart();
  const lines: string[] = [];
  lines.push(stats.indexedChunks === 0 && !stats.building ? 'The code index is empty.' : `${plural(stats.indexedFiles, 'file')} indexed, ${plural(stats.indexedChunks, 'chunk')}${stats.building ? '; a build is running' : ''}.`);
  lines.push(`Available: ${stats.available ? 'yes' : 'no'} (${stats.backend}, ${stats.dimensions} dims)`);
  lines.push(`Kept at: ${stats.path}`);
  lines.push(`Embedding provider: ${stats.embeddingProviderLabel} (${stats.embeddingProviderId})`);
  lines.push(stats.semanticRetrievalAvailable ? 'Results labelled: semantic' : 'Results labelled: lexical (hashed fallback; low precision)');
  lines.push(`Built at start: ${autoStart ? 'on' : 'off'} (storage.codeIndexEnabled in Settings, off by default)`);
  const flag = index.passiveInjectionFlag();
  if (flag && autoStart) lines.push('Given to coding turns: on (code hits may be added to coding turns within the shared knowledge budget)');
  else {
    const reasons = [
      ...(!flag ? ['the agent-passive-code-injection flag is off (Settings, flags)'] : []),
      ...(!autoStart ? ['storage.codeIndexEnabled is off (Settings)'] : []),
    ];
    lines.push(`Given to coding turns: off (${reasons.join('; ')})`);
  }
  const activity = index.reindexActivity();
  if (!activity) {
    lines.push(autoStart || index.keptCurrent()
      ? 'Last reindex: none this session (writes and edits reindex the files they touch once the index is built)'
      : 'Last reindex: off; edits do not update the index until it is built in this session or storage.codeIndexEnabled is on');
  } else {
    const agoSec = Math.max(0, Math.round((now - activity.at) / 1000));
    const detail = activity.status === 'error' ? `error: ${activity.error ?? 'unknown'}` : activity.status === 'skipped' ? `skipped (${activity.reason ?? activity.mode ?? 'empty'})` : `indexed (${activity.mode ?? 'symbols'})`;
    lines.push(`Last reindex: ${activity.path}; ${detail}, ${agoSec}s ago`);
  }
  const limits = index.limits;
  lines.push([limits.files, limits.fileBytes, limits.totalBytes].every((limit) => limit === Infinity)
    ? 'Limits: no file count or byte limits'
    : `Limits: at most ${limits.files} files, ${formatBytes(limits.fileBytes)} per file, ${formatBytes(limits.totalBytes)} per build`);
  if (stats.embeddingProviderMismatch) lines.push(`Provider mismatch: ${stats.embeddingProviderMismatch} (vector search off; lexical only)`);
  if (stats.building) {
    const progress = index.buildProgress();
    lines.push(progress ? `Build: running (${progress.scanned}/${progress.total} files read)` : 'Build: running');
  } else if (stats.lastBuild) {
    const build = stats.lastBuild;
    lines.push(`Last build: ${build.filesIndexed} indexed, ${build.filesUnchanged} unchanged, ${build.filesRemoved} removed, ${build.chunksIndexed} chunks embedded (${build.chunksUnchanged} unchanged), ${build.durationMs}ms`);
    if (build.filesFailed) lines.push(`Not indexed: ${plural(build.filesFailed, 'file')}; first error: ${build.firstFailure ?? 'unknown'}`);
    const skip = build.skip;
    const skipped = [
      ...(skip.tooLarge ? [`${skip.tooLarge} too large`] : []),
      ...(skip.overFileCap ? [`${skip.overFileCap} over the file count`] : []),
      ...(skip.overTotalBytes ? [`${skip.overTotalBytes} over the byte budget`] : []),
      ...(skip.binary ? [`${skip.binary} binary`] : []),
      ...(skip.ignoredByGitignore ? [`${skip.ignoredByGitignore} gitignored`] : []),
      ...(skip.readErrors ? [`${skip.readErrors} unreadable`] : []),
      ...(skip.chunkedByWindow ? [`${skip.chunkedByWindow} read in windows (no syntax tree symbols)`] : []),
    ];
    lines.push(skipped.length > 0 ? `Skipped: ${skipped.join(', ')}` : 'Skipped: none');
  } else {
    lines.push('Last build: never');
  }
  if (stats.error) lines.push(`Error: ${stats.error}`);
  if (stats.lastBuildError) lines.push(`Last build error: ${stats.lastBuildError}`);
  if (stats.lastSearchError) lines.push(`Last search error: ${stats.lastSearchError}`);
  if (!stats.semanticRetrievalAvailable) lines.push('Code is not found by meaning: no semantic embedding provider is set up.');
  return lines;
}

export const CODEBASE_STATUS: CodeDefinition = {
  capability: { id: 'codebase.status', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'status', label: 'See how the code index stands', word: 'status', inputs: [],
  sentence: 'Shows what is indexed, how search results are found, what was skipped, and the last build and reindex.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.code?.codeIndex !== undefined,
  async run(_values, services) {
    const index = piece(services, 'codeIndex', NO_INDEX);
    const stats = index.stats();
    return { text: codeIndexStatusLines(index).join('\n'), data: { indexedFiles: stats.indexedFiles, indexedChunks: stats.indexedChunks, building: stats.building, semantic: stats.semanticRetrievalAvailable } };
  },
};

export const CODEBASE_BUILD: CodeDefinition = {
  capability: { id: 'codebase.build', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'build', label: 'Build the code index', word: 'build', inputs: [],
  sentence: 'The code index of this project is built in the background, and edits made in this session keep it current.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.code?.codeIndex !== undefined,
  async run(_values, services) {
    const index = piece(services, 'codeIndex', NO_INDEX);
    if (index.isBuilding()) {
      const progress = index.buildProgress();
      throw new CapabilityRefusal(progress ? `A build is already running (${progress.scanned}/${progress.total} files read).` : 'A build is already running.');
    }
    index.scheduleBuild();
    // Asked for, so it is kept current on this session's file writes whatever storage.codeIndexEnabled says.
    index.keepCurrent();
    // The code index announces when a build begins and ends (state/code-index-store.ts), so its list says so by itself.
    return { text: 'Build started; the Code index list in Code and changes says when it has ended.' };
  },
};

function codeRow(result: CodeContextResult): CodeResultRow {
  const chunk = result.chunk;
  return {
    id: `${chunk.path}:${chunk.startLine}`,
    title: `${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
    detail: [`${result.label}, ${Math.round(result.similarity * 100)}% alike`, `${chunk.kind}${chunk.symbol ? ` ${chunk.symbol}` : ''}`],
  };
}

export const CODEBASE_SEARCH: CodeDefinition = {
  capability: { id: 'codebase.search', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'search', label: 'Search the code index', word: 'search',
  inputs: [
    { id: 'words', label: 'Words', help: 'What to look for in the code', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    { id: 'limit', label: 'How many', help: 'The most results to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: 'the usual number' }, typed: { flag: '--limit' } },
  ],
  sentence: 'Finds the parts of this project\'s code that match {words}, each labelled semantic or lexical.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { words: 'retry backoff', limit: '5' },
  available: (services) => services.code?.codeIndex !== undefined,
  async run(values, services) {
    const index = piece(services, 'codeIndex', NO_INDEX);
    const limit = values.limit ? Number.parseInt(values.limit, 10) : Number.NaN;
    const results = await index.search(values.words!, Number.isNaN(limit) ? undefined : { limit });
    const rows = results.map(codeRow);
    codeOf(services).results?.show(`Code matching "${values.words}"`, rows);
    if (results.length === 0) {
      const stats = index.stats();
      return { text: stats.lastSearchError ? `Search failed: ${stats.lastSearchError}` : stats.indexedChunks === 0 ? 'No results: the code index is empty. Build it first.' : 'No matching code found.', data: { results: [] } };
    }
    return {
      text: [`${plural(results.length, 'result')}, listed under Results:`, ...rows.map((row) => `  ${row.title}  [${row.detail.join('; ')}]`)].join('\n'),
      data: { results: rows.map((row) => ({ at: row.title, about: row.detail })) },
    };
  },
};

// ---------------------------------------------------------------------------
// code intelligence
// ---------------------------------------------------------------------------

const NO_INTELLIGENCE = 'Code lookups are not available in this program.';
const NO_READING = 'This program keeps no reading of code problems; the terminal app does.';

const FILE: InputDescription = { id: 'file', label: 'File', help: 'A source file in this project', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } };
const AT: readonly InputDescription[] = [
  FILE,
  { id: 'line', label: 'Line', help: 'The line, from 1', kind: 'number', freeTextReason: 'a line number', required: true, typed: { position: 2 } },
  { id: 'column', label: 'Column', help: 'The column, from 1', kind: 'number', freeTextReason: 'a column number', required: true, typed: { flag: '--column' } },
];

function existingFile(intelligence: CodeIntelligenceServices, file: string): string {
  const target = intelligence.resolvePath(file);
  if (!existsSync(target)) throw new CapabilityRefusal(`No file at ${target}.`);
  return target;
}

function position(values: Readonly<Record<string, string>>): { readonly line: number; readonly column: number } {
  const line = Number.parseInt(values.line ?? '', 10);
  const column = Number.parseInt(values.column ?? '', 10);
  if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) throw new CapabilityRefusal('A line and a column are whole numbers from 1.');
  return { line: line - 1, column: column - 1 };
}

function kindWord(kind: number | string | undefined): string {
  if (typeof kind === 'number') return `kind ${kind}`;
  if (typeof kind === 'string' && kind.trim().length > 0) return kind;
  return 'symbol';
}

/** Why a lookup has nothing, in lines; nothing when it answered. */
function lookupStatusLines(result: LookupResult<unknown>): string[] {
  if (result.status === 'ok') return [];
  return [`${result.status}: ${result.reason}`, ...result.next.map((step) => `next: ${step}`)];
}

const fileName = (path: string): string => path.split('/').at(-1) || path;

/** Lookup rows to the Results list, and the text a model or a person reads. */
function lookupAnswer(services: CodeCapabilityServices, title: string, summary: string, rows: readonly CodeResultRow[], extra: readonly string[] = []): { text: string; data: Record<string, unknown> } {
  codeOf(services).results?.show(title, rows);
  return {
    text: [summary, ...rows.map((row) => `  ${row.title}${row.detail.length > 0 ? `  ${row.detail[0]}` : ''}`), ...extra.map((line) => `  ${line}`)].join('\n'),
    data: { results: rows.map((row) => ({ at: row.title, about: row.detail })) },
  };
}

function intelligenceAvailable(services: CodeCapabilityServices): boolean {
  return services.code?.intelligence !== undefined;
}

export const INTELLIGENCE_REVIEW: CodeDefinition = {
  capability: { id: 'intelligence.review', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'review', label: 'See whether code intelligence and its language servers are working', word: 'review', inputs: [],
  sentence: 'Shows whether problems, symbols and hover answers are ready, the language servers and their state, and the errors and warnings tracked in the code.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.code?.intelligence?.reading !== undefined,
  async run(_values, services) {
    const reading = piece(services, 'intelligence', NO_INTELLIGENCE).reading;
    if (!reading) throw new CapabilityRefusal(NO_READING, undefined, 'UNAVAILABLE');
    const state = reading();
    const notReady = [
      ...(state.diagnosticsStatus !== 'ready' ? [`problems: ${state.diagnosticsStatus}`] : []),
      ...(state.symbolSearchStatus !== 'ready' ? [`symbols: ${state.symbolSearchStatus}`] : []),
      ...(state.hoverStatus !== 'ready' ? [`hover: ${state.hoverStatus} (install its language server)`] : []),
    ];
    return {
      text: [
        notReady.length === 0 ? 'Code intelligence: everything is ready.' : `Code intelligence: ${notReady.length} not ready.`,
        `Problems: ${state.diagnosticsStatus}`,
        `Symbols: ${state.symbolSearchStatus}`,
        `Hover: ${state.hoverStatus}`,
        `Language servers: ${state.languageServers.length > 0 ? state.languageServers.map((server) => `${server.language} ${server.state}`).join(', ') : 'none set up'}`,
        `Errors: ${state.errorCount}, warnings: ${state.warningCount}, in ${plural(state.problems.size, 'file')}`,
        ...(notReady.length > 0 ? ['Not ready:', ...notReady.map((line) => `  ${line}`)] : []),
      ].join('\n'),
      data: { diagnostics: state.diagnosticsStatus, symbols: state.symbolSearchStatus, hover: state.hoverStatus, languageServers: state.languageServers.map((server) => ({ ...server })), errors: state.errorCount, warnings: state.warningCount },
    };
  },
};

export const INTELLIGENCE_DIAGNOSTICS: CodeDefinition = {
  capability: { id: 'intelligence.diagnostics', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'diagnostics', label: 'See the errors and warnings in a file', word: 'diagnostics',
  inputs: [{ ...FILE, help: 'A source file of this project (src/app.ts); blank for the file with the most errors', required: { default: '', defaultMeans: 'the file with the most errors' } }],
  sentence: 'Shows the problems (errors and warnings) the language servers report for the file named, with their lines.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { file: 'src/index.ts' },
  available: (services) => services.code?.intelligence?.reading !== undefined,
  async run(values, services) {
    const intelligence = piece(services, 'intelligence', NO_INTELLIGENCE);
    if (!intelligence.reading) throw new CapabilityRefusal(NO_READING, undefined, 'UNAVAILABLE');
    const file = values.file ? intelligence.resolvePath(values.file) : '';
    const entries = [...intelligence.reading().problems.entries()]
      .map(([filePath, problems]) => ({ filePath, problems, errors: problems.filter((entry) => entry.severity === 'error').length, warnings: problems.filter((entry) => entry.severity === 'warning').length }))
      .sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.filePath.localeCompare(b.filePath));
    const selected = file ? entries.find((entry) => entry.filePath === file) : entries[0];
    if (!selected) return { text: file ? `No problems are tracked for ${file}.` : 'No problems are tracked.', data: { problems: [] } };
    return {
      text: [
        `${fileName(selected.filePath)}: ${plural(selected.errors, 'error')}, ${plural(selected.warnings, 'warning')}.`,
        `File: ${selected.filePath}`,
        ...selected.problems.slice(0, 8).map((problem) => `  [${problem.severity}] ${problem.line + 1}:${problem.column + 1} ${problem.message}`),
      ].join('\n'),
      data: { file: selected.filePath, problems: selected.problems.map((problem) => ({ ...problem, line: problem.line + 1, column: problem.column + 1 })) },
    };
  },
};

export const INTELLIGENCE_SYMBOLS: CodeDefinition = {
  capability: { id: 'intelligence.symbols', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'symbols', label: 'See the symbols in a file', word: 'symbols', inputs: [FILE],
  sentence: 'Lists the symbols of {file} (its functions, classes, types and variables), from its language server or, without one, from its syntax tree.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { file: 'src/index.ts' },
  available: intelligenceAvailable,
  async run(values, services) {
    const intelligence = piece(services, 'intelligence', NO_INTELLIGENCE);
    const target = existingFile(intelligence, values.file!);
    return intelligence.withFacade(async (facade) => {
      const symbols = await facade.getDocumentSymbols(target, readFileSync(target, 'utf-8'));
      const fromServer = symbols.length > 0 && 'selectionRange' in symbols[0]!;
      const rows = symbols.slice(0, 40).map((symbol): CodeResultRow => {
        if ('selectionRange' in symbol) {
          const at = (symbol as DocumentSymbol).selectionRange?.start ?? (symbol as DocumentSymbol).range.start;
          return { id: `${symbol.name}:${at.line}`, title: `${symbol.name}  ${at.line + 1}:${at.character + 1}`, detail: [kindWord(symbol.kind)] };
        }
        const tree = symbol as SymbolInfo;
        // A syntax-tree symbol's line is counted from 1 already (its column from 0).
        return { id: `${tree.name}:${tree.line}`, title: `${tree.name}  ${tree.line}:${tree.column + 1}`, detail: [kindWord(tree.kind)] };
      });
      return lookupAnswer(services, `Symbols in ${fileName(target)}`,
        `${plural(symbols.length, 'symbol')} in ${fileName(target)}, from ${fromServer ? 'the language server' : 'the syntax tree (the language server gave none or is not set up)'}:`, rows);
    });
  },
};

export const INTELLIGENCE_OUTLINE: CodeDefinition = {
  capability: { id: 'intelligence.outline', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'outline', label: 'See the outline of a file', word: 'outline', inputs: [FILE],
  sentence: 'Shows the outline of {file}: its declarations and their lines.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { file: 'src/index.ts' },
  available: intelligenceAvailable,
  async run(values, services) {
    const intelligence = piece(services, 'intelligence', NO_INTELLIGENCE);
    const target = existingFile(intelligence, values.file!);
    return intelligence.withFacade(async (facade) => {
      const outline = await facade.getOutline(target, readFileSync(target, 'utf-8'));
      const rows = outline.slice(0, 40).map((entry): CodeResultRow => ({ id: `${entry.name}:${entry.line}`, title: `${entry.name}  line ${entry.line}`, detail: [entry.signature || entry.name] }));
      return lookupAnswer(services, `Outline of ${fileName(target)}`,
        outline.length === 0 ? `No outline for ${fileName(target)}${facade.hasTreeSitter(target) ? '' : ' (its language is not read here)'}.` : `${plural(outline.length, 'declaration')} in ${fileName(target)}:`, rows);
    });
  },
};

export const INTELLIGENCE_DEFINITION: CodeDefinition = {
  capability: { id: 'intelligence.definition', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'definition', label: 'Find where a symbol is defined', word: 'definition', inputs: AT,
  sentence: 'Finds where the symbol at line {line}, column {column} of {file} is defined.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { file: 'src/index.ts', line: '12', column: '8' },
  available: intelligenceAvailable,
  async run(values, services) {
    const intelligence = piece(services, 'intelligence', NO_INTELLIGENCE);
    const target = existingFile(intelligence, values.file!);
    const at = position(values);
    return intelligence.withFacade(async (facade) => {
      const found = await facade.lookupDefinition(target, at.line, at.column);
      const rows = found.items.slice(0, 20).map((location): CodeResultRow => ({
        id: `${location.uri}:${location.range.start.line}`, title: `${fileName(location.uri)}:${location.range.start.line + 1}:${location.range.start.character + 1}`, detail: [location.uri],
      }));
      const said = rows.length > 0 ? `Defined at ${rows[0]!.title}:` : found.status === 'ok' ? 'The language server found no definition there.' : 'No definition was found:';
      return lookupAnswer(services, `Definition at ${fileName(target)}:${at.line + 1}`, said, rows, lookupStatusLines(found));
    });
  },
};

export const INTELLIGENCE_REFERENCES: CodeDefinition = {
  capability: { id: 'intelligence.references', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'references', label: 'Find where a symbol is used', word: 'references', inputs: AT,
  sentence: 'Finds every use of the symbol at line {line}, column {column} of {file}.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { file: 'src/index.ts', line: '12', column: '8' },
  available: intelligenceAvailable,
  async run(values, services) {
    const intelligence = piece(services, 'intelligence', NO_INTELLIGENCE);
    const target = existingFile(intelligence, values.file!);
    const at = position(values);
    return intelligence.withFacade(async (facade) => {
      const found = await facade.lookupReferences(target, at.line, at.column);
      const rows = found.items.slice(0, 40).map((reference): CodeResultRow => ({
        id: `${reference.uri}:${reference.range.start.line}:${reference.range.start.character}`, title: `${fileName(reference.uri)}:${reference.range.start.line + 1}:${reference.range.start.character + 1}`, detail: [reference.uri],
      }));
      const said = rows.length > 0 ? `${plural(found.items.length, 'use')} found:` : found.status === 'ok' ? 'The language server found no uses there.' : 'No uses were found:';
      return lookupAnswer(services, `Uses of ${fileName(target)}:${at.line + 1}`, said, rows, lookupStatusLines(found));
    });
  },
};

export const INTELLIGENCE_HOVER: CodeDefinition = {
  capability: { id: 'intelligence.hover', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'hover', label: 'See what a symbol is: its type and documentation', word: 'hover', inputs: AT,
  sentence: 'Shows the type and documentation of the symbol (a variable, a function, a type) at line {line}, column {column} of {file}.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { file: 'src/index.ts', line: '12', column: '8' },
  available: intelligenceAvailable,
  async run(values, services) {
    const intelligence = piece(services, 'intelligence', NO_INTELLIGENCE);
    const target = existingFile(intelligence, values.file!);
    const at = position(values);
    return intelligence.withFacade(async (facade) => {
      const found = await facade.lookupHover(target, at.line, at.column);
      const hover = found.items;
      const lines = typeof hover?.contents === 'string'
        ? hover.contents.split('\n')
        : Array.isArray(hover?.contents)
          ? hover.contents.flatMap((entry) => typeof entry === 'string' ? entry : entry.value.split('\n'))
          : hover?.contents && 'value' in hover.contents ? hover.contents.value.split('\n') : [];
      const kept = lines.map((line) => line.trimEnd()).filter((line) => line.trim() !== '').slice(0, 12);
      const title = `${fileName(target)}:${at.line + 1}:${at.column + 1}`;
      const rows: CodeResultRow[] = kept.length > 0 ? [{ id: title, title, detail: kept }] : [];
      codeOf(services).results?.show(`About ${title}`, rows);
      return {
        text: kept.length > 0 ? [`About ${title}:`, ...kept.map((line) => `  ${line}`)].join('\n')
          : [found.status === 'ok' ? 'The language server has nothing about that position.' : 'Nothing is known about that position:', ...lookupStatusLines(found).map((line) => `  ${line}`)].join('\n'),
        data: { about: kept },
      };
    });
  },
};

export const INTELLIGENCE_INSTALL: CodeDefinition = {
  capability: { id: 'intelligence.install', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'install', label: 'Install the language server for a language', word: 'install',
  inputs: [{ id: 'language', label: 'Language', help: 'A language name, or a file of that language', kind: 'text', freeTextReason: 'a language or a file', required: true, typed: { position: 1 } }],
  sentence: 'The language server for {language} is downloaded into your GoodVibes bin folder, and code lookups use it from then on, until you change it.', done: '',
  // A model's `/intelligence install` was a judgment at v3.5.0 (class none), and so it is now.
  touches: 'another-machine', lasts: 'kept', risk: 'none', example: { language: 'typescript' },
  available: intelligenceAvailable,
  async run(values, services) {
    return { text: await piece(services, 'intelligence', NO_INTELLIGENCE).install(values.language!) };
  },
};

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

export const CODE_TEST: CodeDefinition = {
  capability: { id: 'code.test', group: 'code', home: 'session', repeat: 'unsafe' },
  actionId: 'test', label: 'Run the project\'s tests', word: '',
  inputs: [{ id: 'pattern', label: 'Only', help: 'Words that pick which tests run, passed to the test command', kind: 'text', freeTextReason: 'a test name or file pattern', required: { default: '', defaultMeans: 'every test' }, typed: { tail: true } }],
  sentence: 'The project\'s test command (the test gate, or the package.json test script) runs here and its results are shown in the conversation; Esc stops it.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { pattern: 'upload' },
  available: (services) => services.code?.tests !== undefined,
  async run(values, services) {
    return { text: await piece(services, 'tests', 'This program does not run the project\'s tests; the terminal app does.').run(values.pattern ?? '') };
  },
};

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

const NO_WORKTREES = 'The worktree register is not open in this program.';

/** The register is open here and this program may change it (the Agent reads it only). */
const worktreesWritable = (services: CodeCapabilityServices): boolean =>
  services.code?.worktrees !== undefined && services.code.worktrees.readOnly !== true;

/** The worktrees of this project (terminal-shell code-capabilities.ts reads it). */
export const WORKTREES_LIST = 'worktrees' as ListName;

const WORKTREE: InputDescription = {
  id: 'worktree', label: 'Worktree', help: 'The worktrees of this project', kind: 'choice',
  choices: { list: WORKTREES_LIST, allowOther: { reason: 'a worktree path that is not tracked' } }, required: true, typed: { position: 1 },
};
const ATTACHED_KIND: InputDescription = {
  id: 'kind', label: 'Attached to', help: 'A session or a task', kind: 'choice',
  choices: [{ value: 'session', label: 'A session' }, { value: 'task', label: 'A task' }], required: true, typed: { position: 1 },
};
const ATTACHED_ID: InputDescription = {
  id: 'id', label: 'Its id', help: 'The session\'s or task\'s id, as Sessions or Work shows it', kind: 'text', freeTextReason: 'a session or task id', required: true, typed: { position: 2 },
};

/** A worktree's setup state in words. */
export function worktreeSetupWords(setup: WorktreeSetupResult | undefined): string[] {
  if (!setup) return ['Setup: never run'];
  if (setup.state !== 'failed') return [`Setup: ${setup.state}`];
  const failing = setup.steps.find((step) => !step.ok);
  return [
    `Setup: failed; ${setup.error ?? 'unknown error'}`,
    ...(failing ? [`  failing step (${failing.kind}): ${failing.label}${failing.exitCode !== undefined ? ` (exit ${failing.exitCode})` : ''}`, ...(failing.output ? [`  output: ${failing.output.slice(0, 2000)}`] : [])] : []),
  ];
}

export const WORKTREE_REVIEW: CodeDefinition = {
  capability: { id: 'worktree.review', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'review', label: 'See your worktrees', word: 'review', inputs: [],
  sentence: 'Shows every worktree with its state, branch, age, size and why it is kept.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.code?.worktrees !== undefined,
  async run(_values, services) {
    const worktrees = piece(services, 'worktrees', NO_WORKTREES);
    const rows = await worktrees.list();
    const summary = worktrees.summary(rows);
    let kept: readonly KeptInfo[] = [];
    let failure: string | undefined;
    try { kept = await worktrees.kept({ rows }); } catch (error) { failure = `Retention details could not be read: ${error instanceof Error ? error.message : String(error)}`; }
    const keptInfo = new Map(kept.map((info) => [info.path, info]));
    const removals = worktrees.startupRemovals().map((entry) => `  removed at start: ${entry.path}: ${entry.note}`);
    if (rows.length === 0) return { text: ['No worktrees.', ...removals].join('\n'), data: { worktrees: [] } };
    return {
      text: [
        `${plural(summary.total, 'worktree')}: ${summary.active} active, ${summary.paused} paused, ${summary.kept} kept.`,
        `Tied to a session: ${summary.sessionAttached}; to a task: ${summary.taskAttached}. Made by agents: ${summary.agentOwned}, by work: ${summary.orchestratorOwned}, by hand: ${summary.manualOwned}.`,
        ...rows.map((row) => {
          const info = keptInfo.get(row.path);
          return `  ${row.state.padEnd(7)} ${(row.branch || '-').padEnd(22)} ${row.path}${row.setup?.state === 'failed' ? ' (setup failed)' : ''}${info ? `\n      ${info.summary}` : ''}`;
        }),
        ...(keptInfo.size > 0 ? ['A kept worktree you no longer need can be removed ("Remove a worktree"); its branch and anything uncommitted are kept on the branch.'] : []),
        ...removals,
        ...(failure ? [failure] : []),
      ].join('\n'),
      data: {
        worktrees: rows.map((row) => ({
          path: row.path, branch: row.branch, state: row.state, kind: row.kind, sessionId: row.sessionId, taskId: row.taskId, setup: row.setup?.state,
          updatedAt: row.updatedAt, ...(row.setup?.state === 'failed' ? { setupWords: worktreeSetupWords(row.setup) } : {}),
          ...(keptInfo.has(row.path) ? { kept: keptInfo.get(row.path)!.summary } : {}),
        })),
      },
    };
  },
};

export const WORKTREE_INSPECT: CodeDefinition = {
  capability: { id: 'worktree.inspect', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'inspect', label: 'See the details of one worktree', word: 'inspect', inputs: [WORKTREE],
  sentence: 'Shows the details of the worktree {worktree}: its state, owner, session, task, setup and what to do next.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { worktree: '.goodvibes/worktrees/u-2' },
  available: (services) => services.code?.worktrees !== undefined,
  async run(values, services) {
    const worktrees = piece(services, 'worktrees', NO_WORKTREES);
    const record = worktrees.record(values.worktree!);
    if (!record) throw new CapabilityRefusal(`No tracked worktree at ${values.worktree}.`, 'The Worktrees list in Code and changes shows them', 'NOT_FOUND');
    let kept: readonly KeptInfo[] = [];
    try { kept = await worktrees.kept({ only: record.path }); } catch { /* the record is still shown */ }
    const next = [
      ...(record.setup?.state === 'failed' ? ['run its setup again'] : []),
      ...(record.state === 'paused' ? ['resume it'] : []),
      ...(record.state !== 'kept' ? ['keep it, so the retention sweep leaves it'] : []),
    ];
    return {
      text: [
        `${record.path}: ${record.state}, made ${record.kind === 'manual' ? 'by hand' : record.kind === 'agent' ? 'by an agent' : 'by work'}.`,
        `Owner: ${record.ownerId ?? 'none'}`,
        `Session: ${record.sessionId ?? 'none'}`,
        `Task: ${record.taskId ?? 'none'}`,
        `Changed: ${new Date(record.updatedAt).toLocaleString()}`,
        ...worktreeSetupWords(record.setup),
        ...kept.map((info) => `Kept: ${info.summary}`),
        ...(next.length > 0 ? [`What you can do: ${next.join('; ')}.`] : []),
      ].join('\n'),
      data: { path: record.path, state: record.state, kind: record.kind, ownerId: record.ownerId, sessionId: record.sessionId, taskId: record.taskId, setup: record.setup?.state },
    };
  },
};

function attachmentText(review: WorktreeAttachmentReview, recover: boolean, readOnly = false): string {
  const who = `${review.targetKind} ${review.targetId}`;
  if (review.total === 0) return `No worktrees are tied to ${who}.`;
  return [
    `${plural(review.total, 'worktree')} tied to ${who}: ${review.active} active, ${review.paused} paused, ${review.kept} kept.`,
    ...review.records.map((record) => `  ${record.state.padEnd(7)} ${record.path}${recover ? `: ${record.state === 'paused' ? 'resume it to bring it back' : record.state === 'kept' ? 'it is kept as it is' : 'it is in use'}` : ''}`),
    ...(recover ? [readOnly
      ? 'The terminal app resumes or keeps each one, from its Worktrees list in Code and changes.'
      : 'Resume or keep each one from the Worktrees list in Code and changes.'] : []),
  ].join('\n');
}

export const WORKTREE_ATTACH: CodeDefinition = {
  capability: { id: 'worktree.attach', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'attach', label: 'Tie a worktree to a session or task', word: 'attach',
  inputs: [WORKTREE, { ...ATTACHED_KIND, typed: { flag: '--to' } }, ATTACHED_ID],
  sentence: '{worktree} is tied to {kind} {id} {lasts}.', done: 'Tied {worktree} to {kind} {id}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { worktree: '.goodvibes/worktrees/u-2', kind: 'task', id: 't-9' },
  available: worktreesWritable,
  async run(values, services) {
    try {
      piece(services, 'worktrees', NO_WORKTREES).attach(values.worktree!, values.kind === 'session' ? { sessionId: values.id! } : { taskId: values.id! });
    } catch (error) {
      if (error instanceof CapabilityRefusal) throw error;
      // The register refuses a path no worktree exists at; say so instead of a success line.
      throw new CapabilityRefusal(`Not tied: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { text: '', data: { worktree: values.worktree, kind: values.kind, id: values.id } };
  },
};

export const WORKTREE_ATTACHED: CodeDefinition = {
  capability: { id: 'worktree.attached', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'attached', label: 'See a session\'s or task\'s worktrees', word: 'attached', inputs: [ATTACHED_KIND, ATTACHED_ID],
  sentence: 'Shows the worktrees tied to {kind} {id} and their states.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { kind: 'session', id: 's-41' },
  available: (services) => services.code?.worktrees !== undefined,
  async run(values, services) {
    const review = piece(services, 'worktrees', NO_WORKTREES).attachedTo(values.kind as 'session' | 'task', values.id!);
    return { text: attachmentText(review, false), data: { worktrees: review.records.map((record) => ({ path: record.path, state: record.state })) } };
  },
};

export const WORKTREE_RECOVER: CodeDefinition = {
  capability: { id: 'worktree.recover', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'recover', label: 'See how to recover a session\'s or task\'s worktrees', word: 'recover', inputs: [ATTACHED_KIND, ATTACHED_ID],
  sentence: 'Shows the worktrees tied to {kind} {id} and what brings each back.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { kind: 'task', id: 't-9' },
  available: (services) => services.code?.worktrees !== undefined,
  async run(values, services) {
    const worktrees = piece(services, 'worktrees', NO_WORKTREES);
    const review = worktrees.attachedTo(values.kind as 'session' | 'task', values.id!);
    return { text: attachmentText(review, true, worktrees.readOnly === true), data: { worktrees: review.records.map((record) => ({ path: record.path, state: record.state })) } };
  },
};

function stateDefinition(id: 'pause' | 'resume' | 'keep', label: string, next: ManagedWorktreeState, sentence: string, done: string, undoneBy?: string): CodeDefinition {
  return {
    capability: { id: `worktree.${id}`, group: 'code', home: 'session', repeat: 'safe' },
    actionId: id, label, word: id, inputs: [WORKTREE], sentence, done,
    touches: 'this-machine', lasts: 'kept', risk: 'none', example: { worktree: '.goodvibes/worktrees/u-2' },
    ...(undoneBy ? { undoneBy } : {}),
    available: worktreesWritable,
    async run(values, services) {
      try {
        piece(services, 'worktrees', NO_WORKTREES).setState(values.worktree!, next);
      } catch (error) {
        if (error instanceof CapabilityRefusal) throw error;
        throw new CapabilityRefusal(`Nothing was changed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { text: '', data: { worktree: values.worktree, state: next } };
    },
  };
}

export const WORKTREE_PAUSE = stateDefinition('pause', 'Pause a worktree', 'paused', '{worktree} is marked paused {lasts}.', 'Paused {worktree}.', 'resume');
export const WORKTREE_RESUME = stateDefinition('resume', 'Resume a worktree', 'active', '{worktree} is marked active again {lasts}.', 'Resumed {worktree}.', 'pause');
export const WORKTREE_KEEP = stateDefinition('keep', 'Keep a worktree', 'kept', '{worktree} is marked kept, so the retention sweep leaves it, {lasts}.', 'Kept {worktree}; the retention sweep leaves it.', 'resume');

export const WORKTREE_CLEANUP: CodeDefinition = {
  capability: { id: 'worktree.cleanup', group: 'code', home: 'session', repeat: 'safe' },
  actionId: 'cleanup', label: 'Stop tracking a worktree that is gone', word: 'cleanup', inputs: [WORKTREE],
  sentence: '{worktree}\'s tracking record is removed; use it once the worktree itself is gone.', done: 'Stopped tracking {worktree}.',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', button: 'Stop tracking', example: { worktree: '.goodvibes/worktrees/u-2' },
  available: worktreesWritable,
  async run(values, services) {
    await piece(services, 'worktrees', NO_WORKTREES).cleanup(values.worktree!);
    return { text: '', data: { worktree: values.worktree } };
  },
};

/**
 * The project a daemon-run worktree act is for: the asking program's working folder (supplied from its context, never
 * asked of the person), or the folder an outside caller names with the request. Never the daemon's own folder by
 * default: a caller that names none is refused.
 */
/** What a caller that names no project is told, before anything is asked (capabilities.run reads `callerNeeds`). */
const WORKTREE_PROJECT_NEEDED = 'No project folder came with the request, so no worktree was touched. Ask from the project\'s folder, or send workingDirectory with the request.';

function projectOf(caller: CapabilityCaller): string {
  if (!caller.workingDirectory) {
    throw new CapabilityRefusal('No project folder came with the request, so no worktree was touched.', 'Ask from the project\'s folder, or send workingDirectory with the request', 'NO_PROJECT');
  }
  return caller.workingDirectory;
}

function methodOf(caller: CapabilityCaller): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal('This runs on the daemon, through capabilities.run.');
  return caller.method;
}

const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Run again through the daemon's own method (routes/worktree-setup.ts) in the caller's project, which records the outcome on the worktree. */
export const WORKTREE_SETUP: CapabilityDefinition<object> = {
  capability: { id: 'worktree.setup', group: 'code', home: 'daemon', repeat: 'safe' },
  actionId: 'setup', label: 'Run a worktree\'s setup again', word: 'setup', inputs: [WORKTREE],
  sentence: 'The cold-start setup (worktree.setup.commands and carried-over files) runs again in {worktree}.',
  done: 'The setup ran again in {worktree}.',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { worktree: '.goodvibes/worktrees/u-2' },
  callerNeeds: { project: WORKTREE_PROJECT_NEEDED },
  async run(values, _services, caller) {
    const answer = asRecord(await methodOf(caller)('worktrees.setup.run', { path: values.worktree!, project: projectOf(caller) }));
    const setup = answer['setup'] as WorktreeSetupResult | undefined;
    // The project's own setup commands set aside (its folder is not trusted): said after how it went.
    const notUsed = typeof answer['projectCommandsNotUsed'] === 'string' ? `\n${answer['projectCommandsNotUsed']}` : '';
    // How it went, in words with no folder in them (the done line names the worktree).
    return {
      text: (setup?.state === 'failed'
        ? worktreeSetupWords(setup).join('\n')
        : setup?.state === 'skipped' ? 'There was nothing to run or copy.' : setup?.state === 'succeeded' ? 'It succeeded.' : 'The daemon did not say how it went.') + notUsed,
      // The method's answer as it came: a screen reads the setup's state, steps and error from it.
      data: answer,
    };
  },
};

/** The daemon's eviction-preserving removal (`worktrees.discard`) in the caller's project: uncommitted work is committed onto the kept branch first. */
export const WORKTREE_DISCARD: CapabilityDefinition<object> = {
  capability: { id: 'worktree.discard', group: 'code', home: 'daemon', repeat: 'safe' },
  actionId: 'discard', label: 'Remove a worktree', word: 'discard', inputs: [WORKTREE],
  sentence: '{worktree} is deleted from disk; its branch is kept and anything uncommitted is saved on it first.',
  done: 'Removed {worktree}.',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', button: 'Remove it', example: { worktree: '.goodvibes/worktrees/u-2' },
  callerNeeds: { project: WORKTREE_PROJECT_NEEDED },
  async run(values, _services, caller) {
    const receipt = asRecord(await methodOf(caller)('worktrees.discard', { path: values.worktree!, project: projectOf(caller) }));
    const words = (value: unknown): string => typeof value === 'string' ? value : '';
    const detail = words(receipt['detail']);
    if (receipt['ok'] !== true) throw new CapabilityRefusal(`Nothing was removed: ${detail || 'the daemon did not say why'}`);
    const branch = words(receipt['branch']);
    const saved = words(receipt['preservedCommit']).slice(0, 7);
    return {
      text: `${branch ? `Its branch ${branch} is kept` : 'Its branch is kept'}${saved ? `, with what was uncommitted saved on it as ${saved}` : ''}.`,
      // The daemon's receipt as it came (ok, branch kept, preservation commit, detail).
      data: receipt,
    };
  },
};

/** The one setting (the daemon's, config-ownership.ts) every program and the daemon's own turns follow. */
const CODE_INDEX_KEPT_KEY = 'storage.codeIndexEnabled';

/** Whether a project's code index is kept current, one choice for the machine, written in the daemon's settings. */
export const CODEBASE_KEEP_CURRENT: CapabilityDefinition<object> = {
  capability: { id: 'codebase.keep-current', group: 'code', home: 'daemon', repeat: 'safe' },
  actionId: 'keep-index-current', label: 'Keep the code index up to date', word: 'keep-current',
  inputs: [{
    id: 'kept', label: 'Keep it up to date', help: 'On for every project on this machine, or off', kind: 'choice',
    choices: [
      { value: 'on', label: 'Kept up to date', help: 'A project\'s index is built the first time a turn there asks for code, and kept current after edits.' },
      { value: 'off', label: 'Not built by itself', help: 'No index is built by itself; "build it" builds one on demand.' },
    ],
    required: true, typed: { position: 1 },
  }],
  sentence: 'The code index of every project on this machine: {kept} (one setting, kept by the daemon), until you change it.',
  done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', example: { kept: 'on' },
  async run(values, _services, caller) {
    const on = values.kept === 'on';
    await methodOf(caller)('config.set', { key: CODE_INDEX_KEPT_KEY, value: on });
    return {
      text: on
        ? 'The code index is kept up to date for every project: a project\'s index is built the first time a turn there asks for code.'
        : 'The code index is no longer built by itself in any project; "build it" builds one on demand.',
      data: { kept: on },
    };
  },
};

/** Every code capability that runs in the program holding the conversation. */
export const CODE_SESSION_CAPABILITIES: readonly CodeDefinition[] = [
  GIT_STATUS, GIT_LOG, GIT_DIFF, GIT_INIT, GIT_COMMIT,
  CODEBASE_STATUS, CODEBASE_BUILD, CODEBASE_SEARCH,
  INTELLIGENCE_REVIEW, INTELLIGENCE_DIAGNOSTICS, INTELLIGENCE_SYMBOLS, INTELLIGENCE_OUTLINE, INTELLIGENCE_DEFINITION, INTELLIGENCE_REFERENCES, INTELLIGENCE_HOVER, INTELLIGENCE_INSTALL,
  CODE_TEST,
  WORKTREE_REVIEW, WORKTREE_INSPECT, WORKTREE_ATTACH, WORKTREE_ATTACHED, WORKTREE_RECOVER, WORKTREE_PAUSE, WORKTREE_RESUME, WORKTREE_KEEP, WORKTREE_CLEANUP,
];

/** The command a code capability answered to as a slash command (its id's first word; `code.test` was /test). */
export function codeCommandOf(id: string): { readonly name: string; readonly title: string } {
  const first = id.split('.')[0];
  if (first === 'git') return { name: 'git', title: 'Git' };
  if (first === 'codebase') return { name: 'codebase', title: 'Code index' };
  if (first === 'intelligence') return { name: 'intelligence', title: 'Code intelligence' };
  if (first === 'worktree') return { name: 'worktree', title: 'Worktrees' };
  return { name: 'test', title: 'Run the tests' };
}

/** The ones the daemon runs: each worktree one through its own method in the caller's project, and the index setting. */
export const CODE_DAEMON_CAPABILITIES: readonly CapabilityDefinition<object>[] = [WORKTREE_SETUP, WORKTREE_DISCARD, CODEBASE_KEEP_CURRENT];
