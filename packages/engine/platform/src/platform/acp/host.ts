import { prepareExternalExecution } from '../permissions/external-execution.js';
import { AcpPermissionWire } from './permission-wire.js';
/**
 * acp/host.ts, HOSTING third-party coding agents over the Agent Client
 * Protocol.
 *
 * The existing acp/ modules make GoodVibes an ACP *agent* (agent.ts) and spawn
 * short-lived ACP *subagents* (connection.ts/manager.ts). This module is the
 * daemon-side HOST: it discovers installed third-party coding agents (Claude
 * Code, Codex CLI, opencode), spawns one over stdio as a LONG-LIVED session,
 * and exposes the lifecycle a fleet row needs, prompt (steer) and stop, so a
 * hosted agent is visible, steerable, and stoppable exactly like a native row.
 * Permission asks are decided autonomously, so no row ever waits on a human.
 *
 * Honesty contract:
 *  - Discovery is READ-ONLY (PATH + known install directories; no execution).
 *    Absence is quiet, an empty list, never a nag.
 *  - A binary that fails the ACP handshake yields a STRUCTURED error (which
 *    binary, which stage, what happened) on a 'failed' record, never a hung
 *    row. Spawn/initialize/session are bounded by a handshake timeout.
 *  - Permission requests use the canonical recorded autonomous admission
 *    against the current host prompt, policy, session and exact request. No
 *    human approval callback is used; unavailable authority cancels the ask.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
// `@agentclientprotocol/sdk` is an optionalDependency. This module is on the
// daemon's graph, so a static import of its values made an absent optional
// package a daemon that does not exist; the values come off the awaited module
// in acp/optional-acp-library.ts at connection time instead. The type import is erased.
import { loadAcpLibrary } from './optional-acp-library.js';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type { Agent, Client, NewSessionResponse, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from './protocol.js';
import { ACP_HANDSHAKE_TIMEOUT_MS, drainStderrTail, messageChunkText, permissionOutcomeFor, readNdJsonMessages, stopAcpChild, wellFormedPermissionOptions, withTimeout } from './protocol.js';
import { admitExternalRequest, externalAskDeadlineMs, type ExternalPermissionHost } from '../permissions/external-request.js';
import { captureAutonomousSource, type AutonomousToolSource } from '../permissions/autonomous.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { VERSION } from '../version.js';
import { ACP_HOST_ERROR_STAGES, HOSTED_ACP_STATES } from './hosted-agent-states.js';

// ── Discovery ────────────────────────────────────────────────────────────────

/** One known third-party ACP-capable coding agent and how to launch its ACP mode. */
export interface KnownAcpAgent {
  readonly id: string;
  readonly title: string;
  /** Launch candidates, first found wins: binary name + the args that start ACP stdio mode. */
  readonly candidates: ReadonlyArray<{ readonly binary: string; readonly args: readonly string[] }>;
}

/**
 * The known agents table. The ACP launch shape per agent:
 *  - Claude Code speaks ACP through its dedicated adapter binary
 *    (`claude-code-acp`, the officially published bridge). The bare `claude`
 *    binary is deliberately NOT a candidate: it has no ACP mode (verified
 *    live), and advertising it would offer a spawn that always fails.
 *  - Codex CLI exposes `codex acp` (experimental) on recent builds.
 *  - opencode serves ACP via `opencode acp` (verified live end-to-end).
 * A wrong/outdated launch shape is not a hazard: the handshake timeout turns
 * it into a structured 'failed' record, never a hung row.
 */
export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  { id: 'claude-code', title: 'Claude Code', candidates: [{ binary: 'claude-code-acp', args: [] }] },
  { id: 'codex', title: 'Codex CLI', candidates: [{ binary: 'codex', args: ['acp'] }] },
  { id: 'opencode', title: 'opencode', candidates: [{ binary: 'opencode', args: ['acp'] }] },
];

/** A discovered, spawnable third-party agent: which binary resolved and how to launch it. */
export interface DiscoveredAcpAgent {
  readonly id: string;
  readonly title: string;
  readonly binaryPath: string;
  readonly args: readonly string[];
}

/** Injectable probes so discovery is testable without touching the real filesystem. */
export interface DiscoveryIo {
  readonly fileExists: (path: string) => boolean;
  readonly envPath: () => string;
  readonly home: () => string;
}

const defaultDiscoveryIo: DiscoveryIo = {
  fileExists: (path) => existsSync(path),
  envPath: () => process.env.PATH ?? '',
  home: () => homedir(),
};

