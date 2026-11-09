/** Original file/absence custody only, safe before any database selection. */
import { hasNativeUpdateObservations, type UpdateFileIo } from './update-file-io.js';
type FileIdentity = NonNullable<ReturnType<NonNullable<UpdateFileIo['observe']>>>;
export function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left === null || right === null ? left === right
    : left.identity === right.identity && left.ownerIdentity === right.ownerIdentity && left.mode === right.mode;
}
export function captureIdentity(observe: NonNullable<UpdateFileIo['observe']>, path: string): FileIdentity | null {
  const stat = observe(path);
  return stat === null ? null : { identity: stat.identity, ownerIdentity: stat.ownerIdentity, mode: stat.mode };
}
export function retainNativeUpdateSources(paths: readonly string[], io: UpdateFileIo): () => void {
  const readFile = io.readFile, observe = io.observe;
  if (!readFile || !observe) throw new Error('Native daemon I/O requires retained file observations and reads');
  const native = hasNativeUpdateObservations(io, readFile, observe);
  const snapshot = (path: string) => {
    const stat = captureIdentity(observe, path);
    if (stat === null) return null;
    const bytes = native ? undefined : Buffer.from(readFile(path));
    if (!native && !sameIdentity(stat, observe(path))) throw new Error('Native daemon installation changed during preparation');
    return { stat, bytes };
  };
  const retained = paths.map(path => ({ path, identity: snapshot(path) }));
  return () => { for (const file of retained) {
    const current = snapshot(file.path), original = file.identity;
    if (current === null || original === null ? current !== original
      : !sameIdentity(current.stat, original.stat) || (original.bytes !== undefined && !current.bytes?.equals(original.bytes))) {
      throw new Error('Native daemon installation changed during preparation');
    }
  } };
}
