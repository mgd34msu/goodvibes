import { describe, expect, test } from 'bun:test';
import type { Line } from '../platform/src/platform/types/index.ts';
import { CONFIG_SCHEMA } from '../platform/src/platform/config/schema.ts';
import { renderMarkdown, renderMarkdownTracked } from '../terminal-shell/src/renderer/markdown.ts';
import { renderInlineMarkdown } from '../terminal-shell/src/renderer/markdown-inline.ts';
import { processMaxScroll, renderProcessView, type ProcessRow } from '../terminal-shell/src/renderer/process-view.ts';
import { renderHistorySearchOverlay } from '../terminal-shell/src/renderer/history-search-overlay.ts';
import { HistorySearch } from '../terminal-shell/src/input-history.ts';
import { formRows, maskEnvText, maskLaunchArgs } from '../terminal-shell/src/renderer/mcp-form-rows.ts';
import { filterGroups } from '../terminal-shell/src/renderer/help-groups.ts';
import { SHARED_SETTING_ENUM_DESCRIPTIONS } from '../terminal-shell/src/renderer/settings-metadata.ts';

const text = (line: Line): string => line.map((c) => c.char).join('');

describe('markdown fences', () => {
  test('a fenced example nested in a longer fence stays inside the outer block', () => {
    const source = ['````markdown', '```js', 'code', '```', '````', 'after'].join('\n');
    const { codeBlocks, lines } = renderMarkdownTracked(source, 80);
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]!.rawContent).toBe(['```js', 'code', '```'].join('\n'));
    expect(lines.some((l) => text(l).includes('after'))).toBe(true);
  });

  test('a closing fence may be longer than the opener but not carry an info string', () => {
    const { codeBlocks } = renderMarkdownTracked(['```', 'a', '```js', 'b', '`````'].join('\n'), 80);
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]!.rawContent).toBe(['a', '```js', 'b'].join('\n'));
  });

  test('tabs in a code block survive into the copied content', () => {
    const { codeBlocks } = renderMarkdownTracked('```\n\tindented\n```', 80);
    expect(codeBlocks[0]!.rawContent).toBe('\tindented');
  });
});

describe('markdown prose', () => {
  test('intra-word underscores and spaced asterisks are plain text', () => {
    const snake = renderInlineMarkdown('call my_var_name now');
    expect(snake.some((t) => t.type === 'text' && t.style?.italic)).toBe(false);
    expect(snake.map((t) => (t.type === 'text' ? t.text : '')).join('')).toBe('call my_var_name now');
    const tokens = renderInlineMarkdown('2 * 3 * 4');
    expect(tokens.some((t) => t.type === 'text' && t.style?.italic)).toBe(false);
    expect(tokens.map((t) => (t.type === 'text' ? t.text : '')).join('')).toBe('2 * 3 * 4');
  });

  test('real emphasis still italicises', () => {
    const tokens = renderInlineMarkdown('an _emphasised_ and *starred* word');
    const italic = tokens.filter((t) => t.type === 'text' && t.style?.italic).map((t) => (t.type === 'text' ? t.text : ''));
    expect(italic).toEqual(['emphasised', 'starred']);
  });

  test('a tab-indented list item nests and a tab inside prose keeps its gap', () => {
    const top = text(renderMarkdown('- x', 40)[0]!);
    const nested = text(renderMarkdown('\t- x', 40)[0]!);
    expect(nested.indexOf('•')).toBeGreaterThan(top.indexOf('•'));
    expect(text(renderMarkdown('a\tb', 40)[0]!)).toContain('a  b');
  });
});

