import type { RemoteHostLogger, RemoteHostCredentialStore } from './context.js';
import type { PeerRegistry, PeerRecord } from './peer-registry.js';
import {
  type Backend,
  type BackendContext,
  type DispatchPayload,
  BackendDispatchError,
  createBackends,
} from './backends/create-backends.js';

// ---------------------------------------------------------------------------
// Invoke result, returned through remote.peers.invoke for a registered
// backend. The caller receives a bounded stdout/stderr preview and is told
// whether output was omitted and how large it was.
// ---------------------------------------------------------------------------

export const STDOUT_PREVIEW_LIMIT = 4_096;

export interface RemoteInvokeResult {
  peerId: string;
  backendKind: PeerRecord['backendKind'];
  /** The command's exit status; 124 when it ran past its time limit. */
  exitCode?: number | undefined;
  completed: boolean;
  stdout: string;
  stderr: string;
  /** UTF-8 byte length before preview truncation. */
  stdoutBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RemoteDispatcherOptions {
  registry: PeerRegistry;
  credentials: RemoteHostCredentialStore;
  logger: RemoteHostLogger;
  homeDirectory: string;
  /** Override the backend map (an embedder may supply its own runners). */
  backends?: Map<PeerRecord['backendKind'], Backend> | undefined;
}

export interface DispatchRequest {
  peerId: string;
  command: string;
  payload?: DispatchPayload | undefined;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Runs a remote.peers.invoke command on the backend a registered peer names
 * (docker, ssh, cloud terminal or a local process) and returns its exit code
 * and output. Backends and their credential scratch are built on the first
 * dispatch, so a host that never runs a backend command pays nothing for them.
 */
export class RemoteDispatcher {
  private readonly registry: PeerRegistry;
  private readonly backendContext: BackendContext;
  private readonly suppliedBackends: Map<PeerRecord['backendKind'], Backend> | undefined;
  private backendMap: Map<PeerRecord['backendKind'], Backend> | null = null;
  private readonly logger: RemoteHostLogger;
  private readonly active = new Set<Promise<RemoteInvokeResult>>();
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: RemoteDispatcherOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
    this.backendContext = {
      credentials: options.credentials,
      logger: options.logger,
      homeDirectory: options.homeDirectory,
    };
    this.suppliedBackends = options.backends ? new Map(options.backends) : undefined;
  }

  private backends(): Map<PeerRecord['backendKind'], Backend> {
    this.backendMap ??= this.suppliedBackends ?? createBackends(this.backendContext);
    return this.backendMap;
  }

  dispatch(request: DispatchRequest): Promise<RemoteInvokeResult> {
    const pending = Promise.resolve().then(() => this.performDispatch(request));
    this.active.add(pending);
    void pending.then(() => { this.active.delete(pending); }, () => { this.active.delete(pending); });
    return pending;
  }

  private assertOpen(): void {
    if (this.closed) throw new BackendDispatchError('Remote dispatcher has been closed.', 'REMOTE_DISPATCHER_CLOSED', 503);
  }

  private async performDispatch(request: DispatchRequest): Promise<RemoteInvokeResult> {
    this.assertOpen();
    const peerId = typeof request.peerId === 'string' ? request.peerId.trim() : '';
    if (peerId.length === 0) {
      throw new BackendDispatchError('peerId is required.', 'REMOTE_PEER_ID_REQUIRED', 400);
    }
    const command = typeof request.command === 'string' ? request.command : '';
    if (command.trim().length === 0) {
      throw new BackendDispatchError('command is required.', 'REMOTE_COMMAND_REQUIRED', 400);
    }
    // The registry may still be opening. Never treat cold initialization as a
    // missing peer or choose a fallback backend.
    await this.registry.init();
    this.assertOpen();
    const peer = this.registry.get(peerId);
    if (!peer) {
      throw new BackendDispatchError(
        `No registered backend with id '${peerId}'.`,
        'REMOTE_PEER_NOT_FOUND',
        404,
      );
    }
    const backend = this.backends().get(peer.backendKind);
    if (!backend) {
      throw new BackendDispatchError(
        `No backend available for kind '${peer.backendKind}'.`,
        'REMOTE_BACKEND_UNAVAILABLE',
      );
    }

    const result = await backend.dispatch(peer, command, request.payload);
    const fullStdout = result.stdout ?? '';
    const fullStderr = result.stderr ?? '';
    return {
      peerId: peer.peerId,
      backendKind: peer.backendKind,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      completed: true,
      stdout: truncate(fullStdout, STDOUT_PREVIEW_LIMIT),
      stderr: truncate(fullStderr, STDOUT_PREVIEW_LIMIT),
      stdoutBytes: Buffer.byteLength(fullStdout, 'utf8'),
      stdoutTruncated: fullStdout.length > STDOUT_PREVIEW_LIMIT,
      stderrTruncated: fullStderr.length > STDOUT_PREVIEW_LIMIT,
    };
  }

  /**
   * Close admission, stop every backend that was built, and await accepted
   * dispatches. Backend cleanup failures are reported without exception or
   * credential text; shutdown never closes the caller-owned registry.
   */
  teardown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Store the promise before invoking teardown hooks, which may be reentrant.
    this.closing = Promise.resolve().then(async () => {
      const stops = [...(this.backendMap?.values() ?? [])].map(async (backend) => {
        try { await backend.teardown?.(); }
        catch {
          try { this.logger.warn('remote backend cleanup failed', { backendKind: backend.kind }); }
          catch { /* Logging must not interrupt other owned cleanup. */ }
        }
      });
      // Start stops first: an active child may need its backend's abort signal
      // before dispatch can settle.
      await Promise.allSettled([...stops, ...this.active]);
    });
    return this.closing;
  }
}
