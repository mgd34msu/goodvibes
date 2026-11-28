#!/usr/bin/env bun
// First, before any other module loads: this process turns private (utils/private-from-start.ts).
import '@goodvibes/engine/platform/platform/utils/private-from-start';
import { writeSync } from 'node:fs';
import { NATIVE_STARTUP_REPAIR_MESSAGE } from './native-startup-repair.js';
import { nativeStartupFailureLine, type NativeStartupStage } from './native-startup-failure.js';
import { initializeOriginalDarwinDaemonInstallation } from '../config/original-darwin-installation.js';
import { initializeDaemonNativeSqlite } from './native-sqlite-runtime.js';
import { exemptLoopbackFromProxy } from '@goodvibes/engine/transport-http/paths';
import { keepProcessPrivate } from '@goodvibes/engine/platform/platform/utils/process-privacy';
import { hydrateServiceShellEnvironment } from './shell-env.js';

// Requests to this machine never go through a proxy, from the first one on.
exemptLoopbackFromProxy();
// No other process of the account (a model's command among them) reads this one's environment or memory.
keepProcessPrivate();

const args = process.argv.slice(2);
// When started by systemd/launchd, fill in missing env vars from the user's login shell in memory only.
hydrateServiceShellEnvironment(args);
if (args[0] === '--internal-launchd-handover') {
  // This already-loaded worker must survive replacement of its native cohort.
  // Import only IPC/launchctl code, before SQLite or installation admission.
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Launchd handover worker stopped.'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    const { runLaunchdHandoverWorker } = await import('@goodvibes/engine/platform/platform/daemon/launchd-handover');
    process.exitCode = process.platform === 'darwin'
      ? await runLaunchdHandoverWorker(args.slice(1), controller.signal) : 1;
  } catch { process.exitCode = 1; }
  finally { process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); }
} else if (args[0] === 'check-install-reader') {
  // A staged reader check must work before any database companions or services
  // are installed. It shares the command handler with the ordinary dispatcher.
  const { runInstallReaderCheck } = await import('./check-install-reader.js');
  process.exitCode = runInstallReaderCheck(args.slice(1));
} else if (args[0] === 'record-installed-programs') {
  // The installer, right after it placed the programs: their hashes recorded in the daemon's own home, where the daemon
  // reads them at its start (never the install folder's files, which every program of the account writes).
  try {
    const { recordInstalledProgramHashes } = await import('@goodvibes/engine/platform/platform/daemon/program-hashes');
    const { resolveGoodVibesDaemonHome } = await import('@goodvibes/engine/platform/platform/config/goodvibes-home');
    const { dirname } = await import('node:path');
    const { realpathSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const recorded = recordInstalledProgramHashes(dirname(realpathSync(process.execPath)), resolveGoodVibesDaemonHome(homedir()));
    writeSync(1, `recorded ${recorded.programs.size} programs and ${recorded.libraries.size} libraries\n`);
    process.exitCode = 0;
  } catch (error) {
    writeSync(2, `the product's programs could not be recorded in the daemon's home: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  let nativeStage: NativeStartupStage = 'sqlite';
  try {
    const sqlite = initializeDaemonNativeSqlite();
    nativeStage = 'darwin-original';
    initializeOriginalDarwinDaemonInstallation(sqlite);
  } catch (error) {
    writeSync(2, `${nativeStartupFailureLine(nativeStage, error)}\n`);
    throw new Error(NATIVE_STARTUP_REPAIR_MESSAGE);
  }
  // Service imports occur only after the compiled Darwin database owner is selected.
  const { runDaemonCli } = await import('./run.js');
  process.exitCode = await runDaemonCli(args, {
    createRuntime: async () => {
      const { createProductionDaemonRuntime } = await import('./production-runtime.js');
      return createProductionDaemonRuntime();
    },
    resolveServiceExecutable: async () => (await import('./service-executable.js')).resolveShippedServiceExecutable(),
    captureCrashes: true,
  });
}
