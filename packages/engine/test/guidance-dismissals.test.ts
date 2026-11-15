/**
 * Guidance dismissals are shared by every surface on one home, so two of them
 * dismissing different messages at once must both stick, and an unreadable
 * store must never be overwritten with an empty one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dismissGuidance, resetGuidance } from '../platform/src/platform/runtime/guidance.ts';

const roots: string[] = [];
const newPath = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'gv-guidance-'));
  roots.push(root);
  return join(root, 'guidance.json');
};
const readIds = (path: string): string[] => Object.keys(JSON.parse(readFileSync(path, 'utf-8')).dismissed as Record<string, number>).sort();

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe('guidance dismissals', () => {
  test('dismissals made by separate processes at the same time all survive', async () => {
    const guidancePath = newPath();
    const module = new URL('../platform/src/platform/runtime/guidance.ts', import.meta.url).href;
    const script = `
      const { dismissGuidance } = await import(process.argv[1]);
      for (let i = 0; i < 15; i++) {
        if (!dismissGuidance(process.argv[3] + i, { guidancePath: process.argv[2] })) process.exit(1);
      }
    `;
    const children = ['a', 'b', 'c'].map((tag) => Bun.spawn([process.execPath, '-e', script, module, guidancePath, tag], { stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual([0, 0, 0]);
    const expected = ['a', 'b', 'c'].flatMap((tag) => Array.from({ length: 15 }, (_, i) => `${tag}${i}`)).sort();
    expect(readIds(guidancePath)).toEqual(expected);
  });

  test('a store that cannot be read is left alone, and the caller is told', () => {
    const guidancePath = newPath();
    mkdirSync(guidancePath);
    expect(dismissGuidance('one', { guidancePath })).toBe(false);
    expect(resetGuidance(undefined, { guidancePath })).toBe(false);
  });

  test('reset removes one id or all of them', () => {
    const guidancePath = newPath();
    expect(dismissGuidance('one', { guidancePath })).toBe(true);
    expect(dismissGuidance('two', { guidancePath })).toBe(true);
    expect(resetGuidance('one', { guidancePath })).toBe(true);
    expect(readIds(guidancePath)).toEqual(['two']);
    expect(resetGuidance(undefined, { guidancePath })).toBe(true);
    expect(readIds(guidancePath)).toEqual([]);
  });
});
