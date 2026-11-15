/**
 * Background-process lifetime policy, how long a tracked process runs, and
 * whether its deadline is allowed to end it.
 *
 * Split out of agent-harness-background-processes.ts, which sits at the
 * architecture line ceiling, and cohesive on its own: everything here answers
 * "when does this process stop, and what do we call the way it stopped".
 */
import type { BackgroundProcess } from '@goodvibes-jev/engine/platform/platform/tools';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { withLongLivedProcessReading, type ProcessClassificationOptions } from './agent-harness-process-classification.ts';
import type { AgentHarnessBackgroundProcessArgs } from './agent-harness-background-processes-types.ts';

export const DEFAULT_BACKGROUND_TIMEOUT_MS = 0;
export const MAX_BACKGROUND_TIMEOUT_MS = 2_147_483_647;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fieldMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

function readField(args: AgentHarnessBackgroundProcessArgs, id: string): string {
  return fieldMap(args.fields)[id] ?? '';
}

function describeReceived(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  return Array.isArray(value) ? 'a list' : typeof value === 'object' && value !== null ? 'an object' : String(value);
}

/** An absent value takes the fallback; one that was given but is not a number is refused, so a deadline the caller asked for is never silently dropped. */
function readNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return fallback;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new RangeError(`timeoutMs must be a number of milliseconds such as 30000 for 30 seconds; received ${describeReceived(value)}. Omit it to use the default.`);
  }
  return Math.trunc(parsed);
}

export function clampTimeout(value: unknown, fallback: number): number {
  const timeout = readNumber(value, fallback);
  if (timeout < 0) throw new RangeError('timeoutMs must be 0 or greater');
  if (timeout > MAX_BACKGROUND_TIMEOUT_MS) throw new RangeError('timeoutMs exceeds the runtime timer range');
  return timeout;
}

/** The longest one wait call blocks a turn; a caller that needs longer waits again. */
export const MAX_WAIT_TIMEOUT_MS = 600_000;

/**
 * A wait has its own reading of the shared timeout field. For a start, 0 means no automatic
 * deadline; for a wait, 0 means look once and return the current status.
 */
export function clampWaitTimeout(value: unknown, fallback: number): { readonly timeoutMs: number; readonly capped: boolean } {
  const timeout = clampTimeout(value, fallback);
  return timeout > MAX_WAIT_TIMEOUT_MS ? { timeoutMs: MAX_WAIT_TIMEOUT_MS, capped: true } : { timeoutMs: timeout, capped: false };
}

/** How a started process is treated when its timeout expires. */
export type BackgroundProcessClass = 'command' | 'long_lived';

/** Explicit declarations stay first; only omitted/invalid classes need a reading. */
export async function withBackgroundProcessClass<T>(
  args: AgentHarnessBackgroundProcessArgs,
  command: string,
  options: ProcessClassificationOptions,
  consume: (processClass: BackgroundProcessClass, assertCurrent: () => void) => T | Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const captured = snapshotJudgmentInput(args) as AgentHarnessBackgroundProcessArgs;
  const explicit = readString(captured.processClass) || readField(captured, 'processClass');
  if (explicit === 'long_lived' || explicit === 'command' || decisionModelPolicyState().operation === 'classic') {
    const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    // An omitted Classic class is the bounded ordinary-command default, never an inferred daemon lifetime.
    assertCurrent(); return await consume(explicit === 'long_lived' ? 'long_lived' : 'command', assertCurrent);
  }
  return withLongLivedProcessReading(command, options, (longLived, assertCurrent) => consume(longLived ? 'long_lived' : 'command', assertCurrent));
}

/** Classify without a side effect; launching uses the same reading's live lease. */
export async function resolveBackgroundProcessClass(
  args: AgentHarnessBackgroundProcessArgs,
  command: string,
  options: ProcessClassificationOptions = {},
): Promise<BackgroundProcessClass> {
  return withBackgroundProcessClass(args, command, options, (processClass) => processClass);
}

/**
 * Whether the timeout watchdog may terminate this process. Explicit
 * `killOnTimeout` always wins; otherwise only ordinary commands are killable.
 */
export function resolveKillOnTimeout(
  args: AgentHarnessBackgroundProcessArgs,
  processClass: BackgroundProcessClass,
): boolean {
  const explicit = args.killOnTimeout ?? readField(args, 'killOnTimeout');
  if (typeof explicit === 'boolean') return explicit;
  if (explicit === undefined || explicit === null || explicit === '') return processClass === 'command';
  const text = typeof explicit === 'string' ? explicit.trim().toLowerCase() : '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new RangeError(`killOnTimeout must be true or false; received ${describeReceived(explicit)}. Omit it to use the default for this process class.`);
}

export function processStatus(entry: BackgroundProcess): 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' {
  if (!entry.done) return 'running';
  if (entry.exitCode === 0) return 'succeeded';
  // A signal-terminated process reports exitCode null, which used to read as an
  // ordinary cancellation whether the caller stopped it or the timeout watchdog
  // did. `timedOut` is the difference, and it was never surfaced.
  if (entry.timedOut === true) return 'timed_out';
  if (entry.exitCode === null) return 'cancelled';
  return 'failed';
}

export function processAgeMs(entry: BackgroundProcess, now = Date.now()): number {
  return Math.max(0, (entry.completedAt ?? now) - entry.startTime);
}
