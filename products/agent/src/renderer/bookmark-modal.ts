import { renderBookmarkModal as paint } from '@goodvibes/engine/terminal-shell/render-bookmark-modal';
import type { BookmarkModal } from '@goodvibes/engine/terminal-shell/bookmark-modal';
export * from '@goodvibes/engine/terminal-shell/render-bookmark-modal';
export const renderBookmarkModal = (modal: BookmarkModal, width: number, height = 24) => paint(modal, width, height, false);
