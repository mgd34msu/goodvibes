// Proves: A daemon takes the folder it was started in, or a folder its flag or environment names, as a project of its own, writing project files and a project identity there.
// Red when: The daemon's working folder is again the start folder or a folder saved in its settings, or a daemon given --working-dir or GOODVIBES_WORKING_DIR starts in that folder instead of refusing with the sentence that it has no working folder.
/**
 * The daemon serves every project at once and makes a project's files, code index, checkpoints and identity only for a
 * project a call or a turn names. Everything the daemon's graph builds for "its own folder" is built for the working
 * folder its command line resolves (`cli/configuration.ts`), so that folder must be the daemon's own, in its home, the
 * start folder must be left exactly as it was, and a folder named for it by flag or environment is refused.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonCliConfiguration, DAEMON_HAS_NO_WORKING_FOLDER } from '../../cli/configuration.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

test('the daemon works in its own folder in its home whatever folder it is started in or told, and leaves the start folder untouched', () => {
  const root = makeOwnedTempDir('daemon-start-folder');
  const home = join(root, 'home');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  const start = join(root, 'start');
  const named = join(root, 'named');
  for (const folder of [home, daemonHome, start, named]) mkdirSync(folder, { recursive: true });
  const env = { GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemonHome, HOME: home } as NodeJS.ProcessEnv;
  const own = join(daemonHome, 'own-folder');
  const workingFolder = (flags: { workingDir?: string }, extra: NodeJS.ProcessEnv = {}): string => {
    try { return createDaemonCliConfiguration(flags, { ...env, ...extra }, start).workingDirectory; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  const rows = [
    `started there: ${workingFolder({})}`,
    `--working-dir: ${workingFolder({ workingDir: named })}`,
    `environment: ${workingFolder({}, { GOODVIBES_WORKING_DIR: named })}`,
  ];
  // A folder saved in the daemon's settings (as a 3.5.0 daemon kept it, or as a caller's config.set would leave it):
  // no caller moves the daemon, so the next start is in its own folder still.
  writeFileSync(join(daemonHome, 'settings.json'), JSON.stringify({ runtime: { workingDir: named } }));
  rows.push(`saved setting: ${workingFolder({})}`);
  expect(rows).toEqual([
    `started there: ${own}`,
    `--working-dir: ${DAEMON_HAS_NO_WORKING_FOLDER}`,
    `environment: ${DAEMON_HAS_NO_WORKING_FOLDER}`,
    `saved setting: ${own}`,
  ]);
  expect([readdirSync(start), readdirSync(named)]).toEqual([[], []]);
});
