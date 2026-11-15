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
  // `/remote dispatch` and delegation start copies of this program as ACP
  // agents; only this entry knows how it was launched, so it says how.
  const { registerSelfAcpAgentCommand } = await import('@goodvibes-jev/engine/platform/platform/acp');
  const compiled = import.meta.path.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(import.meta.path);
  registerSelfAcpAgentCommand(compiled ? [process.execPath, 'acp'] : [process.execPath, 'run', import.meta.path, 'acp']);
  await import('./interactive.ts');
}
