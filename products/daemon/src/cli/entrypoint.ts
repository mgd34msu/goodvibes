#!/usr/bin/env bun
import { initializeDaemonNativeSqlite } from './native-sqlite-runtime.js';

const args = process.argv.slice(2);
if (args[0] === 'check-install-reader') {
  // A staged reader check must work before any database companions or services
  // are installed. It shares the command handler with the ordinary dispatcher.
  const { runInstallReaderCheck } = await import('./check-install-reader.js');
  process.exitCode = runInstallReaderCheck(args.slice(1));
} else {
  initializeDaemonNativeSqlite();
  // Service imports occur only after the compiled Darwin database owner is selected.
  const { runDaemonCli } = await import('./run.js');
  const { resolveShippedServiceExecutable } = await import('./service-executable.js');
  process.exitCode = await runDaemonCli(args, {
    createRuntime: async () => {
      const { createProductionDaemonRuntime } = await import('./production-runtime.js');
      return createProductionDaemonRuntime();
    },
    resolveServiceExecutable: resolveShippedServiceExecutable,
  });
}
