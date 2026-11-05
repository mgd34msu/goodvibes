import { renderBookmarkModal as paint } from '@goodvibes-jev/engine/terminal-shell/render-bookmark-modal';
import type { BookmarkModal } from '@goodvibes-jev/engine/terminal-shell/bookmark-modal';
export * from '@goodvibes-jev/engine/terminal-shell/render-bookmark-modal';
export const renderBookmarkModal = (modal: BookmarkModal, width: number, height = 24) => paint(modal, width, height, false);
