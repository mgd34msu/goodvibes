/**
 * ACP Protocol Types
 *
 * Re-exports SDK types and defines local types for subagent management.
 * The platform host acts as the ACP client; subagents implement the Agent interface.
 */

import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// Re-export ACP SDK types
export type {
  Client,
  Agent,
  AgentSideConnection,
  ClientSideConnection,
  RequestError,
} from '@agentclientprotocol/sdk';

export type {
  SessionNotification,
  PromptRequest,
  PromptResponse,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  CancelNotification,
} from '@agentclientprotocol/sdk';

/**
 * The ACP SDK's VALUES, `ndJsonStream`, `AgentSideConnection`,
 * `PROTOCOL_VERSION`, `ClientSideConnection`, used to be re-exported from
 * here. They are not any more, because `export { … } from '@agentclientprotocol/sdk'`
 * links the specifier at module init exactly like an import does, and the
 * package is an optionalDependency: an install without it took down every
 * graph that reached this file, the daemon's included. Take them off the
 * awaited module instead:
 *
 *   const { ndJsonStream, ClientSideConnection } = await loadAcpLibrary();
 *
 * The type re-exports above are unaffected, `export type` is erased.
 */
export { describeAcpAvailability, loadAcpLibrary } from './optional-acp-library.js';
export type { AcpAvailability, AcpLibraryModule } from './optional-acp-library.js';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** Lifecycle status of a spawned subagent. */
export type SubagentStatus = 'running' | 'complete' | 'error' | 'cancelled';

/** Tracks a live subagent process. */
export interface SubagentInfo {
  id: string;
  task: string;
  status: SubagentStatus;
  startedAt: number;
  /** Latest progress text from session updates. */
  progress?: string | undefined;
  /** The last permission ask refused without a decision on its merits (timeout, no owner, malformed), and why. */
  lastRefusal?: { readonly at: number; readonly reason: string } | undefined;
}

/** Final result after a subagent completes. */
export interface SubagentResult {
  id: string;
  success: boolean;
  output: string;
  toolCallsMade: number;
  duration: number;
}

/** Parameters for spawning a subagent task. */
export interface SubagentTask {
  /** Human-readable task description / prompt. */
  description: string;
  /** Additional context to inject into the subagent's system prompt. */
  context: string;
  /**
   * Tool names the subagent may use: a permission ask for a call outside them
   * is refused (acp/runner-ceiling.ts). Empty sets no tool ceiling.
   */
  tools: string[];
  /** Paths (relative to the working directory) the subagent may write; empty or absent sets no path ceiling. */
  writeScope?: string[] | undefined;
  /** App-owned working directory for the spawned ACP session. */
  workingDirectory: string;
  /**
   * Whose input the subagent acts on, recorded from who started it (a runner the daemon starts: the cause of the
   * capability call that started it). Every ask of its own is decided as that party's turn (security/turn-input-party.ts):
   * started by anyone but the owner, it runs reads only. Absent: the starter's own turn decides it, as before.
   */
  inputParty?: { readonly party: 'owner' } | { readonly party: 'other'; readonly who: string } | undefined;
  /** Optional model override (e.g. "claude-sonnet-4-5"). */
  model?: string | undefined;
  /** Optional provider override (e.g. "anthropic"). */
  provider?: string | undefined;
  /** The session that dispatched the task; the subagent's events carry it. */
  sessionId?: string | undefined;
}

/**
 * The answer to an ACP permission request for the owner's decision: the
 * option whose declared `kind` matches it. An approval selects allow_once
 * (allow_always when the decision is remembered), a refusal reject_once
 * (reject_always when remembered). A remembered decision may narrow to once;
 * a one-shot decision never widens to an always option. When the agent offered no
 * option of the needed kind the request is answered cancelled, so an
 * approval is never sent as whatever option happens to come first.
 */
