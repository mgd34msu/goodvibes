import type { SandboxSessionRegistry } from './sandbox/session-registry.js';
import type { ShellPathService } from './shell-paths.js';
import type { WorktreeRegistry } from './worktree/registry.js';

export interface CommandWorkspaceShellServices {
  readonly shellPaths?: ShellPathService | undefined;
  readonly worktreeRegistry?: WorktreeRegistry | undefined;
  readonly sandboxSessionRegistry?: SandboxSessionRegistry | undefined;
}
