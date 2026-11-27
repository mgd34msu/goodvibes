/**
 * The worktree setup settings of a project the daemon is asked to act on by name.
 *
 * The daemon reads its own folder's setup settings through its own settings manager. A call that names another
 * project (a terminal program's folder, the project a web page chose) reads THAT project's own settings layer: the
 * project settings file at the same place inside the project as the daemon's own project layer sits inside its folder,
 * admitted exactly as the daemon admits its own (`restrictProjectLayer`: the file is repository content). A worktree key
 * that file holds is the project's; a key it does not hold is the daemon's own setting.
 *
 * `worktree.setup.commands` runs commands, so the project file's commands are used only when the owner trusts the
 * folder (a trust kept for "nothing of its own to run" does not count: the file is something of its own, and both
 * terminal programs ask about a folder that has one, folder-trust.ts). In a folder not trusted, the daemon's own
 * setting is used and the answer says the project's commands were not used and why.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { restrictProjectLayer } from '../../config/project-layer-restrictions.js';
import { readDotPath } from '../../config/shared-config-tier.js';
import { deleteRawDotPath, writeRawDotPath } from '../../config/settings-io.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** The setting a project file may give only in a trusted folder: it runs commands. */
export const PROJECT_SETUP_COMMANDS_KEY = 'worktree.setup.commands';

/**
 * Where inside a project its own settings for the daemon are kept (the daemon's project layer:
 * `.goodvibes/daemon-host/settings.json`, products/daemon config/surface.ts GOODVIBES_DAEMON_SETTINGS_ROOT).
 */
export const PROJECT_DAEMON_SETTINGS_FILE = join('.goodvibes', 'daemon-host', 'settings.json');

/**
 * The project's settings file, relative to the project, when it gives worktree setup commands; null when it has none
 * (no file, unreadable, or no such key). The terminal programs' trust card counts such a file as the folder bringing
 * something of its own to run.
 */
export function projectSetupCommandsFile(project: string): string | null {
  const file = join(project, PROJECT_DAEMON_SETTINGS_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return readDotPath(parsed, PROJECT_SETUP_COMMANDS_KEY).present ? PROJECT_DAEMON_SETTINGS_FILE : null;
  } catch {
    return null;
  }
}

export interface ProjectWorktreeSettingsSource {
  /** The daemon's own folder. */
  readonly daemonFolder: string;
  /** The daemon's own project settings file (inside `daemonFolder`), when it reads one. */
  readonly daemonProjectFile: string | undefined;
  /** The daemon's own setting, for a key the project's layer does not hold. */
  readonly daemonSetting: (key: string) => unknown;
  /**
   * The owner's trust decision for a folder: 'trusted' only when they trusted it (not for having nothing of its own),
   * 'restricted' when they kept it restricted, 'undecided' otherwise.
   */
  readonly folderTrust: (folder: string) => 'trusted' | 'restricted' | 'undecided';
}

/** The settings a project's setup reads, and, when its own commands were set aside, why. */
export interface ProjectWorktreeSettings {
  /** Its own layer first, the daemon's own setting otherwise. */
  readonly get: (key: string) => unknown;
  /** Said with the setup's outcome when the project file gave commands that were not used; absent otherwise. */
  readonly commandsNotUsed?: string | undefined;
}

/** The project's settings file: where the daemon's own project layer sits, inside `project`. */
export function projectSettingsFileFor(project: string, source: Pick<ProjectWorktreeSettingsSource, 'daemonFolder' | 'daemonProjectFile'>): string | undefined {
  if (!source.daemonProjectFile) return undefined;
  const inside = relative(source.daemonFolder, source.daemonProjectFile);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  return join(project, inside);
}

/** The worktree settings for `project`, read at each call. */
export function projectWorktreeSettings(project: string, source: ProjectWorktreeSettingsSource): ProjectWorktreeSettings {
  const file = projectSettingsFileFor(project, source);
  let layer: Record<string, unknown> = {};
  let commandsNotUsed: string | undefined;
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const raw = parsed as Record<string, unknown>;
        // The commands are taken out before the file is admitted (a project file may not set them for the daemon's own
        // folder), and put back only for a folder the owner trusts.
        const commands = readDotPath(raw, PROJECT_SETUP_COMMANDS_KEY);
        if (commands.present) deleteRawDotPath(raw, PROJECT_SETUP_COMMANDS_KEY);
        layer = restrictProjectLayer(raw, {}, file).layer;
        if (commands.present) {
          const trust = source.folderTrust(project);
          if (trust === 'trusted') {
            writeRawDotPath(layer, PROJECT_SETUP_COMMANDS_KEY, commands.value);
          } else {
            const shown = relative(project, file) || file;
            commandsNotUsed = trust === 'restricted'
              ? `The project's own setup commands (in ${shown}) were not used: you keep ${project} restricted, so the daemon's own setup settings were used. "Trust this folder" in Permissions and safety, This folder, lets the project's commands run.`
              : `The project's own setup commands (in ${shown}) were not used: you have not trusted ${project}, so the daemon's own setup settings were used. Open the folder in goodvibes and choose "Trust this workspace", or "Trust this folder" in Permissions and safety, This folder, to let them run.`;
          }
        }
      }
    } catch (error) {
      // An unreadable project file is set aside by the daemon's own load for its folder; here it reads as holding nothing.
      logger.warn('worktree setup: the project settings file could not be read; the daemon settings apply', { file, error: summarizeError(error) });
    }
  }
  return {
    get: (key) => {
      const own = readDotPath(layer, key);
      return own.present ? own.value : source.daemonSetting(key);
    },
    ...(commandsNotUsed !== undefined ? { commandsNotUsed } : {}),
  };
}
