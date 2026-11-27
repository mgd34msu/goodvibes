#!/usr/bin/env bun
// First, before any other module loads: this process turns private (utils/private-from-start.ts).
import '@goodvibes/engine/platform/platform/utils/private-from-start';
import { installedDataWriterAdmission } from './runtime/native-data-writer.ts';
import { installedReaderCommand } from '@goodvibes/engine/platform/platform/runtime/self-update';
import { COMPILED_VERSION } from './version.ts';
import { metadataCliResult } from './cli/metadata.ts';
import { writeExitingStdoutLine, writeFatalLine } from './utils/fatal-boot-write.ts';
import { exemptLoopbackFromProxy } from '@goodvibes/engine/transport-http/paths';
import { keepProcessPrivate } from '@goodvibes/engine/platform/platform/utils/process-privacy';

// Requests to this machine never go through a proxy, from the first one on.
exemptLoopbackFromProxy();
// No other process of the account (a model's command among them) reads this one's environment or memory.
keepProcessPrivate();

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
// Commands (`status`, `run`, management) are answered by the CLI entry, which
// loads only the chosen command's modules and exits; the terminal UI's module
// graph loads only when no command took the launch.
const [{ prepareShellCliRuntime }, { resolveGoodVibesHome }] = await Promise.all([
  import('./cli/entrypoint.ts'),
  import('@goodvibes/engine/platform/platform/config'),
]);
let prepared: Awaited<ReturnType<typeof prepareShellCliRuntime>>;
try {
  prepared = await prepareShellCliRuntime(
    process.argv.slice(2),
    {
      defaultWorkingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
      // GOODVIBES_AGENT_HOME moves the Agent alone; otherwise the Agent's tree
      // is where the daemon's and the terminal app's is (GOODVIBES_HOME, else
      // the login home), so they share one secrets.key and one daemon home.
      homeDirectory: process.env['GOODVIBES_AGENT_HOME']?.trim() || resolveGoodVibesHome(),
    },
    'goodvibes-agent',
  );
} catch (error) {
  const [{ reportFatalStartupError }, { envFlag, logger }] = await Promise.all([
    import('./cli/tui-startup.ts'),
    import('@goodvibes/engine/platform/platform/utils'),
  ]);
  reportFatalStartupError(
    error,
    { binary: 'goodvibes-agent', debug: envFlag(process.env['GOODVIBES_AGENT_DEBUG']) },
    { logError: (message, context) => logger.error(message, context), writeStderr: writeFatalLine, exit: (code) => process.exit(code) },
  );
  process.exit(1);
}
const { runInteractive } = await import('./interactive.ts');
await runInteractive(prepared);
