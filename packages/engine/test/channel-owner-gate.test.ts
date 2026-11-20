// Proves: A sender outside the owner's allowlists reaches the assistant because the lists are combined as "any" instead of "all".
// Red when: With only a group listed a stranger's direct message is admitted, or with a user and a group listed an unlisted member or an unlisted group is admitted.
// Proves: The first person to write to an unowned channel becomes its owner, or someone other than the owner answers a pending permission ask by replying in the channel.
// Red when: The first unknown sender is admitted or made owner without the owner accepting the claim, or a non-owner's "approve" resolves a pending approval.
// Proves: A card number typed into a chat channel is kept in the session, the policy audit and a model request.
// Red when: `authorizeSurfaceIngress` reads, records or passes on a message with a card number instead of refusing it first and telling the owner on that channel.
// Proves: A guest on the owner's channel settles something of the owner's: answers a purchase window, presses Approve on a permission ask, or cancels a run; or the owner's command from one conversation acts on work another started.
// Red when: The purchase-window reply, the approve button or a channel control command stops requiring the channel's owner, or a control command stops requiring that its conversation started the work it names.
// Proves: A stranger writing in a chat the owner set up for delegated review is offered ownership of the channel or a place on its allowlist, or is made its owner.
// Red when: The ingress decision stops reading a delegated chat as delegated review for a sender other than the owner, or the first-sender seeding stops skipping a delegated chat: a claim is posted or the stranger becomes owner.
/**
 * Who reaches the assistant over a chat channel, and who may answer for the
 * owner. On a surface with no owner the first unknown sender is held as a
 * claim and becomes the owner only when the owner accepts it; an unknown sender
 * starts no session; and only the owner (not a stranger, not another
 * allowlisted sender) can answer a pending permission ask by replying in the
 * channel.
 *
 * Real policy manager over its file, real owner inbox over its SQLite file,
 * real approval broker and surface-action helper, and the real delegated
 * Telegram intake reading its own record of delegated chats; the decision
 * model is the approval-readings fixture port.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { createOwnerInbox } from '../platform/src/platform/control-plane/owner-inbox.ts';
import { DaemonSurfaceActionHelper } from '../platform/src/platform/daemon/surface-actions.ts';
import { handleInteractiveApprovalAction } from '../platform/src/platform/daemon/facade-approval-action.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';
import { useApprovalReadings } from './helpers/approval-readings.ts';
import { DelegatedTelegramIntake } from '../platform/src/platform/daemon/delegated-telegram-intake.ts';
import { createTelegramSourceAccountOwner } from '../platform/src/platform/channels/telegram/source-account.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';

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

test('a card number the owner sends on the channel is refused before anything reads it, and the owner is told', async () => {
  const policy = await ownedSlack();
  const notices: string[] = [];
  const helper = new DaemonSurfaceActionHelper({
    channelPolicy: policy,
    routeBindings: { getBinding: () => ({ surfaceKind: 'slack' }), listBindings: () => [] },
    deliverSurfaceNotice: async (_binding: unknown, message: string) => { notices.push(message); return { delivered: true }; },
  } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  try {
    const card = await helper.authorizeSurfaceIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct',
      text: 'use my card 4111 1111 1111 1111 for the kettle' });
    expect(card.allowed).toBe(false);
    expect(card.reason).toStartWith('card-shapes-refused');
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain('1111');
    // Control: the same words without the number go on to the conversation.
    expect((await helper.authorizeSurfaceIngress({ surface: 'slack', userId: 'U-OWNER', conversationKind: 'direct',
      text: 'use my card for the kettle' })).allowed).toBe(true);
  } finally {
    await policy.stop();
  }
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

test('a guest on the owner\'s channel answers no purchase window, presses no approval, cancels no run; the owner does, from the conversation that started it', async () => {
  const retire = configureDecisionModelPolicy(() => 'No Decision Model');
  const root = scratch();
  const policy = await ownedSlack();
  await policy.upsertPolicy('telegram', { allowlistUserIds: ['U-OWNER', 'U-FRIEND'], ownerId: 'U-OWNER' });
  const broker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
  await broker.start();
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({ storePath: join(root, 'sessions.json'), routeBindings,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } });
  await sessionBroker.start();
  const paymentReplies = new PaymentReplyInbox();
  // The agent runtime is the stand-in: one running agent, and a record of what was cancelled.
  const cancelled: string[] = [];
  const running = { id: 'agent-a', status: 'running', task: 'the owner\'s job', tools: [] };
  const agentManager = { getStatus: (id: string) => id === 'agent-a' ? running : null,
    cancel: (id: string) => { cancelled.push(id); return true; } };
  const helper = new DaemonSurfaceActionHelper({
    channelPolicy: policy, approvalBroker: broker, routeBindings, sessionBroker, agentManager, paymentReplies,
    automationManager: { getRun: () => undefined, cancelRun: async () => undefined },
    // As the daemon wires it: the button's press goes to the approval action with who pressed it.
    handleApprovalAction: (approvalId: string, action: 'claim' | 'approve' | 'deny' | 'cancel', req: Request, interaction?: { readonly surface: string; readonly userId: string }) =>
      handleInteractiveApprovalAction({ broker, channelPolicy: policy, interaction, parseBody: async () => null,
        actor: () => `${interaction?.surface ?? 'web'}:${interaction?.userId ?? ''}`, surface: () => interaction?.surface ?? 'web',
        record: (_request, _path, response) => response }, approvalId, action, req),
  } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  try {
    // The purchase window: the guest's yes is not taken; the owner's settles it.
    const window = paymentReplies.waitForAnswer({ purchaseId: 'p-1', kind: 'approval', deadlineMs: Date.now() + 600_000, channels: ['telegram'], notice: 'Buy the kettle for 20.00?' });
    const reply = (userId: string) => helper.authorizeSurfaceIngress({ surface: 'telegram', userId, conversationKind: 'direct', text: 'approve' });
    await reply('U-FRIEND');
    expect(paymentReplies.pending).toBe(1);
    await reply('U-OWNER');
    expect(await window).toEqual({ answer: 'approve', channel: 'telegram' });

    // The approve button on a permission ask: the guest's press, and one with no sender, leave it pending; the owner's approves it.
    const ask = broker.requestApproval({ request: { callId: 'call-button', tool: 'run_command', args: { command: 'deploy' }, category: 'execute',
      analysis: { classification: 'execute', riskLevel: 'medium', summary: 'run a command', reasons: [] } }, routeId: 'route-1' });
    void ask.catch(() => undefined);
    await until(() => broker.listApprovals(10).some((entry) => entry.status === 'pending'), 'the ask to be pending');
    const approvalId = broker.listApprovals(10).find((entry) => entry.status === 'pending')!.id;
    const press = (userId?: string) => helper.performInteractiveSurfaceAction(`gv:approval:approve:${approvalId}`, 'slack', new Request('http://127.0.0.1/slack/actions', { method: 'POST' }), userId);
    await press('U-FRIEND');
    await press(undefined);
    expect(broker.listApprovals(10).find((entry) => entry.id === approvalId)!.status).toBe('pending');
    await press('U-OWNER');
    expect(broker.listApprovals(10).find((entry) => entry.id === approvalId)!.status).toBe('approved');

    // A control command: the agent was started from conversation A.
    const routeA = await routeBindings.upsertBinding({ kind: 'channel', surfaceKind: 'slack', surfaceId: 'slack', externalId: 'C-A', channelId: 'C-A' });
    const routeB = await routeBindings.upsertBinding({ kind: 'channel', surfaceKind: 'slack', surfaceId: 'slack', externalId: 'C-B', channelId: 'C-B' });
    const submitted = await sessionBroker.submitMessage({ routeId: routeA.id, surfaceKind: 'slack', surfaceId: 'slack', externalId: 'C-A', body: 'start the job', providerMessageId: 'm-1' });
    await sessionBroker.bindAgent(submitted.session.id, 'agent-a', submitted.input!.id);
    const scope = helper.buildSurfaceAdapterContext();
    const command = async (userId: string, routeId: string) => {
      expect((await scope.authorizeSurfaceIngress({ surface: 'slack', userId, conversationKind: 'direct', text: '/cancel agent-a' })).allowed).toBe(true);
      const parsed = await scope.parseSurfaceControlCommand('/cancel agent-a');
      return scope.performSurfaceControlCommand(parsed!, { surface: 'slack', routeId, userId });
    };
    expect(await command('U-FRIEND', routeA.id)).toStartWith('Not done');
    expect(await command('U-OWNER', routeB.id)).toStartWith('Not done');
    expect(cancelled).toEqual([]);
    expect(await command('U-OWNER', routeA.id)).toBe('Cancelled agent agent-a');
    expect(cancelled).toEqual(['agent-a']);
  } finally {
    retire();
    await paymentReplies.close();
    await sessionBroker.stop();
    await policy.stop();
  }
});

test('a stranger in a chat set up for delegated review is never offered ownership or the allowlist, with or without an owner', async () => {
  const dir = scratch();
  const chat = '-100777';
  // The owner set this group up for delegated review before the daemon started: the intake's own record says so.
  const selectionPath = join(dir, 'telegram-delegated-selection.json');
  await new PersistentStore<{ selected: Array<{ chatId: string }> }>(selectionPath).persist({ selected: [{ chatId: chat }] }, { durable: true });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(dir, 'bindings.json')) });
  const sessions = new SharedSessionBroker({ storePath: join(dir, 'sessions.json'), routeBindings, agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } });
  await sessions.start();
  const approvals = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  const intake = new DelegatedTelegramIntake({
    broker: sessions, approvals, routes: routeBindings, accounts: createTelegramSourceAccountOwner().reader,
    workspaceRoot: dir, selectionPath, receiptPath: join(dir, 'telegram-delegated-review.json'),
  });
  const inbox = createOwnerInbox({ questionsPath: join(dir, 'owner-inbox.sqlite') });
  /** A policy manager wired as the daemon wires it: delegated chats read from the intake, claims put to the owner's inbox unless `noInbox`. */
  const surface = async (name: string, owner: string | null, noInbox = false) => {
    const policy = new ChannelPolicyManager({ storePath: join(dir, `${name}-policies.json`) });
    if (owner) await policy.upsertPolicy('telegram', { allowlistUserIds: [owner] });
    if (!noInbox) policy.attachOwnerInbox(inbox);
    policy.attachDelegatedReview({ isDelegated: async (kind, channelId, threadId) => kind === 'telegram' && await intake.selects(channelId, threadId) });
    return policy;
  };
  const stranger = (channelId: string) => ({ surface: 'telegram' as const, userId: '9001', channelId, groupId: channelId, conversationKind: 'group' as const, mentioned: true, text: 'please review this' });
  const owned = await surface('owned', '42');
  const unowned = await surface('unowned', null);
  const embedded = await surface('embedded', null, true);
  try {
    const seen = [];
    for (const [name, policy] of [['owned', owned], ['unowned', unowned], ['no inbox', embedded]] as const) {
      const decision = await policy.evaluateIngress(stranger(chat));
      seen.push({ name, reason: decision.reason, owner: policy.getPolicy('telegram').ownerId ?? null, allowlist: policy.getPolicy('telegram').allowlistUserIds });
    }
    expect(seen).toEqual([
      { name: 'owned', reason: 'delegated-review', owner: '42', allowlist: ['42'] },
      { name: 'unowned', reason: 'delegated-review', owner: null, allowlist: [] },
      { name: 'no inbox', reason: 'delegated-review', owner: null, allowlist: [] },
    ]);
    expect(inbox.listNow({ kinds: ['claim'], status: 'all' })).toEqual([]);
    // The same stranger in a chat that is not delegated is held as a claim: the claims above were withheld, not broken.
    expect((await unowned.evaluateIngress(stranger('-100888'))).reason).toBe('owner-claim-pending');
    expect(inbox.listNow({ kinds: ['claim'], status: 'open' }).map((item) => item.metadata?.['userId'])).toEqual(['9001']);
  } finally {
    await Promise.all([owned.stop(), unowned.stop(), embedded.stop()]);
    intake.close();
    inbox.dispose();
    await sessions.stop();
  }
});
