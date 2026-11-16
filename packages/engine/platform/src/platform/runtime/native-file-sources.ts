/** Original file/absence custody only, safe before any database selection. */
import type { UpdateFileIo } from './update-file-io.js';
type FileIdentity = NonNullable<ReturnType<NonNullable<UpdateFileIo['observe']>>>;
export function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left === null || right === null ? left === right
    : left.identity === right.identity && left.ownerIdentity === right.ownerIdentity && left.mode === right.mode;
}
export function captureIdentity(observe: NonNullable<UpdateFileIo['observe']>, path: string): FileIdentity | null {
  const stat = observe(path);
  return stat === null ? null : { identity: stat.identity, ownerIdentity: stat.ownerIdentity, mode: stat.mode };
}
/**
 * Retain the physical identity (file, owner and every parent directory) of
 * each path, or its absence, and return a check that fails when any of them
 * moved. One rule for every caller: the identity is the file system's own
 * revision of the file, so nothing is read or hashed, whichever I/O adapter is
 * passed. The failure names the file and says that retrying is the fix.
 */
export function retainNativeUpdateSources(paths: readonly string[], io: UpdateFileIo): () => void {
  const observe = io.observe;
  if (!observe) throw new Error('Native update I/O must observe file identities');
  const retained = paths.map(path => ({ path, identity: captureIdentity(observe, path) }));
  return () => {
    for (const file of retained) {
      if (!sameIdentity(captureIdentity(observe, file.path), file.identity)) {
        throw new Error(`${file.path} changed while the update was being prepared, so nothing was replaced. Retry the update.`);
      }
    }
  };
}
