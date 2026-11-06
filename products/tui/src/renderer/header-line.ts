import { createHeaderRenderer } from '@goodvibes-jev/engine/terminal-shell/renderer/header-line';
import { VERSION } from '../version.ts';
export { HEADER_GAP_ROWS, withHeaderGap } from '@goodvibes-jev/engine/terminal-shell/renderer/header-line';
export type { HeaderView } from '@goodvibes-jev/engine/terminal-shell/renderer/header-line';
export const renderHeaderLine = createHeaderRenderer({ brand: 'GoodVibes', defaultVersion: VERSION });
