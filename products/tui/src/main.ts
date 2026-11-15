#!/usr/bin/env bun
import './runtime/native-data-writer.ts';
import { installedReaderCommand } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from './version.ts';

// Installation reader checks never load the UI/config/provider runtime.
const readerDescription = installedReaderCommand(process.argv.slice(2), COMPILED_VERSION);
if (readerDescription !== undefined) {
  process.stdout.write(readerDescription + '\n');
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
  await import('./interactive.ts');
}