/** Known install directories checked IN ADDITION to $PATH (read-only). */
function knownInstallDirs(io: DiscoveryIo): string[] {
  const home = io.home();
  return [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
}

/**
 * Discover installed third-party ACP-capable agents. READ-ONLY: existence
 * checks over $PATH entries and known install directories, no process is ever
 * executed. Returns only what is present; absence is a quiet empty list.
 */
export function discoverAcpAgents(io: DiscoveryIo = defaultDiscoveryIo): DiscoveredAcpAgent[] {
  const dirs = [...io.envPath().split(delimiter).filter(Boolean), ...knownInstallDirs(io)];
  const seen = new Set<string>();
  const uniqueDirs = dirs.filter((dir) => (seen.has(dir) ? false : (seen.add(dir), true)));
  const found: DiscoveredAcpAgent[] = [];
  for (const agent of KNOWN_ACP_AGENTS) {
    for (const candidate of agent.candidates) {
      const dir = uniqueDirs.find((d) => io.fileExists(join(d, candidate.binary)));
      if (dir) {
        found.push({ id: agent.id, title: agent.title, binaryPath: join(dir, candidate.binary), args: candidate.args });
        break; // first candidate wins per agent
      }
    }
  }
  return found;
}

// ── Hosted sessions ──────────────────────────────────────────────────────────

export { ACP_HOST_ERROR_STAGES, HOSTED_ACP_STATES };

/**
 * Lifecycle state of a hosted third-party agent session. There is no waiting
 * state: permission asks are decided by the autonomous admission, not by a
 * person, so no hosted row waits on a human.
 */
export type HostedAcpState = typeof HOSTED_ACP_STATES[number];

/** The structured, user-renderable handshake/spawn failure, never a bare string. */
export interface AcpHostError {
  /** The binary that was launched. */
  readonly binary: string;
  /** Which stage failed: spawning the process, the ACP initialize, session creation, or a prompt. */
  readonly stage: typeof ACP_HOST_ERROR_STAGES[number];
  readonly message: string;
}

/** One hosted third-party agent session, as the fleet adapter reads it. */
export interface HostedAcpAgent {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly state: HostedAcpState;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  /** The daemon shared-session id this hosted agent is mapped onto. */
  readonly sessionId?: string | undefined;
  /** Latest streamed output tail (bounded), for the row's activity line. */
  readonly progress?: string | undefined;
  /** When the output tail last grew. */
  readonly progressAt?: number | undefined;
  /** Present when state === 'failed'. */
  readonly error?: AcpHostError | undefined;
  /** The last permission ask or prompt that was refused without a decision on its merits, and why. */
  readonly lastRefusal?: AcpHostRefusal | undefined;
  readonly promptCount: number;
}

/** A refusal the row shows: an ask that timed out, lost its owner or was malformed, or a prompt that could not start. */
export interface AcpHostRefusal {
  readonly at: number;
  readonly reason: string;
}

interface HostedRecord {
  info: {
    id: string; agentId: string; title: string; binaryPath: string; cwd: string;
    state: HostedAcpState; startedAt: number; completedAt?: number | undefined;
    sessionId?: string | undefined; progress?: string | undefined; progressAt?: number | undefined;
    error?: AcpHostError | undefined; lastRefusal?: AcpHostRefusal | undefined; promptCount: number;
  };
  child: ReturnType<typeof Bun.spawn> | null;
  conn: ClientSideConnection | null;
  acpSessionId: string | null;
  lifetime: AbortController;
  operation?: { readonly source: AutonomousToolSource; readonly lifetime: AbortController } | undefined;
  readonly permissionRequests: Map<string, AbortController>;
  permissionWire?: AcpPermissionWire | undefined;
  /** The workspace trust revision captured at spawn: integer compares, no path resolution. */
  assertWorkspaceCurrent?: (() => void) | undefined;
  teardownPromise?: Promise<void> | undefined;
  teardownState?: 'pending' | 'done' | 'failed' | undefined;
}

/** Registers/heartbeats the daemon shared session a hosted agent maps onto. */
export type AcpSessionRegistrar = (input: {
  readonly id: string;
  readonly title: string;
  readonly agentTitle: string;
  readonly cwd: string;
}) => void;

export interface AcpHostServiceDeps {
  /** Canonical recorded autonomous owner. No configured owner means fail closed. */
  readonly permissionHost?: ExternalPermissionHost | undefined;
  /** Maps the hosted agent onto a daemon shared session (kind 'acp'). Optional, narrower embeds skip it. */
  readonly registerSession?: AcpSessionRegistrar | undefined;
  /** Injectable spawn seam for tests. Defaults to Bun.spawn. */
  readonly spawn?: ((cmd: string[], opts: { cwd: string }) => ReturnType<typeof Bun.spawn>) | undefined;
  /** Handshake bound (spawn→initialize→session). Default 15s, a bad binary becomes a structured failure, never a hung row. */
  readonly handshakeTimeoutMs?: number | undefined;
  /**
   * The fleet ceiling (fleet.maxSize): returns why a new hosted session would
   * exceed it, counting every agent this process owns, or undefined when it fits.
   * Checked synchronously right before the session is recorded.
   */
  readonly admitSession?: (() => string | undefined) | undefined;
  readonly now?: (() => number) | undefined;
}

const PROGRESS_TAIL_CHARS = 400;

/** A hosted session refused because the fleet ceiling (fleet.maxSize) is reached; nothing was started. */
export class AcpFleetCapacityError extends Error {
  override readonly name = 'AcpFleetCapacityError';
}

export class AcpHostService {
  private readonly records = new Map<string, HostedRecord>();
  private readonly deps: AcpHostServiceDeps;
  private readonly now: () => number;

  constructor(deps: AcpHostServiceDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  list(): HostedAcpAgent[] {
    return [...this.records.values()].map((record) => ({ ...record.info }));
  }

  get(id: string): HostedAcpAgent | null {
    const record = this.records.get(id);
    return record ? { ...record.info } : null;
  }

  /**
   * Spawn a discovered agent into a working directory as a hosted session.
   * Resolves once the ACP handshake + session creation completed (state
   * 'idle', ready for prompts) or failed (state 'failed' with the structured
   * error). An initial prompt, when given, is fired after the handshake
   * without being awaited, the row streams like any live agent.
   */
  async spawnAgent(input: {
    readonly agent: DiscoveredAcpAgent;
    readonly cwd: string;
    readonly title?: string | undefined;
    readonly prompt?: string | undefined;
  }): Promise<HostedAcpAgent> {
    input = structuredClone(input);
    const host = this.deps.permissionHost;
    host?.signal.throwIfAborted();
    const configuration = new AbortController();
    const unsubscribe = host?.config.onDidInvalidate(() => configuration.abort()) ?? (() => {});
    const signal = AbortSignal.any([configuration.signal, ...(host ? [host.signal] : [])]);
    let assertWorkspaceCurrent: (() => void) | undefined;
    try { assertWorkspaceCurrent = host ? await prepareExternalExecution(host, input.cwd, signal) : undefined; }
    catch (error) { unsubscribe(); throw error; }
    const assertSpawnCurrent = () => { signal.throwIfAborted(); assertWorkspaceCurrent?.(); };
    const refusal = this.deps.admitSession?.();
    if (refusal !== undefined) { unsubscribe(); throw new AcpFleetCapacityError(refusal); }
    const id = `acp-host-${randomUUID().slice(0, 10)}`;
    const sessionId = `acp-${id}`;
    const record: HostedRecord = {
      info: {
        id,
        agentId: input.agent.id,
        title: input.title ?? `${input.agent.title}: ${input.cwd}`,
        binaryPath: input.agent.binaryPath,
        cwd: input.cwd,
        state: 'starting',
        startedAt: this.now(),
        promptCount: 0,
      },
      child: null,
      conn: null,
      acpSessionId: null,
      lifetime: new AbortController(),
      permissionRequests: new Map(),
      assertWorkspaceCurrent,
    };
    this.records.set(id, record);
    const timeoutMs = this.deps.handshakeTimeoutMs ?? ACP_HANDSHAKE_TIMEOUT_MS;
    const spawn = this.deps.spawn ?? ((cmd: string[], opts: { cwd: string }) => Bun.spawn(cmd, { ...opts, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));

    let stage: AcpHostError['stage'] = 'spawn';
    try {
      // Inside the try, so an install without the optional ACP package fails
      // this one session start with a message naming it, reported through the
      // same AcpHostError path as a spawn failure.
      const { ClientSideConnection } = await loadAcpLibrary();
      record.lifetime.signal.throwIfAborted();
      assertSpawnCurrent();
      record.child = spawn([input.agent.binaryPath, ...input.agent.args], { cwd: input.cwd });
      const ownedChild = record.child;
      // An unread stderr pipe fills and blocks a chatty child; keep its tail for the exit message.
      const stderr = drainStderrTail(ownedChild.stderr);
      void ownedChild.exited.then(() => {
        if (record.child !== ownedChild || record.lifetime.signal.aborted) return;
        record.info.state = 'failed'; record.info.completedAt = this.now();
        record.info.error = { binary: record.info.binaryPath, stage: 'prompt', message: stderr.tail() ? `Hosted ACP process exited (stderr: ${stderr.tail()})` : 'Hosted ACP process exited' };
        this.teardown(record);
      }, () => { if (record.child === ownedChild) this.teardown(record); });
      if (!record.child.stdin || !record.child.stdout) {
        throw new Error('subprocess stdio not available (stdin/stdout must be piped)');
      }
      const bunStdin = record.child.stdin as import('bun').FileSink;
      // An ask belongs to the prompt that was running when it arrived: a late
      // ask must not borrow a newer prompt's goal. Config, trust and deadline
      // are the admission's to check; this scope is only that binding.
      record.permissionWire = new AcpPermissionWire(() => {
        const operation = record.operation;
        const assertCurrent = () => {
          record.lifetime.signal.throwIfAborted();
          if (!operation || record.operation !== operation || record.child !== ownedChild) throw new Error('the prompt that raised this ask has ended');
          operation.lifetime.signal.throwIfAborted();
        };
        return { assertCurrent, close: () => {} };
      }, (reason) => { if (!record.lifetime.signal.aborted) this.noteRefusal(record, reason); });
      const stdout = readNdJsonMessages(record.child.stdout as unknown as ReadableStream<Uint8Array>);
      type WireMessage = typeof stdout extends ReadableStream<infer Message> ? Message : never;
      const readable = stdout.pipeThrough(new TransformStream<WireMessage, WireMessage>({ transform(message, controller) {
        record.permissionWire!.observe(message); controller.enqueue(message);
      } }));
      // Own the final message sink rather than relying on the SDK's async
      // serializer: its queued write could otherwise outlive an act decision.
      const writable = new WritableStream<WireMessage>({
        write(message) { record.permissionWire!.write(message, bytes => { bunStdin.write(bytes); }); },
        close() { bunStdin.end(); }, abort() { bunStdin.end(); },
      });
      record.conn = new ClientSideConnection((_agent: Agent) => this.buildClient(record), { readable, writable });

      stage = 'initialize';
      await withTimeout(record.conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'goodvibes-daemon', version: VERSION },
        clientCapabilities: {},
      }), timeoutMs, 'ACP initialize');

      record.lifetime.signal.throwIfAborted();
      assertSpawnCurrent();
      stage = 'session';
      const session = await withTimeout<NewSessionResponse>(record.conn.newSession({ cwd: input.cwd, mcpServers: [] }), timeoutMs, 'ACP session/new');
      record.lifetime.signal.throwIfAborted();
      assertSpawnCurrent();
      record.acpSessionId = session.sessionId;

      record.info.sessionId = sessionId;
      record.info.state = 'idle';
      try {
        this.deps.registerSession?.({ id: sessionId, title: record.info.title, agentTitle: input.agent.title, cwd: input.cwd });
      } catch (error) {
        logger.warn('AcpHostService: shared-session registration failed', { id, error: summarizeError(error) });
      }
      if (input.prompt) {
        const first = this.prompt(id, input.prompt);
        if (!first.queued) this.noteRefusal(record, `The first prompt was not sent: ${first.reason}`);
      }
      return { ...record.info };
    } catch (error) {
      if (record.info.state === 'stopped') { await this.teardown(record); return { ...record.info }; }
      record.info.state = 'failed';
      record.info.completedAt = this.now();
      record.info.error = {
        binary: input.agent.binaryPath,
        stage,
        message: summarizeError(error),
      };
      await this.teardown(record);
      return { ...record.info };
    } finally { unsubscribe(); }
  }

  /**
   * Send a prompt (a steer) to a hosted agent's live ACP session. Honest
   * refusal for a row that cannot take one. Resolves queued immediately; the
   * turn streams in the background and the state returns to 'idle' when the
   * agent's turn ends.
   */
  prompt(id: string, text: string): { queued: true } | { queued: false; reason: string } {
    if (this.deps.permissionHost?.signal.aborted) return { queued: false, reason: 'hosted agent owner is closed' };
    const record = this.records.get(id);
    if (!record) return { queued: false, reason: 'no such hosted agent' };
    try { record.assertWorkspaceCurrent?.(); } catch (error) { return { queued: false, reason: summarizeError(error) }; }
    if (!record.conn || !record.acpSessionId) return { queued: false, reason: 'hosted agent has no live ACP session' };
    if (record.info.state === 'failed' || record.info.state === 'stopped') {
      return { queued: false, reason: `hosted agent is ${record.info.state}` };
    }
    // ACP permission requests identify the session, not their originating prompt.
    // Two overlapping prompts would let a late ask borrow the newer goal.
    if (record.operation && !record.operation.lifetime.signal.aborted) return { queued: false, reason: 'hosted agent already has an active prompt' };
    const operation = { source: captureAutonomousSource({ goal: text, criteria: [] }), lifetime: new AbortController() };
    record.operation = operation;
    record.info.state = 'prompting';
    record.info.promptCount += 1;
    const conn = record.conn;
    const sessionId = record.acpSessionId;
    void conn.prompt({ sessionId, prompt: [{ type: 'text' as const, text }] })
      .then((response: PromptResponse) => {
        if (record.operation !== operation) return;
        operation.lifetime.abort();
        if (record.info.state === 'prompting') {
          // A cancelled turn ends the turn, not the session: the child and the
          // connection are still alive, so the row goes back to idle (promptable,
          // not dismissable) rather than 'stopped', which would refuse prompts
          // while still owning a child and let a later exit rewrite it as 'failed'.
          // Only stop() or a failure tears the session down.
          record.info.state = 'idle';
        }
      })
      .catch((error: unknown) => {
        if (record.operation !== operation) return;
        operation.lifetime.abort();
        if (record.info.state === 'stopped') return; // stop() raced the in-flight turn, not a failure
        record.info.state = 'failed';
        record.info.completedAt = this.now();
        record.info.error = { binary: record.info.binaryPath, stage: 'prompt', message: summarizeError(error) };
        this.teardown(record);
      });
    return { queued: true };
  }

  /** Stop a hosted agent and await its single owned child-drain promise. */
  async stop(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    const wasRunning = record.info.state !== 'stopped' && record.info.state !== 'failed';
    const connection = record.conn, sessionId = record.acpSessionId;
    if (wasRunning) {
      record.info.state = 'stopped';
      record.info.completedAt = this.now();
    }
    await this.teardown(record, wasRunning && connection && sessionId
      ? () => connection.cancel({ sessionId }) : undefined);
    return wasRunning;
  }

  /** Drop terminal records (a panel dismiss); live rows are untouched. */
  dismiss(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.info.state !== 'stopped' && record.info.state !== 'failed') return false;
    // A row whose child is still being stopped stays until that ends.
    if (record.teardownState === 'pending') return false;
    if (record.teardownState === 'failed' && record.child) {
      // Everything that could be done was done; the row says which process is left, then goes.
      logger.warn('AcpHostService: dismissed a hosted agent whose process could not be reaped', { id, pid: record.child.pid, binary: record.info.binaryPath });
    } else if (record.child) return false;
    this.records.delete(id);
    return true;
  }

  private teardown(record: HostedRecord, cancel?: () => Promise<void>): Promise<void> {
    if (record.teardownPromise) return record.teardownPromise;
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const owned = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    // Published before any authority is revoked, so a callback that reenters stop shares it.
    record.teardownPromise = owned;
    record.teardownState = 'pending';
    const child = record.child;
    record.conn = null;
    record.acpSessionId = null;
    record.lifetime.abort();
    record.operation?.lifetime.abort();
    let wireError: unknown;
    try { record.permissionWire?.close(); } catch (error) { wireError = error; }
    void (async () => {
      if (child) {
        await stopAcpChild(child, { ...(cancel ? { cancel } : {}) });
        if (record.child === child) record.child = null;
      }
      if (wireError !== undefined) throw new AggregateError([wireError], 'Hosted ACP permission cleanup failed');
    })().then(() => { record.teardownState = 'done'; complete(); }, (error: unknown) => {
      record.teardownState = 'failed';
      logger.warn('AcpHostService: child drainage failed', { id: record.info.id, pid: child?.pid, error: summarizeError(error) });
      fail(error);
    });
    // Prompt and exit callbacks start the same teardown without awaiting it; stop awaits and reports it.
    void owned.catch(() => {});
    return owned;
  }

  /** Record why an ask or prompt was refused without a decision on its merits; logged once, shown on the row. */
  private noteRefusal(record: HostedRecord, reason: string): void {
    record.info.lastRefusal = { at: this.now(), reason };
    logger.warn('AcpHostService: refused', { id: record.info.id, binary: record.info.binaryPath, reason });
  }

  private buildClient(record: HostedRecord): Client {
    return {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
        const refuse = (reason: string): RequestPermissionResponse => { this.noteRefusal(record, reason); return cancelled; };
        // The wire captured this exact request when it arrived; the binding is
        // that capture, so the ask is read once. Descriptor reads take the id
        // without invoking a remote getter.
        let binding: ReturnType<AcpPermissionWire['binding']>;
        try {
          const call = Object.getOwnPropertyDescriptor(params, 'toolCall')?.value as unknown;
          const id = call && typeof call === 'object' ? Object.getOwnPropertyDescriptor(call, 'toolCallId')?.value as unknown : undefined;
          if (typeof id === 'string') binding = record.permissionWire?.binding(id);
          binding?.bindTerminal(cancelled);
        } catch { return refuse('the permission ask could not be read'); }
        if (record.lifetime.signal.aborted) return cancelled;
        const host = this.deps.permissionHost;
        const operation = record.operation;
        if (!host) return refuse('no permission owner is configured for hosted agents, so asks cannot be decided');
        if (!operation || operation.lifetime.signal.aborted) return refuse('a permission ask arrived while no prompt was running');
        const owned = binding?.request;
        if (!binding || !owned || !binding.protocolSubject) return refuse('the permission ask was not a well-formed ACP request');
        const requestId = owned.toolCall?.toolCallId;
        if (owned.sessionId !== record.acpSessionId || typeof requestId !== 'string' || !requestId || !wellFormedPermissionOptions(owned.options))
          return refuse('the permission ask named another session or offered malformed options');
        const previous = record.permissionRequests.get(requestId);
        if (previous) { previous.abort(); return refuse(`the agent reused tool call id ${requestId} while its first ask was pending`); }
        const requestLife = new AbortController();
        record.permissionRequests.set(requestId, requestLife);
        const deadlineMs = externalAskDeadlineMs(host);
        const deadline = AbortSignal.timeout(deadlineMs);
        // The one owner of "this ask is still wanted": the row, the prompt, this
        // request, the wire binding and the deadline all abort this signal.
        const signal = AbortSignal.any([record.lifetime.signal, operation.lifetime.signal, requestLife.signal, binding.signal, deadline]);
        const wire = binding;
        const assertCurrent = () => { signal.throwIfAborted(); wire.assertCurrent(); record.assertWorkspaceCurrent?.(); };
        let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
        let deferred = false;
        const cleanup = () => {
          if (record.permissionRequests.get(requestId) === requestLife) record.permissionRequests.delete(requestId);
          requestLife.abort();
        };
        try {
          assertCurrent();
          admission = await admitExternalRequest(host, { connectionId: record.info.id, destination: record.info.binaryPath, signal, assertCurrent },
            { sourceOf: () => operation.source, assertCurrent: () => {} }, {
              tool: owned.toolCall.title ?? 'ACP action', protocolSubject: wire.protocolSubject!,
              args: { ...(owned.toolCall.rawInput && typeof owned.toolCall.rawInput === 'object' && !Array.isArray(owned.toolCall.rawInput)
                ? owned.toolCall.rawInput as Record<string, unknown> : {}),
                destination: { binaryPath: record.info.binaryPath, cwd: record.info.cwd } },
            });
          const response = permissionOutcomeFor(owned.options, { approved: admission.result.approved, remember: false });
          // The wire checks once more, immediately before the response bytes are written.
          wire.defer(response, admission, admission.result.approved && response.outcome.outcome === 'selected', cleanup);
          deferred = true;
          return response;
        } catch (error) {
          if (record.lifetime.signal.aborted || operation.lifetime.signal.aborted) return cancelled;
          return refuse(deadline.aborted
            ? `the permission decision did not arrive within ${deadlineMs} ms ("Longest a waiting decision may take" in /settings open)`
            : `the permission ask could not be decided: ${summarizeError(error)}`);
        } finally {
          if (!deferred) { admission?.close(); cleanup(); }
        }
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const text = messageChunkText(params.update as { sessionUpdate?: unknown; content?: unknown });
        if (text) {
          record.info.progress = ((record.info.progress ?? '') + text).slice(-PROGRESS_TAIL_CHARS);
          record.info.progressAt = this.now();
        }
      },
    };
  }
}
