import { createOperatorApiClient } from '@goodvibes/engine/operator-client';
import { createPeerApiClient } from '@goodvibes/engine/peer-client';
import type { FetchLike } from '@goodvibes/engine/transport-core';

export interface ReferenceHttpClientOptions {
  /** The daemon's base URL, for example `http://127.0.0.1:3421`. */
  readonly baseUrl: string;
  /** An operator bearer token (the shared token or a session token). */
  readonly authToken: string;
  /** Replaces the global `fetch`, for example to answer from recorded responses. */
  readonly fetch?: FetchLike;
}

export interface ReferenceHttpClientSummary {
  readonly providerCount: number;
  readonly activeClients: number;
  readonly peerContractBasePath: string;
  readonly peerContractTransport: string;
  readonly pendingPairRequests: number;
  readonly pairedPeers: number;
}

/**
 * Read what an operator screen shows first: the configured providers, the
 * clients connected to the control plane, the contract a node host pairs
 * against, and the distributed runtime's pair requests and peers.
 */
export async function runReferenceHttpClientExample(options: ReferenceHttpClientOptions): Promise<ReferenceHttpClientSummary> {
  const clientOptions = {
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const operator = createOperatorApiClient(clientOptions);
  // The peer client carries the operator token here because the distributed
  // runtime snapshot is an operator read; a paired peer uses its own token
  // for heartbeat and work.
  const peer = createPeerApiClient(clientOptions);

  const [providers, controlPlane, nodeHost, remote] = await Promise.all([
    operator.providers.list(),
    operator.control.snapshot(),
    operator.invoke('remote.node_host.contract'),
    peer.operator.snapshot(),
  ]);

  return {
    providerCount: providers.providers.length,
    activeClients: controlPlane.totals.activeClients,
    peerContractBasePath: nodeHost.contract.basePath,
    peerContractTransport: nodeHost.contract.transport,
    pendingPairRequests: remote.distributed.pairRequests.filter((request) => request.status === 'pending').length,
    pairedPeers: remote.distributed.peers.length,
  };
}

const REQUIRED_ENV = {
  GOODVIBES_BASE_URL: 'the daemon base URL, for example http://127.0.0.1:3421',
  GOODVIBES_TOKEN: 'an operator bearer token from the daemon',
} as const;

function requireEnv(name: keyof typeof REQUIRED_ENV): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} (${REQUIRED_ENV[name]}) and run again.`);
  return value;
}

if (import.meta.main) {
  Promise.resolve().then(() => runReferenceHttpClientExample({
    baseUrl: requireEnv('GOODVIBES_BASE_URL'),
    authToken: requireEnv('GOODVIBES_TOKEN'),
  })).then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
