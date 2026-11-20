import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolveGoodVibesTreeDirectory } from '@goodvibes/engine/platform/platform/config';
import { resolveVerificationHostUrl } from '@goodvibes/engine/terminal-shell/verification-primitives';
import {
  type DistributedNodeHostContract,
  type DistributedPeerKind,
  type DistributedPeerRecord,
  type DistributedPeerTokenRecord,
  type DistributedPendingWork,
  type DistributedRuntimePairRequest,
} from '@/runtime/index.ts';

export interface ReferenceNodeHostConfig {
  readonly baseUrl: string;
  readonly label: string;
  readonly requestedId: string;
  readonly peerKind: DistributedPeerKind;
  readonly platform?: string;
  readonly deviceFamily?: string;
  readonly version?: string;
  readonly clientMode?: string;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly allowedCommands?: readonly string[];
  readonly heartbeatIntervalMs: number;
  readonly workPullIntervalMs: number;
  readonly pairingRetryMs: number;
  readonly verifyTimeoutMs: number;
  readonly maxWorkItemsPerPull: number;
  readonly statePath: string;
  readonly operatorToken?: string;
  /**
   * The requested id is fixed per host, so a re-pair names the peer this host already registered and the daemon
   * refuses to replace it unless the approval confirms it. Retry with confirmation after that refusal (default true;
   * set false to leave such an approval to a human operator).
   */
  readonly confirmReplace?: boolean;
  readonly workLeaseMs?: number;
}

export interface ReferenceNodeHostState {
  readonly contract?: DistributedNodeHostContract;
  readonly pairRequest?: DistributedRuntimePairRequest;
  readonly challenge?: string;
  readonly pairRequestedAt?: number;
  readonly peer?: DistributedPeerRecord;
  readonly token?: DistributedPeerTokenRecord & { readonly value: string };
  readonly lastHeartbeatAt?: number;
  readonly lastWorkPullAt?: number;
  readonly lastError?: string;
}

export interface ReferenceNodeHostRunSummary {
  readonly paired: boolean;
  readonly heartbeated: boolean;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
}

export interface WorkExecutionResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly result?: unknown;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Executes one claimed work item whose command is allowlisted. */
export type ReferenceNodeHostWorkHandler = (work: DistributedPendingWork, command: string) => Promise<WorkExecutionResult>;

/**
 * Real execution for the work types the reference host cannot answer from what it already knows. Without a handler,
 * such an item is reported failed with the reason, never completed.
 */
export interface ReferenceNodeHostHandlers {
  readonly 'automation.run'?: ReferenceNodeHostWorkHandler;
  readonly invoke?: ReferenceNodeHostWorkHandler;
}

export interface PairRequestResponse {
  readonly request: DistributedRuntimePairRequest;
  readonly challenge: string;
}

export interface PairVerifyResponse {
  readonly peer: DistributedPeerRecord;
  readonly token: DistributedPeerTokenRecord & { readonly value: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expandHome(input: string): string {
  if (input === '~') return process.env.HOME ?? input;
  if (input.startsWith('~/')) return resolve(process.env.HOME ?? '', input.slice(2));
  return input;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeList(values: readonly string[] | undefined, fallback: readonly string[]): string[] {
  const source = values && values.length > 0 ? values : fallback;
  return [...new Set(source.map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** Null when the file is absent; throws when it exists but is not JSON, so the caller decides what happens to it. */
async function readJsonFile<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(raw) as T;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  // The state file holds the peer's bearer token: owner-only, whatever the umask.
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmpPath, path);
}

/** A non-2xx answer from the host, so callers can tell a refused credential from a transient failure. */
class HostRejectedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

class ExponentialBackoff {
  private attempt = 0;

  constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
    private readonly jitterRatio = 0.2,
  ) {}

  reset(): void {
    this.attempt = 0;
  }

  nextDelay(): number {
    this.attempt += 1;
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, this.attempt - 1));
    const jitter = Math.floor(exponential * this.jitterRatio * Math.random());
    return Math.min(this.maxDelayMs, exponential + jitter);
  }
}

export class ReferenceNodeHostClient {
  private readonly stateFile: string;
  private state: ReferenceNodeHostState = {};
  private contract: DistributedNodeHostContract | null = null;
  private readonly backoff: ExponentialBackoff;
  private stopped = false;
  private ready = false;
  /** Whether the state file was read; a save before it would replace the saved pairing with only this call's fields. */
  private loaded = false;

