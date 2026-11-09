import type { PeerEndpointContract, PeerEndpointId } from '@goodvibes-jev/engine/contracts';
import { getPeerContract } from '@goodvibes-jev/engine/contracts';
import { createHttpTransport, type HttpTransport, type HttpTransportOptions } from '@goodvibes-jev/engine/transport-http';
import {
  createPeerRemoteClient,
  type PeerRemoteClient,
  type PeerRemoteClientOptions,
  type PeerRemoteClientInvokeOptions,
} from './client-core.js';

/**
 * Peer-platform-specific behaviour flags (not transport configuration).
 */
export interface PeerApiClientBehaviorOptions extends Pick<PeerRemoteClientOptions, 'regexReading' | 'getRegexReading'> {
  /**
   * When `true` (default), response bodies are checked against the peer
   * contract's JSON Schema shape before typed calls return.
   *
   * @defaultValue true
   */
  readonly validateResponses?: boolean | undefined;
}

/**
 * Options for `createPeerApiClient`. Combines HTTP transport options with
 * peer-platform behaviour flags.
 */
export type PeerApiClientOptions = HttpTransportOptions & PeerApiClientBehaviorOptions;

/**
 * Per-call options for `platform.peer.invoke()`.
 *
 * Extends the underlying transport invoke options, see `ContractInvokeOptions`
 * for available fields (e.g. `signal`, `responseSchema`).
 */
export interface PeerInvokeOptions extends PeerRemoteClientInvokeOptions {}

/**
 * The peer-level platform instance for peer-to-peer and collaboration APIs.
 *
 * Exposes pairing, heartbeat, work-pull/complete, and operator-snapshot
 * endpoints as typed namespaced methods, plus the underlying HTTP transport
 * and lifecycle disposal hooks.
 *
 * Obtain via `createGoodVibesPlatform({ ... }).peer` or `createPeerApiClient()`.
 *
 * @example
 * import { createGoodVibesPlatform } from '@goodvibes-jev/engine/platform';
 *
 * const platform = createGoodVibesPlatform({ baseUrl: 'https://daemon.example.com', authToken: token });
 * const pairState = await platform.peer.pairing.request({ peerKind: 'agent' });
 */
export type PeerApiClient =
  & Omit<PeerRemoteClient, 'getOperation'>
  & {
    /** The underlying HTTP transport; use to attach middleware or issue raw requests. */
    readonly transport: HttpTransport;
    /**
     * Look up a contract endpoint descriptor by its string id.
     * @param endpointId - The peer contract endpoint id (e.g. `'pair.request'`).
     * @throws `GoodVibesError` when the endpoint id is not in the contract.
     */
    getOperation(endpointId: PeerEndpointId): PeerEndpointContract;
    /** Release any resources held by this platform instance. Safe to call more than once. */
    dispose(): void;
    /** Async variant of `dispose()`. */
    asyncDispose(): Promise<void>;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
  };

/**
 * Create a standalone peer platform client.
 *
 * In most cases use `createGoodVibesPlatform()` instead, which wires up operator,
 * auth, and realtime events alongside the peer client. Use this factory
 * directly only when you need a lean peer-only client.
 *
 * @param options - Transport and validation options.
 * @returns A `PeerApiClient` instance ready to make requests to the peer API.
 */
export function createPeerApiClient(options: PeerApiClientOptions): PeerApiClient {
  const transport = createHttpTransport(options);
  const remote = createPeerRemoteClient(transport, getPeerContract(), {
    validateResponses: options.validateResponses !== false,
    regexReading: options.regexReading,
    getRegexReading: options.getRegexReading,
  });
  return {
    ...remote,
    getOperation(endpointId: PeerEndpointId): PeerEndpointContract {
      return remote.getOperation(endpointId);
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
