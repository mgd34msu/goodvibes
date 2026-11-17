/**
 * hosts.ts, the real effects behind the trigger family's ports.
 *
 * manager.ts holds the policy and takes every effect as an injected port, so
 * this file is the one place where that policy meets an actual subprocess and
 * an actual agent. A host wires these once at composition; tests keep using
 * fakes.
 *
 * The on-exit host is deliberately built on ProcessManager rather than a fresh
 * Bun.spawn: ProcessManager already owns the credential-env scrub, the live
 * output collection, the SIGTERM→SIGKILL watchdog and the terminating-signal
 * capture, every one of which an honest termination payload needs. Building a
 * second, thinner spawn path here would mean an on-exit trigger silently had
 * weaker guarantees than a plain background command.
 */

import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { TriggerChildProcesses } from './host-processes.js';
import type { ProcessManager } from '../tools/shared/process-manager.js';
import type { LaunchedProcess, ObservedTermination, TriggerProcessHost } from './process-triggers.js';
import type { TriggerActionExecutor, TriggerStreamHost } from './manager-types.js';
import type { TriggerActionGrant } from './types.js';
import { ProbeTimeoutError, type ProbeIo } from './probes.js';

/** ProcessManager-backed on-exit host. Binds only to processes we launched. */
export function createProcessManagerTriggerHost(processManager: ProcessManager): TriggerProcessHost {
  /** Exact original children; remembered PIDs are never adopted after restart. */
  const launched = new TriggerChildProcesses(processManager);

  return Object.freeze<TriggerProcessHost>({
    async launch(spec): Promise<LaunchedProcess> {
      return launched.admit(async () => {
        const result = await processManager.spawnArgv(
          spec.command,
          spec.args,
          spec.cwd,
          spec.env ? { ...spec.env } : undefined,
          {
            timeout_ms: spec.maxDurationMs,
            // Both input-free policies must provide EOF. An unwritten pipe
            // remains open and can leave a child waiting forever.
            stdin: 'ignore',
          },
        );
        const processId = result.process_id;
        if (!processId) {
          throw new Error('Failed to launch supervised process');
        }
        const original = launched.capture(result);
        return { processId, pid: original.pid, startedAt: original.startedAt };
      });
    },

    observe(processId: string): ObservedTermination | null {
      const entry = launched.get(processId)?.readStatus();
      if (!entry) return null;
      return {
        running: entry.running,
        exitCode: entry.exitCode,
        signal: entry.signal ?? null,
        timedOut: entry.timedOut === true,
        stdoutTail: entry.stdoutTail,
        stderrTail: entry.stderrTail,
        ...(entry.completedAt !== undefined ? { endedAt: entry.completedAt } : {}),
      };
    },

    cancel(processId: string): void {
      launched.stop(processId);
    },

    release: (processId) => launched.release(processId),
    join: () => launched.join(),

    /**
     * Reporting only, the trigger never re-binds to this pid. A pid from a
     * previous daemon boot very likely belongs to somebody else's process by
     * now, so this answers "is anything alive there" and nothing stronger.
     */
    isSameProcessAlive(pid: number, startedAt: number): boolean {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      void startedAt;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Streams through the SAME native manager used by ordinary supervised jobs:
 * credential scrub, private process groups, bounded output and owned drainage. */
export function createBunStreamHost(processManager: ProcessManager): TriggerStreamHost {
  const running = new TriggerChildProcesses(processManager);
  return Object.freeze<TriggerStreamHost>({
    start(input) {
      // Capture callbacks before async admission; a later mutable port object
      // cannot transfer output or completion to a different observer.
      const onChunk = input.onChunk, onExit = input.onExit;
      return running.admit(async () => {
        const result = await processManager.spawnArgv(input.command, input.args, input.cwd, undefined,
          { timeout_ms: 0, stdin: 'ignore', onOutput: (chunk) => onChunk(chunk) });
        const original = running.capture(result);
        // The watcher itself is retained until its final callback returns.
        running.watch(original, async () => {
          await original.completion;
          assertSynchronousJudgmentGuard(() => onExit(original.readStatus().exitCode), () => new Error('Trigger exit observer must be synchronous'));
        });
        return { streamId: original.processId, pid: original.pid };
      });
    },
    stop: (streamId) => running.stop(streamId),
    join: () => running.join(),
  });
}

/**
 * Command probes through the same process manager: credential scrub, a
 * private process group killed whole at the deadline, and bounded output.
 * A probe whose command outlives its budget is a failed check, never its
 * partial output.
 */
export function createProcessManagerCommandRunner(processManager: ProcessManager): ProbeIo['runCommand'] {
  return async (command, args, options) => {
    const result = await processManager.spawnArgv(command, args, options.cwd, undefined,
      { timeout_ms: Math.max(1, options.timeoutMs), sigterm_grace_ms: 500, stdin: 'ignore' });
    const child = processManager.captureProcessLifetime(result);
    await child.completion;
    const status = child.readStatus();
    if (status.timedOut) throw new ProbeTimeoutError('command', options.timeoutMs);
    return { exitCode: status.exitCode, stdout: status.stdoutTail, stderr: status.stderrTail };
  };
}

/** What a fired trigger needs in order to actually start an agent turn. */
export interface TriggerAgentSpawner {
  spawn(input: { mode: 'spawn'; task: string; model?: string | undefined }): { id: string };
}

/**
 * Real fire-action executor.
 *
 * `runGrant` runs the grant's argv through the same no-shell path as an
 * on-exit child. By the time it is reached the manager has already verified
 * the independently pinned action against the registered grant, so what runs here is exactly what a
 * person confirmed.
 */
export function createTriggerActionExecutor(deps: {
  readonly agents: TriggerAgentSpawner;
  readonly processManager: ProcessManager;
  readonly grantTimeoutMs?: number | undefined;
}): TriggerActionExecutor {
  return {
    runAgentTurn(input) {
      const record = deps.agents.spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
      });
      return Promise.resolve(`agent:${record.id}`);
    },

    async runGrant(input: { readonly triggerId: string; readonly grant: TriggerActionGrant }) {
      const result = await deps.processManager.spawnArgv(
        input.grant.command,
        input.grant.args,
        input.grant.cwd,
        undefined,
        { timeout_ms: deps.grantTimeoutMs ?? 300_000, stdin: 'ignore' },
      );
      const original = deps.processManager.captureProcessLifetime(result);
      await original.completion;
      const status = original.readStatus();
      if (status.running || status.exitCode !== 0 || status.signal !== null || status.timedOut) {
        throw new Error('Supervised trigger grant did not complete successfully');
      }
      return `grant:${input.grant.id}:${original.processId}`;
    },
  };
}
