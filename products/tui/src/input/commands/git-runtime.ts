/**
 * `/git`, described (command-actions/): the repository this session runs in,
 * what changed, its recent commits, starting one, and committing every change
 * (what `/commit-all` was). Only this app has it.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { GitService } from '@goodvibes-jev/engine/platform/platform/git';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { readAction } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { executeCommitAll } from './quit-shared.ts';

const TERMINAL_ONLY = 'It works on the repository this terminal app\'s session runs in.';

/** The repository's git, or a refusal saying there is none here. */
function repository(ctx: CommandContext): { readonly cwd: string; readonly git: GitService } {
  const cwd = requireShellPaths(ctx).workingDirectory;
  if (!GitService.isGitRepo(cwd)) throw commandRefusal(`${cwd} is not inside a git repository; nothing was read.`, '/git init starts one here.');
  return { cwd, git: new GitService(cwd) };
}

const GIT_COMMAND = defineCommand<CommandContext>({
  name: 'git',
  title: 'Git',
  summary: 'The repository this session runs in: what changed, recent commits, and committing every change',
  group: 'Work',
  report: 'status',
  actions: [
    readAction<CommandContext>({
      id: 'status', label: 'See what changed', word: 'status',
      sentence: 'Shows the files that are staged, changed, new or deleted, and what committing every change would include.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async rowValue(ctx) {
        const cwd = requireShellPaths(ctx).workingDirectory;
        if (!GitService.isGitRepo(cwd)) return 'not a repository';
        const status = await new GitService(cwd).status();
        return status.isClean() ? 'nothing changed' : `${status.files.length} changed file${status.files.length === 1 ? '' : 's'}`;
      },
      async run(_values, ctx) {
        const { git } = repository(ctx);
        let status;
        try {
          status = await git.status();
        } catch (error) {
          throw commandRefusal(`The repository could not be read: ${summarizeError(error)}`);
        }
        if (status.isClean()) return 'Nothing changed: the working tree is clean.';
        const lines: string[] = [];
        const group = (title: string, mark: string, files: readonly string[]) => {
          if (files.length === 0) return;
          lines.push(`${title} (${files.length}):`, ...files.map((file) => `  ${mark} ${file}`));
        };
        group('Staged', '+', status.staged);
        group('Changed', '~', status.modified);
        group('New, not tracked', '?', status.not_added);
        group('Deleted', '-', status.deleted);
        ctx.print(lines.join('\n'));
        // What a commit of every change would include, without making it.
        await executeCommitAll(ctx, []);
      },
    }),
    readAction<CommandContext>({
      id: 'log', label: 'See recent commits', word: 'log',
      sentence: 'Shows the last ten commits: short hash, date and message.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) {
        const { git } = repository(ctx);
        try {
          const entries = await git.log(10);
          return [`Recent commits (${entries.length}):`, ...entries.map((entry) => `  ${entry.hash.slice(0, 7)}  ${entry.date.slice(0, 10)}  ${entry.message}`)].join('\n');
        } catch (error) {
          throw commandRefusal(`The commits could not be read: ${summarizeError(error)}`);
        }
      },
    }),
    readAction<CommandContext>({
      id: 'diff', label: 'See changes not yet staged', word: 'diff',
      sentence: 'Counts the changes not yet staged and opens them in the Changes view, where hunks can be staged.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) {
        const { git } = repository(ctx);
        let structured;
        try {
          structured = await git.diffStructured();
        } catch (error) {
          throw commandRefusal(`The changes could not be read: ${summarizeError(error)}`);
        }
        if (structured.files.length === 0) return 'No changes are waiting to be staged.';
        ctx.openChanges?.({ source: 'working' });
        return `Not staged: ${structured.files.length} file${structured.files.length === 1 ? '' : 's'}, +${structured.additions} -${structured.deletions}.`;
      },
    }),
    {
      id: 'init', label: 'Start a repository here', word: 'init', inputs: [],
      sentence: 'A new, empty git repository is created in this folder and kept until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: TERMINAL_ONLY }, example: {},
      async run(_values, ctx) {
        // Repository state is only ever created on request: the Changes view, checkpoints and commits treat any folder with a .git as one.
        const cwd = requireShellPaths(ctx).workingDirectory;
        if (GitService.isGitRepo(cwd)) throw commandRefusal(`${cwd} is already inside a git repository; nothing was changed.`);
        const result = GitService.initRepo(cwd);
        if (!result.success) throw commandRefusal(`No repository was created: ${result.error ?? 'git did not say why'}.`);
        return `Started a git repository in ${cwd}.`;
      },
    },
    {
      id: 'commit', label: 'Commit every change', word: 'commit', inputs: [],
      sentence: 'Every change in this repository, new files included, is committed as one commit (only the staged files, when some are staged), which stays in its history until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it commits your whole working tree', instead: 'Stage and commit the files this task changed with the git tools.' },
      operator: { terminalOnly: TERMINAL_ONLY }, example: {},
      async run(_values, ctx) {
        await executeCommitAll(ctx, ['--yes']);
      },
    },
  ],
});

export function registerGitRuntimeCommands(registry: CommandRegistry): void {
  registry.register(GIT_COMMAND);
}
