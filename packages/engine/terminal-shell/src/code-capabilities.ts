/**
 * code-capabilities.ts, the services the code capabilities run on in both
 * terminal programs (capabilities/builtin/code.ts: git, the code index, code
 * lookups, tests, worktrees; home `session`): the program's working folder and
 * what it keeps for it. The Code and changes place and the model's
 * `capability_run` run the same definitions on them, so what each says is the
 * same. A program passes only the pieces it has (the Agent keeps no code index
 * and runs no tests); the capability that needs a missing piece is not offered.
 */
import {
  CapabilityRefusal, WORKTREES_LIST,
  type CodeGitServices, type CodeIndexServices, type CodeIntelligenceReading, type CodeIntelligenceServices, type CodeResultRow, type CodeServices,
  type CodeWorktreeServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import { GitService } from '@goodvibes/engine/platform/platform/git';
import type { CodeIntelligence } from '@goodvibes/engine/platform/platform/intelligence';
import {
  getPersistedWorktreeMeta, listPersistedWorktreeMeta, reviewWorktreeAttachments, summarizeWorktreeOwnership, type WorktreeRegistry,
} from '@goodvibes/engine/platform/platform/runtime/shell';
import { defineList } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { runLanguageServerInstall } from './language-server-install.js';

/** A hold on the workspace's one code-intelligence facade (the one the model's read and find tools hold). */
export interface CodeIntelligenceHold {
  readonly intelligence: Pick<CodeIntelligence, 'getDocumentSymbols' | 'getOutline' | 'hasTreeSitter' | 'lookupDefinition' | 'lookupReferences' | 'lookupHover' | 'installLanguageServer'>;
  release(): Promise<void>;
}

/** The last lookup's rows, kept for the Code and changes place's Results list. */
export interface CodeResults {
  show(title: string, rows: readonly CodeResultRow[]): void;
  read(): { readonly title: string; readonly rows: readonly CodeResultRow[] };
  subscribe(listener: () => void): () => void;
}

export function createCodeResults(): CodeResults {
  let held: { title: string; rows: readonly CodeResultRow[] } = { title: '', rows: [] };
  const listeners = new Set<() => void>();
  return {
    show(title, rows) {
      held = { title, rows };
      for (const listener of [...listeners]) listener();
    },
    read: () => held,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The program's one holder of the last lookup's rows (one program per process): the place's Results list reads it. */
export const codeResults: CodeResults = createCodeResults();

/** What a program has for its project folder. */
export interface CodeProgramPieces {
  readonly workingDirectory: string;
  readonly worktreeRegistry?: WorktreeRegistry | undefined;
  readonly codeIndex?: CodeIndexServices | undefined;
  readonly intelligence?: {
    readonly hold: () => CodeIntelligenceHold;
    readonly resolvePath: (target: string) => string;
    readonly reading?: (() => CodeIntelligenceReading) | undefined;
  } | undefined;
  readonly tests?: CodeServices['tests'];
  readonly changesView?: CodeServices['changesView'];
  /** Committing every change (the terminal app's own commit, as /quit's write-and-quit makes it). */
  readonly commit?: { preview(): Promise<string>; commitAll(): Promise<string> } | undefined;
  readonly results?: CodeResults | undefined;
}

function gitOf(workingDirectory: string, commit: CodeProgramPieces['commit']): CodeGitServices {
  const git = (): GitService => new GitService(workingDirectory);
  return {
    isRepo: () => GitService.isGitRepo(workingDirectory),
    async status() {
      const status = await git().status();
      return { staged: [...status.staged], modified: [...status.modified], notAdded: [...status.not_added], deleted: [...status.deleted] };
    },
    async log(count) {
      return (await git().log(count)).map((entry) => ({ hash: entry.hash, date: entry.date, message: entry.message }));
    },
    async unstaged() {
      const structured = await git().diffStructured();
      return { files: structured.files.length, additions: structured.additions, deletions: structured.deletions };
    },
    init() {
      const result = GitService.initRepo(workingDirectory);
      return result.success ? { ok: true } : { ok: false, error: result.error ?? 'git did not say why' };
    },
    ...(commit ? { commitPreview: () => commit.preview(), commitAll: () => commit.commitAll() } : {}),
  };
}

function worktreesOf(workingDirectory: string, registry: WorktreeRegistry): CodeWorktreeServices {
  const paths = { workingDirectory };
  return {
    list: () => registry.list(),
    records: () => listPersistedWorktreeMeta(paths),
    record: (path) => getPersistedWorktreeMeta(path, paths),
    summary: (rows) => summarizeWorktreeOwnership(rows),
    kept: (options) => registry.describeKept(options),
    startupRemovals: () => registry.lastStartupReport()?.removed ?? [],
    attachedTo: (kind, id) => reviewWorktreeAttachments(kind, id, paths),
    setState: (path, state) => registry.setState(path, state),
    attach: (path, target) => registry.attach(path, target),
    cleanup: (path) => registry.cleanup(path),
  };
}

function intelligenceOf(pieces: NonNullable<CodeProgramPieces['intelligence']>): CodeIntelligenceServices {
  return {
    resolvePath: pieces.resolvePath,
    async withFacade(work) {
      const hold = pieces.hold();
      try {
        return await work(hold.intelligence);
      } finally {
        await hold.release();
      }
    },
    async install(target) {
      const said: string[] = [];
      await runLanguageServerInstall(target, {
        print: (text) => { said.push(text); },
        resolvePath: pieces.resolvePath,
        hold: pieces.hold,
        nextAfterInstall: 'code lookups for this language (where a symbol is defined, its uses, a file\'s symbols) use it from now on',
      });
      // The progress line said while it ran is left out: the outcome is what is kept.
      const outcome = said.at(-1) ?? '';
      const [head, ...rest] = outcome.split('\n').map((line) => line.trim()).filter(Boolean);
      const state = rest[0] ?? head ?? 'Nothing was said about the install.';
      return [state.replace(/^([a-z-]+): /, (_whole, status: string) => `${status.replace(/-/g, ' ')}: `), ...rest.slice(1)].join('\n');
    },
    ...(pieces.reading ? { reading: pieces.reading } : {}),
  };
}

/** The code capabilities' services over one program's project folder and what it keeps for it. */
export function codeServices(pieces: CodeProgramPieces): CodeServices {
  return {
    workingDirectory: pieces.workingDirectory,
    git: gitOf(pieces.workingDirectory, pieces.commit),
    ...(pieces.worktreeRegistry ? { worktrees: worktreesOf(pieces.workingDirectory, pieces.worktreeRegistry) } : {}),
    ...(pieces.codeIndex ? { codeIndex: pieces.codeIndex } : {}),
    ...(pieces.intelligence ? { intelligence: intelligenceOf(pieces.intelligence) } : {}),
    ...(pieces.tests ? { tests: pieces.tests } : {}),
    ...(pieces.changesView ? { changesView: pieces.changesView } : {}),
    ...(pieces.results ? { results: pieces.results } : {}),
  };
}

/** Keep what a program prints while it does something, as the words the capability answers with. */
export async function printedBy(work: (print: (text: string) => void) => Promise<void>): Promise<string> {
  const said: string[] = [];
  try {
    await work((text) => { said.push(text); });
  } catch (error) {
    if (error instanceof CapabilityRefusal) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CapabilityRefusal(message);
  }
  return said.join('\n');
}

interface WorktreesListContext extends CommandActionContext {
  readonly workspace: { readonly worktreeRegistry?: WorktreeRegistry | undefined };
}

/** The worktrees of this project, by their path (an input of the worktree capabilities chooses from it). */
defineList<WorktreesListContext>({
  name: WORKTREES_LIST,
  async read(ctx) {
    const registry = ctx.workspace.worktreeRegistry;
    if (!registry) return [];
    return (await registry.list()).map((row) => ({ value: row.path, label: row.branch || row.path, detail: row.path, state: row.state }));
  },
  operator: { terminalOnly: 'The worktree list is read from this program\'s project.' },
});