describe('process view', () => {
  const height = 10;
  const rowsFor = (n: number): ProcessRow[] => Array.from({ length: n }, (_, i) => ({ source: i, text: `line-${i}`, error: false }));
  const drawn = (lines: Line[]): string => lines.map(text).join('\n');

  test('with dropped lines, following still shows the newest row', () => {
    const rows = rowsFor(height - 3);
    const out = renderProcessView({ width: 60, height, rows, scrollFromBottom: 0, color: '#fff', dropped: 4 });
    expect(drawn(out)).toContain(`line-${height - 4}`);
  });

  test('the dropped-lines notice is reachable by scrolling to the top', () => {
    const rows = rowsFor(30);
    const max = processMaxScroll(rows.length, height, 4);
    const out = renderProcessView({ width: 60, height, rows, scrollFromBottom: max, color: '#fff', dropped: 4 });
    expect(drawn(out)).toContain('4 earlier lines are no longer kept');
    expect(drawn(out)).toContain('line-0');
    expect(out.length).toBeLessThanOrEqual(height);
  });
});

describe('history search overlay', () => {
  test('the highlight lands on the matched columns after wide characters', () => {
    const search = new HistorySearch(() => ['中文abc']);
    search.open('');
    search.search('abc');
    const [line] = renderHistorySearchOverlay(search, 80);
    const marked = line!.filter((c) => c.underline && c.char !== ' ').map((c) => c.char).join('');
    expect(marked).toBe('abc');
    const first = line!.findIndex((c) => c.underline && c.char !== ' ');
    expect(line!.slice(first - 4, first).map((c) => c.char).join('').replaceAll(' ', '')).toBe('中文');
  });
});

describe('MCP workspace display', () => {
  const field = (id: string, value: string) => ({ id, label: id, value, help: '', editable: true }) as never;

  test('literal env values are hidden unless the field is being edited; references stay readable', () => {
    expect(maskEnvText('TOKEN=abc, HOME=${HOME}, KEY=goodvibes://secrets/x, EMPTY=')).toBe('TOKEN=••••, HOME=${HOME}, KEY=goodvibes://secrets/x, EMPTY=');
    const fields = [field('name', 'srv'), field('env', 'TOKEN=abc')];
    const rows = formRows({ formIndex: 0, formFields: fields });
    expect(rows[1]!.desc).toBe('TOKEN=••••');
    expect(formRows({ formIndex: 1, formFields: fields })[1]!.desc).toBe('TOKEN=abc▏');
  });

  test('values of secret-looking launch flags are hidden', () => {
    expect(maskLaunchArgs(['-y', 'pkg', '--api-key', 'abc', '--token=xyz', '--port', '80'])).toEqual(['-y', 'pkg', '--api-key', '••••', '--token=••••', '--port', '80']);
  });
});

describe('help group filtering', () => {
  const groups = [{ title: 'Keys', entries: [{ label: 'Save', right: 'ctrl+s' }] }, { title: 'Empty', entries: [] }];
  test('an empty query drops empty groups and a title match keeps every entry', () => {
    expect(filterGroups(groups, '').map((g) => g.title)).toEqual(['Keys']);
    expect(filterGroups(groups, 'keys')[0]!.entries).toHaveLength(1);
    expect(filterGroups(groups, 'ctrl+s')).toHaveLength(1);
    expect(filterGroups(groups, 'nothing')).toEqual([]);
  });
});

describe('shared enum descriptions', () => {
  test('every described value is a value the config registry accepts for that key', () => {
    for (const [key, described] of Object.entries(SHARED_SETTING_ENUM_DESCRIPTIONS)) {
      const setting = CONFIG_SCHEMA.find((s) => s.key === key);
      expect(setting?.enumValues).toBeDefined();
      for (const value of Object.keys(described)) expect(setting!.enumValues as readonly string[]).toContain(value);
    }
  });
});

describe('launch args are masked wherever they are listed', () => {
  test('a quoted secret value is masked whole in the form row', () => {
    const fields = [{ id: 'args', label: 'Args', value: "--token 'a b' --port 80", editable: true }] as never;
    expect(formRows({ formIndex: 5, formFields: fields })[0]!.desc).toBe('--token •••• --port 80');
  });
});
