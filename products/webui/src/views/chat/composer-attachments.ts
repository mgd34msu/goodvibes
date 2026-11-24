/**
 * Composer attachment helpers.
 * Handles drag-and-drop and paste-image (clipboard) for the Composer.
 * Pure utilities, no React dependencies; the file limit both the composer and the native request form keep.
 */

import { MAX_ATTACHMENTS_PER_MESSAGE } from '@goodvibes/engine/platform/platform/companion/attachment-limits';

/** The files one message or request may carry: the daemon's own limit. */
export const MAX_ATTACHED_FILES = MAX_ATTACHMENTS_PER_MESSAGE;

/** Said when more files are added than fit, in the chat composer and the native request form alike. */
export const TOO_MANY_FILES = `A request takes at most ${MAX_ATTACHMENTS_PER_MESSAGE} files. Remove one to add another.`;

/** The files that still fit beside `held` already attached, and whether any were left out. */
export function filesThatFit<T>(held: number, added: readonly T[]): { taken: T[]; refused: boolean } {
  const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - held);
  return { taken: added.slice(0, room), refused: added.length > room };
}

/** Returns true if the drag event carries files. */
export function dragHasFiles(event: DragEvent): boolean {
  if (!event.dataTransfer) return false;
  return Array.from(event.dataTransfer.types).includes('Files');
}

/** Extracts File[] from a drop DragEvent. */
export function filesFromDrop(event: DragEvent): File[] {
  if (!event.dataTransfer) return [];
  return Array.from(event.dataTransfer.files);
}

/**
 * Extracts image File[] from a clipboard paste event. A clipboard that also
 * carries plain text (spreadsheet cells, a word-processor selection, both put a
 * picture of the selection beside its text) is a text paste: nothing is
 * attached and the default paste puts the text in the draft.
 */
export function imageFilesFromPaste(event: ClipboardEvent): File[] {
  if (!event.clipboardData) return [];
  const items = Array.from(event.clipboardData.items);
  if (items.some((item) => item.kind === 'string' && item.type === 'text/plain')) return [];
  return items
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** Returns an object URL for preview. Caller must revoke when done. */
export function previewUrl(file: File): string {
  return URL.createObjectURL(file);
}

/** True if the file is an image based on MIME type. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}
