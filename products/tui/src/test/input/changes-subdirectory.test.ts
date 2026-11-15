/**
 * Diff paths are relative to the repository root, but the TUI can be launched
 * in a subdirectory: staging, unstaging and opening a file must resolve them
 * against the root, and the modal must be honest about empty commits and
 * double presses.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyHunkToIndex, loadDiff, resolveRepoPath, setFileStaged } from '../../input/changes-git.ts';
import { ChangesModal } from '../../input/changes-modal.ts';
import { hunkPatch, parseChanges } from '../../input/changes-model.ts';
import { SurfaceModalHost } from '@goodvibes-jev/engine/terminal-shell/surface-modal-host';
import { layerTextBlock } from '../helpers/surface-frame.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let repo = '';
let sub = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
}
const staged = (): string[] => git('diff', '--cached', '--name-only').split('\n').filter(Boolean);

beforeAll(() => {
  repo = makeProjectTempDir('changes-subdirectory');
  sub = join(repo, 'sub');
  git('init', '-q');
  mkdirSync(sub);
  writeFileSync(join(repo, 'top.txt'), 'one\n');
  writeFileSync(join(sub, 'in.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('commit', '-q', '--allow-empty', '-m', 'empty commit');
});

function modalIn(cwd: string, overrides: Partial<ConstructorParameters<typeof ChangesModal>[0]> = {}) {
  const renders: Array<() => void> = [];
  const modal = new ChangesModal({
    workingDirectory: cwd,
    getSessionFiles: () => [],
    requestRender: () => { for (const waiter of renders.splice(0)) waiter(); },
    ...overrides,
  });
  const host = new SurfaceModalHost();
  host.push(modal);
  const nextRender = () => new Promise<void>((resolve) => { renders.push(resolve); });
  return { modal, host, nextRender };
}
const text = (value: string) => ({ type: 'text', value }) as const;

describe('staging from a subdirectory launch', () => {
  test('a hunk of a file outside the subdirectory is staged, not silently dropped', async () => {
    writeFileSync(join(repo, 'top.txt'), 'two\n');
    const file = parseChanges((await loadDiff(sub, 'working', [])).raw).find((f) => f.path === 'top.txt')!;
    expect(await applyHunkToIndex(sub, hunkPatch(file, file.hunks[0]!), false)).toBeNull();
    expect(staged()).toEqual(['top.txt']);
    expect(await applyHunkToIndex(sub, hunkPatch(file, file.hunks[0]!), true)).toBeNull();
    expect(staged()).toEqual([]);
  });

  test('stage and unstage a whole file by its root-relative path', async () => {
    writeFileSync(join(sub, 'in.txt'), 'two\n');
    expect(await setFileStaged(sub, 'sub/in.txt', true)).toBeNull();
    expect(staged()).toEqual(['sub/in.txt']);
    expect(await setFileStaged(sub, 'sub/in.txt', false)).toBeNull();
    expect(staged()).toEqual([]);
  });

  test('the modal reports the hunk staged only because it is in the index', async () => {
    const { modal } = modalIn(sub);
    await modal.reload('working');
    modal.selected = modal.files.findIndex((f) => f.path === 'top.txt');
    await modal.stageHunk();
    expect(modal.status?.text).toContain('Staged the hunk at top.txt');
    expect(staged()).toContain('top.txt');
    git('reset', '-q');
  });

  test('o opens the root file by its absolute path', async () => {
    const opened: Array<{ path: string; line: number | undefined }> = [];
    const done = Promise.withResolvers<void>();
    const { modal, host } = modalIn(sub, { openInEditor: (path, line) => { opened.push({ path, line }); done.resolve(); } });
    await modal.reload('working');
    modal.selected = modal.files.findIndex((f) => f.path === 'top.txt');
    host.handleToken(text('o'));
    await done.promise;
    expect(opened[0]!.path).toBe(await resolveRepoPath(sub, 'top.txt'));
    expect(opened[0]!.path.endsWith('/top.txt')).toBe(true);
    expect(opened[0]!.path).not.toContain('/sub/');
  });
});

describe('Changes modal states', () => {
  test('a commit with no file changes says so instead of loading forever', async () => {
    const { modal, host, nextRender } = modalIn(repo);
    await modal.reload('staged');
    expect(modal.files).toHaveLength(0);
    const loaded = nextRender();
    // Up on the first row re-selects it, which starts reading the newest commit (the empty one).
    host.handleToken({ type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    await loaded;
    const screen = layerTextBlock(modal.render(120, 40));
    expect(screen).toContain('This commit has no file changes.');
    expect(screen).not.toContain('Loading');
  });

  test('a second Space while the first stage is still running does not stage twice', async () => {
    writeFileSync(join(repo, 'top.txt'), 'three\n');
    const { modal } = modalIn(repo);
    await modal.reload('working');
    modal.selected = modal.files.findIndex((f) => f.path === 'top.txt');
    let firstDone = false;
    const first = modal.stageHunk().then(() => { firstDone = true; });
    // The press that arrives mid-flight returns at once instead of running git for the same hunk.
    await modal.stageHunk();
    expect(firstDone).toBe(false);
    // Without the guard the second press runs git too and its note (here an error, the hunk being staged already) is shown.
    expect(modal.status).toBeNull();
    await first;
    expect(staged()).toEqual(['top.txt']);
    expect(modal.status?.tone).toBe('success');
    expect(modal.status?.text).toContain('Staged the hunk');
    git('reset', '-q');
  });
});

describe('reverting a hunk from a subdirectory launch', () => {
  test('the revert request carries the path relative to the launch directory, and a file outside it is refused', async () => {
    writeFileSync(join(repo, 'top.txt'), 'four\n');
    writeFileSync(join(sub, 'in.txt'), 'four\n');
    const requested: string[] = [];
    const { modal, host, nextRender } = modalIn(sub, { revertHunk: async (hunk) => { requested.push(hunk.filePath); return 'ok'; } });
    await modal.reload('working');
    modal.selected = modal.files.findIndex((f) => f.path === 'sub/in.txt');
    // The reload inside revert renders first; the status line is set after it.
    let rendered = nextRender();
    host.handleToken(text('x'));
    await rendered;
    while (modal.status === null) { rendered = nextRender(); await rendered; }
    expect(requested).toEqual(['in.txt']);

    modal.selected = modal.files.findIndex((f) => f.path === 'top.txt');
    rendered = nextRender();
    host.handleToken(text('x'));
    await rendered;
    expect(requested).toEqual(['in.txt']);
    expect(modal.status?.tone).toBe('error');
    expect(modal.status?.text).toContain('outside');
    git('checkout', '--', '.');
  });
});

describe('reverting a hunk when the launch directory is a symlink', () => {
  test('a file at the launch directory is reverted with its plain relative path', async () => {
    const link = `${repo}-link`;
    symlinkSync(repo, link);
    writeFileSync(join(repo, 'top.txt'), 'five\n');
    const requested: string[] = [];
    const { modal, host, nextRender } = modalIn(link, { revertHunk: async (hunk) => { requested.push(hunk.filePath); return 'ok'; } });
    await modal.reload('working');
    modal.selected = modal.files.findIndex((f) => f.path === 'top.txt');
    let rendered = nextRender();
    host.handleToken(text('x'));
    await rendered;
    while (modal.status === null) { rendered = nextRender(); await rendered; }
    expect(requested).toEqual(['top.txt']);
    expect(modal.status?.tone).not.toBe('error');
    git('checkout', '--', '.');
  });
});