  constructor(
    private readonly config: ReferenceNodeHostConfig,
    private readonly handlers: ReferenceNodeHostHandlers = {},
  ) {
    this.stateFile = expandHome(config.statePath);
    this.backoff = new ExponentialBackoff(config.pairingRetryMs, config.verifyTimeoutMs);
  }

  getState(): ReferenceNodeHostState {
    return { ...this.state };
  }

  getContract(): DistributedNodeHostContract | null {
    return this.contract;
  }

  async loadState(): Promise<void> {
    let loaded: ReferenceNodeHostState | null = null;
    let unreadable: string | undefined;
    try {
      loaded = await readJsonFile<ReferenceNodeHostState>(this.stateFile);
    } catch (error) {
      // Keep the unreadable file for the owner instead of overwriting it, and say so in the state.
      const keptAs = `${this.stateFile}.corrupt-${Date.now()}`;
      await rename(this.stateFile, keptAs);
      unreadable = `State file could not be read (${error instanceof Error ? error.message : String(error)}); kept as ${keptAs}. Pairing again.`;
    }
    this.state = loaded ?? (unreadable === undefined ? {} : { lastError: unreadable });
    this.loaded = true;
    if (this.state.contract) {
      this.contract = this.state.contract;
    }
  }

  async saveState(): Promise<void> {
    await writeJsonFile(this.stateFile, this.state);
  }

  stop(): void {
    this.stopped = true;
  }

  async fetchContract(): Promise<DistributedNodeHostContract> {
    // The saved pairing (peer, token) is kept: the state is read before it is written.
    if (!this.loaded) await this.loadState();
    const response = await fetch(new URL('/api/remote/node-host/contract', this.config.baseUrl).toString(), {
      headers: this.operatorHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch node-host contract (${response.status})`);
    }
    const payload = await response.json() as { contract?: DistributedNodeHostContract };
    if (!payload.contract) {
      throw new Error('Node-host contract response missing contract payload');
    }
    this.contract = payload.contract;
    this.state = { ...this.state, contract: payload.contract };
    await this.saveState();
    return payload.contract;
  }

  async requestPairing(): Promise<PairRequestResponse> {
    if (!this.loaded) await this.loadState();
    const body = {
      peerKind: this.config.peerKind,
      requestedId: this.config.requestedId,
      label: this.config.label,
      platform: this.config.platform,
      deviceFamily: this.config.deviceFamily,
      version: this.config.version,
      clientMode: this.config.clientMode,
      capabilities: [...this.config.capabilities],
      commands: [...this.config.commands],
      metadata: {
        client: 'reference-node-host',
        hostname: hostname(),
        ...(this.config.clientMode ? { clientMode: this.config.clientMode } : {}),
      },
    };
    const response = await fetch(new URL('/api/remote/pair/request', this.config.baseUrl).toString(), {
      method: 'POST',
      headers: this.operatorHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Pair request failed (${response.status})`);
    }
    const payload = await response.json() as PairRequestResponse;
    this.state = {
      ...this.state,
      pairRequest: payload.request,
      challenge: payload.challenge,
      pairRequestedAt: Date.now(),
      lastError: undefined,
    };
    await this.saveState();
    return payload;
  }

  async approvePairRequest(note = 'reference node-host approval'): Promise<boolean> {
    if (!this.config.operatorToken || !this.state.pairRequest?.id) return false;
    const url = new URL(`/api/remote/pair/requests/${encodeURIComponent(this.state.pairRequest.id)}/approve`, this.config.baseUrl).toString();
    const approve = (confirmReplace: boolean): Promise<Response> => fetch(url, {
      method: 'POST',
      headers: this.operatorHeaders(),
      body: JSON.stringify({ note, ...(confirmReplace ? { confirmReplace: true } : {}) }),
    });
    const response = await approve(false);
    if (response.status !== 409 || this.config.confirmReplace === false) return response.ok;
    const refusal = await response.json().catch(() => null) as { code?: unknown } | null;
    if (refusal?.code !== 'REMOTE_PAIR_REPLACES_PEER') return false;
    return (await approve(true)).ok;
  }

