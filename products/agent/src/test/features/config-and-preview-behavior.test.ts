import { describe, it, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

// ---------------------------------------------------------------------------
// Tool preview tests
// ---------------------------------------------------------------------------

describe('tool preview truncation', () => {
  it('UIFactory.createToolPreviewRow draws the tool preview as one row (the spinner lives on the status line)', () => {
    const width = 80;
    const toolPreview = 'read_file({"path":"/home/user/test.ts"})';
    const row = UIFactory.createToolPreviewRow(width, toolPreview);
    expect(row).toHaveLength(width);
    const text = row.map((c) => c.char).join('');
    expect(text).toContain('read_file');
  });

  it('a preview of double-width glyphs is cut to the terminal width, not to the cell count', () => {
    const width = 40;
    const wideTool = 'ツール(' + '漢'.repeat(100) + ')';
    const previewLine = UIFactory.createToolPreviewRow(width, wideTool);
    expect(previewLine).toHaveLength(width);
    const text = previewLine.map((c) => c.char).join('');
    // Two columns per glyph: counting cells instead of columns would overflow.
    expect(getDisplayWidth(text.trimEnd())).toBeLessThanOrEqual(width);
    expect(text).toContain('ツール');
  });
});
