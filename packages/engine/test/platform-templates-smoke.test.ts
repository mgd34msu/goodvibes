import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { TemplateManager, parseTemplateArgs } from '../platform/src/platform/templates/manager.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('platform/templates: template management behavior', () => {
  test('parseTemplateArgs parses named args', () => {
    const result = parseTemplateArgs(['name=foo', 'value=bar']);
    expect(result).toEqual({ name: 'foo', value: 'bar' });
  });

  test('parseTemplateArgs parses positional args', () => {
    const result = parseTemplateArgs(['hello', 'world']);
    expect(result['1']).toBe('hello');
    expect(result['2']).toBe('world');
  });

  test('a saved template is listed, loaded and expanded with its arguments', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-templates-'));
    roots.push(root);
    const mgr = new TemplateManager({ projectRoot: root, homeDirectory: root });
    expect(mgr.list()).toEqual([]);

    const stored = mgr.save('My Plan', 'Review {{1}} for {{topic}}');
    expect(stored).toBe('my-plan');
    expect(mgr.list().map((entry) => [entry.name, entry.scope, entry.preview])).toEqual([
      ['my-plan', 'project', 'Review {{1}} for {{topic}}'],
    ]);
    const loaded = mgr.load('my-plan');
    expect(loaded).toBe('Review {{1}} for {{topic}}');
    expect(mgr.expand(loaded!, parseTemplateArgs(['the diff', 'topic=security']))).toBe('Review the diff for security');
  });
});