  async verifyPairing(): Promise<boolean> {
    if (!this.state.pairRequest?.id || !this.state.challenge) return false;
    const ageMs = Date.now() - (this.state.pairRequestedAt ?? 0);
    if (ageMs > this.config.verifyTimeoutMs) {
      this.state = {
        ...this.state,
        pairRequest: undefined,
        challenge: undefined,
        pairRequestedAt: undefined,
        lastError: `Pair request expired after ${ageMs}ms`,
      };
      await this.saveState();
      return false;
    }
    const response = await fetch(new URL('/api/remote/pair/verify', this.config.baseUrl).toString(), {
      method: 'POST',
      headers: this.operatorHeaders(),
      body: JSON.stringify({
        requestId: this.state.pairRequest.id,
        challenge: this.state.challenge,
      }),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`Pair verification failed (${response.status})`);
    }
    const payload = await response.json() as PairVerifyResponse;
    this.state = {
      ...this.state,
      peer: payload.peer,
      token: payload.token,
      lastError: undefined,
    };
    await this.saveState();
    return true;
  }

  async ensureSession(): Promise<boolean> {
    if (!this.ready) {
      await this.loadState();
      if (!this.contract) {
        try {
          await this.fetchContract();
        } catch (error) {
          this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) };
          await this.saveState();
          return false;
        }
      }
      this.ready = true;
    }

    if (this.state.token?.value) {
      // The heartbeat interval is applied here and nowhere else: a stored token is re-proven only when one is due.
      const due = !this.state.peer || !this.state.lastHeartbeatAt
        || (Date.now() - this.state.lastHeartbeatAt) >= this.config.heartbeatIntervalMs;
      if (!due) return true;
      try {
        await this.heartbeat();
        return true;
      } catch (error) {
        // Only a refused credential discards the pairing. A network failure or a 5xx says nothing about the token, so it is retried with backoff.
        if (!(error instanceof HostRejectedError) || (error.status !== 401 && error.status !== 403)) throw error;
        this.state = {
          ...this.state,
          token: undefined,
          peer: undefined,
          lastError: 'Stored peer token is no longer valid.',
        };
        await this.saveState();
      }
    }

    if (!this.state.pairRequest || !this.state.challenge) {
      await this.requestPairing();
    }

