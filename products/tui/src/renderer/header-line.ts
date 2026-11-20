import { createHeaderRenderer } from '@goodvibes/engine/terminal-shell/renderer/header-line';
import { VERSION } from '../version.ts';
export { HEADER_GAP_ROWS, withHeaderGap } from '@goodvibes/engine/terminal-shell/renderer/header-line';
export type { HeaderView } from '@goodvibes/engine/terminal-shell/renderer/header-line';
export const renderHeaderLine = createHeaderRenderer({ brand: 'GoodVibes', defaultVersion: VERSION });
