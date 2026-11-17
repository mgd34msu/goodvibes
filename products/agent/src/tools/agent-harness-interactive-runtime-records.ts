import type { BackgroundProcess, ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import type { CommandContext } from '../input/command-registry.ts';
import { redactedHarnessPreview } from './agent-harness-secret-redaction.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';

/**
 * Interactive runtime, read from the owners that exist in this process: the
 * process manager (tracked processes, their status and output) and the sudo
 * posture. Kind, status and routes are known by construction, so nothing is
 * interpreted. No PTY session owner exists; that row says so.
 */
export type AgentHarnessInteractiveRuntimeKind = 'process-output' | 'pty-session' | 'sudo-mediation';
export type AgentHarnessInteractiveRuntimeStatus = 'running' | 'completed' | 'failed';

export interface AgentHarnessInteractiveRuntimeRoute {
  readonly id: 'inspect' | 'log' | 'write' | 'kill';
  readonly label: string;
  readonly modelRoute: string;
  readonly effect: 'read-only' | 'confirmed';
}

export interface AgentHarnessInteractiveRuntimeRecord {
  readonly id: string;
  readonly kind: AgentHarnessInteractiveRuntimeKind;
  readonly status: AgentHarnessInteractiveRuntimeStatus;
  readonly source: 'process-manager';
  readonly label: string;
  readonly summary: string;
  readonly processId: string;
  readonly pid: number;
  readonly command: string;
  readonly exitCode?: number | null;
  readonly signal?: string;
  /** The last few hundred characters of output, masked locally; `process action:"log"` reads more. */
  readonly outputTail?: string;
  readonly routes: readonly AgentHarnessInteractiveRuntimeRoute[];
  readonly updatedAt: string;
}

export interface InteractiveRuntimeParity {
  /** The process manager can write to a running process's stdin. */
  readonly stdinWriteContract: boolean;
  /** No PTY session owner exists in this runtime. */
  readonly ptyContract: false;
  /** Privilege prompts are mediated only in the foreground (sudo posture). */
  readonly sudoMediationContract: false;
}

export interface InteractiveRuntimeSnapshot {
  readonly records: readonly AgentHarnessInteractiveRuntimeRecord[];
  readonly capabilitySummary: Record<string, unknown>;
  readonly parityStatus: InteractiveRuntimeParity;
  /** Kept for callers of the earlier shape: a snapshot is a plain value, so this only checks cancellation. */
  readonly assertCurrent: () => void;
}

const OUTPUT_TAIL_CHARACTERS = 300;
const LATEST_RECORDS = 6;

function processStatus(entry: BackgroundProcess): AgentHarnessInteractiveRuntimeStatus {
  if (!entry.done) return 'running';
  return entry.exitCode === 0 && !entry.signal ? 'completed' : 'failed';
}

function processRoutes(processId: string, running: boolean, canWrite: boolean): readonly AgentHarnessInteractiveRuntimeRoute[] {
  const quoted = JSON.stringify(processId);
  return [
    { id: 'inspect', label: 'Inspect process', modelRoute: `process action:"poll" processId:${quoted}`, effect: 'read-only' },
    { id: 'log', label: 'Read output', modelRoute: `process action:"log" processId:${quoted}`, effect: 'read-only' },
    ...(running && canWrite ? [{ id: 'write', label: 'Write input', modelRoute: `process action:"write" processId:${quoted} data:"..."`, effect: 'confirmed' } as const] : []),
    ...(running ? [{ id: 'kill', label: 'Stop process', modelRoute: `process action:"kill" processId:${quoted}`, effect: 'confirmed' } as const] : []),
  ];
}

function outputTail(manager: ProcessManager, id: string): string | undefined {
  const output = manager.getOutput(id);
  if (!output) return undefined;
  const text = `${output.stdout}${output.stderr ? `\n${output.stderr}` : ''}`;
  if (!text.trim()) return undefined;
  return redactedHarnessPreview(text.slice(-OUTPUT_TAIL_CHARACTERS * 2), OUTPUT_TAIL_CHARACTERS);
}

function processRecords(manager: ProcessManager): AgentHarnessInteractiveRuntimeRecord[] {
  const canWrite = typeof manager.writeInput === 'function';
  const records: AgentHarnessInteractiveRuntimeRecord[] = [];
  for (const listed of manager.list()) {
    const entry = manager.getStatus(listed.id);
    if (!entry) continue;
    const status = processStatus(entry);
    const command = redactedHarnessPreview(entry.cmd, 160);
    records.push({
      id: entry.id,
      kind: 'process-output',
      status,
      source: 'process-manager',
      label: command,
      summary: `${listed.status}${listed.startedBy ? `; started by ${listed.startedBy}` : ''}`,
      processId: entry.id,
      pid: entry.pid,
      command,
      ...(entry.done ? { exitCode: entry.exitCode } : {}),
      ...(entry.signal ? { signal: entry.signal } : {}),
      routes: processRoutes(entry.id, !entry.done, canWrite),
      updatedAt: new Date(entry.completedAt ?? entry.startTime).toISOString(),
    });
  }
  return records.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id));
}

