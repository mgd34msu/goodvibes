#!/usr/bin/env bun
import { installedDataWriterAdmission } from './runtime/native-data-writer.ts';
import { installedReaderCommand } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from './version.ts';
import { metadataCliResult } from './cli/metadata.ts';
import { exemptLoopbackFromProxy } from '@goodvibes/engine/transport-http/paths';

// Requests to this machine never go through a proxy, from the first one on.
exemptLoopbackFromProxy();

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
  // Commands (`status`, `run`, management) are answered by the CLI entry, which
  // loads only the chosen command's modules and exits; the terminal UI's module
  // graph loads only when no command took the launch.
  const [{ prepareShellCliRuntime }, { resolveGoodVibesHome }] = await Promise.all([
    import('./cli/entrypoint.ts'),
    import('@goodvibes/engine/platform/platform/config'),
  ]);
  let prepared: Awaited<ReturnType<typeof prepareShellCliRuntime>> | undefined;
  try {
    // Both roots come from the one resolver the daemon CLI also uses. This
    // called homedir() unconditionally once, so a harness that redirected the
    // tree got a client that wrote the real one, secret store included.
    prepared = await prepareShellCliRuntime(
      process.argv.slice(2),
      {
        defaultWorkingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
        homeDirectory: resolveGoodVibesHome(),
      },
      'goodvibes',
    );
  } catch (error) {
    const { reportFatalStartupError } = await import('./cli/tui-startup.ts');
    reportFatalStartupError(error);
  }
  if (prepared !== undefined) {
    const { runInteractive } = await import('./interactive.ts');
    await runInteractive(prepared);
  }
}
