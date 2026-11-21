/** Staged release inspection: no settings, database bootstrap or service graph. */
import { writeSync } from 'node:fs';
import { installedReaderCommand, InstallReaderUsageError, NativeDataCompatibilityError } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from '../version.js';

/** The daemon's `check-install-reader` command: the engine's check, with the daemon's output and exit codes. */
export function runInstallReaderCheck(args: readonly string[], output: {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
} = {}): number {
  const stdout = output.stdout ?? ((line: string) => { writeSync(1, `${line}\n`); });
  const stderr = output.stderr ?? ((line: string) => { writeSync(2, `${line}\n`); });
  try {
    const result = installedReaderCommand(['check-install-reader', ...args], COMPILED_VERSION);
    if (result !== undefined) stdout(result);
    return 0;
  } catch (error) {
    if (error instanceof InstallReaderUsageError) { stderr('Usage: goodvibes-daemon check-install-reader <installed-executable> | --describe'); return 2; }
    stderr(error instanceof NativeDataCompatibilityError ? error.message : 'Installed data-reader requirements could not be confirmed.');
    return 2;
  }
}
