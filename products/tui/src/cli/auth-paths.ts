import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell-paths';
import type { CliCommandRuntime } from '@goodvibes/engine/terminal-shell/cli-types';

/** Where the local auth store, the setup credential and the daemon's operator tokens live, and whether each exists. */
export function readAuthPaths(runtime: Pick<CliCommandRuntime, 'workingDirectory' | 'homeDirectory'>) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'auth-bootstrap.txt');
  const operatorTokenPath = join(resolveGoodVibesDaemonHome(runtime.homeDirectory), 'operator-tokens.json');
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath,
    operatorTokenPresent: existsSync(operatorTokenPath),
  };
}
