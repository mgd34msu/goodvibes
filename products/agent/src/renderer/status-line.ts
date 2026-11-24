import { renderStatusLine as paint, type StatusLineOptions } from '@goodvibes/engine/terminal-shell/status-line';
import { tagFooterRegion } from './footer-targets.ts';
export * from '@goodvibes/engine/terminal-shell/status-line';

/** The key that opens the Agent workspace as bound ("ctrl+g"); undefined when it is unbound. */
let workspaceKey: string | undefined = 'ctrl+g';

/** Set from the keybindings each frame, so a rebound key shows as bound. */
export function setStatusWorkspaceKey(key: string | undefined): void {
  workspaceKey = key;
}

/** The Agent's status line ends with how to open its workspace (`ctrl+g workspace`), the screen most of its work starts from. */
export const renderStatusLine = (options: StatusLineOptions) => paint({
  ...options,
  tagRegion: tagFooterRegion,
  menu: options.menu ?? (workspaceKey ? { hints: [[workspaceKey, 'workspace']], target: 'workspace' } : null),
});
