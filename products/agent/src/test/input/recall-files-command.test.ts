import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import { projectMemoryToFiles } from '@goodvibes-jev/engine/platform/platform/state';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleRecallFilesApply, handleRecallFilesReview, handleRecallFilesSync } from '../../input/commands/recall-files.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeMemoryRecord } from '../tools/agent-harness-tool-fixture.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function rig(records: MemoryRecord[], invokedByModel = false) {
  const root = makeProjectTempDir('gv-recall-files');
  dirs.push(root);
  const printed: string[] = [];
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const deletes: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    ...(invokedByModel ? { invokedByModel: true } : {}),
    workspace: {
      shellPaths: {
        resolveWorkspacePath: (path: string) => resolve(root, path),
        isWithinWorkingDirectory: (path: string) => resolve(root, path).startsWith(root),
        workingDirectory: root,
      },
    },
    clients: {
      memorySpine: {
        list: async () => records,
        update: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return records[0] ?? null; },
        delete: async (id: string) => { deletes.push(id); return true; },
      },
    },
  } as unknown as CommandContext;
  return { root, printed, updates, deletes, ctx, text: () => printed.join('\n') };
}

function editFirstProjectedFile(dir: string, from: string, to: string): void {
  const file = join(dir, readdirSync(dir).find((name) => name.endsWith('.md'))!);
  writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
}

describe('/memory files', () => {
  test('review shows an edited file as a proposal and changes nothing; apply changes only the named record', async () => {
    const record = makeMemoryRecord({ id: 'mem-a', summary: 'Original summary' });
    const { root, ctx, text, updates } = rig([record]);
    const dir = join(root, 'projection');
    projectMemoryToFiles([record], dir);
    editFirstProjectedFile(dir, 'Original summary', 'Edited summary');

    await handleRecallFilesReview(['--dir', 'projection'], ctx);
    expect(text()).toContain('mem-a [update]');
    expect(text()).toContain('Nothing has been applied');
    expect(updates).toEqual([]);

    await handleRecallFilesApply(['mem-a', '--dir', 'projection'], ctx);
    expect(updates).toEqual([{ id: 'mem-a', patch: expect.objectContaining({ summary: 'Edited summary' }) }]);
    expect(text()).toContain('Applied 1');
  });

  test('sync names the edited file it kept', async () => {
    const record = makeMemoryRecord({ id: 'mem-a', summary: 'Original summary' });
    const { root, ctx, text } = rig([record]);
    const dir = join(root, 'projection');
    projectMemoryToFiles([record], dir);
    editFirstProjectedFile(dir, 'Original summary', 'Edited summary');

    await handleRecallFilesSync(['--dir', 'projection'], ctx);
    expect(text()).toContain('Projected 0 record(s)');
    expect(text()).toContain('Kept 1 edited or deleted file(s) as they are: mem-a');
    expect(readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith('.md'))!), 'utf8')).toContain('Edited summary');
  });

  test('a model-run command may review but not sync or apply, and cannot name a directory outside the workspace', async () => {
    const record = makeMemoryRecord({ id: 'mem-a', summary: 'Original summary' });
    const { root, ctx, text, updates, deletes } = rig([record], true);
    const dir = join(root, 'projection');
    projectMemoryToFiles([record], dir);
    editFirstProjectedFile(dir, 'Original summary', 'Edited summary');

    await handleRecallFilesApply(['--all', '--dir', 'projection'], ctx);
    await handleRecallFilesSync(['--dir', 'synced'], ctx);
    expect(text().match(/^Refused: \/memory files (apply|sync)/gm)).toHaveLength(2);
    expect(updates).toEqual([]);
    expect(deletes).toEqual([]);
    expect(() => readdirSync(join(root, 'synced'))).toThrow();

    await handleRecallFilesReview(['--dir', 'projection'], ctx);
    expect(text()).toContain('mem-a [update]');
    await handleRecallFilesReview(['--dir', '/etc'], ctx);
    expect(text()).toContain('is outside the workspace');
  });
});
