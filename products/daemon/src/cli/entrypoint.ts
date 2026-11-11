#!/usr/bin/env bun
import { writeSync } from 'node:fs';
import { nativeStartupFailureLine, type NativeStartupStage } from './native-startup-failure.js';
import { initializeOriginalDarwinDaemonInstallation } from '../config/original-darwin-installation.js';
import { initializeDaemonNativeSqlite } from './native-sqlite-runtime.js';

const args = process.argv.slice(2);
if (args[0] === 'check-install-reader') {
  // A staged reader check must work before any database companions or services
  // are installed. It shares the command handler with the ordinary dispatcher.
  const { runInstallReaderCheck } = await import('./check-install-reader.js');
  process.exitCode = runInstallReaderCheck(args.slice(1));
} else {
  let nativeStage: NativeStartupStage = 'sqlite';
  try {
    const sqlite = initializeDaemonNativeSqlite();
    nativeStage = 'darwin-original';
    initializeOriginalDarwinDaemonInstallation(sqlite);
  } catch (error) {
    writeSync(2, `${nativeStartupFailureLine(nativeStage, error)}\n`);
    throw new Error('Native daemon startup could not verify its installation. Repair using the released suite installer: curl -fsSL https://goodvibes.sh/install.sh | sh . The installer preserves existing application data.');
  }
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
