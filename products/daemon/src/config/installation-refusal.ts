/**
 * Refusals raised while the daemon checks its own installation. The code rides
 * on the error, so the command failure lines and the native start-up line read
 * it directly; rewording a reason cannot drop the diagnostic.
 */
import { RefusalError, refusal } from '@goodvibes/engine/errors';

export type InstallationRefusalCode = 'INSTALLATION_NOT_OWNED' | 'INSTALLATION_UNSETTLED' | 'INSTALLATION_UNAVAILABLE';

export type NativeStartupRefusalCode =
  | 'SQLITE_ARCH_UNSUPPORTED' | 'SQLITE_ARCH_MISMATCH' | 'SQLITE_PARENT_TYPE' | 'SQLITE_FILE_MODE' | 'SQLITE_SIZE_BOUND'
  | 'SQLITE_READ_CHANGED' | 'SQLITE_LIFETIME_ASYNC' | 'SQLITE_RUNTIME_UNDECLARED' | 'SQLITE_COMPILED_OWNER'
  | 'SQLITE_BYTES_MISMATCH' | 'SQLITE_PROVENANCE_MISMATCH' | 'SQLITE_ADMISSION_CHANGED' | 'SQLITE_LOADER_REFUSED'
  | 'SQLITE_SOURCE_CHANGED' | 'DARWIN_SQLITE_OWNER' | 'DARWIN_TARGET' | 'DARWIN_SOURCE_CHANGED';

const REINSTALL = 'Reinstall the suite with the released installer; it keeps existing application data.';

const INSTALLATION_STATES: Record<InstallationRefusalCode, { readonly state: string; readonly next: string }> = {
  INSTALLATION_NOT_OWNED: {
    state: 'this binary is not the installed daemon',
    next: 'This binary is not the installed daemon. Run the command from the installed goodvibes-daemon, or reinstall the suite with the released installer.',
  },
  INSTALLATION_UNSETTLED: {
    state: 'an update of the installed daemon is unfinished',
    next: 'An update is unfinished. Wait for it to finish or rerun the installer, then retry.',
  },
  INSTALLATION_UNAVAILABLE: {
    state: 'the installed daemon could not be identified',
    next: 'The installed daemon could not be identified. Reinstall the suite with the released installer.',
  },
};

/** The installed daemon cannot act on its installation; `reason` is fixed text, never a path or value. */
export function installationRefused(code: InstallationRefusalCode, reason: string): RefusalError {
  const { state, next } = INSTALLATION_STATES[code];
  return new RefusalError(refusal({ code, state, reason, next: [next] }));
}

/** Native start-up could not verify its SQLite runtime or original installation; `reason` is fixed text. */
export function nativeStartupRefused(code: NativeStartupRefusalCode, reason: string): RefusalError {
  return new RefusalError(refusal({ code, state: 'the native daemon could not verify its installation', reason, next: [REINSTALL] }));
}
