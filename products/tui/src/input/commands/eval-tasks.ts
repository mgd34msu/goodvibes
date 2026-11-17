/**
 * /eval tasks: evaluate the product on real work.
 *
 * Each task directory holds a `task.json` (`instruction`, optional `timeoutMs`)
 * and a `verify.sh`. The suite is copied to a scratch directory, every
 * instruction runs as one headless `goodvibes run --output json` in its task's
 * copy, and the task's script decides pass or fail. The checked-in tasks are
 * never changed.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createHeadlessRunExecutor,
  formatTaskSuiteResult,
  runTaskSuite,
} from '@goodvibes-jev/engine/platform/platform/runtime/observability';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';

/** Where `/eval tasks` looks when no suite directory is named, relative to the project. */
export const DEFAULT_TASK_SUITE_DIR = join('.goodvibes', 'eval', 'tasks');

export async function handleEvalTasks(args: string[], context: CommandContext): Promise<void> {
  const projectRoot = requireShellPaths(context).workingDirectory;
  const named = args[0];
  const suiteDir = named ? (isAbsolute(named) ? named : resolve(projectRoot, named)) : join(projectRoot, DEFAULT_TASK_SUITE_DIR);
  if (!existsSync(suiteDir) || !statSync(suiteDir).isDirectory()) {
    context.print([
      `[eval] No task suite at ${suiteDir}.`,
      `[eval] Create one directory per task under ${named ? suiteDir : DEFAULT_TASK_SUITE_DIR}, each with a task.json`
        + ' ({"instruction": "..."}) and a verify.sh that exits 0 when the work is right, then run /eval tasks again.',
    ].join('\n'));
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-eval-tasks-'));
  try {
    const copy = join(scratch, 'suite');
    cpSync(suiteDir, copy, { recursive: true });
    context.print(`[eval] Running the task suite ${suiteDir}: one goodvibes run per task, then its verify.sh...`);
    const result = await runTaskSuite(copy, { executor: createHeadlessRunExecutor() });
    context.print([
      formatTaskSuiteResult({ ...result, suiteDir }),
      result.passed ? '[eval] Every task passed.' : `[eval] ${result.total - result.passedCount} of ${result.total} task(s) failed.`,
    ].join('\n'));
  } catch (error) {
    context.print(`[eval] The task suite did not run: ${summarizeError(error)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Adds `/eval tasks [suite-dir]` to the eval command; every other subcommand goes to it unchanged. */
export function withEvalTasks(command: SlashCommand): SlashCommand {
  return {
    ...command,
    argsHint: command.argsHint ? `${command.argsHint}|tasks [suite-dir]` : 'tasks [suite-dir]',
    handler: async (args: string[], context: CommandContext): Promise<void> => {
      const [sub, ...rest] = args;
      if (sub === 'tasks') await handleEvalTasks(rest, context);
      else await command.handler(args, context);
    },
  };
}
