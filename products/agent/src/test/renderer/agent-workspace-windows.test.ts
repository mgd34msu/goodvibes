import { describe, expect, test } from 'bun:test';
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import { buildEditorRows } from '../../renderer/agent-workspace-editor-rows.ts';
import {
  clampResultScroll,
  maxResultScroll,
  reserveForResult,
  settleResultScroll,
  windowResultRows,
  type ResultRow,
} from '../../renderer/agent-workspace-result-rows.ts';
import { ClientBuildGuard } from '../../runtime/client-build-compatibility.ts';

function editorWith(value: string, selected: boolean): AgentWorkspaceLocalEditor {
  const field = (id: string, text: string) => ({ id, label: id, value: text, required: false, multiline: true, hint: 'hint' });
  return {
    kind: 'note',
    mode: 'create',
    title: 'New note',
    message: 'Editing',
    fields: [field('body', value), field('other', 'x')],
    selectedFieldIndex: selected ? 0 : 1,
  } as unknown as AgentWorkspaceLocalEditor;
}

const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
const texts = (rows: readonly { text: string }[]) => rows.map((row) => row.text);

describe('buildEditorRows multiline windows', () => {
  test('the field being edited shows its last lines, with a marker for the earlier ones', () => {
    const rows = texts(buildEditorRows(editorWith(tenLines, true), 80, 40));
    expect(rows.some((text) => text.includes('line 10'))).toBe(true);
    expect(rows.some((text) => text.includes('line 7'))).toBe(true);
    expect(rows.some((text) => text.includes('line 6'))).toBe(false);
    expect(rows.some((text) => text.includes('6 earlier line(s)'))).toBe(true);
  });

  test('a field that is not being edited shows its first lines, with a count of the rest', () => {
    const rows = texts(buildEditorRows(editorWith(tenLines, false), 80, 40));
    expect(rows.some((text) => text.includes('line 1'))).toBe(true);
    expect(rows.some((text) => text.includes('line 10'))).toBe(false);
    expect(rows.some((text) => text.includes('6 more line(s)'))).toBe(true);
  });

  test('a short value is shown whole with no marker', () => {
    const rows = texts(buildEditorRows(editorWith('a\nb', true), 80, 40));
    expect(rows.some((text) => text.includes('earlier line') || text.includes('more line'))).toBe(false);
  });
});

describe('result window arithmetic', () => {
  const palette = { text: 't', good: 'g', muted: 'm', dim: 'd' };
  const marks = { palette, moreAbove: '^', moreBelow: 'v' };
  const rowsOf = (count: number): ResultRow[] => Array.from({ length: count }, (_, i) => ({ text: `row ${i + 1}` }));

  test('at the largest scroll offset the last row is on screen, for every size', () => {
    for (let total = 2; total <= 40; total += 1) {
      for (let reserved = 1; reserved < total; reserved += 1) {
        const rows = rowsOf(total);
        const window = windowResultRows(rows, reserved, maxResultScroll(total, reserved), marks);
        expect(window.some((row) => row.text === `row ${total}`)).toBe(true);
        expect(window.length).toBeLessThanOrEqual(Math.max(reserved, 2));
      }
    }
  });

  test('every row is reachable by scrolling one offset at a time', () => {
    const total = 23;
    const reserved = 7;
    const seen = new Set<string>();
    for (let offset = 0; offset <= maxResultScroll(total, reserved); offset += 1) {
      for (const row of windowResultRows(rowsOf(total), reserved, offset, marks)) if (row.kind !== 'more') seen.add(row.text);
    }
    expect(seen.size).toBe(total);
  });

  test('offsets are clamped and a changed result restarts at the top', () => {
    expect(clampResultScroll(999, 20, 5)).toBe(maxResultScroll(20, 5));
    expect(clampResultScroll(-3, 20, 5)).toBe(0);
    const first = { title: 'a', detail: 'a' } as unknown as AgentWorkspaceActionResult;
    const second = { title: 'b', detail: 'b' } as unknown as AgentWorkspaceActionResult;
    const workspace = { resultScroll: 4, resultScrollFor: first as AgentWorkspaceActionResult | null };
    expect(settleResultScroll(workspace, first, 20, 5)).toBe(4);
    expect(settleResultScroll(workspace, second, 20, 5)).toBe(0);
    expect(workspace.resultScrollFor).toBe(second);
  });

  test('the action list keeps room and the result always gets at least one row', () => {
    expect(reserveForResult(0, 10)).toBe(0);
    expect(reserveForResult(50, 3)).toBeGreaterThanOrEqual(1);
    expect(reserveForResult(50, 20)).toBeLessThan(20);
  });
});

describe('ClientBuildGuard latch', () => {
  test('restart-required stays latched when a later probe reads no floor, and announces once', () => {
    const announced: string[] = [];
    const guard = new ClientBuildGuard({ clientVersion: '1.0.0', onRestartRequired: (verdict) => { announced.push(verdict.status); } });
    expect(guard.maySharedSessionWork()).toBe(true);
    guard.observeFloor('9.9.9');
    expect(guard.maySharedSessionWork()).toBe(false);
    guard.observeFloor(undefined);
    guard.observeFloor('9.9.9');
    expect(guard.maySharedSessionWork()).toBe(false);
    expect(announced).toEqual(['restart-required']);
  });
});