    if (this.config.operatorToken) {
      await this.approvePairRequest().catch((error: unknown) => {
        this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) };
      });
    }

    return this.verifyPairing();
  }

  async heartbeat(): Promise<DistributedPeerRecord> {
    if (!this.state.token?.value) {
      throw new Error('No peer token available');
    }
    const response = await fetch(new URL('/api/remote/heartbeat', this.config.baseUrl).toString(), {
      method: 'POST',
      headers: this.peerHeaders(),
      body: JSON.stringify({
        capabilities: [...this.config.capabilities],
        commands: [...this.config.commands],
        version: this.config.version,
        clientMode: this.config.clientMode,
        metadata: {
          hostname: hostname(),
          statePath: this.stateFile,
          client: 'reference-node-host',
        },
      }),
    });
    if (!response.ok) {
      throw new HostRejectedError(`Heartbeat failed (${response.status})`, response.status);
    }
    const payload = await response.json() as { peer?: DistributedPeerRecord };
    if (!payload.peer) {
      throw new Error('Heartbeat response missing peer payload');
    }
    this.state = {
      ...this.state,
      peer: payload.peer,
      lastHeartbeatAt: Date.now(),
      lastError: undefined,
    };
    await this.saveState();
    return payload.peer;
  }

  async pullWork(): Promise<DistributedPendingWork[]> {
    if (!this.state.token?.value) {
      throw new Error('No peer token available');
    }
    const response = await fetch(new URL('/api/remote/work/pull', this.config.baseUrl).toString(), {
      method: 'POST',
      headers: this.peerHeaders(),
      body: JSON.stringify({
        maxItems: this.config.maxWorkItemsPerPull,
        leaseMs: this.config.workLeaseMs ?? 45_000,
      }),
    });
    if (!response.ok) {
      throw new Error(`Work pull failed (${response.status})`);
    }
    const payload = await response.json() as { work?: DistributedPendingWork[] };
    const work = payload.work ?? [];
    this.state = {
      ...this.state,
      lastWorkPullAt: Date.now(),
      lastError: undefined,
    };
    await this.saveState();
    return work;
  }

  async completeWork(work: DistributedPendingWork, outcome: WorkExecutionResult): Promise<DistributedPendingWork> {
    if (!this.state.token?.value) {
      throw new Error('No peer token available');
    }
    const response = await fetch(new URL(`/api/remote/work/${encodeURIComponent(work.id)}/complete`, this.config.baseUrl).toString(), {
      method: 'POST',
      headers: this.peerHeaders(),
      body: JSON.stringify({
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
        metadata: outcome.metadata ?? {},
      }),
    });
    if (!response.ok) {
      throw new Error(`Work completion failed (${response.status})`);
    }
    const payload = await response.json() as { work?: DistributedPendingWork };
    if (!payload.work) {
      throw new Error('Work completion response missing work payload');
    }
    return payload.work;
  }

  isCommandAllowed(command: string): boolean {
    const allowlist = normalizeList(this.config.allowedCommands, this.config.commands);
    if (allowlist.includes('*')) return true;
    return allowlist.includes(command.trim());
  }

  async processWork(work: DistributedPendingWork): Promise<WorkExecutionResult> {
    const command = work.type === 'invoke'
      ? this.resolveInvokeCommand(work)
      : work.command.trim();

    if (!this.isCommandAllowed(command)) {
      return {
        status: 'failed',
        error: `Command not allowlisted: ${command}`,
      };
    }

    switch (work.type) {
      case 'status.request':
        return {
          status: 'completed',
          result: {
            type: 'status.request',
            peerId: this.state.peer?.id ?? null,
            label: this.config.label,
            hostname: hostname(),
            uptimeMs: Math.round(process.uptime() * 1000),
            heartbeatIntervalMs: this.config.heartbeatIntervalMs,
            workPullIntervalMs: this.config.workPullIntervalMs,
            contract: this.contract?.metadata ?? {},
          },
        };
      case 'location.request':
        return {
          status: 'completed',
          result: {
            type: 'location.request',
            hostname: hostname(),
            platform: process.platform,
            arch: process.arch,
            release: process.release.name,
            cwd: process.cwd(),
          },
        };
      case 'session.message':
        return {
          status: 'completed',
          result: {
            type: 'session.message',
            sessionId: work.sessionId ?? null,
            routeId: work.routeId ?? null,
            message: this.extractMessage(work.payload) ?? work.command,
            acknowledged: true,
            receivedAt: Date.now(),
          },
        };
      case 'automation.run':
        return this.runHandler('automation.run', work, command);
      case 'invoke':
      default:
        return this.runHandler('invoke', work, command);
    }
  }

  private async runHandler(kind: keyof ReferenceNodeHostHandlers, work: DistributedPendingWork, command: string): Promise<WorkExecutionResult> {
    const handler = this.handlers[kind];
    if (!handler) {
      return {
        status: 'failed',
        error: `The reference node host does not execute ${kind} work (command: ${command}). Pass a '${kind}' handler to ReferenceNodeHostClient to run it.`,
        metadata: { executed: false, workType: work.type },
      };
    }
    try {
      return await handler(work, command);
    } catch (error) {
      return {
        status: 'failed',
        error: `The ${kind} handler failed for ${command}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async runOnce(): Promise<ReferenceNodeHostRunSummary> {
    const heartbeatBefore = this.state.lastHeartbeatAt;
    const paired = await this.ensureSession();
    if (!paired || !this.state.token?.value) {
      return { paired: false, heartbeated: false, claimed: 0, completed: 0, failed: 0 };
    }

    // ensureSession owns the heartbeat schedule; a changed timestamp means one was sent.
    const heartbeated = this.state.lastHeartbeatAt !== heartbeatBefore;
    let claimed = 0;
    let completed = 0;
    let failed = 0;

    const shouldPull =
      !this.state.lastWorkPullAt
      || (Date.now() - this.state.lastWorkPullAt) >= this.config.workPullIntervalMs;
    if (shouldPull) {
      const workItems = await this.pullWork();
      claimed = workItems.length;
      for (const work of workItems) {
        const outcome = await this.processWork(work);
        if (outcome.status === 'completed') completed += 1;
        else failed += 1;
        await this.completeWork(work, outcome);
      }
    }

    return {
      paired: true,
      heartbeated,
      claimed,
      completed,
      failed,
    };
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
      try {
        const summary = await this.runOnce();
        this.backoff.reset();
        const delayMs = summary.claimed > 0
          ? Math.max(250, Math.min(this.config.workPullIntervalMs, this.config.heartbeatIntervalMs))
          : this.config.workPullIntervalMs;
        await sleep(delayMs);
      } catch (error) {
        this.state = {
          ...this.state,
          lastError: error instanceof Error ? error.message : String(error),
        };
        await this.saveState();
        const delayMs = this.backoff.nextDelay();
        await sleep(delayMs);
      }
    }
  }

  private extractMessage(payload: unknown): string | null {
    if (!isObject(payload)) return null;
    const value = payload.message ?? payload.text ?? payload.body;
    return typeof value === 'string' ? value : null;
  }

  private resolveInvokeCommand(work: DistributedPendingWork): string {
    if (isObject(work.payload) && typeof work.payload.command === 'string' && work.payload.command.trim().length > 0) {
      return work.payload.command.trim();
    }
    return work.command.trim();
  }

  private peerHeaders(): Headers {
    if (!this.state.token?.value) {
      throw new Error('No peer token available');
    }
    return new Headers({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.state.token.value}`,
    });
  }

  private operatorHeaders(): Headers {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (this.config.operatorToken) {
      headers.set('Authorization', `Bearer ${this.config.operatorToken}`);
    }
    return headers;
  }
}

