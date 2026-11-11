import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Select a prior default name only; this grants no service mutation authority.
 * Historical product LaunchAgents keep their name when no canonical installer
 * slot exists. New or ambiguous installations use the installer label.
 */
export function resolveDaemonServiceDefault(homeDirectory: string, platform: string = process.platform): string {
  if (platform !== 'darwin') return 'goodvibes';
  const canonical = 'sh.goodvibes.daemon', directory = join(homeDirectory, 'Library', 'LaunchAgents');
  try {
    // lstat sees every occupied canonical slot, including a dangling alias.
    if (lstatSync(join(directory, canonical + '.plist'), { throwIfNoEntry: false })) return canonical;
    const previous = lstatSync(join(directory, 'goodvibes.plist'), { throwIfNoEntry: false });
    return previous?.isFile() && !previous.isSymbolicLink() ? 'goodvibes' : canonical;
  } catch { return canonical; }
}
