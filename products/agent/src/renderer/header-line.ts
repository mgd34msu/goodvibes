import { createHeaderRenderer, type HeaderView } from '@goodvibes-jev/engine/terminal-shell/renderer/header-line';
import { VERSION } from '../version.ts';
export { HEADER_GAP_ROWS, withHeaderGap } from '@goodvibes-jev/engine/terminal-shell/renderer/header-line';
export type { HeaderView };
const render = createHeaderRenderer({ brand: 'GoodVibes Agent', defaultVersion: VERSION, versionPrefix: 'v', truncateModel: true });
/** Agent headers name the session and model; delegated build posture stays in the TUI. */
export function renderHeaderLine(width: number, model: string, title?: string, version: string = VERSION, view?: HeaderView) {
  return render(width, model, title, undefined, version, undefined, view);
}
