/** Reconstructible code-cache revisions describe the actual physical read.
 * They are neither content digests nor permission/admission credentials. */
import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { captureExistingDirectory } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { assertCapturedToolReadAccess } from '../tools/shared/captured-input-tools.js';
import { addFindWarning, type FindDiagnostics } from '../tools/find/shared.js';
import { summarizeError } from '../utils/error-display.js';

export interface CodeFileObservation {
  readonly content: string;
  readonly revision: string;
  readonly size: number;
  readonly mtimeMs: number;
  assertCurrent(): void;
}

/** Directory modes/owners/incarnations matter; sibling creation does not retire
 * an otherwise original source. The directory owner pins every lookup alias. */
function directoryIdentity(path: string): readonly string[] {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Code source ancestor is not a physical directory');
  return [path, stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].map(String);
}

export function captureCodeFileObservation(root: string, path: string, maxBytes = Infinity): CodeFileObservation {
  const rootOwner = captureExistingDirectory(root), parent = captureExistingDirectory(dirname(path));
  const selected = join(parent.canonical, basename(path)), rel = relative(rootOwner.canonical, selected);
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Code source is outside its original root');
  rootOwner.assertCurrent(); parent.assertCurrent();
  const directories: Array<readonly string[]> = [];
  for (let directory = parent.canonical;; directory = dirname(directory)) {
    directories.push(directoryIdentity(directory));
    if (dirname(directory) === directory) break;
  }
  const observation = readFileObservation(selected, { maxBytes });
  const physical = observation.physical;
  const assertCurrent = () => {
    rootOwner.assertCurrent(); parent.assertCurrent();
    if (fileObservationIdentity(selected) !== physical) throw new Error('Code source changed after reading');
  };
  assertCurrent();
  const content = new TextDecoder('utf-8').decode(observation.bytes);
  const revision = JSON.stringify(['code-file-observation-v1', rootOwner.canonical, selected, directories, physical]);
  return Object.freeze({ content, revision, size: observation.bytes.length, mtimeMs: observation.mtimeMs, assertCurrent });
}

/** Preserve the indexer's original captured-read admission and diagnostics;
 * the resulting text and revision both come from the same nofollow FD read. */
export async function readCodeIndexFile(root: string, path: string, diagnostics: FindDiagnostics, maxBytes: number): Promise<CodeFileObservation | null> {
  try {
    await assertCapturedToolReadAccess(path);
    return captureCodeFileObservation(root, path, maxBytes);
  } catch (error) {
    addFindWarning(diagnostics, `Skipped unreadable file '${path}': ${summarizeError(error)}`);
    return null;
  }
}
