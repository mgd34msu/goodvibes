/**
 * Composer attachment helpers.
 * Handles drag-and-drop and paste-image (clipboard) for the Composer.
 * Pure utilities, no React dependencies.
 */

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
