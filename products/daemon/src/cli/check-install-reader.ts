/** Staged release inspection: no settings, database bootstrap or service graph. */
import { writeSync } from 'node:fs';
import { assertNativeReaderCompatible, NativeDataCompatibilityError, realUpdateFileIo } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { VERSION } from '../version.js';

export function runInstallReaderCheck(args: readonly string[], output: {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
} = {}): number {
  const stdout = output.stdout ?? ((line: string) => { writeSync(1, `${line}\n`); });
  const stderr = output.stderr ?? ((line: string) => { writeSync(2, `${line}\n`); });
  const installedExecutable = args[0];
  if (args.length !== 1 || installedExecutable === undefined || installedExecutable.startsWith('-')) {
    stderr('Usage: goodvibes-daemon check-install-reader <installed-executable>'); return 2;
  }
  try { assertNativeReaderCompatible(installedExecutable, VERSION, realUpdateFileIo); }
  catch (error) { stderr(error instanceof NativeDataCompatibilityError ? error.message : 'Installed data-reader requirements could not be confirmed.'); return 2; }
  stdout(JSON.stringify({ schema: 'goodvibes.install.reader-check', schemaVersion: 1, readerVersion: VERSION }));
  return 0;
}
