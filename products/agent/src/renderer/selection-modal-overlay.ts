import { renderSelectionModalOverlay as paint } from '@goodvibes-jev/engine/terminal-shell/render-selection-modal-overlay';
import type { SelectionModal } from '@goodvibes-jev/engine/terminal-shell/selection-modal';
export * from '@goodvibes-jev/engine/terminal-shell/render-selection-modal-overlay';
export const renderSelectionModalOverlay = (modal: SelectionModal, width: number, height = 24) => paint(modal, width, height, false);
