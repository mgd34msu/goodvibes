import { MOCK_DAEMON_FIXTURES } from '@goodvibes/engine/contracts/generated/mock-daemon-fixtures';
import type { MockDaemonResponse } from '@goodvibes/engine/contracts/testing';
import { createOperatorApiClient } from '@goodvibes/engine/operator-client';
import { createPeerApiClient } from '@goodvibes/engine/peer-client';
import type { FetchLike } from '@goodvibes/engine/transport-core';

/** One request the fixture daemon answered, kept so a test can check what was sent. */
export interface FixtureDaemonRequest {
  readonly method: string;
  readonly path: string;
  readonly methodId: string | null;
  readonly authorization: string | null;
}

interface FixtureRoute {
  readonly method: string;
  readonly pattern: RegExp;
  readonly response: MockDaemonResponse;
}

function routePattern(path: string): RegExp {
  const source = path
    .split(/\{[^}]+\}/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${source}$`);
}

/**
 * A `fetch` that answers every operator route from the schema-valid sample
 * responses the contracts package generates, with no daemon and no network.
 * An exact path wins over a templated one (`/api/sessions/{sessionId}`); an
 * unknown route answers 404 the way the daemon does.
 */
export function createFixtureDaemonFetch(requests: FixtureDaemonRequest[] = []): FetchLike {
  const exact = new Map<string, MockDaemonResponse>();
  const templated: FixtureRoute[] = [];
  for (const response of Object.values(MOCK_DAEMON_FIXTURES)) {
    if (!response.http) continue;
    const method = response.http.method.toUpperCase();
    if (response.http.path.includes('{')) {
      templated.push({ method, pattern: routePattern(response.http.path), response });
    } else {
      exact.set(`${method} ${response.http.path}`, response);
    }
  }

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const method = (init?.method ?? request.method).toUpperCase();
    const path = new URL(request.url).pathname;
    const response = exact.get(`${method} ${path}`)
      ?? templated.find((route) => route.method === method && route.pattern.test(path))?.response
      ?? null;
    const headers = new Headers(init?.headers ?? request.headers);
    requests.push({ method, path, methodId: response?.methodId ?? null, authorization: headers.get('authorization') });
    if (!response) {
      return Response.json({ error: `No route for ${method} ${path}.` }, { status: 404 });
    }
    return Response.json(response.body, { status: response.status });
  };
}

export interface ReferenceOperatorClientSummary {
  readonly sessionId: string;
  readonly providerCount: number;
  readonly activeClients: number;
  readonly peerContractBasePath: string;
  readonly pairedPeers: number;
}

/**
 * The calls an operator client makes against a live daemon, answered by the
 * fixture daemon: create a session, list providers, read the control plane,
 * read the node-host contract and the distributed runtime snapshot. Use the
 * same pattern to test a client of your own without starting a daemon.
 */
export async function runReferenceOperatorClientExample(
  requests: FixtureDaemonRequest[] = [],
): Promise<ReferenceOperatorClientSummary> {
  const clientOptions = {
    // Never contacted: the fixture fetch answers every request. The client
    // still refuses plain http to a public host, so the URL is a local one.
    baseUrl: 'http://127.0.0.1:3421',
    authToken: 'fixture-token',
    fetch: createFixtureDaemonFetch(requests),
  };
  const operator = createOperatorApiClient(clientOptions);
  const peer = createPeerApiClient(clientOptions);

  const session = await operator.sessions.create({ title: 'Reference operator session' });
  const [providers, controlPlane, nodeHost, remote] = await Promise.all([
    operator.providers.list(),
    operator.control.snapshot(),
    operator.invoke('remote.node_host.contract'),
    peer.operator.snapshot(),
  ]);

  return {
    sessionId: session.session.id,
    providerCount: providers.providers.length,
    activeClients: controlPlane.totals.activeClients,
    peerContractBasePath: nodeHost.contract.basePath,
    pairedPeers: remote.distributed.peers.length,
  };
}

if (import.meta.main) {
  runReferenceOperatorClientExample().then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
