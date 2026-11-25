import { renderStatusLine as paint, type StatusLineOptions } from '@goodvibes/engine/terminal-shell/status-line';
import { tagFooterRegion } from './footer-targets.ts';
export * from '@goodvibes/engine/terminal-shell/status-line';

/** The keys that open the menu of every place as bound ("ctrl+g m"); undefined when unbound. */
let menuKey: string | undefined = 'ctrl+g m';

/** Set from the keybindings each frame, so a rebound key shows as bound. */
export function setStatusMenuKey(key: string | undefined): void {
  menuKey = key;
}

/** The Agent's status line ends with how to open the menu of every place (`ctrl+g m menu`); a click on it opens the menu. */
export const renderStatusLine = (options: StatusLineOptions) => paint({
  ...options,
  tagRegion: tagFooterRegion,
  menu: options.menu ?? (menuKey ? { hints: [[menuKey, 'menu']], target: 'places' } : null),
});
