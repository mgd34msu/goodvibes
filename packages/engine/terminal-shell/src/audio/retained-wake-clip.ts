import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeWavPcm16,
  resolveManagedWakePaths,
  retainedClipFileName,
  type CapturedUtterance,
} from '@goodvibes-jev/engine/platform/platform/voice';
export function retainWakeClip(
  deps: {
    readonly managedRoot: string;
    readonly sessionId: string;
    readonly now?: (() => number) | undefined;
    readonly warn: (
      message: string,
      metadata: {
        readonly error: string;
      },
    ) => void;
  },
  utterance: CapturedUtterance,
): void {
  const retainedDir = resolveManagedWakePaths(deps.managedRoot).retainedDir;
  try {
    mkdirSync(retainedDir, { recursive: true, mode: 0o700 });
    // The platform owns the filename, and it is load-bearing rather than cosmetic: the
    // recovery sweeper reads the owning session id from the first `--`-delimited
    // segment, so a name invented here would get a live session's clips reaped as
    // orphans (or leave them unreaped forever).
    const target = join(retainedDir, retainedClipFileName(deps.sessionId, (deps.now ?? Date.now)()));
    // A voice recording is private to the owner on a shared host.
    writeFileSync(target, encodeWavPcm16(utterance.samples, utterance.sampleRate), { mode: 0o600 });
  } catch (error) {
    deps.warn('retaining the wake clip failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
