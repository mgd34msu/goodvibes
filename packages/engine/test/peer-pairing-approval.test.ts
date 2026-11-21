// Proves: A machine that asked to pair gets a peer token before the owner approved it, with the wrong challenge, or keeps one after it was revoked.
// Red when: Verifying a pair request issues a token while it waits for the owner, after he rejected it, after its token was used, or for the wrong challenge; a repeated verify leaves the token it replaced working; or a revoked peer token still authenticates.
// Proves: A second machine that asked to pair under a paired peer's id takes that peer over, ending its token, without the owner confirming the replace.
// Red when: Verifying an approved request whose requested id another machine verified first merges into that peer and issues a token instead of refusing with REMOTE_PAIR_REPLACES_PEER.
/**
 * Anyone who can reach the daemon may ask to pair a machine as a remote peer;
 * a peer token then pulls the owner's work and runs it. The real distributed
 * runtime over a store in a temp directory: a request yields a token only after
 * the owner approved it, only to the holder of its challenge, and one live
 * token at a time (a verify repeated while its token is unused replaces that
 * token, and none follows once it is used); a rejected request yields none; a
 * revoked token stops authenticating.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DistributedRuntimeManager } from '../platform/src/platform/runtime/remote/distributed-runtime-manager.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** What a verify attempt gave the machine: a token, nothing yet, or a refusal code. */
async function attempt(verify: () => Promise<{ token: { value: string } } | null>): Promise<string> {
  try {
    const result = await verify();
    return result ? 'token' : 'nothing yet';
  } catch (error) {
    return `refused ${(error as { code?: string }).code}`;
  }
}

test('a pair request yields a token only after approval, to its challenge, once; a revoked token stops working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-peer-pairing-'));
  dirs.push(dir);
  const runtime = new DistributedRuntimeManager(join(dir, 'remote', 'distributed-runtime.json'));
  const asked = await runtime.requestPairing({ peerKind: 'node', label: 'runner' });
  const refused = await runtime.requestPairing({ peerKind: 'node', label: 'stranger' });

  const beforeApproval = await attempt(() => runtime.verifyPairRequest(asked.request.id, asked.challenge));
  await runtime.rejectPairRequest(refused.request.id);
  const afterRejection = await attempt(() => runtime.verifyPairRequest(refused.request.id, refused.challenge));
  await runtime.approvePairRequest(asked.request.id);
  const wrongChallenge = await attempt(() => runtime.verifyPairRequest(asked.request.id, refused.challenge));
  const verified = await runtime.verifyPairRequest(asked.request.id, asked.challenge);
  // The same verify again while its token is unused (its answer was lost) gets a new token; the first stops working.
  const retried = await runtime.verifyPairRequest(asked.request.id, asked.challenge);
  const firstAfterRetry = await runtime.authenticatePeerToken(verified!.token.value);
  const token = retried!.token.value;
  const beforeRevoke = (await runtime.authenticatePeerToken(token))?.peer.id;
  // Once the token has been used, the request is settled: no further token.
  const again = await attempt(() => runtime.verifyPairRequest(asked.request.id, asked.challenge));
  await runtime.revokePeerToken(retried!.peer.id);
  const afterRevoke = await runtime.authenticatePeerToken(token);

  expect({ beforeApproval, afterRejection, wrongChallenge, firstAfterRetry, again, beforeRevoke, afterRevoke }).toEqual({
    beforeApproval: 'nothing yet',
    afterRejection: 'refused REMOTE_PAIR_REQUEST_SETTLED',
    wrongChallenge: 'nothing yet',
    firstAfterRetry: null,
    again: 'refused REMOTE_PAIR_REQUEST_SETTLED',
    beforeRevoke: verified!.peer.id,
    afterRevoke: null,
  });
});

test('a second approved request under a paired peer\'s id is refused at verify and the paired machine keeps its token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-peer-pairing-'));
  dirs.push(dir);
  const runtime = new DistributedRuntimeManager(join(dir, 'remote', 'distributed-runtime.json'));
  // Two machines ask under one id while no peer holds it, so the owner is asked no replace question for either.
  const first = await runtime.requestPairing({ peerKind: 'node', requestedId: 'build-box', label: 'build box' });
  const second = await runtime.requestPairing({ peerKind: 'node', requestedId: 'build-box', label: 'build box' });
  await runtime.approvePairRequest(first.request.id);
  await runtime.approvePairRequest(second.request.id);
  const paired = await runtime.verifyPairRequest(first.request.id, first.challenge);
  await runtime.authenticatePeerToken(paired!.token.value);

  const takeover = await attempt(() => runtime.verifyPairRequest(second.request.id, second.challenge));
  expect({ takeover, firstStill: (await runtime.authenticatePeerToken(paired!.token.value))?.peer.id }).toEqual({
    takeover: 'refused REMOTE_PAIR_REPLACES_PEER',
    firstStill: paired!.peer.id,
  });
});
