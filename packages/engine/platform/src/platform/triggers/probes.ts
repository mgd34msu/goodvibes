/**
 * probes.ts, executing one declarative probe.
 *
 * Four kinds, all data-driven: http, file, command (argv, never a shell) and
 * platform-tool. Each returns a TriggerValue the extractor then narrows. Nothing
 * here interpolates a previously extracted value back into the probe: a probe
 * is a fixed measurement, so there is no path by which an observed value can
 * become part of the next request or command line.
 *
 * All I/O is injectable so the whole probe layer is testable without a network,
 * a filesystem or a subprocess, the policy lives here, the host supplies the
 * effects.
 */

import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { TriggerProbe, TriggerValue } from './types.js';

export interface ProbeCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The effects a probe needs. A host wires the real ones; a test wires fakes.
 * `runCommand` takes argv, not a command string, there is no shell anywhere in
 * this path, so no extracted value can ever be interpreted as a metacharacter.
 */
export interface ProbeIo {
  readonly fetch: (url: string, init: RequestInit, timeoutMs: number) => Promise<{
    readonly status: number;
    readonly ok: boolean;
    readonly text: () => Promise<string>;
    /** Releases the connection when the body will not be read. */
    readonly close?: () => void;
  }>;
  readonly readFile: (path: string, maxBytes: number) => Promise<string>;
  readonly statFile: (path: string) => { readonly size: number; readonly mtimeMs: number } | null;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string | undefined; readonly timeoutMs: number },
  ) => Promise<ProbeCommandResult>;
  readonly callTool: (
    tool: string,
    input: Readonly<Record<string, TriggerValue>>,
    timeoutMs: number,
  ) => Promise<TriggerValue>;
}

export class ProbeTimeoutError extends Error {
  constructor(kind: string, timeoutMs: number) {
    super(`${kind} probe exceeded its ${timeoutMs}ms budget`);
    this.name = 'ProbeTimeoutError';
  }
}

/** Node/Bun-backed default effects. Hosts may substitute their own. */
export function createDefaultProbeIo(): ProbeIo {
  return {
    fetch: async (url, init, timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      timer.unref?.();
      // The budget covers the whole exchange: a server that sends headers and then
      // stalls must not hang the body read, so the timer outlives this call.
      const timedOut = (error: unknown): unknown => {
        clearTimeout(timer);
        return controller.signal.aborted ? new ProbeTimeoutError('http', timeoutMs) : error;
      };
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return {
          status: response.status,
          ok: response.ok,
          text: async () => {
            try { return await response.text(); } catch (error) { throw timedOut(error); } finally { clearTimeout(timer); }
          },
          close: () => { clearTimeout(timer); controller.abort(); },
        };
      } catch (error) {
        throw timedOut(error);
      }
    },
    readFile: async (path, maxBytes) => {
      // Read at most maxBytes from the start; a large file is never loaded whole.
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await handle.close();
      }
    },
    statFile: (path) => {
      try {
        const stat = statSync(path);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
    runCommand: async (command, args, options) => {
      const proc = Bun.spawn([command, ...args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      } as Parameters<typeof Bun.spawn>[1]);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }, options.timeoutMs);
      timer.unref?.();
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
          new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
          proc.exited,
        ]);
        // Output cut off by the kill is not an observation: a `change` rule would fire on it.
        if (timedOut) throw new ProbeTimeoutError('command', options.timeoutMs);
        return { exitCode, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    },
    callTool: () => Promise.reject(new Error('No platform-tool probe host is wired; register one before using platform-tool probes.')),
  };
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function isAbsentFile(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Rejects with ProbeTimeoutError when the work outlives its budget. */
async function withinBudget<T>(kind: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new ProbeTimeoutError(kind, timeoutMs)); }, timeoutMs); timer.unref?.(); });
  try { return await Promise.race([work, expired]); } finally { clearTimeout(timer); }
}
const DEFAULT_FILE_MAX_BYTES = 1_048_576;

/** Runs one probe and returns its raw result for the extractor to narrow. */
export async function runProbe(
  probe: TriggerProbe,
  io: ProbeIo,
  defaults: { readonly timeoutMs?: number | undefined } = {},
): Promise<TriggerValue> {
  const budget = probe.kind === 'file'
    ? (defaults.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    : (probe.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

  switch (probe.kind) {
    case 'http': {
      const init: RequestInit = {
        method: probe.method ?? 'GET',
        ...(probe.headers ? { headers: { ...probe.headers } } : {}),
        ...(probe.body !== undefined ? { body: probe.body } : {}),
      };
      const response = await io.fetch(probe.url, init, budget);
      if (probe.capture === 'status') { response.close?.(); return response.status; }
      // A body that cannot be read in full is a failed check, never an empty observation.
      const text = await response.text();
      if (probe.capture === 'envelope') {
        return { status: response.status, ok: response.ok, body: text };
      }
      return text;
    }

    case 'file': {
      if (probe.capture === 'stat') {
        const stat = io.statFile(probe.path);
        return stat ? { exists: true, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) } : { exists: false };
      }
      try {
        return await withinBudget('file', budget, io.readFile(probe.path, probe.maxBytes ?? DEFAULT_FILE_MAX_BYTES));
      } catch (error) {
        // A missing file is an observation, not a probe failure: a `change`
        // rule watching for a file to appear needs to see the absent state.
        // Any other failure (permissions, a directory, I/O) is not "absent".
        if (isAbsentFile(error)) return null;
        throw error;
      }
    }

    case 'command': {
      const result = await io.runCommand(probe.command, probe.args ?? [], {
        ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
        timeoutMs: budget,
      });
      if (probe.capture === 'exit-code') return result.exitCode;
      if (probe.capture === 'stderr') return result.stderr;
      if (probe.capture === 'envelope') {
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      return result.stdout;
    }

    case 'platform-tool':
      return io.callTool(probe.tool, probe.input ?? {}, budget);

    default:
      return null;
  }
}
