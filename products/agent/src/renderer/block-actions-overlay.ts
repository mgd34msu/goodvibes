import { renderBlockActionsMenu as render } from '@goodvibes-jev/engine/terminal-shell/block-actions-overlay';
export * from '@goodvibes-jev/engine/terminal-shell/block-actions-overlay';
export const renderBlockActionsMenu = (...args: Parameters<typeof render>) => render(args[0], args[1], args[2], false);
