import { spawnSync } from 'node:child_process';
import type { CliCommandOutput, CliCommandRuntime } from '@goodvibes/engine/terminal-shell';
import { formatCliServicePosture, probeServiceReadiness } from '@goodvibes/engine/platform/platform/support/service-manager-posture';
import { buildCliServicePosture, createPlatformServiceManager, resolveGoodVibesDaemonExecutable } from './service-posture.ts';

/**
 * How long `start` and `restart` wait for the daemon to run and answer on its
 * enabled endpoints. The wait ends as soon as it does; each check is the
 * platform's status query plus one TCP connect per listening endpoint.
 */
const READY_WAIT_MS = 10_000;
const READY_POLL_MS = 250;

type ServiceManager = ReturnType<typeof createPlatformServiceManager>;

/** Undefined when the service is running and answering; otherwise what is wrong. */
async function waitUntilServiceAnswers(runtime: CliCommandRuntime, manager: ServiceManager, verb: string): Promise<string | undefined> {
  const deadline = Date.now() + READY_WAIT_MS;
  for (;;) {
    const readiness = await probeServiceReadiness(runtime, manager);
    if (readiness.running && readiness.unreachable.length === 0) return undefined;
    if (Date.now() >= deadline) {
      const seconds = READY_WAIT_MS / 1000;
      if (!readiness.running) return `the managed service is not running ${seconds} seconds after ${verb}; its log says why`;
      const endpoint = readiness.unreachable[0]!;
      return `the ${endpoint.label} is not answering on ${endpoint.binding.host}:${endpoint.binding.port} after ${seconds} seconds`;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

/** The `goodvibes-daemon` command each `goodvibes service` verb runs. */
const DAEMON_SERVICE_VERBS = {
  install: 'install-service',
  start: 'start-service',
  restart: 'restart-service',
  stop: 'stop-service',
  uninstall: 'uninstall-service',
} as const;

/**
 * `goodvibes service install|start|restart|stop|uninstall` run the daemon's own
 * service command (`goodvibes-daemon install-service`, ...), in this shell's
 * environment and directory: one code path, so the two commands write the same
 * definition, refuse the same foreign one, start, record the choice in
 * `service.enabled` and exit with the same codes. This command adds only a
 * readiness check of the endpoints after a start and the service summary.
 */
function runDaemonServiceVerb(verb: keyof typeof DAEMON_SERVICE_VERBS): { exitCode: number; lines: string[] } {
  const daemon = resolveGoodVibesDaemonExecutable().command;
  const result = spawnSync(daemon, [DAEMON_SERVICE_VERBS[verb]], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  if (result.error) {
    return { exitCode: 1, lines: [`Service ${verb} failed: ${daemon} could not be run (${result.error.message}). Set GOODVIBES_DAEMON_COMMAND to the goodvibes-daemon program, or put it on PATH.`] };
  }
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter((line) => line.length > 0);
  return { exitCode: result.status ?? 1, lines };
}

export async function handleServiceCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'status'] = runtime.cli.commandArgs;
  const json = runtime.cli.flags.outputFormat === 'json';
  if (sub === 'status' || sub === 'check') {
    const posture = await buildCliServicePosture(runtime, { probe: sub === 'check' });
    return {
      output: formatCliServicePosture(posture, json),
      exitCode: sub === 'check' && posture.issues.length > 0 ? 1 : 0,
    };
  }
  if (sub === 'install' || sub === 'start' || sub === 'restart' || sub === 'stop' || sub === 'uninstall') {
    const ran = runDaemonServiceVerb(sub);
    const starting = sub === 'install' || sub === 'start' || sub === 'restart';
    // The platform accepting the command is not the daemon answering: a daemon
    // that cannot bind or exits at boot is named here. A non-zero code from the
    // daemon command is passed through; a start it accepted but that never ran
    // or answered exits 1.
    const notReady = starting && ran.exitCode === 0
      ? await waitUntilServiceAnswers(runtime, createPlatformServiceManager(runtime), sub)
      : undefined;
    const exitCode = ran.exitCode !== 0 ? ran.exitCode : notReady ? 1 : 0;
    const posture = await buildCliServicePosture(runtime, { probe: starting });
    const text = [
      ...ran.lines,
      ...(notReady ? [`  ${notReady}. Run goodvibes service check for the details.`] : []),
      '',
      formatCliServicePosture(posture, false),
    ].join('\n');
    return {
      output: json
        ? JSON.stringify({ action: sub, ok: exitCode === 0, exitCode, lines: ran.lines, ...(notReady ? { notReady } : {}), posture }, null, 2)
        : text,
      exitCode,
    };
  }
  return {
    output: 'Usage: goodvibes service [status|check|install|start|stop|restart|uninstall]',
    exitCode: 2,
  };
}
