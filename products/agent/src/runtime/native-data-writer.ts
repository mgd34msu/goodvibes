import { admitInstalledClientDataWriter } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from '../version.ts';

type InstalledClientDataOptions = Parameters<typeof admitInstalledClientDataWriter>[0];
type InstalledDataWriter = ReturnType<typeof admitInstalledClientDataWriter>;

export type InstalledDataWriterAdmission =
  | { readonly ok: true; readonly writer: InstalledDataWriter }
  | { readonly ok: false; readonly message: string };

/**
 * Admit the installed executable, and when it is refused say what to do about
 * it. The refusal is deliberate (a hard-linked, relocated or unreadable image
 * cannot be proven to be the installed one), but the underlying message names
 * no way forward. The refusal is returned, not thrown: this runs while the
 * entry point is still loading, before `--version`, `--help` and
 * `check-install-reader` are parsed, and those must still answer.
 */
export function admitInstalledDataWriterOrExplain(
  options: InstalledClientDataOptions,
  admit: typeof admitInstalledClientDataWriter = admitInstalledClientDataWriter,
): InstalledDataWriterAdmission {
  try {
    return { ok: true, writer: admit(options) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `This installation cannot be verified (${reason}). `
        + 'Run the program from the file the official installer placed, not from a hard link, a copy or a moved file; '
        + 'if it was installed another way, reinstall it with the official installer.',
    };
  }
}

/** Captured synchronously in the real executable's initial import graph, before
 * its first await, which is what lets the admission prove the loaded image. */
export const installedDataWriterAdmission = admitInstalledDataWriterOrExplain({ moduleUrl: import.meta.url, execPath: process.execPath, compiledVersion: COMPILED_VERSION, platform: process.platform });

/**
 * The admitted publisher; undefined for a source run. `main.ts` stops every
 * command that can reach this before it is read when the admission was refused.
 */
export const installedDataWriter: InstalledDataWriter = installedDataWriterAdmission.ok ? installedDataWriterAdmission.writer : undefined;
