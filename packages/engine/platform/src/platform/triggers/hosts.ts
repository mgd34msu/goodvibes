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

import { readFileSync } from 'node:fs';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { TriggerChildProcesses } from './host-processes.js';
import { MANAGED_OUTPUT_WINDOW_BYTES, type ProcessManager } from '../tools/shared/process-manager.js';
import type { LaunchedProcess, ObservedTermination, TriggerProcessHost } from './process-triggers.js';
import type { TriggerActionExecutor, TriggerStreamHost } from './manager-types.js';
import type { TriggerActionGrant } from './types.js';
import type { AgentRecord } from '../tools/agent/record.js';
import type { UnattendedRuns } from '../automation/unattended-runs.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { ProbeTimeoutError, type ProbeIo } from './probes.js';

/**
 * How far apart the kernel's start time of a process and the recorded launch
 * time may be for them to be the same process: the boot time is kept in whole
 * seconds and the launch is recorded just after the spawn.
 */
const SAME_PROCESS_START_TOLERANCE_MS = 3_000;

/** Clock ticks per second in /proc/<pid>/stat (USER_HZ, 100 on Linux). */
const USER_HZ = 100;

/**
 * When the process at `pid` started, in epoch milliseconds, from Linux /proc:
 * field 22 of /proc/<pid>/stat (ticks since boot) plus btime from /proc/stat.
 * 'gone' when /proc is there and the pid is not; undefined when /proc cannot
 * say (another system, or a format this does not read).
 */
function processStartedAtMs(pid: number): number | 'gone' | undefined {
  let bootSeconds: number;
  try {
    const btime = /^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
    if (!btime) return undefined;
    bootSeconds = Number(btime[1]);
  } catch {
    return undefined;
  }
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : undefined;
  }
  // The command name (field 2) is in parentheses and may hold spaces: fields are counted after its closing one.
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const ticks = Number(fields[22 - 3]);
  if (!Number.isFinite(ticks)) return undefined;
  return (bootSeconds + ticks / USER_HZ) * 1000;
}

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
     * Whether the child launched at `startedAt` under `pid` is still running.
     * The manager waits on the answer before it reconciles an on-exit trigger
     * left over from an earlier boot (the trigger never re-binds to the pid).
     * A pid is reused once its process ends, so where the kernel says when the
     * process at `pid` started (Linux /proc) the answer is yes only for one
     * that started when the child did; elsewhere it is whether anything this
     * user may signal is alive there. A pid owned by another user is never
     * the child, which this user launched.
     */
    isSameProcessAlive(pid: number, startedAt: number): boolean {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const started = processStartedAtMs(pid);
      if (started === 'gone') return false;
      if (started !== undefined) return Math.abs(started - startedAt) <= SAME_PROCESS_START_TOLERANCE_MS;
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
 * partial output; so is one whose stdout passes the managed output window,
 * whose kept tail is not the output an extract or change rule must read.
 */
export function createProcessManagerCommandRunner(processManager: ProcessManager): ProbeIo['runCommand'] {
  return async (command, args, options) => {
    const result = await processManager.spawnArgv(command, args, options.cwd, undefined,
      { timeout_ms: Math.max(1, options.timeoutMs), sigterm_grace_ms: 500, stdin: 'ignore' });
    const child = processManager.captureProcessLifetime(result);
    await child.completion;
    const status = child.readStatus();
    if (status.timedOut) throw new ProbeTimeoutError('command', options.timeoutMs);
    if (status.stdoutOverflowed) {
      throw new Error(`The probe command printed more than ${MANAGED_OUTPUT_WINDOW_BYTES} bytes on stdout, so its output was not read: `
        + 'an extract or change rule would see only the end of it. Make the command print less (filter it, or select the field it needs).');
    }
    return { exitCode: status.exitCode, stdout: status.stdoutTail, stderr: status.stderrTail };
  };
}

/** What a fired trigger needs in order to actually start an agent turn and read its answer. */
export interface TriggerAgentSpawner {
  spawn(input: { mode: 'spawn'; task: string; model?: string | undefined; tools?: string[] | undefined }): { id: string };
  /** Settles once the agent's work (and its cleanup) is done. */
  join(agentId: string): Promise<void>;
  getStatus(agentId: string): Pick<AgentRecord, 'status' | 'fullOutput' | 'progress' | 'error'> | null;
}

/** The answer of a finished trigger turn, as it is delivered. */
function triggerTurnAnswer(record: Pick<AgentRecord, 'status' | 'fullOutput' | 'progress' | 'error'> | null): string {
  if (!record) return 'The turn\'s agent is no longer known to this process, so its answer could not be read.';
  if (record.status === 'completed') return record.fullOutput ?? record.progress ?? '';
  if (record.status === 'cancelled') return 'The turn was cancelled before it answered.';
  return `The turn failed${record.error ? `: ${record.error}` : ''}.${record.fullOutput ? `\n\n${record.fullOutput}` : ''}`;
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
  /** Where the turn's answer goes and which connected tools (mail, calendar) the turn gets. */
  readonly unattendedRuns?: UnattendedRuns | undefined;
}): TriggerActionExecutor {
  return {
    runAgentTurn(input) {
      const tools = deps.unattendedRuns?.connectedTools() ?? [];
      const record = deps.agents.spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(tools.length > 0 ? { tools: [...tools] } : {}),
      });
      // The firing is recorded once the turn has started; its answer is
      // delivered when the turn ends: to the channel the action names, else
      // (or when that send fails) to the owner inbox.
      const unattended = deps.unattendedRuns;
      if (unattended) {
        void deps.agents.join(record.id)
          .then(() => unattended.deliver({
            source: 'trigger',
            runId: `${input.triggerId}:${record.id}`,
            ownerId: input.triggerId,
            title: `Trigger ${input.label ?? input.triggerId}`,
            body: triggerTurnAnswer(deps.agents.getStatus(record.id)),
            agentId: record.id,
            ...(input.deliverTo !== undefined ? { deliverTo: input.deliverTo } : {}),
          }))
          .catch((error: unknown) => {
            logger.warn('Trigger turn answer could not be delivered', { triggerId: input.triggerId, agentId: record.id, error: summarizeError(error) });
          });
      }
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
