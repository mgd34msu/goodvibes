#!/usr/bin/env bun
import { installedDataWriterAdmission } from './runtime/native-data-writer.ts';
import { installedReaderCommand } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from './version.ts';
import { metadataCliResult } from './cli/metadata.ts';
import { writeExitingStdoutLine, writeFatalLine } from './utils/fatal-boot-write.ts';

// Informational CLI commands need no runtime, profile, provider, or terminal,
// and they answer even when the installed image could not be admitted: that
// is when a person runs them to find out what is wrong. The interactive and
// management graph loads only after them.
let readerDescription: string | undefined;
try {
  readerDescription = installedReaderCommand(process.argv.slice(2), COMPILED_VERSION);
} catch (error) {
  writeFatalLine(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (readerDescription !== undefined) { writeExitingStdoutLine(readerDescription); process.exit(0); }
const result = metadataCliResult(process.argv.slice(2));
if (result) {
  if (result.stdout) writeExitingStdoutLine(result.stdout);
  if (result.stderr) writeFatalLine(result.stderr);
  process.exit(result.exitCode);
}
if (!installedDataWriterAdmission.ok) {
  writeFatalLine(installedDataWriterAdmission.message);
  process.exit(1);
}
await import('./interactive.ts');
