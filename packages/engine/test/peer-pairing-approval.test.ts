// Proves: A machine that asked to pair gets a peer token before the owner approved it, with the wrong challenge, or keeps one after it was revoked.
// Red when: Verifying a pair request issues a token while it waits for the owner, after he rejected it, a second time, or for the wrong challenge; or a revoked peer token still authenticates.
/**
 * Anyone who can reach the daemon may ask to pair a machine as a remote peer;
 * a peer token then pulls the owner's work and runs it. The real distributed
 * runtime over a store in a temp directory: a request yields a token only after
 * the owner approved it, only to the holder of its challenge, and only once; a
 * rejected request yields none; a revoked token stops authenticating.
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
  const again = await attempt(() => runtime.verifyPairRequest(asked.request.id, asked.challenge));
  const token = verified!.token.value;
  const beforeRevoke = (await runtime.authenticatePeerToken(token))?.peer.id;
  await runtime.revokePeerToken(verified!.peer.id);
  const afterRevoke = await runtime.authenticatePeerToken(token);

  expect({ beforeApproval, afterRejection, wrongChallenge, again, beforeRevoke, afterRevoke }).toEqual({
    beforeApproval: 'nothing yet',
    afterRejection: 'refused REMOTE_PAIR_REQUEST_SETTLED',
    wrongChallenge: 'nothing yet',
    again: 'refused REMOTE_PAIR_REQUEST_SETTLED',
    beforeRevoke: verified!.peer.id,
    afterRevoke: null,
  });
});
