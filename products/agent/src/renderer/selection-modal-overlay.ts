import { renderSelectionModalOverlay as paint } from '@goodvibes/engine/terminal-shell/render-selection-modal-overlay';
import type { SelectionModal } from '@goodvibes/engine/terminal-shell/selection-modal';
export * from '@goodvibes/engine/terminal-shell/render-selection-modal-overlay';
export const renderSelectionModalOverlay = (modal: SelectionModal, width: number, height = 24) => paint(modal, width, height, false);
