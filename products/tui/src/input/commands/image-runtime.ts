import { spawn } from 'node:child_process';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { externalUrlLaunchers } from '@goodvibes-jev/engine/platform/platform/utils';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { createMediaCommand } from '@goodvibes-jev/engine/terminal-shell/media-command';

/** Ask the system viewer to open a file; false where there is no desktop to show it on. */
function openInViewer(path: string): Promise<boolean> {
  if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY'] && !process.env['WSL_DISTRO_NAME']) {
    return Promise.resolve(false);
  }
  const [launcher] = externalUrlLaunchers(path, process.platform, Boolean(process.env['WSL_DISTRO_NAME']));
  if (!launcher) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(launcher.command, [...launcher.args], { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

/**
 * `/media`: one description shared with the Agent (terminal-shell/media-command.ts).
 * What a provider makes is saved as a file and opened in the system viewer
 * where there is a desktop. `/image <file>` (local-runtime.ts) is the other
 * direction: it attaches a local image to the next message.
 */
export function registerImageRuntimeCommands(
  registry: CommandRegistry,
  options: { readonly openFile?: (path: string) => Promise<boolean> } = {},
): void {
  registry.register(createMediaCommand<CommandContext>({
    product: 'goodvibes',
    registry: (ctx) => ctx.platform.mediaProviders,
    artifactStore: (ctx) => ctx.platform.artifactStore,
    paths: requireShellPaths,
    openFile: options.openFile ?? openInViewer,
  }));
}
