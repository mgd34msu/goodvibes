#!/usr/bin/env bun
import { installedDataWriterAdmission } from './runtime/native-data-writer.ts';
import { installedReaderCommand } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from './version.ts';
import { metadataCliResult } from './cli/metadata.ts';

// Installation reader checks, help, version and completion never load the
// UI/config/provider runtime: they are answered from the parser alone, and the
// interactive and management graph loads only after them.
const readerDescription = installedReaderCommand(process.argv.slice(2), COMPILED_VERSION);
const metadata = readerDescription === undefined ? metadataCliResult(process.argv.slice(2)) : null;
if (readerDescription !== undefined) {
  process.stdout.write(readerDescription + '\n');
} else if (metadata) {
  if (metadata.stdout !== undefined) process.stdout.write(`${metadata.stdout}\n`);
  if (metadata.stderr !== undefined) process.stderr.write(`${metadata.stderr}\n`);
  process.exitCode = metadata.exitCode;
} else if (!installedDataWriterAdmission.ok) {
  // Reader checks, help and version answered above; nothing else runs from an image that could not be admitted.
  process.stderr.write(`${installedDataWriterAdmission.message}\n`);
  process.exitCode = 1;
} else if (process.argv[2] === 'acp') {
  // An ACP agent server owns stdout for protocol frames, so it never reaches
  // the interactive entry's config, gitignore and migration side effects.
  const { runAcpCommand } = await import('./cli/acp-command.ts');
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  const code = await runAcpCommand({
    args: process.argv.slice(3),
    env: process.env,
    cwd: process.cwd(),
    stdout: (line) => { process.stdout.write(`${line}\n`); },
    stderr: (line) => { process.stderr.write(`${line}\n`); },
    signal: stop.signal,
  });
  process.exit(code);
} else {
  // `/remote dispatch` and delegation start copies of this program as ACP
  // agents; only this entry knows how it was launched, so it says how.
  const { registerSelfAcpAgentCommand } = await import('@goodvibes-jev/engine/platform/platform/acp');
  const compiled = import.meta.path.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(import.meta.path);
  registerSelfAcpAgentCommand(compiled ? [process.execPath, 'acp'] : [process.execPath, 'run', import.meta.path, 'acp']);
  await import('./interactive.ts');
}
