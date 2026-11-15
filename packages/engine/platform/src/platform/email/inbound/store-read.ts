/**
 * Reading an inbound store for a WRITE.
 *
 * `PersistentStore.loadOrDiscard` reports an unreadable file as corruption
 * whatever the cause, which is right for a read and wrong for a read-modify-
 * write: the writer would then replace a file that holds good data because one
 * `readFile` failed (EIO, EMFILE, a busy file). Content that does not parse
 * parses the same way on the next try; an I/O failure does not. So a
 * corruption verdict is only believed when the bytes can be read back and still
 * do not parse, and otherwise the write is refused with the file untouched.
 */

import { promises as fs } from 'node:fs';
import type { PersistentStore, PersistentStoreRead } from '../../state/persistent-store.js';
import { summarizeError } from '../../utils/error-display.js';

export async function loadStoreForWrite<T extends Record<string, unknown>>(store: PersistentStore<T>): Promise<PersistentStoreRead<T>> {
  const first = await store.loadOrDiscard();
  if (first.corruption === null) return first;
  const { filePath } = first.corruption;
  try {
    await fs.readFile(filePath);
  } catch (error) {
    throw new Error(
      `${filePath} could not be read (${summarizeError(error)}), so it was left as it is and the change was `
      + 'not made. Nothing was discarded; the change can be retried once the file is readable.',
    );
  }
  // Readable now: either the first failure was transient, in which case this
  // read is the real answer, or the content genuinely does not parse and this
  // read says so again.
  return store.loadOrDiscard();
}
