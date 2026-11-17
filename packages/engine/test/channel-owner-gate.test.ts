/**
 * Who reaches the assistant over a chat channel, and who may answer for the
 * owner. On a surface with no owner the first unknown sender is held as a
 * claim and becomes the owner only when the owner accepts it; an unknown sender
 * starts no session; and only the owner (not a stranger, not another
 * allowlisted sender) can answer a pending permission ask by replying in the
 * channel.
 *
 * Real policy manager over its file, real owner inbox over its SQLite file,
 * real approval broker and surface-action helper; the decision model is the
 * approval-readings fixture port.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { createOwnerInbox } from '../platform/src/platform/control-plane/owner-inbox.ts';
import { DaemonSurfaceActionHelper } from '../platform/src/platform/daemon/surface-actions.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
import { useApprovalReadings } from './helpers/approval-readings.ts';

const readings = useApprovalReadings();
const scratchDirs: string[] = [];
afterEach(() => { for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-channel-owner-gate-'));
  scratchDirs.push(dir);
  return dir;
}

/** Let the event loop turn until `done` holds; bounded in turns, never in milliseconds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 20_000; turn += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  if (!done()) throw new Error(`Gave up waiting for: ${what}`);
}

/** A slack surface whose owner is U-OWNER and which also admits U-FRIEND. */
async function ownedSlack(): Promise<ChannelPolicyManager> {
  const policy = new ChannelPolicyManager({ storePath: join(scratch(), 'policies.json') });
  await policy.upsertPolicy('slack', { allowlistUserIds: ['U-OWNER', 'U-FRIEND'] });
  expect(policy.getPolicy('slack').ownerId).toBe('U-OWNER');
  return policy;
}

test('the first unknown sender is held as a claim; only an accepted claim makes them the owner', async () => {
  const dir = scratch();
  const policy = new ChannelPolicyManager({ storePath: join(dir, 'policies.json') });
  const inbox = createOwnerInbox({ questionsPath: join(dir, 'owner-inbox.sqlite') });
  policy.attachOwnerInbox(inbox);
  try {
    expect((await policy.evaluateIngress({ surface: 'telegram', userId: 'U-STRANGER', conversationKind: 'direct', text: 'hi' })).allowed).toBe(false);
    expect((await policy.evaluateIngress({ surface: 'telegram', userId: 'U-OWNER', conversationKind: 'direct', text: 'hello' })).allowed).toBe(false);
    expect(policy.getPolicy('telegram').allowlistUserIds).toEqual([]);
    expect(policy.getPolicy('telegram').ownerId).toBeUndefined();

    const claims = inbox.listNow({ kinds: ['claim'], status: 'open' });
    expect(claims).toHaveLength(2);
    const ownerClaim = claims.find((item) => item.metadata?.['userId'] === 'U-OWNER')!;
    expect((await inbox.answer(ownerClaim.id, { option: 'accept' }, { actor: 'owner', surface: 'tui' })).applied).toBe(true);
    await until(() => policy.getPolicy('telegram').ownerId === 'U-OWNER', 'the accepted claim to make U-OWNER the owner');

    expect(policy.getPolicy('telegram').allowlistUserIds).toEqual(['U-OWNER']);
    expect((await policy.evaluateIngress({ surface: 'telegram', userId: 'U-OWNER', conversationKind: 'direct', text: 'again' })).allowed).toBe(true);
    expect((await policy.evaluateIngress({ surface: 'telegram', userId: 'U-STRANGER', conversationKind: 'direct', text: 'again' })).allowed).toBe(false);
  } finally {
    await policy.stop();
    inbox.dispose();
  }
});

describe('a reply in the channel answering a pending permission ask', () => {
  function askRequest(callId: string): PermissionPromptRequest {
    return {
      callId, tool: 'run_command', args: { command: 'deploy' }, category: 'execute',
      analysis: { classification: 'execute', riskLevel: 'medium', summary: 'run a command', reasons: [] },
    };
  }

  async function pendingAsk(callId: string) {
    const policy = await ownedSlack();
    const broker = new ApprovalBroker({ storePath: join(scratch(), 'approvals.json') });
    await broker.start();
    const helper = new DaemonSurfaceActionHelper({
      channelPolicy: policy,
      approvalBroker: broker,
      routeBindings: { getBinding: () => ({ surfaceKind: 'slack' }) },
    } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
    const decision = broker.requestApproval({ request: askRequest(callId), routeId: 'route-1' });
    await until(() => broker.listApprovals(10).some((entry) => entry.status === 'pending'), 'the ask to be pending');
    const reply = (userId: string, text: string) => helper.authorizeSurfaceIngress({ surface: 'slack', userId, conversationKind: 'direct', text });
    return { policy, broker, decision, reply };
  }

  test('a stranger, or an allowlisted sender who is not the owner, never touches it', async () => {
    readings.set({ reply: 'approve' });
    const ask = await pendingAsk('call-guard');
    void ask.decision.catch(() => undefined);
    try {
      const stranger = await ask.reply('U-STRANGER', 'approve');
      expect(stranger.allowed).toBe(false);
      expect(stranger.reason).toBe('user-not-allowlisted');
      const friend = await ask.reply('U-FRIEND', 'approve');
      expect(friend.reason).not.toBe('approval-reply-consumed');
      expect(ask.broker.listApprovals(10)[0]!.status).toBe('pending');
    } finally {
      await ask.policy.stop();
    }
  });
});

/** A telegram surface owned by U-OWNER with the given allowlists. */
async function policyWith(lists: { allowlistUserIds?: string[]; allowlistGroupIds?: string[] }): Promise<ChannelPolicyManager> {
  const policy = new ChannelPolicyManager({ storePath: join(scratch(), 'policies.json') });
  await policy.upsertPolicy('telegram', { ...lists, ownerId: 'U-OWNER' });
  return policy;
}

const admitted = async (policy: ChannelPolicyManager, input: { userId: string; conversationKind: 'direct' | 'group'; groupId: string }) =>
  (await policy.evaluateIngress({ surface: 'telegram', text: 'hi', ...input })).allowed;

test('with only a group listed, a stranger cannot write directly; the owner can', async () => {
  const policy = await policyWith({ allowlistGroupIds: ['G-TEAM'] });
  try {
    expect(await admitted(policy, { userId: 'U-STRANGER', conversationKind: 'direct', groupId: 'U-STRANGER' })).toBe(false);
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'direct', groupId: 'U-OWNER' })).toBe(true);
    expect(await admitted(policy, { userId: 'U-MEMBER', conversationKind: 'group', groupId: 'G-TEAM' })).toBe(true);
  } finally { await policy.stop(); }
});

test('with a user and a group listed, only that user in that group is taken', async () => {
  const policy = await policyWith({ allowlistUserIds: ['U-OWNER'], allowlistGroupIds: ['G-TEAM'] });
  try {
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'group', groupId: 'G-TEAM' })).toBe(true);
    expect(await admitted(policy, { userId: 'U-MEMBER', conversationKind: 'group', groupId: 'G-TEAM' })).toBe(false);
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'group', groupId: 'G-OTHER' })).toBe(false);
    expect(await admitted(policy, { userId: 'U-OWNER', conversationKind: 'direct', groupId: 'U-OWNER' })).toBe(true);
  } finally { await policy.stop(); }
});
