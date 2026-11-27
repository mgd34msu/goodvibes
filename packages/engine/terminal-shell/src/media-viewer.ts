/**
 * media-viewer.ts, what a terminal program does itself after a person's own
 * press of "Make an image or a video" (`media.make`): the daemon makes the
 * file and saves it in the project; the program that asked opens it in the
 * desktop's viewer, as `/media make` did before the daemon made it. A model's
 * call opens nothing, and an outside caller's call never reaches a program.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { externalUrlLaunchers } from '@goodvibes/engine/platform/platform/utils';
import { programSideOf } from './command-actions/capability-actions.js';

/** Ask the desktop's viewer to open a file; false where there is no desktop to show it on. */
export function openInViewer(path: string): Promise<boolean> {
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

/** The first file the daemon saved, from its answer (`data.artifacts[].path`). */
function firstSaved(data: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const artifacts = Array.isArray(data?.['artifacts']) ? data['artifacts'] as unknown[] : [];
  for (const artifact of artifacts) {
    const path = artifact !== null && typeof artifact === 'object' ? (artifact as Record<string, unknown>)['path'] : undefined;
    if (typeof path === 'string' && path) return path;
  }
  return undefined;
}

programSideOf('media.make', {
  async after(_values, ctx, answer) {
    // Only the person's own press opens it: the model's call made a file for the conversation, not for their screen.
    if (ctx.invokedByModel === true) return;
    const path = firstSaved(answer.data);
    // Saved on the daemon's machine and not this one (a daemon elsewhere): there is nothing here to open.
    if (!path || !existsSync(path)) return;
    return await openInViewer(path)
      ? 'Opened in the system viewer.'
      : 'No viewer is available here; open the file from the path above.';
  },
});
