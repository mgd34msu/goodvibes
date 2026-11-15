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
 * The real command runner is the process manager's (`createProcessManagerCommandRunner`
 * in hosts.ts): credential scrub, its own process group, bounded output and a
 * kill of the whole group at the deadline.
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

/** Most of an http body a probe reads; the rest is not read, so a large page cannot fill memory. */
export const HTTP_PROBE_MAX_BYTES = 1_048_576;

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (bytes >= maxBytes) break;
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Default effects: fetch, file reads and stats. Command probes run only through
 * the runner the host passes (the process manager's); with none, a command
 * probe fails and says so.
 */
export function createDefaultProbeIo(options: { readonly runCommand?: ProbeIo['runCommand'] | undefined } = {}): ProbeIo {
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
            try { return await readBounded(response, HTTP_PROBE_MAX_BYTES); } catch (error) { throw timedOut(error); } finally { clearTimeout(timer); }
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
    runCommand: options.runCommand ?? (() => Promise.reject(new Error('Command probes run through the process manager, and this host passed none; use an http or file probe, or run the trigger in the daemon.'))),
    callTool: () => Promise.reject(new Error('Platform-tool probes have no host in this build; use an http, file or command probe.')),
  };
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function isAbsentFile(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Rejects with ProbeTimeoutError when the work outlives its budget (plus any grace before it is abandoned). */
async function withinBudget<T>(kind: string, timeoutMs: number, work: Promise<T>, graceMs = 0): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new ProbeTimeoutError(kind, timeoutMs)); }, timeoutMs + graceMs); timer.unref?.(); });
  try { return await Promise.race([work, expired]); } finally { clearTimeout(timer); }
}
const DEFAULT_FILE_MAX_BYTES = 1_048_576;
/** Time past the budget a probe that keeps its own deadline (http, command) has to report it before it is abandoned. */
const PROBE_SETTLE_GRACE_MS = 1_000;

/**
 * Runs one probe and returns its raw result for the extractor to narrow. The
 * whole probe is held to its budget, so a check always settles and the
 * trigger is never left waiting on output a stray child still holds open.
 */
export function runProbe(
  probe: TriggerProbe,
  io: ProbeIo,
  defaults: { readonly timeoutMs?: number | undefined } = {},
): Promise<TriggerValue> {
  const budget = probe.kind === 'file'
    ? (defaults.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    : (probe.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  // http and command probes keep their own deadline and report it first; a file
  // read has none, so the budget is its deadline.
  return withinBudget(probe.kind, budget, runProbeWork(probe, io, budget), probe.kind === 'file' ? 0 : PROBE_SETTLE_GRACE_MS);
}

async function runProbeWork(probe: TriggerProbe, io: ProbeIo, budget: number): Promise<TriggerValue> {
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
        return await io.readFile(probe.path, probe.maxBytes ?? DEFAULT_FILE_MAX_BYTES);
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
