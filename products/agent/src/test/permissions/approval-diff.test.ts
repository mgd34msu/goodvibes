/**
 * A write or edit put to the owner shows the change itself, so "allow" is never given blind.
 */
import { describe, expect, test } from 'bun:test';
import { PermissionPromptUI, type PermissionRequest } from '../../permissions/prompt.ts';

function request(tool: string, args: Record<string, unknown>): PermissionRequest {
  return {
    callId: 'call-1',
    tool,
    args,
    category: 'write',
    analysis: {
      classification: 'write',
      riskLevel: 'medium',
      summary: 'Change a file',
      reasons: [],
      target: 'config/app.json',
      targetKind: 'path',
    },
    workingDirectory: '/repo',
    resolve: () => {},
  };
}

function rendered(width: number, height: number, req: PermissionRequest): string {
  return PermissionPromptUI.createPromptLayer(width, height, req).lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
}

describe('approval card for a file change', () => {
  test('an edit shows the text it replaces and the text it writes', () => {
    const text = rendered(100, 40, request('edit', { edits: [{ path: 'config/app.json', find: '"port": 8080', replace: '"port": 9090' }] }));
    expect(text).toContain('"port": 8080');
    expect(text).toContain('"port": 9090');
  });

  test('a write shows the new content, and a line wider than the card continues on the next row', () => {
    const tail = 'END-OF-THE-LONG-LINE';
    const content = `first line\n${'x'.repeat(150)}${tail}`;
    const text = rendered(100, 40, request('write', { files: [{ path: 'notes.txt', content }] }));
    expect(text).toContain('first line');
    expect(text).toContain(tail);
  });

  test('a change longer than the screen keeps its start and says how much is not shown', () => {
    const content = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n');
    const text = rendered(100, 30, request('write', { files: [{ path: 'big.txt', content }] }));
    expect(text).toContain('row 1');
    expect(text).toMatch(/not shown/);
    expect(text).not.toContain('row 200');
  });
});
