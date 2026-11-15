/** One read of a source file for the code index: its text, and a revision that
 * is the SHA-256 of the bytes read. The revision says "same text", which is the
 * only fact the index needs to skip a file it already embedded; a permission,
 * owner, link or mount change re-embeds nothing. Which file the bytes came from
 * is fenced in memory for the life of the read only, never stored. */
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { captureExistingDirectory } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { assertCapturedToolReadAccess } from '../tools/shared/captured-input-tools.js';
import { addFindWarning, type FindDiagnostics } from '../tools/find/shared.js';
import { summarizeError } from '../utils/error-display.js';

/** The observed source (or its parent directory) is no longer the one that was read. */
export class CodeSourceChangedError extends Error {
  override readonly name = 'CodeSourceChangedError';
}

export interface CodeFileObservation {
  readonly content: string;
  /** SHA-256 (hex) of the bytes read. */
  readonly revision: string;
  readonly size: number;
  readonly mtimeMs: number;
  assertCurrent(): void;
}

/** The code index's revision for a file's bytes: 64 hex characters, one hash pass over bytes already in memory. */
export function codeContentRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function captureCodeFileObservation(root: string, path: string, maxBytes = Infinity): CodeFileObservation {
  const rootOwner = captureExistingDirectory(root), parent = captureExistingDirectory(dirname(path));
  const selected = join(parent.canonical, basename(path)), rel = relative(rootOwner.canonical, selected);
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Code source is outside its original root');
  rootOwner.assertCurrent(); parent.assertCurrent();
  const observation = readFileObservation(selected, { maxBytes, allowLinks: true });
  const physical = observation.physical;
  const assertCurrent = () => {
    try {
      rootOwner.assertCurrent(); parent.assertCurrent();
      if (fileObservationIdentity(selected, { allowLinks: true }) !== physical) throw new Error('Code source changed after reading');
    } catch (error) {
      // Callers tell "the file moved under us" apart from their own failures by this type.
      if (error instanceof CodeSourceChangedError) throw error;
      throw new CodeSourceChangedError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  };
  assertCurrent();
  const content = new TextDecoder('utf-8').decode(observation.bytes);
  const revision = codeContentRevision(observation.bytes);
  return Object.freeze({ content, revision, size: observation.bytes.length, mtimeMs: observation.mtimeMs, assertCurrent });
}

/** The indexer's read: captured-read admission, then the text and its revision
 * from the same no-follow descriptor read. */
export async function readCodeIndexFile(root: string, path: string, diagnostics: FindDiagnostics, maxBytes: number): Promise<CodeFileObservation | null> {
  try {
    await assertCapturedToolReadAccess(path);
    return captureCodeFileObservation(root, path, maxBytes);
  } catch (error) {
    addFindWarning(diagnostics, `Skipped unreadable file '${path}': ${summarizeError(error)}`);
    return null;
  }
}