/** The fields of an ACP PermissionOption this answer reads. */
export interface AcpPermissionOptionLike {
  readonly optionId: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

const PERMISSION_OPTION_KINDS: ReadonlySet<string> = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/** An option list an answer can be chosen from: each option has an id and a known kind, and no id repeats. */
export function wellFormedPermissionOptions(options: unknown): options is readonly AcpPermissionOptionLike[] {
  if (!Array.isArray(options)) return false;
  const ids = new Set<string>();
  for (const option of options as unknown[]) {
    if (!option || typeof option !== 'object') return false;
    const { optionId, kind } = option as { optionId?: unknown; kind?: unknown };
    if (typeof optionId !== 'string' || !optionId || typeof kind !== 'string' || !PERMISSION_OPTION_KINDS.has(kind) || ids.has(optionId)) return false;
    ids.add(optionId);
  }
  return true;
}

export function permissionOutcomeFor(
  options: readonly AcpPermissionOptionLike[],
  decision: { readonly approved: boolean; readonly remember?: boolean | undefined; readonly rememberTier?: unknown },
): RequestPermissionResponse {
  if (new Set(options.map(option => option.optionId)).size !== options.length) return { outcome: { outcome: 'cancelled' } };
  const remembered = decision.remember === true || decision.rememberTier !== undefined;
  const kinds: readonly AcpPermissionOptionLike['kind'][] = decision.approved
    ? (remembered ? ['allow_always', 'allow_once'] : ['allow_once'])
    : (remembered ? ['reject_always', 'reject_once'] : ['reject_once']);
  for (const kind of kinds) {
    const matching = options.filter((candidate) => candidate.kind === kind);
    if (matching.length > 1) return { outcome: { outcome: 'cancelled' } };
    if (matching[0]) return { outcome: { outcome: 'selected', optionId: matching[0].optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * The text of an `agent_message_chunk` session update, or '' for any other
 * update. ACP sends `content` as ONE ContentBlock; an array of blocks is
 * tolerated so a lenient agent does not lose its text.
 */
export function messageChunkText(update: { sessionUpdate?: unknown; content?: unknown }): string {
  if (update.sessionUpdate !== 'agent_message_chunk') return '';
  const blocks: unknown[] = Array.isArray(update.content) ? update.content : [update.content];
  return blocks
    .filter((block): block is { type: string; text?: string } => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** Bound for the spawn, initialize and session/new handshake of an ACP child. */
export const ACP_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Reject with a labelled error when `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${ms}ms`)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

/**
 * The messages a child writes to stdout, one JSON value per line. The host owns
 * the other direction (the permission wire is the only serialiser of what is
 * sent to the child), so only the reading half of the SDK's ndjson stream is
 * needed and it is done here.
 */
export function readNdJsonMessages(input: ReadableStream<Uint8Array>): ReadableStream<unknown> {
  const decoder = new TextDecoder();
  // The line not yet ended, as the pieces it arrived in: each chunk is scanned once, and a long line is joined once.
  let pending: string[] = [];
  const emitLine = (line: string, controller: TransformStreamDefaultController<unknown>): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try { controller.enqueue(JSON.parse(trimmed) as unknown); }
    catch (error) { logger.warn('ACP child wrote a line that is not JSON; skipped', { line: trimmed.slice(0, 200), error: summarizeError(error) }); }
  };
  return input.pipeThrough(new TransformStream<Uint8Array, unknown>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      let start = 0;
      let end = text.indexOf('\n');
      if (end < 0) {
        if (text) pending.push(text);
        return;
      }
      pending.push(text.slice(0, end));
      emitLine(pending.join(''), controller);
      pending = [];
      start = end + 1;
      while ((end = text.indexOf('\n', start)) >= 0) {
        emitLine(text.slice(start, end), controller);
        start = end + 1;
      }
      if (start < text.length) pending.push(text.slice(start));
    },
    flush(controller) {
      pending.push(decoder.decode());
      emitLine(pending.join(''), controller);
      pending = [];
    },
  }));
}

/** The part of a spawned ACP child that stopping it needs. */
export interface AcpChildProcess {
  readonly pid?: number | undefined;
  readonly exited: Promise<unknown>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** How long a child gets to exit after SIGTERM before SIGKILL. */
export const ACP_CHILD_GRACE_MS = 250;
/** How long a child gets to exit after SIGKILL before it is reported as not reaped. */
export const ACP_CHILD_FORCED_EXIT_MS = 5000;

/**
 * The one way an ACP child is stopped: ask the agent to cancel (bounded),
 * SIGTERM, wait, SIGKILL, wait. Resolves once the process has exited; rejects,
 * naming the pid, when it is still there after SIGKILL.
 */
export async function stopAcpChild(child: AcpChildProcess, options: {
  readonly cancel?: (() => Promise<unknown>) | undefined;
  readonly graceMs?: number | undefined;
  readonly forcedExitMs?: number | undefined;
} = {}): Promise<void> {
  const graceMs = options.graceMs ?? ACP_CHILD_GRACE_MS;
  if (options.cancel) {
    try { await withTimeout(options.cancel(), graceMs, 'ACP cancel'); }
    catch (error) { logger.warn('ACP child did not take the cancel; terminating it', { pid: child.pid, error: summarizeError(error) }); }
  }
  try { child.kill('SIGTERM'); }
  catch (error) { logger.warn('ACP child could not be sent SIGTERM', { pid: child.pid, error: summarizeError(error) }); }
  try { await withTimeout(child.exited, graceMs, 'ACP child exit'); return; }
  catch { /* still running: escalate */ }
  try { child.kill('SIGKILL'); }
  catch (error) { logger.warn('ACP child could not be sent SIGKILL', { pid: child.pid, error: summarizeError(error) }); }
  const forcedExitMs = options.forcedExitMs ?? ACP_CHILD_FORCED_EXIT_MS;
  try { await withTimeout(child.exited, forcedExitMs, 'ACP child exit after SIGKILL'); }
  catch (error) {
    throw new Error(`ACP child process ${child.pid ?? '(unknown pid)'} did not report its exit after SIGKILL: ${summarizeError(error)}`, { cause: error });
  }
}