/**
 * One synchronous read of the process manager. Output is read (and masked)
 * only for the few newest records the summary shows.
 */
export function readInteractiveRuntime(context: CommandContext, options: CatalogRankingOptions = {}): InteractiveRuntimeSnapshot {
  options.signal?.throwIfAborted();
  const manager = context.workspace.processManager;
  const records = manager ? processRecords(manager) : [];
  const latest = manager
    ? records.slice(0, LATEST_RECORDS).map((record) => {
      const tail = outputTail(manager, record.id);
      return tail ? { ...record, outputTail: tail } : record;
    })
    : [];
  const running = records.filter((record) => record.status === 'running').length;
  const canWrite = manager !== undefined && typeof manager.writeInput === 'function';
  const sudo = sudoExecutionPosture(context);
  const capabilitySummary: Record<string, unknown> = {
    status: !manager ? 'unavailable' : running > 0 ? 'live' : 'idle',
    recordCount: records.length,
    runningCount: running,
    liveProcessOutput: manager
      ? { status: running > 0 ? 'live' : 'idle', recordCount: records.length, runningCount: running,
        route: 'execution action:"processes"', stdinWrite: canWrite ? 'available' : 'unavailable' }
      : { status: 'unavailable', reason: 'No process manager is wired into this runtime, so nothing tracks background processes.' },
    ptySessions: {
      status: 'unavailable',
      reason: 'No PTY session owner exists in this runtime; interactive programs that need a terminal cannot be driven.',
      next: 'Run non-interactive commands with exec, or a tracked background process with terminal background:true.',
    },
    sudoMediation: { status: sudo.status, route: sudo.foregroundRoute, setupRoute: sudo.setupRoute },
    latestRecords: latest,
    policy: 'Read from the process manager and the sudo posture in this process. Routes on a record act through the process tool under its own admission.',
  };
  return {
    records,
    capabilitySummary,
    parityStatus: { stdinWriteContract: canWrite, ptyContract: false, sudoMediationContract: false },
    assertCurrent: () => { options.signal?.throwIfAborted(); },
  };
}

/** The earlier asynchronous entry point; the read is synchronous now. */
export async function acquireInteractiveRuntimeSnapshot(context: CommandContext, options: CatalogRankingOptions = {}): Promise<InteractiveRuntimeSnapshot> {
  return readInteractiveRuntime(context, options);
}

export async function interactiveRuntimeRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly AgentHarnessInteractiveRuntimeRecord[]> {
  return readInteractiveRuntime(context, options).records;
}

export async function interactiveRuntimeCapabilitySummary(context: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  return readInteractiveRuntime(context, options).capabilitySummary;
}

export async function interactiveRuntimeParityStatus(context: CommandContext, options: CatalogRankingOptions = {}): Promise<InteractiveRuntimeParity> {
  return readInteractiveRuntime(context, options).parityStatus;
}
