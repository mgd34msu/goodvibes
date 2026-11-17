// Proves: A sender the owner removed regains access at the next restart (an old accepted claim is applied again), or an owner-claim answer given while the daemon was down is lost.
// Red when: The claim replay at start-up re-applies an answer that was already applied, or skips one answered while the daemon was down.
/**
 * A sender the owner took off a channel's allowlist stays off after a daemon
 * restart, while an owner-claim answer given while the daemon was down is
 * still applied once.
 *
 * Real pieces: the channel policy manager and its policy file, the owner inbox
 * over its SQLite file, and the claim wiring between them (`attachOwnerInbox`).
 * A restart is a second policy manager and a second inbox opened over the same
 * two files after the first pair was stopped and closed.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.ts';
import { OwnerInbox } from '../platform/src/platform/control-plane/owner-inbox.ts';
import { QuestionStore } from '../platform/src/platform/control-plane/question-store.ts';
import type { ChannelIngressPolicyInput } from '../platform/src/platform/channels/types.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Let the event loop turn until `done` holds; bounded in turns, never in milliseconds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  if (!done()) throw new Error(`Gave up waiting for: ${what}`);
}

/** One daemon's view: the policy manager and the owner inbox over the home's two files. */
async function daemon(dir: string) {
  const inbox = new OwnerInbox({ questions: new QuestionStore({ path: join(dir, 'owner-inbox.sqlite') }) });
  const policy = new ChannelPolicyManager({ storePath: join(dir, 'channel-policies.json') });
  const detach = policy.attachOwnerInbox(inbox);
  await policy.start();
  return {
    inbox, policy,
    async stop() { await policy.stop(); detach(); inbox.dispose(); },
  };
}

const message = (surface: ChannelIngressPolicyInput['surface'], userId: string): ChannelIngressPolicyInput =>
  ({ surface, userId, conversationKind: 'direct', text: 'hello' });

const claimOf = (inbox: OwnerInbox, userId: string) =>
  inbox.listNow({ kinds: ['claim'], status: 'open' }).find((item) => item.metadata?.['userId'] === userId);

test('a sender removed from the allowlist is still refused after a restart; a claim accepted while down still counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-allowlist-restart-'));
  dirs.push(dir);
  const first = await daemon(dir);

  // Two unknown senders on an unowned surface: both are held as claims, neither is answered.
  expect((await first.policy.evaluateIngress(message('telegram', 'U-STRANGER'))).allowed).toBe(false);
  expect((await first.policy.evaluateIngress(message('telegram', 'U-OWNER'))).allowed).toBe(false);

  // The owner accepts the wrong one, then corrects the allowlist by hand.
  const strangerClaim = claimOf(first.inbox, 'U-STRANGER');
  expect(strangerClaim).toBeDefined();
  expect((await first.inbox.answer(strangerClaim!.id, { option: 'accept' }, { actor: 'owner', surface: 'tui' })).applied).toBe(true);
  await until(() => first.policy.getPolicy('telegram').allowlistUserIds.includes('U-STRANGER'), 'the accepted claim to reach the policy');
  await first.policy.upsertPolicy('telegram', { allowlistUserIds: ['U-OWNER'] });
  expect((await first.policy.evaluateIngress(message('telegram', 'U-STRANGER'))).allowed).toBe(false);

  // A claim on another surface, answered after this daemon stopped listening.
  expect((await first.policy.evaluateIngress(message('slack', 'U-SLACK'))).allowed).toBe(false);
  const slackClaim = claimOf(first.inbox, 'U-SLACK');
  expect(slackClaim).toBeDefined();
  await first.stop();
  const answering = new OwnerInbox({ questions: new QuestionStore({ path: join(dir, 'owner-inbox.sqlite') }) });
  expect((await answering.answer(slackClaim!.id, { option: 'accept' }, { actor: 'owner', surface: 'web' })).applied).toBe(true);
  answering.dispose();

  // The restart.
  const second = await daemon(dir);
  try {
    // The answer given while down is applied: the replay ran.
    await until(() => second.policy.getPolicy('slack').allowlistUserIds.includes('U-SLACK'), 'the answer given while down to be applied');
    expect((await second.policy.evaluateIngress(message('slack', 'U-SLACK'))).allowed).toBe(true);

    // The removal holds: the earlier acceptance was not applied again.
    expect(second.policy.getPolicy('telegram').allowlistUserIds).toEqual(['U-OWNER']);
    expect((await second.policy.evaluateIngress(message('telegram', 'U-STRANGER'))).allowed).toBe(false);
    expect((await second.policy.evaluateIngress(message('telegram', 'U-OWNER'))).allowed).toBe(true);
    expect(second.policy.getPolicy('telegram').ownerId).toBe('U-OWNER');
  } finally {
    await second.stop();
  }
});
