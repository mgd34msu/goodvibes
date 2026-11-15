import { mkdirSync } from 'node:fs';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import { enableServicePosture } from './management-utils.ts';
import { buildCliServicePosture, createPlatformServiceManager, formatCliServicePosture, getServiceStateRoot } from './service-posture.ts';
import type { CliCommandOutput } from '@goodvibes-jev/engine/terminal-shell';

const POSTURE_KEYS = ['service.enabled', 'service.autostart', 'service.restartOnFailure'] as const;

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
    const enabling = sub === 'install' || sub === 'start' || sub === 'restart';
    // The manager refuses while service.enabled is off, so the flags go on first and are put back if the action fails.
    const previous = POSTURE_KEYS.map((key) => [key, runtime.configManager.get(key)] as const);
    if (enabling) enableServicePosture(runtime.configManager);
    const restorePosture = () => {
      for (const [key, value] of previous) runtime.configManager.setDynamic(key, value);
    };
    let result: ReturnType<typeof manager.install>;
    try {
      if (enabling) mkdirSync(getServiceStateRoot(runtime), { recursive: true });
      result =
        sub === 'install' ? manager.install()
          : sub === 'start' ? manager.start()
            : sub === 'restart' ? manager.restart()
              : sub === 'stop' ? manager.stop()
                : manager.uninstall();
    } catch (error) {
      if (enabling) restorePosture();
      throw error;
    }
    if (enabling && result.actionError) restorePosture();
    if (sub === 'uninstall' && !result.actionError) {
      runtime.configManager.setDynamic('service.enabled', false);
      runtime.configManager.setDynamic('service.autostart', false);
    }
    const posture = await buildCliServicePosture(runtime);
    const text = [
      `Service ${sub}: ${result.actionError ? 'failed' : 'ok'}`,
      formatCliServicePosture(posture, false),
      ...(result.actionError ? [`actionError: ${result.actionError}`] : []),
    ].join('\n');
    return {
      output: json ? JSON.stringify({ action: sub, result, posture }, null, 2) : text,
      exitCode: result.actionError ? 1 : 0,
    };
  }
  return {
    output: 'Usage: goodvibes service [status|check|install|start|stop|restart|uninstall]',
    exitCode: 2,
  };
}
