import { renderFilePickerOverlay as paint } from '@goodvibes-jev/engine/terminal-shell/render-file-picker-overlay';
import type { FilePickerModal } from '@goodvibes-jev/engine/terminal-shell/file-picker';
import { createEmptyLine } from '@goodvibes-jev/engine/platform/platform/types';
export * from '@goodvibes-jev/engine/terminal-shell/render-file-picker-overlay';
export const renderFilePickerOverlay = (picker: FilePickerModal, width: number, height = 24) => [createEmptyLine(width), ...paint(picker, width, height)];
