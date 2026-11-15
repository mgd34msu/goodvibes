/** One-shot evaluation and authority-owned attempt history. No host eval,
 * shared VM or model-selected workspace is available here. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  assertContractInputAuthority,
  assertContractInputReadAccess,
  withContractInputReadBatch,
  contractInputAuthorityMutable,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import type { Tool, ToolResult } from '../../types/tools.js';
import { guardExecCommand } from '../exec/ast-guard.js';
import { probeCapturedExecAvailability, runCapturedCommand, type CapturedExecAuthority } from '../exec/captured-exec.js';
import { createCapturedExecBunRuntimeAdmission } from '../exec/captured-bun-runtime-input.js';
import { REPL_TOOL_SCHEMA } from './schema.js';
import { capturedReplScript } from './captured-script.js';

const tools = new WeakMap<Tool, ContractInputAuthority>();
const HELD = 'Captured REPL held: original-owner/view authority is unavailable, changed or restricted. Output withheld.';
const CANCELLED = 'Captured REPL cancelled. Output withheld.';
/** Bounds an eval that never finishes; an explicit timeout_ms of 0 still waits for completion or cancellation. */
const DEFAULT_EVAL_TIMEOUT_MS = 120_000;

/** The eval deadline for a call: omitted means the default bound, 0 means wait; anything else invalid is undefined. */
export function resolveEvalTimeoutMs(requested: unknown): number | undefined {
  const timeoutMs = requested ?? DEFAULT_EVAL_TIMEOUT_MS;
  return typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : undefined;
}
type Runtime = 'javascript' | 'typescript';
interface HistoryEntry {
  readonly ts: number;
  readonly runtime: Runtime;
  readonly expression: string;
  readonly sessionId: string;
  readonly backend?: string | undefined;
  readonly launchSummary?: string | undefined;
  readonly result?: string | undefined;
  readonly error?: string | undefined;
}
interface RetainedEntry {
  readonly offset: number;
  readonly bytes: number;
  readonly check: (signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
}
interface History {
  readonly authority: ContractInputAuthority;
  readonly signal?: AbortSignal | undefined;
  readonly entries: RetainedEntry[];
  bytes: number;
  /** Opened on the first retained attempt, so a run that never evaluates leaves nothing behind. */
  readonly file: { fd: number | undefined };
}
// A copied root, serialized session ID or newly minted authority never selects
// another execution's journal. Weak ownership also lets disposed runs be freed.
export interface CapturedReplHistory {
  readonly kind: 'captured-repl-history';
}
const histories = new WeakMap<CapturedReplHistory, History>();
// A run that never disposes its journal (a caller that took the default owner) still releases the descriptor once the owner is collected.
const unreleased = new FinalizationRegistry<{ fd: number | undefined }>((file) => {
  if (file.fd !== undefined) { try { closeSync(file.fd); } catch { /* already closed */ } file.fd = undefined; }
});

/** Mint once per actual agent run, then reuse only for its registry rebuilds. */
export function createCapturedReplHistory(authority: ContractInputAuthority, signal?: AbortSignal): CapturedReplHistory {
  const owner = Object.freeze({ kind: 'captured-repl-history' as const });
  const file: { fd: number | undefined } = { fd: undefined };
  histories.set(owner, { authority, signal, entries: [], bytes: 0, file });
  unreleased.register(owner, file);
  return owner;
}

/**
 * The journal is private to one run, so its file is unlinked as soon as it is
 * open: the descriptor is all that reads and writes need, and nothing is left on
 * disk when the run ends or the process dies.
 */
function journalFd(history: History): number {
  if (history.file.fd !== undefined) return history.file.fd;
  const directory = join(process.env.GOODVIBES_HOME ?? join(homedir(), '.local', 'share', 'goodvibes-jev-data'), '.goodvibes', 'repl-history');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.jsonl`);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { unlinkSync(path); } catch (error) { closeSync(fd); throw error; }
  history.file.fd = fd;
  return fd;
}

export function disposeCapturedReplHistory(owner: CapturedReplHistory): void {
  const history = histories.get(owner);
  if (history?.file.fd !== undefined) { closeSync(history.file.fd); history.file.fd = undefined; }
  histories.delete(owner);
}

function historyOf(owner: CapturedReplHistory, authority: ContractInputAuthority): History {
  const history = histories.get(owner);
  if (!history || history.authority !== authority) throw new Error('captured REPL history binding is unavailable');
  history.signal?.throwIfAborted();
  return history;
}

function retain(history: History, entry: HistoryEntry, check: RetainedEntry['check'], signal?: AbortSignal): void {
  const data = Buffer.from(JSON.stringify(entry) + '\n');
  const fd = journalFd(history);
  let written = 0;
  while (written < data.length) written += writeSync(fd, data, written, data.length - written, history.bytes + written);
  history.entries.push({ offset: history.bytes, bytes: data.length, check, signal });
  history.bytes += data.length;
}

export function isCapturedReplTool(tool: Tool, authority: ContractInputAuthority): boolean {
  return tools.get(tool) === authority;
}

export function createCapturedReplTool(
  binding: CapturedExecAuthority,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  historyOwner: CapturedReplHistory = createCapturedReplHistory(binding.authority, binding.signal),
): Tool {
  binding = Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined });
  const admitRuntime = binding.bunRuntimeAdmission ?? createCapturedExecBunRuntimeAdmission(binding);
  const check = async (callSignal?: AbortSignal): Promise<void> => {
    const signal = binding.signal && callSignal ? AbortSignal.any([binding.signal, callSignal]) : binding.signal ?? callSignal;
    await withContractInputReadBatch(binding.authority, async () => {
      await assertContractInputAuthority(binding.authority, binding.root, signal);
      await assertContractInputReadAccess(binding.authority, binding.readAccessFilter, signal);
      historyOf(historyOwner, binding.authority);
    });
  };
  const tool: Tool = {
    definition: {
      ...REPL_TOOL_SCHEMA,
      description: 'Evaluate one JavaScript or TypeScript snippet in a fresh contained captured workspace. Bindings are JSON values exposed as globals. Returns printed completion and console output. Each eval is stateless (no shared variables or VM); authorized file changes persist only in a mutable member view. History retains all authorized attempts in a private per-run journal with optional pagination. History is not inherited by another run or resumed/rebound authority. Network, ambient host environment and other runtimes are unavailable.',
      sideEffects: ['exec', 'read_fs', 'write_fs', 'state'],
      concurrency: 'serial',
    },
    async execute(args, options) {
      const signal = binding.signal && options?.signal ? AbortSignal.any([binding.signal, options.signal]) : binding.signal ?? options?.signal;
      try {
        // Pin model input before the first policy await. Neither caller mutation
        // nor a workspaceRoot property can replace the construction binding.
        args = structuredClone(args);
        await check(signal);
        if (args.mode === 'history') {
          const history = historyOf(historyOwner, binding.authority);
          // The outer tool/provider delivery checks may cancel after this
          // backend completed. Such an attempt must not become replayable.
          for (let index = history.entries.length - 1; index >= 0; index--) {
            if (history.entries[index]!.signal?.aborted) {
              history.entries.splice(index, 1);
            }
          }
          const offset = args.offset ?? 0, limit = args.limit ?? history.entries.length;
          if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) return { success: false, error: 'History offset and limit must be nonnegative integers.' };
          const entries = history.entries.slice(offset, offset + limit);
          const previousChecks = new Set(entries.map(entry => entry.check));
          previousChecks.delete(check);
          // Replaying through a newly constructed registry must not replace an
          // earlier binding's permission filter or lifecycle with a broader one.
          for (const originalCheck of previousChecks) await originalCheck(signal);
          for (const retained of entries) retained.signal?.throwIfAborted();
          const output = JSON.stringify({ count: history.entries.length, history: entries.map(entry => {
            const data = Buffer.alloc(entry.bytes);
            let read = 0;
            while (read < data.length) { const n = readSync(journalFd(history), data, read, data.length - read, entry.offset + read); if (!n) throw new Error('Incomplete REPL journal'); read += n; }
            return JSON.parse(data.toString('utf8')) as HistoryEntry;
          }), ...(offset > 0 || entries.length < history.entries.length ? { offset, returned: entries.length, has_more: offset + entries.length < history.entries.length, ...(entries.length && offset + entries.length < history.entries.length ? { next_offset: offset + entries.length } : {}) } : {}) });
          for (const originalCheck of previousChecks) await originalCheck(signal);
          await check(signal);
          for (const retained of entries) retained.signal?.throwIfAborted();
          return { success: true, output };
        }
        if (args.mode !== 'eval' || typeof args.expression !== 'string' || args.expression.length === 0)
          return { success: false, error: 'Captured REPL requires mode eval and a nonempty expression.' };
        const runtime = args.runtime ?? 'javascript';
        if (runtime !== 'javascript' && runtime !== 'typescript')
          return { success: false, error: `runtime ${String(runtime)} is not available; repl evaluates javascript and typescript.` };
        const timeoutMs = resolveEvalTimeoutMs(args.timeout_ms);
        if (timeoutMs === undefined) return { success: false, error: 'timeout_ms must be a nonnegative integer.' };
        const attempt = { ts: Date.now(), runtime: runtime as Runtime, expression: args.expression, sessionId: `captured_repl_${randomUUID()}` };
        const finish = async (result: Omit<ToolResult, 'callId'>, details: Partial<HistoryEntry> = {}): Promise<Omit<ToolResult, 'callId'>> => {
          await check(signal);
          // Cancelled/revoked attempts retain neither partial output nor source.
          if (!result.cancelled) retain(historyOf(historyOwner, binding.authority), { ...attempt, ...details, error: result.error ?? details.error }, check, signal);
          return result;
        };
        if (!process.versions.bun)
          return await finish({ success: false, error: 'Captured REPL requires the trusted Bun runtime. Host evaluation is unavailable as a fallback.' });
        if (args.bindings !== undefined && (args.bindings === null || typeof args.bindings !== 'object' || Array.isArray(args.bindings)))
          return { success: false, error: 'Captured REPL bindings must be an object of JSON values.' };
        const script = await capturedReplScript(args.expression, JSON.stringify(args.bindings ?? {}));
        const scriptName = `.goodvibes-repl-${randomUUID()}.ts`;
        const command = `bun --no-env-file ./${scriptName}`;
        const guard = await guardExecCommand(command, featureFlags, signal);
        if (!guard.allowed) return await finish({ success: false, error: guard.denialMessage ?? 'Captured REPL command denied by policy.' });
        const availability = await probeCapturedExecAvailability();
        if (!availability.available) return await finish({
          success: false, error: availability.message,
          output: JSON.stringify({ runtime, result: '', error: availability.message,
            isolated: false, stateless: true,
            workspace_changes_persist: contractInputAuthorityMutable(binding.authority),
            captured_exec_availability: availability }),
        });
        let bunRuntimeInput = binding.bunRuntimeInput;
        if (!bunRuntimeInput) {
          try { bunRuntimeInput = await admitRuntime(signal); }
          catch {
            return await finish({ success: false, error: 'Captured REPL ordinary Bun runtime is unavailable, changed or access-restricted. Host evaluation is unavailable as a fallback.' });
          }
        }
        // The view is proved once more just before the command runs, and again when the result is kept (finish).
        await check(signal);
        const result = await runCapturedCommand({ ...binding, bunRuntimeInput }, command, {}, binding.root, timeoutMs, signal, 'disabled', {}, { script: { name: scriptName, content: script } });
        const error = result.timed_out ? `Captured REPL evaluation timed out after ${timeoutMs}ms.`
          : result.stderr || (!result.success && !result.denied && result.exit_code !== null
            ? `Captured REPL evaluation exited with code ${result.exit_code} and printed no error output.` : '');
        return await finish({
          success: result.success,
          ...(result.cancelled ? { cancelled: true } : {}),
          ...(!result.success ? { error: error || HELD } : {}),
          output: JSON.stringify({
            runtime, result: result.stdout, error: error || undefined,
            isolated: result.sandboxed === true, stateless: true,
            workspace_changes_persist: contractInputAuthorityMutable(binding.authority),
            ...(result.captured_exec_availability ? { captured_exec_availability: result.captured_exec_availability } : {}),
          }),
        }, {
          ...(result.sandboxed ? { backend: 'linux-bwrap-projection', launchSummary: `Fresh contained ${runtime} evaluation` } : {}),
          result: result.stdout || undefined, error: error || undefined,
        });
      } catch {
        return signal?.aborted ? { success: false, error: CANCELLED, cancelled: true } : { success: false, error: HELD };
      }
    },
  };
  tools.set(tool, binding.authority);
  return tool;
}