/**
 * The local daemon's control plane: GOODVIBES_DAEMON_URL, else the `controlPlane.port` saved in the terminal settings,
 * else the default port, resolved the same way the live verifier does.
 */
export function resolveDefaultReferenceNodeHostBaseUrl(): string {
  return resolveVerificationHostUrl(
    resolveGoodVibesTreeDirectory(),
    undefined,
    ['GOODVIBES_DAEMON_URL'],
    (path) => JSON.parse(readFileSync(path, 'utf-8')) as unknown,
  );
}

export function createDefaultReferenceNodeHostConfig(overrides: Partial<ReferenceNodeHostConfig> = {}): ReferenceNodeHostConfig {
  return {
    baseUrl: overrides.baseUrl ?? resolveDefaultReferenceNodeHostBaseUrl(),
    label: 'goodvibes-reference-node-host',
    requestedId: `goodvibes-reference-node-host-${hostname()}`,
    peerKind: 'node',
    platform: 'bun',
    deviceFamily: 'desktop',
    version: '0.1.0',
    clientMode: 'reference',
    capabilities: ['files', 'commands', 'approvals', 'artifacts', 'resume'],
    commands: ['status.request', 'location.request', 'session.message', 'automation.run', 'invoke'],
    allowedCommands: ['status.request', 'location.request', 'session.message', 'automation.run', 'invoke'],
    heartbeatIntervalMs: 30_000,
    workPullIntervalMs: 2_000,
    pairingRetryMs: 5_000,
    verifyTimeoutMs: 10 * 60_000,
    maxWorkItemsPerPull: 4,
    confirmReplace: true,
    statePath: '~/.goodvibes/reference-node-host/state.json',
    ...overrides,
  };
}
