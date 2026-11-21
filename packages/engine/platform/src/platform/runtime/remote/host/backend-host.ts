/**
 * Registered execution backends: hosts the daemon runs a command on itself,
 * without a paired GoodVibes node on the other side (a docker container, an
 * ssh host, a cloud VM through its provider CLI, or a local process).
 *
 * An admin registers a backend under an id (`remote.backends.register`), and
 * `remote.peers.invoke` with that id runs the command on it and answers with
 * the exit code and output. An id a paired peer holds is never a backend: the
 * pairing owns it, and invoking it queues work for that peer as before.
 *
 * Credentials are stored only as `goodvibes://secrets/` references and are
 * resolved when a command runs. Nothing is opened at startup: the registry file
 * is read on first use, and a host with no registry file answers "not a
 * backend" without opening anything.
 */
import { existsSync } from 'node:fs';
import type { RemoteHostCredentialStore, RemoteHostLogger } from './context.js';
import { PeerRegistry, normalizeBackendConfig, parseAzureServicePrincipalCredential, type PeerRecord, type BackendKind } from './peer-registry.js';
import { RemoteDispatcher, type RemoteInvokeResult } from './dispatcher.js';
import {
  BackendDispatchError,
  ENV_NAME_PATTERN,
  isProgramChangingEnvName,
  type Backend,
  type DispatchPayload,
} from './backends/types.js';

export interface RemoteBackendHostOptions {
  /** The project root; the registry lives in its private operator directory. */
  readonly workingDirectory: string;
  /** The user's home; short-lived key and credential files live under it. */
  readonly homeDirectory: string;
  readonly credentials: RemoteHostCredentialStore;
  readonly logger: RemoteHostLogger;
  /** Whether a paired peer holds this id; such an id cannot be registered as a backend. */
  readonly isPairedPeer?: ((peerId: string) => boolean) | undefined;
  /** Runners to use in place of the built-in ones (an embedder's own). */
  readonly backends?: Map<BackendKind, Backend> | undefined;
}

export interface RemoteBackendListing {
  readonly backends: readonly PeerRecord[];
  /** Rows that no longer read as a valid registration, with the reason; remove and register them again. */
  readonly unreadable: readonly { readonly peerId: string; readonly reason: string }[];
}

export interface RemoteBackendInvokeInput {
  readonly peerId: string;
  readonly command: string;
  readonly payload?: unknown;
  /** The route's time limit, used when the payload names none. */
  readonly timeoutMs?: number | undefined;
}

const PAYLOAD_FIELDS = new Set(['args', 'stdin', 'env', 'timeoutMs', 'cwd']);

function badPayload(message: string): BackendDispatchError {
  return new BackendDispatchError(`${message} Nothing was run.`, 'REMOTE_BACKEND_BAD_PAYLOAD', 400);
}

/**
 * The backend payload, read strictly: `args` (strings), `stdin`, `env`
 * (string values), `timeoutMs` and `cwd`. Any other field is refused by name
 * rather than ignored, so a caller never believes a setting took effect.
 */
export function readBackendPayload(payload: unknown, routeTimeoutMs?: number): DispatchPayload | undefined {
  if (payload === undefined || payload === null) {
    return routeTimeoutMs !== undefined ? { timeoutMs: routeTimeoutMs } : undefined;
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) throw badPayload('payload must be an object.');
  const record = payload as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => !PAYLOAD_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw badPayload(`payload field${unknownFields.length > 1 ? 's' : ''} ${unknownFields.join(', ')} ${unknownFields.length > 1 ? 'are' : 'is'} not used by a backend; send only args, stdin, env, timeoutMs or cwd.`);
  }
  const read: DispatchPayload = {};
  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string')) throw badPayload('payload.args must be a list of strings.');
    read.args = record.args as string[];
  }
  if (record.stdin !== undefined) {
    if (typeof record.stdin !== 'string') throw badPayload('payload.stdin must be a string.');
    read.stdin = record.stdin;
  }
  if (record.env !== undefined) {
    const env = record.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)
      || Object.values(env as Record<string, unknown>).some((value) => typeof value !== 'string')) {
      throw badPayload('payload.env must be an object of string values.');
    }
    const names = Object.keys(env);
    const malformed = names.filter((name) => !ENV_NAME_PATTERN.test(name));
    if (malformed.length > 0) throw badPayload(`payload.env names ${malformed.join(', ')} are not environment variable names.`);
    const refused = names.filter(isProgramChangingEnvName);
    if (refused.length > 0) {
      throw badPayload(`payload.env may not set ${refused.join(', ')}: ${refused.length > 1 ? 'they change' : 'it changes'} which program runs or what it loads, so a command allowed by name could run something else.`);
    }
    read.env = { ...(env as Record<string, string>) };
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string' || record.cwd.trim().length === 0) throw badPayload('payload.cwd must be a non-empty string.');
    read.cwd = record.cwd;
  }
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== 'number' || !Number.isFinite(record.timeoutMs) || record.timeoutMs <= 0) {
      throw badPayload('payload.timeoutMs must be a positive number of milliseconds.');
    }
    read.timeoutMs = record.timeoutMs;
  } else if (routeTimeoutMs !== undefined) {
    read.timeoutMs = routeTimeoutMs;
  }
  return read;
}

