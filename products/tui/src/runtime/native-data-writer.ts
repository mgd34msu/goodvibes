import { admitInstalledClientDataWriter } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from '../version.ts';

type InstalledClientDataOptions = Parameters<typeof admitInstalledClientDataWriter>[0];

/**
 * Admit the installed executable, and when it is refused say what to do about
 * it. The refusal is deliberate (a hard-linked, relocated or unreadable image
 * cannot be proven to be the installed one), but the underlying message names
 * no way forward, and this runs during import so an unexplained throw is all a
 * person would see.
 */
export function admitInstalledDataWriterOrExplain(
  options: InstalledClientDataOptions,
  admit: typeof admitInstalledClientDataWriter = admitInstalledClientDataWriter,
): ReturnType<typeof admitInstalledClientDataWriter> {
  try {
    return admit(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This installation cannot be verified (${reason}). `
      + 'Run the program from the file the official installer placed, not from a hard link, a copy or a moved file; '
      + 'if it was installed another way, reinstall it with the official installer.',
      { cause: error },
    );
  }
}

/** Captured synchronously in the real executable's initial import graph, before
 * its first await. Source imports return no installation publisher. */
export const installedDataWriter = admitInstalledDataWriterOrExplain({ moduleUrl: import.meta.url, execPath: process.execPath, compiledVersion: COMPILED_VERSION, platform: process.platform });
