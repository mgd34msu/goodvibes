// Proves: A repository's VIBE.md or project context file linked to a file outside the workspace puts that private file's text into every prompt sent to the model provider.
// Red when: The project VIBE.md, project context file or instruction chain loader reads a project file without opening it as a held path first (its real place, links followed, judged inside the project's root), so a link out of the project is read.
/**
 * A cloned repository ships `VIBE.md -> ~/notes/private.md` and
 * `AGENTS.md -> ~/notes/private.md`. The loaders compose the system prompt sent
 * with every turn (the Agent's VIBE.md and project context files, the programs'
 * instruction chain). The real loaders over a real repository on disk, trusted
 * by the owner: the files that live in the repository are loaded, the linked-out
 * ones are reported not read and their text is in no prompt.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
import { WorkspaceTrustManager } from '../platform/src/platform/runtime/workspace-trust.ts';
import { loadSystemPromptWithSources } from '../platform/src/platform/utils/prompt-loader.ts';
import { buildVibePrompt } from '../terminal-shell/src/agent-turn/vibe-file.ts';
import { buildProjectContextPrompt } from '../terminal-shell/src/agent-turn/project-context-files.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const PRIVATE = 'Private journal: the custody hearing moved to the ninth of December.';

test('a VIBE.md or AGENTS.md linked out of the repository is not read into the prompt; the repository\'s own files are', async () => {
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
  writeFileSync(join(repo, '.goodvibes', 'GOODVIBES.md'), 'Keep the changelog current.');

  const paths = createShellPathService({ workingDirectory: repo, homeDirectory: home });
  // Project files are read only for a project the owner trusted: he trusts this one.
  const trust = new WorkspaceTrustManager({ shellPaths: paths, surfaceRoot: 'agent' });
  await trust.load();
  await trust.setLevel('trusted');
  const prompts = [
    buildVibePrompt(paths) ?? '',
    buildProjectContextPrompt(paths) ?? '',
    loadSystemPromptWithSources({ workingDirectory: repo, homeDirectory: home, argv: [] }).prompt,
  ];
  expect(prompts.map((prompt) => ({
    privateText: prompt.includes(PRIVATE),
    ownFile: prompt.includes('Answer in short sentences.') || prompt.includes('Run the tests before a commit.') || prompt.includes('Keep the changelog current.'),
    blocked: /leads out of the project/.test(prompt),
  }))).toEqual([
    { privateText: false, ownFile: true, blocked: true },
    { privateText: false, ownFile: true, blocked: true },
    { privateText: false, ownFile: true, blocked: true },
  ]);
});
