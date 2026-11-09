import type {
  OperatorMethodContract,
  OperatorMethodId,
} from '@goodvibes-jev/engine/contracts';
import { getOperatorContract, OPERATOR_METHOD_IDS } from '@goodvibes-jev/engine/contracts';
import * as ContractZodSchemas from '@goodvibes-jev/engine/contracts';
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
} from '@goodvibes-jev/engine/transport-http';
import {
  createOperatorRemoteClient,
  type OperatorRemoteClient,
  type OperatorRemoteClientOptions,
  type OperatorRemoteClientInvokeOptions,
  type OperatorRemoteClientStreamOptions,
} from './client-core.js';
import { buildSchemaRegistry } from './schema-registry.js';

/**
 * Options for constructing an `OperatorApiClient` instance via `createOperatorApiClient`.
 *
 * Extends `HttpTransportOptions` with operator-specific settings.
 * Typically created indirectly by `createGoodVibesPlatform`, pass operator-level
 * options as part of `GoodVibesPlatformOptions` instead.
 */
export interface OperatorApiClientOptions extends HttpTransportOptions, Pick<OperatorRemoteClientOptions, 'regexReading' | 'getRegexReading'> {
  /**
   * When `true` (default), response bodies for typed operator methods are
   * validated against their Zod contract schemas. Set to `false` to opt out.
   * This is useful when a caller wants raw response bodies for contract
   * debugging or benchmarking.
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
 * import { createOperatorApiClient } from '@goodvibes-jev/engine/operator-client';
 *
 * const operator = createOperatorApiClient({
 *   baseUrl: 'https://daemon.example.com',
 *   authToken: process.env.GV_TOKEN,
 * });
 *
 * const sessions = await operator.sessions.list();
 */
export function createOperatorApiClient(options: OperatorApiClientOptions): OperatorApiClient {
  const validateResponses = options.validateResponses !== false;
  const transport = createHttpTransport(options);
  const contract = getOperatorContract();
  const schemaRegistry = validateResponses
    ? buildSchemaRegistry(OPERATOR_METHOD_IDS, ContractZodSchemas)
    : {};
  const remote = createOperatorRemoteClient(transport, contract, {
    validateResponses,
    regexReading: options.regexReading,
    getRegexReading: options.getRegexReading,
    getResponseSchema: validateResponses
      ? (methodId) => schemaRegistry[methodId]
      : undefined,
  });
  return {
    ...remote,
    getOperation(methodId: OperatorMethodId): OperatorMethodContract {
      return remote.getOperation(methodId);
    },
    dispose(): void {
      // HTTP transports do not hold sockets today, but exposing disposal on the
      // platform object gives callers a stable lifecycle hook as transports evolve.
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
