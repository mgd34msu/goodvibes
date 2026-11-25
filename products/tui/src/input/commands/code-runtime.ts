/**
 * Code and changes in the terminal app: the code capabilities' services
 * (capabilities/builtin/code.ts) over this app's working folder and what it
 * keeps for it: git, the worktree register, its code index, the workspace's
 * code intelligence and its reading of problems, the project's tests, the
 * Changes view, and committing every change. The Code and changes place and
 * the model's `capability_run` both run on these.
 */
import type { CodeServices } from '@goodvibes/engine/platform/platform/capabilities';
import { CodeIntelligence } from '@goodvibes/engine/platform/platform/intelligence';
import { isCodeIndexAutoStartEnabled, CODE_INDEX_MAX_FILES, CODE_INDEX_MAX_FILE_BYTES, CODE_INDEX_MAX_TOTAL_BYTES } from '@goodvibes/engine/platform/platform/runtime/operations';
import { codeResults, codeServices, printedBy, type CodeProgramPieces } from '@goodvibes/engine/terminal-shell/code-capabilities';
import type { CommandContext } from '../command-registry.ts';
import { executeCommitAll } from './quit-shared.ts';
import { runTestCommand } from './test-runtime.ts';

function codeIndexOf(ctx: CommandContext): CodeProgramPieces['codeIndex'] {
  const store = ctx.session.codeIndexStore;
  if (!store) return undefined;
  const scheduler = ctx.session.codeIndexReindexScheduler;
  return {
    stats: () => store.stats(),
    isBuilding: () => store.isBuilding(),
    buildProgress: () => store.buildProgress(),
    scheduleBuild: () => { store.scheduleBuild(); },
    search: (words, options) => store.search(words, options?.limit !== undefined ? { limit: options.limit } : undefined),
    autoStart: () => isCodeIndexAutoStartEnabled(ctx.platform.configManager),
    passiveInjectionFlag: () => ctx.session.isPassiveCodeInjectionFlagEnabled?.() ?? false,
    reindexActivity: () => scheduler?.lastActivity() ?? null,
    keptCurrent: () => scheduler?.keptCurrentThisSession() ?? false,
    keepCurrent: () => { scheduler?.keepCurrent(); },
    limits: { files: CODE_INDEX_MAX_FILES, fileBytes: CODE_INDEX_MAX_FILE_BYTES, totalBytes: CODE_INDEX_MAX_TOTAL_BYTES },
  };
}

/** This app's code services; undefined before it has a working folder. */
export function codeOf(ctx: CommandContext): CodeServices | undefined {
  const shellPaths = ctx.workspace.shellPaths;
  if (!shellPaths) return undefined;
  const readModels = ctx.platform.readModels;
  return codeServices({
    workingDirectory: shellPaths.workingDirectory,
    worktreeRegistry: ctx.workspace.worktreeRegistry,
    codeIndex: codeIndexOf(ctx),
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
    tests: { run: (pattern) => runTestCommand(pattern.split(/\s+/).filter(Boolean), ctx) },
    changesView: {
      open: (source) => {
        if (!ctx.openChanges) throw new Error('The Changes view is not available in this session.');
        ctx.openChanges({ source });
      },
    },
    commit: {
      preview: () => printedBy((print) => executeCommitAll({ print, workspace: ctx.workspace }, [])),
      commitAll: () => printedBy((print) => executeCommitAll({ print, workspace: ctx.workspace }, ['--yes'])),
    },
    results: codeResults,
  });
}
