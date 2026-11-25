/**
 * Code and changes in the Agent: the code capabilities' services
 * (capabilities/builtin/code.ts) over the Agent's working folder: git and the
 * workspace's code intelligence with its reading of problems. The Agent keeps
 * no code index and no worktrees, runs no test command, has no Changes view
 * and does not commit for you, so those capabilities are not offered here
 * (the terminal app has them).
 */
import type { CodeServices } from '@goodvibes/engine/platform/platform/capabilities';
import { CodeIntelligence } from '@goodvibes/engine/platform/platform/intelligence';
import { codeResults, codeServices } from '@goodvibes/engine/terminal-shell/code-capabilities';
import type { CommandContext } from '../command-registry.ts';

/** The Agent's code services; undefined before it has a working folder. */
export function codeOf(ctx: CommandContext): CodeServices | undefined {
  const shellPaths = ctx.workspace.shellPaths;
  if (!shellPaths) return undefined;
  const readModels = ctx.platform.readModels;
  return codeServices({
    workingDirectory: shellPaths.workingDirectory,
    // No worktree register: the Agent's is disabled on purpose (runtime/services.ts, DisabledAgentWorktreeRegistry),
    // it hands build and fix work to the terminal app, which keeps the project's worktrees.
    intelligence: {
      // The workspace's one facade, the same object the model's read and find tools hold.
      hold: () => CodeIntelligence.holdForWorkspace(shellPaths),
      resolvePath: (target) => shellPaths.resolveWorkspacePath(target),
      ...(readModels ? {
        reading: () => {
          const state = readModels.intelligence.getSnapshot();
          return { ...state, problems: state.diagnostics };
        },
      } : {}),
    },
    results: codeResults,
  });
}
