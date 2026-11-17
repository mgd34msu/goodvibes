import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config/goodvibes-home';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell-paths';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell/cli-types';

/** Where the local auth store, the setup credential and the daemon's operator tokens live, and whether each exists. */
export function readAuthPaths(runtime: Pick<CliCommandRuntime, 'workingDirectory' | 'homeDirectory'>) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath('tui', 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt');
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
