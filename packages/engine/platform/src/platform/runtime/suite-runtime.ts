import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The directory holding the suite's own `bun` and `node`, set by a checkout
 * installation's command wrappers. PATH is left as the user's, so a command
 * the agent runs in a project resolves the `bun`, `node` and `npm` the user's
 * shell resolves; only the suite's own needs (installing the browser driver)
 * read this. A release installation has no such directory: its programs carry
 * their own Bun beside the executable.
 */
export const SUITE_RUNTIME_ENV = 'GOODVIBES_SUITE_RUNTIME';

/** The suite's private `bun` or `node`, or undefined when this installation has none. One `access` call. */
export function suiteRuntimeExecutable(name: 'bun' | 'node'): string | undefined {
  const directory = process.env[SUITE_RUNTIME_ENV];
  if (!directory || !isAbsolute(directory)) return undefined;
  const path = join(directory, name);
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}
