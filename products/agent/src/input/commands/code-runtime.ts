/**
 * Code and changes in the Agent: the code capabilities' services
 * (capabilities/builtin/code.ts) over the Agent's working folder: git and the
 * workspace's code intelligence with its reading of problems, and the
 * project's worktree register read as it is (one file per project, the one the
 * terminal app and the daemon read). The Agent keeps no code index, runs no
 * test command, has no Changes view, does not commit for you and does not
 * change a worktree's state, ties or record, so those capabilities are not
 * offered here (the terminal app has them); a worktree's setup and its removal
 * run through the daemon from here as from anywhere.
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
    // The register as it is; its writes are refused here (runtime/services.ts, DisabledAgentWorktreeRegistry).
    worktreeRegistry: ctx.workspace.worktreeRegistry,
    readOnlyWorktrees: true,
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
    // A turn's file writes reach the place's lists also in a folder the Agent has not registered (no checkpoint there).
    ...(ctx.session.changeTracker ? { turnChanges: ctx.session.changeTracker } : {}),
  });
}
