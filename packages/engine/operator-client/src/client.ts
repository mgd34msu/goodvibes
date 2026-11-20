import type {
  OperatorMethodContract,
  OperatorMethodId,
} from '@goodvibes/engine/contracts';
import { getOperatorContract } from '@goodvibes/engine/contracts';
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
} from '@goodvibes/engine/transport-http';
import {
  createOperatorRemoteClient,
  type OperatorRemoteClient,
  type OperatorRemoteClientInvokeOptions,
  type OperatorRemoteClientStreamOptions,
} from './client-core.js';

/**
 * Options for constructing an `OperatorApiClient` instance via `createOperatorApiClient`.
 *
 * Extends `HttpTransportOptions` with operator-specific settings.
 * Typically created indirectly by `createGoodVibesPlatform`, pass operator-level
 * options as part of `GoodVibesPlatformOptions` instead.
 */
export interface OperatorApiClientOptions extends HttpTransportOptions {
  /**
   * When `true` (default), every JSON response is validated once against its
   * method's output schema in the operator contract before `invoke` resolves.
   * A mismatch rejects with a `ContractError` that names the method and the
   * field, so a daemon of another version is reported as such. A call that
   * passes its own `responseSchema` is checked against that instead. Set to
   * `false` to receive raw bodies with no check at all.
   *
   * @defaultValue true
   */
  readonly validateResponses?: boolean | undefined;
}

/**
 * Per-call options for `platform.operator.invoke()`.
 *
 * Extends the underlying transport invoke options, see `ContractInvokeOptions`
 * for the full set of available fields (e.g. `signal`, `responseSchema`).
 */
export interface OperatorInvokeOptions extends OperatorRemoteClientInvokeOptions {}

/**
 * Per-call options for `platform.operator.stream()`.
 *
 * Extends the underlying transport stream options, see `ContractStreamOptions`
 * for available fields (e.g. `handlers`, `signal`).
 */
export interface OperatorStreamOptions extends OperatorRemoteClientStreamOptions {}

/**
 * The operator-level platform instance for the GoodVibes daemon control plane.
 *
 * Exposes the full operator API surface as strongly-typed namespaced methods
 * (e.g. `platform.operator.sessions.create(...)`) plus the underlying HTTP transport
 * and lifecycle disposal hooks.
 *
 * Obtain via `createGoodVibesPlatform({ ... }).operator` or `createOperatorApiClient()`.
 */
export type OperatorApiClient =
  & Omit<OperatorRemoteClient, 'getOperation'>
  & {
    /** The underlying HTTP transport; use to attach middleware or issue raw requests. */
    readonly transport: HttpTransport;
    /**
     * Look up a contract method descriptor by its string id.
     * @param methodId - The operator contract method id (e.g. `'sessions.create'`).
     * @throws `GoodVibesError` when the method id is not in the contract.
     */
    getOperation(methodId: OperatorMethodId): OperatorMethodContract;
    /** Release any resources held by this platform instance. Safe to call more than once. */
    dispose(): void;
    /** Async variant of `dispose()`. */
    asyncDispose(): Promise<void>;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
  };

/**
 * Create a standalone operator platform client.
 *
 * In most cases you should use `createGoodVibesPlatform()` instead, which wires
 * up auth, the peer client, and realtime events together. Use this factory
 * directly only when you need a lean operator-only client (e.g. server-side
 * scripts or test helpers).
 *
 * @param options - Transport and validation options.
 * @returns An `OperatorApiClient` instance ready to make authenticated requests.
 *
 * @example
 * import { createOperatorApiClient } from '@goodvibes/engine/operator-client';
 *
 * const operator = createOperatorApiClient({
 *   baseUrl: 'https://daemon.example.com',
 *   authToken: process.env.GV_TOKEN,
 * });
 *
 * const sessions = await operator.sessions.list();
 */
export function createOperatorApiClient(options: OperatorApiClientOptions): OperatorApiClient {
  const transport = createHttpTransport(options);
  const contract = getOperatorContract();
  // Owns every stream this client opens: dispose() ends the open ones and refuses the rest.
  const lifetime = new AbortController();
  const remote = createOperatorRemoteClient(transport, contract, {
    validateResponses: options.validateResponses !== false,
    streamSignal: lifetime.signal,
  });
  return {
    ...remote,
    getOperation(methodId: OperatorMethodId): OperatorMethodContract {
      return remote.getOperation(methodId);
    },
    /** Ends every stream this client opened (and any still opening); later stream() calls are refused. */
    dispose(): void {
      if (!lifetime.signal.aborted) lifetime.abort(new Error('The operator client was disposed.'));
    },
    async asyncDispose(): Promise<void> {
      this.dispose();
    },
    [Symbol.dispose](): void {
      this.dispose();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      return this.asyncDispose();
    },
  };
}
