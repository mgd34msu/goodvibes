/** Bounded readonly reference ownership using the existing strict SQLite lock
 * wire format. The synchronous guarded claim never recursively creates a parent
 * after an asynchronous queue wait. General asynchronous lock users are separate.
 */
import { assertCrossProcessLockCurrent, tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
export async function acquireArtifactReferenceLock(path: string, assertParent: () => void): Promise<{ assertCurrent(): void; release(): void } | null> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    assertParent(); const release = tryAcquireCrossProcessLock(`${path}.knowledge-lock`, { assertCurrent: assertParent });
    if (release) return Object.freeze({ assertCurrent: () => { assertParent(); assertCrossProcessLockCurrent(release); }, release });
    if (Date.now() >= deadline) return null;
    await new Promise<void>(resolveWait => { const timer = setTimeout(resolveWait, 25); timer.unref?.(); });
  }
}
