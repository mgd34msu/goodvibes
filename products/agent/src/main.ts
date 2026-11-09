#!/usr/bin/env bun
import './runtime/native-data-writer.ts';
import { installedReaderCommand } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { COMPILED_VERSION } from './version.ts';
import { metadataCliResult } from './cli/metadata.ts';
import { writeExitingStdoutLine, writeFatalLine } from './utils/fatal-boot-write.ts';

// Informational CLI commands need no runtime, profile, provider, or terminal.
// Load the interactive and management graph only after parsing those commands.
const readerDescription = installedReaderCommand(process.argv.slice(2), COMPILED_VERSION);
if (readerDescription !== undefined) { writeExitingStdoutLine(readerDescription); process.exit(0); }
const result = metadataCliResult(process.argv.slice(2));
if (result) {
  if (result.stdout) writeExitingStdoutLine(result.stdout);
  if (result.stderr) writeFatalLine(result.stderr);
  process.exit(result.exitCode);
}
await import('./interactive.ts');
