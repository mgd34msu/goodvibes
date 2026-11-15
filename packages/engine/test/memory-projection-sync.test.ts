import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  diffProjectionToProposals,
  findOrphanedProjectionFiles,
  projectMemoryToFiles,
  readProjectedMemoryFiles,
  readProjectedMemoryIds,
  type MemoryRecord,
} from '../platform/src/platform/state/index.js';

/**
 * `sync` writes the store's records to files, `review` diffs the files back.
 * These pin what must survive that trip: a record the store gained since the
 * last sync is not a deletion, a file the user edited or deleted is not
 * overwritten or recreated before it can be reviewed, and a record that was
 * not touched by anyone never reads back as an edit.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function projectionDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-proj-sync-'));
  roots.push(root);
  return join(root, 'memory');
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_a', scope: 'project', cls: 'decision', summary: 'use bun', detail: 'bun is the runtime', tags: ['tooling'],
    provenance: [], reviewState: 'reviewed', confidence: 80, createdAt: 1_000, updatedAt: 1_000, ...overrides,
  };
}

describe('a record the store gained after the last sync', () => {
  test('is not proposed for deletion', () => {
    const dir = projectionDir();
    const first = [record({ id: 'mem_a' }), record({ id: 'mem_b', createdAt: 2_000 })];
    projectMemoryToFiles(first, dir, { now: 1_000 });
    const later = [...first, record({ id: 'mem_c', createdAt: 3_000, summary: 'added later' })];
    expect(diffProjectionToProposals(later, readProjectedMemoryFiles(dir))).toEqual([]);
  });

  test('a file deleted after a sync is proposed for deletion, and only that record', () => {
    const dir = projectionDir();
    const first = [record({ id: 'mem_a' }), record({ id: 'mem_b', createdAt: 2_000 })];
    projectMemoryToFiles(first, dir, { now: 1_000 });
    unlinkSync(join(dir, 'mem_b.md'));
    const later = [...first, record({ id: 'mem_c', createdAt: 3_000 })];
    // The files read from the directory carry what the last sync projected, so no option is needed.
    const proposals = diffProjectionToProposals(later, readProjectedMemoryFiles(dir));
    expect(proposals.map((p) => [p.kind, p.id])).toEqual([['delete', 'mem_b']]);
  });

  test('a directory with no manifest proposes no deletion', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    expect(readProjectedMemoryIds(join(dir, 'nowhere'))).toBeNull();
    expect(diffProjectionToProposals([record()], [], { projectedIds: readProjectedMemoryIds(join(dir, 'nowhere')) })).toEqual([]);
  });
});

describe('a record deleted from the store', () => {
  test('loses its untouched file at the next sync; an edited one is kept and listed as an orphan', () => {
    const dir = projectionDir();
    const first = [record({ id: 'mem_1' }), record({ id: 'mem_2', createdAt: 2_000 }), record({ id: 'mem_3', createdAt: 3_000 })];
    projectMemoryToFiles(first, dir, { now: 1_000 });
    const edited = join(dir, 'mem_3.md');
    writeFileSync(edited, readFileSync(edited, 'utf-8').replace('# use bun', '# use bun everywhere'));
    const remaining = [first[0]!];
    const report = projectMemoryToFiles(remaining, dir, { now: 2_000 });
    expect(report.removed).toEqual(['mem_2']);
    expect(report.orphaned).toEqual(['mem_3']);
    expect(existsSync(join(dir, 'mem_2.md'))).toBe(false);
    expect(existsSync(edited)).toBe(true);
    const files = readProjectedMemoryFiles(dir);
    expect(findOrphanedProjectionFiles(remaining, files).map((file) => file.id)).toEqual(['mem_3']);
    expect(diffProjectionToProposals(remaining, files)).toEqual([]);
  });
});

describe('sync does not overwrite what the user changed', () => {
  test('an edited file is kept, reported, and still proposed as an edit', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    const path = join(dir, 'mem_a.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('# use bun', '# use bun everywhere'), 'utf-8');

    const report = projectMemoryToFiles([record()], dir, { now: 2_000 });
    expect(report.kept).toEqual(['mem_a']);
    expect(report.written).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toContain('# use bun everywhere');
    const proposals = diffProjectionToProposals([record()], readProjectedMemoryFiles(dir), { projectedIds: readProjectedMemoryIds(dir) });
    expect(proposals.map((p) => [p.kind, p.changedFields])).toEqual([['update', ['summary']]]);
  });

  test('a deleted file is not recreated before the deletion can be reviewed', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    unlinkSync(join(dir, 'mem_a.md'));
    const report = projectMemoryToFiles([record()], dir, { now: 2_000 });
    expect(report.kept).toEqual(['mem_a']);
    expect(readProjectedMemoryFiles(dir)).toEqual([]);
    const proposals = diffProjectionToProposals([record()], [], { projectedIds: readProjectedMemoryIds(dir) });
    expect(proposals.map((p) => p.kind)).toEqual(['delete']);
  });

  test('a file edited so it no longer parses is kept, not overwritten', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    const path = join(dir, 'mem_a.md');
    writeFileSync(path, '# use bun everywhere\n\nmy long correction', 'utf-8');
    const report = projectMemoryToFiles([record()], dir, { now: 2_000 });
    expect(report.kept).toEqual(['mem_a']);
    expect(report.written).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toContain('my long correction');
  });

  test('an edit of the read-only cls line is kept, not overwritten', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    const path = join(dir, 'mem_a.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('cls: decision', 'cls: fact'), 'utf-8');
    const report = projectMemoryToFiles([record()], dir, { now: 2_000 });
    expect(report.kept).toEqual(['mem_a']);
    expect(readFileSync(path, 'utf-8')).toContain('cls: fact');
  });

  test.each([
    ['confidence: 80', 'confidence: 99'],
    ['reviewState: reviewed', 'reviewState: pending'],
  ])('an edit of the read-only line %s is kept, not overwritten', (from, to) => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    const path = join(dir, 'mem_a.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace(from, to), 'utf-8');
    const report = projectMemoryToFiles([record()], dir, { now: 2_000 });
    expect(report.kept).toEqual(['mem_a']);
    expect(readFileSync(path, 'utf-8')).toContain(to);
    // Reverting the line lets the next sync refresh the file again.
    writeFileSync(path, readFileSync(path, 'utf-8').replace(to, from), 'utf-8');
    expect(projectMemoryToFiles([record()], dir, { now: 3_000 }).kept).toBeUndefined();
  });

  test('a file nobody edited is refreshed when the store record changed', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    const changed = record({ confidence: 95, summary: 'use bun for everything', updatedAt: 2_000 });
    const report = projectMemoryToFiles([changed], dir, { now: 2_000 });
    expect(report.kept).toBeUndefined();
    expect(readFileSync(join(dir, 'mem_a.md'), 'utf-8')).toContain('# use bun for everything');
  });

  test('a record added since the last sync is written next to the kept file', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    const path = join(dir, 'mem_a.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('# use bun', '# edited'), 'utf-8');
    const report = projectMemoryToFiles([record(), record({ id: 'mem_b', createdAt: 2_000 })], dir, { now: 2_000 });
    expect(report.kept).toEqual(['mem_a']);
    expect(report.written.map((p) => p.endsWith('mem_b.md'))).toEqual([true]);
  });
});

describe('an untouched projection reads back with no proposals', () => {
  test('trailing-newline detail, a comma in a tag and a two-line summary survive the round trip', () => {
    const dir = projectionDir();
    const awkward = record({ summary: 'first line\nsecond line', detail: 'x \n', tags: ['a,b', 'plain', '[bracket'] });
    projectMemoryToFiles([awkward], dir, { now: 1_000 });
    const files = readProjectedMemoryFiles(dir);
    expect(files[0]?.tags).toEqual(['a,b', 'plain', '[bracket']);
    expect(diffProjectionToProposals([awkward], files, { projectedIds: readProjectedMemoryIds(dir) })).toEqual([]);
  });

  test('a detail with CRLF line endings reads back with no proposal', () => {
    const dir = projectionDir();
    const crlf = record({ detail: 'a\r\nb' });
    projectMemoryToFiles([crlf], dir, { now: 1_000 });
    expect(diffProjectionToProposals([crlf], readProjectedMemoryFiles(dir), { projectedIds: readProjectedMemoryIds(dir) })).toEqual([]);
  });

  test('the comma-separated tag line a person writes by hand still reads', () => {
    const dir = projectionDir();
    projectMemoryToFiles([record()], dir, { now: 1_000 });
    const path = join(dir, 'mem_a.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('tags: tooling', 'tags: tooling, build'), 'utf-8');
    const proposals = diffProjectionToProposals([record()], readProjectedMemoryFiles(dir));
    expect(proposals[0]?.desired?.tags).toEqual(['tooling', 'build']);
  });
});

describe('the commit report', () => {
  test('says nothing was committed when the git seam reports an unchanged tree', () => {
    const dir = projectionDir();
    const git = { resolveToplevel: (d: string) => d, init: () => {}, add: () => {}, commit: () => false as const };
    expect(projectMemoryToFiles([record()], dir, { now: 1_000, git }).committed).toBe(false);
  });
});
