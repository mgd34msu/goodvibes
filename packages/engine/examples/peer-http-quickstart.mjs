/**
 * Pair a peer with a GoodVibes daemon and take one turn at its work queue.
 *
 * The journey, and the credential each step needs:
 *   1. pair.request    no token. The daemon answers with a request id and a one-time challenge.
 *   2. approval        an operator token with admin access, held by the operator, not the peer.
 *                      Operator method `remote.pair.requests.approve`
 *                      (POST /api/remote/pair/requests/<id>/approve). This script prints the step.
 *   3. pair.verify     no token; the challenge from step 1 proves it is the same peer. Polled
 *                      until the operator approves, and then it returns the peer token.
 *   4. peer.heartbeat  the peer token from step 3.
 *   5. work.pull       the peer token from step 3. Pulls at most one item; a pulled item is
 *                      leased for 30 seconds and goes back on the queue when the lease lapses.
 *
 * Prerequisites: a GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3421).
 * For a local test on one machine, set GOODVIBES_TOKEN to an operator token with admin access
 * and the script approves its own request in step 2 instead of waiting for the operator.
 *
 * Run: bun examples/peer-http-quickstart.mjs
 */
import { createGoodVibesPlatform } from '@goodvibes/engine/platform';
import { createPeerApiClient } from '@goodvibes/engine/platform/peer';

const baseUrl = process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421';
const operatorToken = process.env.GOODVIBES_TOKEN;
const POLL_INTERVAL_MS = 2_000;

/** The peer token, once pair.verify has issued it; steps 1 and 3 send no token. */
let peerToken = /** @type {string | null} */ (null);
const peer = createPeerApiClient({ baseUrl, getAuthToken: () => peerToken });

// 1. Ask to pair.
const { request, challenge } = await peer.pairing.request({
  peerKind: 'node',
  label: 'peer-http-quickstart',
  capabilities: [],
});
console.log(`Pair request ${request.id} is ${request.status}; it expires at ${new Date(request.expiresAt).toISOString()}.`);

// 2. The operator approves it.
if (operatorToken) {
  const operator = createGoodVibesPlatform({ baseUrl, authToken: operatorToken });
  await operator.operator.invoke('remote.pair.requests.approve', { requestId: request.id });
  console.log('Approved with the operator token from GOODVIBES_TOKEN.');
} else {
  console.log([
    'Waiting for the operator to approve. With an operator token that has admin access, run:',
    `  curl -X POST -H "Authorization: Bearer <operator token>" ${baseUrl}/api/remote/pair/requests/${encodeURIComponent(request.id)}/approve`,
  ].join('\n'));
}

// 3. Poll until approved. The daemon answers 404 while the request is pending
// and 410 once it was rejected or expired.
let verified = null;
while (!verified) {
  try {
    verified = await peer.pairing.verify({ requestId: request.id, challenge });
  } catch (error) {
    const status = /** @type {{ status?: number }} */ (error).status;
    if (status !== 404) throw error;
    if (Date.now() >= request.expiresAt) {
      throw new Error(`Pair request ${request.id} expired before the operator approved it. Run the script again to request pairing.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
peerToken = verified.token.value;
console.log(`Paired as peer ${verified.peer.id}; peer token ${verified.token.fingerprint} issued.`);

// 4. One heartbeat.
const heartbeat = await peer.peer.heartbeat({ capabilities: [] });
console.log(`Heartbeat accepted; peer status ${heartbeat.peer.status}.`);

// 5. Pull once.
const { work } = await peer.work.pull({ maxItems: 1, leaseMs: 30_000 });
if (work.length === 0) {
  console.log('No work is queued for this peer.');
} else {
  for (const item of work) {
    console.log(`Pulled work ${item.id} (${item.type}); finish it with peer.work.complete('${item.id}', { status: 'completed', result }).`);
  }
}
