import { mkdirSync } from 'node:fs';
import type { CliCommandOutput, CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import {
  buildCliServicePosture,
  createPlatformServiceManager,
  formatCliServicePosture,
  getServiceStateRoot,
  probeServiceReadiness,
  type CliServicePosture,
} from './service-posture.ts';

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

/**
 * The service verbs act on the service as the settings describe it and change
 * no setting. A setting that disagrees with the platform gets one line here
 * unless the posture below already reports it as an issue.
 */
function settingNotes(posture: CliServicePosture): string[] {
  const notes: string[] = [];
  const reported = new Set(posture.findings.map((finding) => finding.id));
  if (!posture.config.enabled && !reported.has('service-disabled-for-server-surfaces')) {
    notes.push('Note: service.enabled is off, so status and doctor do not check this service. Turn it on with /config set service.enabled true.');
  }
  if (!posture.config.autostart && posture.managed.installed && posture.managed.autostart) {
    notes.push('Note: service.autostart is off, but the platform has the installed service set to start at login.');
  }
  return notes;
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
    const manager = createPlatformServiceManager(runtime);
    const starting = sub === 'start' || sub === 'restart';
    if (sub === 'install' || starting) mkdirSync(getServiceStateRoot(runtime), { recursive: true });
    const result =
      sub === 'install' ? manager.install()
        : sub === 'start' ? manager.start()
          : sub === 'restart' ? manager.restart()
            : sub === 'stop' ? manager.stop()
              : manager.uninstall();
    if (sub === 'uninstall' && !result.actionError) {
      runtime.configManager.setDynamic('service.enabled', false);
      runtime.configManager.setDynamic('service.autostart', false);
    }
    // The platform accepting the command is not the daemon running: a daemon
    // that cannot bind or exits at boot is reported as a failure, not "ok".
    const notReady = starting && !result.actionError
      ? await waitUntilServiceAnswers(runtime, manager, sub)
      : undefined;
    const failure = result.actionError ?? notReady;
    const posture = await buildCliServicePosture(runtime, { probe: starting });
    const notes = sub === 'install' || starting ? settingNotes(posture) : [];
    const text = [
      `Service ${sub}: ${failure ? 'failed' : 'ok'}`,
      ...(notReady ? [`  ${notReady}. Run goodvibes service check for the details.`] : []),
      ...notes,
      formatCliServicePosture(posture, false),
      ...(result.actionError ? [`actionError: ${result.actionError}`] : []),
    ].join('\n');
    return {
      output: json
        ? JSON.stringify({ action: sub, ok: failure === undefined, ...(notReady ? { notReady } : {}), notes, result, posture }, null, 2)
        : text,
      exitCode: failure ? 1 : 0,
    };
  }
  return {
    output: 'Usage: goodvibes service [status|check|install|start|stop|restart|uninstall]',
    exitCode: 2,
  };
}