function closedError(): BackendDispatchError {
  return new BackendDispatchError('Remote backends are closed: this host is shutting down.', 'REMOTE_BACKENDS_CLOSED', 503);
}

export class RemoteBackendHost {
  private readonly registry: PeerRegistry;
  private readonly dispatcher: RemoteDispatcher;
  private readonly isPairedPeer: (peerId: string) => boolean;
  private readonly credentials: RemoteHostCredentialStore;
  private opened = false;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: RemoteBackendHostOptions) {
    this.registry = new PeerRegistry(options.workingDirectory);
    this.dispatcher = new RemoteDispatcher({
      registry: this.registry,
      credentials: options.credentials,
      logger: options.logger,
      homeDirectory: options.homeDirectory,
      ...(options.backends ? { backends: options.backends } : {}),
    });
    this.isPairedPeer = options.isPairedPeer ?? (() => false);
    this.credentials = options.credentials;
  }

  private async open(): Promise<void> {
    if (this.closed) throw closedError();
    await this.registry.init();
    if (this.closed) throw closedError();
    this.opened = true;
  }

  /**
   * Whether `peerId` names a registered backend. A host whose registry file
   * does not exist has none, and is answered without opening anything.
   */
  async has(peerId: string): Promise<boolean> {
    if (this.closed) return false;
    if (!this.opened && !existsSync(this.registry.dbPath)) return false;
    await this.open();
    return this.registry.get(peerId) !== null;
  }

  async list(): Promise<RemoteBackendListing> {
    if (!this.opened && !existsSync(this.registry.dbPath)) return { backends: [], unreadable: [] };
    await this.open();
    return this.registry.list();
  }

  /**
   * Register (or replace) a backend from an operator's body: `peerId`,
   * `displayName` (defaults to the id), `backendKind` and `backendConfig`.
   */
  async register(input: Record<string, unknown>): Promise<PeerRecord> {
    const peerId = typeof input.peerId === 'string' ? input.peerId.trim() : '';
    if (peerId && this.isPairedPeer(peerId)) {
      throw new BackendDispatchError(
        `A paired peer already has the id '${peerId}', and invoking it queues work for that peer. Register the backend under another id.`,
        'REMOTE_BACKEND_ID_TAKEN',
        409,
      );
    }
    const backendConfig = input.backendConfig;
    if (backendConfig !== undefined && (typeof backendConfig !== 'object' || backendConfig === null || Array.isArray(backendConfig))) {
      throw new BackendDispatchError('backendConfig must be an object. Nothing was registered.', 'REMOTE_BACKEND_INVALID_CONFIG', 400);
    }
    const displayName = typeof input.displayName === 'string' && input.displayName.trim().length > 0 ? input.displayName : peerId;
    await this.assertAzureCredentialShape(input.backendKind, (backendConfig ?? {}) as Record<string, unknown>);
    await this.open();
    const replaced = peerId.length > 0 && this.registry.get(peerId) !== null;
    const record = await this.registry.register({
      peerId,
      displayName,
      // Checked against the four kinds by the registry, which refuses any other.
      backendKind: input.backendKind as BackendKind,
      backendConfig: (backendConfig ?? {}) as Record<string, unknown>,
    });
    // A replaced key or kind leaves no key file or connection behind.
    if (replaced) await this.dispatcher.forget(record.peerId);
    return record;
  }

  /**
   * An azure backend signs in as the service principal its credential names,
   * so a stored credential of another shape is refused here, before anything
   * is registered. A credential not stored yet is checked when a command runs.
   */
  private async assertAzureCredentialShape(backendKind: unknown, raw: Record<string, unknown>): Promise<void> {
    if (backendKind !== 'cloud-terminal' || raw.provider !== 'azure') return;
    const config = normalizeBackendConfig('cloud-terminal', raw);
    if (config.kind !== 'cloud-terminal') return;
    let stored: string | null;
    try { stored = await this.credentials.resolveRef(config.credentialRef); } catch { stored = null; }
    if (typeof stored === 'string' && stored.length > 0) parseAzureServicePrincipalCredential(stored);
  }

  /** Remove a backend and what its backend held for it; false when no backend had that id. */
  async remove(peerId: string): Promise<boolean> {
    if (!this.opened && !existsSync(this.registry.dbPath)) return false;
    await this.open();
    const removed = await this.registry.remove(peerId);
    if (removed) await this.dispatcher.forget(peerId);
    return removed;
  }

  /** Run one command on a registered backend and return its exit code and output. */
  async invoke(input: RemoteBackendInvokeInput): Promise<RemoteInvokeResult> {
    if (this.closed) throw closedError();
    const payload = readBackendPayload(input.payload, input.timeoutMs);
    return this.dispatcher.dispatch({
      peerId: input.peerId,
      command: input.command,
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  /** Stop running commands, remove short-lived credential files and close the registry. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.dispatcher.teardown().finally(() => { this.registry.close(); });
    return this.closing;
  }
}

/** Build the backend host for one runtime; nothing is opened until it is used. */
export function createRemoteBackendHost(options: RemoteBackendHostOptions): RemoteBackendHost {
  return new RemoteBackendHost(options);
}

export type { PeerRecord as RemoteBackendRecord, BackendKind as RemoteBackendKind, RemoteInvokeResult as RemoteBackendInvokeResult };
