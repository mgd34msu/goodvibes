import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import type { ProcessManager, ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import type { AgentHarnessBackgroundProcessArgs } from './agent-harness-background-processes-types.ts';
import { resolveProcessLifetime } from './agent-harness-process-timeout-policy.ts';

export interface ProcessClassificationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

/** The calling composition's cancellation and admission, not authority supplied in model arguments. */
export function processClassificationOptions(context: CommandContext, _registry?: ToolRegistry, signal?: AbortSignal, assertExecution?: () => void): ProcessClassificationOptions {
  const workspace = context.workspace, manager = workspace.processManager;
  return { signal, assertCurrent() {
    signal?.throwIfAborted(); assertExecution?.();
    if (context.workspace !== workspace || workspace.processManager !== manager) throw new ToolInputProjectionError('stale');
  } };
}

/**
 * Start a background process with the lifetime the caller stated. No reading
 * is taken: `task` is owned by this runtime (ended with it, and at a deadline),
 * `detached` runs in its own session with its output in `logPath`.
 */
export async function spawnBackgroundProcess(
  manager: ProcessManager, args: AgentHarnessBackgroundProcessArgs, command: string, cwd: string | undefined,
  timeoutMs: number, options: ProcessClassificationOptions, logPath?: string,
) {
  const { lifetime, killOnTimeout } = resolveProcessLifetime(args);
  const detached = lifetime === 'detached';
  if (detached && !logPath) throw new Error('A detached process needs a log file; none was given.');
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  // A detached process must not write into the Agent's pipes: they close when the Agent exits.
  const result = detached
    ? await manager.spawn(`exec >>"$GOODVIBES_PROCESS_LOG" 2>&1 </dev/null\n${command}`, cwd, { GOODVIBES_PROCESS_LOG: logPath! }, {
      timeout_ms: timeoutMs, sigterm_grace_ms: 5_000, kill_on_timeout: killOnTimeout, kill_on_close: false, own_session: true,
      signal: options.signal, assertCurrent: options.assertCurrent,
    })
    : await manager.spawn(command, cwd, undefined, {
      timeout_ms: timeoutMs, sigterm_grace_ms: 5_000, kill_on_timeout: killOnTimeout, kill_on_close: true,
      stdin: 'pipe', signal: options.signal, assertCurrent: options.assertCurrent,
    });
  return { lifetime, killOnTimeout, result };
}
