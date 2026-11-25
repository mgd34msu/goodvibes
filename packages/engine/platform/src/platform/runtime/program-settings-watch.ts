/**
 * runtime/program-settings-watch.ts, each terminal program's own settings file
 * as the daemon follows it. A program changes its own settings inside its own
 * process too (its model picker, its theme picker, the model's settings tool),
 * writing its settings file without the daemon; the daemon watches both files
 * and announces a change of either as the `settings` list notice, the same one
 * `settings.set` sends, so every open settings screen (in either program, or a
 * client of the daemon) reads the values again. A file whose text did not
 * change (a write of the same values, a second event for one write) says
 * nothing.
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { noteListChanged } from './list-changes.js';
import type { TerminalProgram } from './program-host-settings.js';

const SETTINGS_FILE = 'settings.json';
const TERMINAL_PROGRAMS: readonly TerminalProgram[] = ['tui', 'agent'];

function textOf(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

/**
 * Follow `<goodvibesRoot>/<program>/settings.json` for both programs; returns the stop. A program folder that does
 * not exist yet is not followed (a program that never ran has no settings of its own to change).
 */
export function watchProgramSettingsFiles(goodvibesRoot: string): () => void {
  const watchers: FSWatcher[] = [];
  for (const program of TERMINAL_PROGRAMS) {
    const folder = join(goodvibesRoot, program);
    const path = join(folder, SETTINGS_FILE);
    let last = textOf(path);
    const changed = (owner: TerminalProgram): void => {
      const now = textOf(path);
      if (now === last) return;
      last = now;
      noteListChanged({ list: 'settings', change: 'changed', id: owner });
    };
    try {
      // The folder, not the file: a settings write replaces the file (written beside it, then renamed over it).
      const watcher = watch(folder, { persistent: false }, (_event, name) => {
        if (name === null || name.toString() === SETTINGS_FILE) changed(program);
      });
      watcher.on('error', () => { watcher.close(); });
      watchers.push(watcher);
    } catch { /* No folder yet: nothing of this program's own to follow. */ }
  }
  return () => { for (const watcher of watchers) watcher.close(); };
}
