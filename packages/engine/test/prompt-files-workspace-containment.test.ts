// Proves: A repository's VIBE.md or project context file linked to a file outside the workspace puts that private file's text into every prompt sent to the model provider.
// Red when: The project VIBE.md or project context file loader reads a candidate without first checking that its real path, links followed, is inside the workspace boundary (the git root, else the working directory).
/**
 * A cloned repository ships `VIBE.md -> ~/notes/private.md` and
 * `AGENTS.md -> ~/notes/private.md`. Both loaders compose the system prompt sent
 * with every turn. The real loaders over a real repository on disk: the files
 * that live in the repository are loaded, the linked-out ones are reported
 * blocked and their text is in neither prompt.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
import { buildVibePrompt } from '../terminal-shell/src/agent-turn/vibe-file.ts';
import { buildProjectContextPrompt } from '../terminal-shell/src/agent-turn/project-context-files.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const PRIVATE = 'Private journal: the custody hearing moved to the ninth of December.';

test('a VIBE.md or AGENTS.md linked out of the repository is not read into the prompt; the repository\'s own files are', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-prompt-files-')));
  roots.push(root);
  const home = join(root, 'home'), repo = join(root, 'repo'), notes = join(home, 'notes');
  for (const dir of [join(repo, '.git'), join(repo, '.goodvibes'), notes]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(notes, 'private.md'), PRIVATE);
  symlinkSync(join(notes, 'private.md'), join(repo, 'VIBE.md'));
  symlinkSync(join(notes, 'private.md'), join(repo, 'AGENTS.md'));
  // The control: files that live in the repository are loaded by the same loaders.
  writeFileSync(join(repo, '.goodvibes', 'VIBE.md'), 'Answer in short sentences.');
  writeFileSync(join(repo, 'CLAUDE.md'), 'Run the tests before a commit.');

  const paths = createShellPathService({ workingDirectory: repo, homeDirectory: home });
  const prompts = [buildVibePrompt(paths) ?? '', buildProjectContextPrompt(paths) ?? ''];
  expect(prompts.map((prompt) => ({
    privateText: prompt.includes(PRIVATE),
    ownFile: prompt.includes('Answer in short sentences.') || prompt.includes('Run the tests before a commit.'),
    blocked: prompt.includes('Symlink resolves outside the workspace; not loaded.'),
  }))).toEqual([
    { privateText: false, ownFile: true, blocked: true },
    { privateText: false, ownFile: true, blocked: true },
  ]);
});
