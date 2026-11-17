import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { allowTerminalWrite } from './terminal-write.js';

/**
 * copyToClipboard - Uses OSC 52 escape sequence to copy text to the terminal clipboard.
 * Terminal-specific: only works in terminals that support OSC 52. Returns whether the sequence
 * was written; the terminal gives no acknowledgement that it honoured it.
 */
export function copyToClipboard(text: string): boolean {
  if (!text) return false;
  logger.info('Clipboard: Attempting to copy via OSC 52', { length: text.length });
  try {
    const base64 = Buffer.from(text).toString('base64');
    const sequence = `\x1b]52;c;${base64}\x07`;
    allowTerminalWrite(() => process.stdout.write(sequence));
    logger.info('Clipboard: OSC 52 sequence written');
    return true;
  } catch (err: unknown) {
    logger.error('Clipboard: OSC 52 copy failed', { error: summarizeError(err) });
    return false;
  }
}

export { pasteFromClipboard, pasteImageFromClipboard } from '@goodvibes-jev/engine/platform/platform/utils';

export { missingClipboardReaderHint } from '@goodvibes-jev/engine/platform/platform/utils';
