import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import {
  readReceiptFile,
  receiptPath,
  writeReceipt,
  type LearningConsolidationReceipt,
} from '../../tools/agent-learning-consolidation-core.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function paths() {
  const root = makeProjectTempDir('consolidation-receipts'); roots.push(root);
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

function receipt(id: string, phase: LearningConsolidationReceipt['phase'], candidateId = `candidate-${id}`): LearningConsolidationReceipt {
  return { id, createdAt: '2026-01-01T00:00:00.000Z', domain: 'skill', candidateId, phase, explicitUserRequest: 'Test request.',
    survivorId: 'survivor', duplicateIds: ['duplicate'], beforeDuplicates: [{ id: 'duplicate', name: 'Duplicate' }] };
}

function seedFile(shellPaths: ReturnType<typeof paths>, content: string): string {
  const path = receiptPath(shellPaths);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
  return path;
}

describe('consolidation receipt file', () => {
  test('a receipt this build does not recognise survives the next write', () => {
    const shellPaths = paths();
    const unknown = { id: 'future', phase: 'quarantine', detail: 'written by a newer build' };
    const path = seedFile(shellPaths, JSON.stringify({ version: 2, receipts: [receipt('known', 'stale'), unknown] }));
    writeReceipt(shellPaths, receipt('newest', 'merge'));
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { receipts: Array<{ id: string }> };
    expect(stored.receipts.map((entry) => entry.id)).toEqual(['newest', 'known', 'future']);
    // And it is still preserved on the write after that.
    writeReceipt(shellPaths, receipt('later', 'stale'));
    expect((JSON.parse(readFileSync(path, 'utf8')) as { receipts: Array<{ id: string }> }).receipts.map((entry) => entry.id)).toContain('future');
  });

  test('an unreadable file is refused and left exactly as it was', () => {
    const shellPaths = paths();
    const path = seedFile(shellPaths, '{ this is not json');
    expect(() => readReceiptFile(shellPaths)).toThrow('unreadable');
    expect(() => writeReceipt(shellPaths, receipt('newest', 'merge'))).toThrow('unreadable');
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
  });

  test('a missing file is an empty history, not an error', () => {
    expect(readReceiptFile(paths()).receipts).toEqual([]);
  });

  test('a delete receipt older than the cap survives until its records are recreated', () => {
    const shellPaths = paths();
    writeReceipt(shellPaths, receipt('oldest-delete', 'delete', 'candidate-gone'));
    for (let index = 0; index < 101; index++) writeReceipt(shellPaths, receipt(`filler-${index}`, 'merge'));
    const ids = () => readReceiptFile(shellPaths).receipts.map((entry) => entry.id);
    expect(ids()).toContain('oldest-delete');
    expect(ids().filter((id) => id.startsWith('filler-'))).toHaveLength(100);
    writeReceipt(shellPaths, receipt('recreated', 'recreate', 'candidate-gone'));
    expect(ids()).not.toContain('oldest-delete');
  });

  test('a second delete of the same candidate is kept although an earlier delete of it was recreated', () => {
    const shellPaths = paths();
    writeReceipt(shellPaths, receipt('first-delete', 'delete', 'candidate-again'));
    writeReceipt(shellPaths, receipt('first-recreate', 'recreate', 'candidate-again'));
    writeReceipt(shellPaths, receipt('second-delete', 'delete', 'candidate-again'));
    for (let index = 0; index < 101; index++) writeReceipt(shellPaths, receipt(`filler-${index}`, 'merge'));
    const ids = readReceiptFile(shellPaths).receipts.map((entry) => entry.id);
    expect(ids).toContain('second-delete');
    expect(ids).not.toContain('first-delete');
  });
});
