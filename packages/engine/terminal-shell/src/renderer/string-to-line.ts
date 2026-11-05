import { requireDefined } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createEmptyLine, type Line, type Cell } from '@goodvibes-jev/engine/sdk/platform/types';
import { getDisplayWidth } from '@goodvibes-jev/engine/sdk/platform/utils';

export function stringToLine(text: string, width: number, style: Partial<Cell> = {}): Line {
    const line = createEmptyLine(width);
    let currentColumn = 0;
    for (const char of text) {
      if (currentColumn >= width) break;
      const code = char.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) continue;
      const charWidth = getDisplayWidth(char);
      line[currentColumn] = {
        char,
        fg: style.fg || '',
        bg: style.bg || '',
        bold: style.bold || false,
        dim: style.dim || false,
        underline: style.underline || false,
        italic: style.italic || false,
        strikethrough: style.strikethrough || false
      };
      if (charWidth === 2 && currentColumn + 1 < width) {
        line[currentColumn + 1] = { ...requireDefined(line[currentColumn]), char: '' };
      }
      currentColumn += charWidth;
    }
    return line;
  }
