// Proves: A paired device or member that does not own a hosted session reads or rewrites the owner's queued messages, or cancels the owner's turn or a running tool call.
// Red when: A live-turn verb (sessions.queuedMessages.list, edit, delete, sessions.turns.cancel, sessions.toolCalls.cancel) acts on a hosted session without admitting the caller against that session's owners.
// Proves: A paired device or member that does not own a hosted session rewinds its conversation, cutting the owner's messages, or undoes the owner's rewind.
// Red when: rewind.plan or rewind.apply with scope conversation or both, or rewind.undo, reaches the conversation without admitting the caller against that session's owners.
/**
 * The catalog gate admits these verbs for any credential holding write:sessions
 * or read:transcripts, whatever session it names; the session's owners are the
 * subject, checked by the handler. The real handlers and controls over the real
 * live-turn holder with the session's owners installed as the hosted-session
 * engine installs them. The bound loop is a stand-in that keeps the queue and
 * what was cancelled, which is what the owner would lose.
 */
import { expect, test } from 'bun:test';
import { actorFromPrincipal, NO_OWNER_USER } from '@goodvibes/engine/daemon-api/http-policy';
import {
  createSessionQueuedMessageDeleteHandler,
  createSessionQueuedMessageEditHandler,
  createSessionQueuedMessagesListHandler,
  createSessionRuntimeControls,
  createSessionToolCallCancelHandler,
  createSessionTurnCancelHandler,
  SessionLiveTurnControlsHolder,
  type PermissionModeConfig,
  type SessionLiveTurnControls,
} from '../platform/src/platform/control-plane/routes/session-runtime.ts';
import type { GatewayMethodHandler } from '../platform/src/platform/control-plane/method-catalog-shared.ts';
import {
  createRewindApplyHandler,
  createRewindPlanHandler,
  createRewindUndoHandler,
  type RewindConversationUndoPort,
} from '../platform/src/platform/control-plane/routes/rewind.ts';
import { UnifiedRewindService, type RewindConversationPort } from '../platform/src/platform/rewind/index.ts';

const SESSION = 'hosted-alice';
const OWNER_TEXT = 'Pay the March invoice to the account ending 4410';

function boundLoop() {
  const state = { queue: [{ id: 'm1', queuedAt: 1, text: OWNER_TEXT }], cancelledTurns: [] as string[], cancelledCalls: [] as string[] };
  const live: SessionLiveTurnControls = {
    cancelTurn: (turnId) => { state.cancelledTurns.push(turnId); return { status: 'cancellation-requested' }; },
    cancelToolCall: (callId) => { state.cancelledCalls.push(callId); return true; },
    listQueuedMessages: () => state.queue.map((message) => ({ ...message })),
    editQueuedMessage: (id, text) => { const message = state.queue.find((entry) => entry.id === id); if (!message) return false; message.text = text; return true; },
    deleteQueuedMessage: (id) => { const before = state.queue.length; state.queue = state.queue.filter((entry) => entry.id !== id); return state.queue.length < before; },
  };
  return { state, live };
}

const device = (principalId: string) => actorFromPrincipal({
  principalId, principalKind: 'token', credentialKind: 'device-token', admin: false, scopes: ['write:sessions', 'read:transcripts'],
}, NO_OWNER_USER);

test('a device that does not own a hosted session cannot read, rewrite or delete its queued message or cancel its turn or tool call; its owner can', async () => {
  const { state, live } = boundLoop();
  const holder = new SessionLiveTurnControlsHolder();
  holder.bindSession(SESSION, live);
  holder.setSessionOwners((sessionId) => (sessionId === SESSION ? ['pairing:alice-phone'] : null));
  const config: PermissionModeConfig = { get: () => 'prompt' as never, set: () => undefined };
  const controls = createSessionRuntimeControls({
    config,
    store: { getState: () => ({ session: { id: 'local-runtime' }, conversation: { estimatedContextTokens: 0 } }) },
    liveTurnHolder: holder,
  });
  const verbs: Record<string, { handler: GatewayMethodHandler; body: Record<string, unknown> }> = {
    list: { handler: createSessionQueuedMessagesListHandler(controls), body: { sessionId: SESSION } },
    edit: { handler: createSessionQueuedMessageEditHandler(controls), body: { sessionId: SESSION, messageId: 'm1', text: 'Pay it to the account ending 9999' } },
    delete: { handler: createSessionQueuedMessageDeleteHandler(controls), body: { sessionId: SESSION, messageId: 'm1' } },
    cancelTurn: { handler: createSessionTurnCancelHandler(controls), body: { sessionId: SESSION, expectedTurnId: 't1' } },
    cancelToolCall: { handler: createSessionToolCallCancelHandler(controls), body: { sessionId: SESSION, callId: 'c1' } },
  };
  const call = async (principalId: string, verb: string): Promise<string> => {
    const { handler, body } = verbs[verb]!;
    try {
      const answer = await handler({ body, context: { principalId, actor: device(principalId) } });
      return JSON.stringify(answer).includes(OWNER_TEXT) ? 'read the text' : 'done';
    } catch (error) {
      return (error as { code?: string }).code ?? 'threw';
    }
  };

  const stranger: Record<string, string> = {};
  for (const verb of Object.keys(verbs)) stranger[verb] = await call('pairing:other-phone', verb);
  expect({ stranger, state: { ...state, queue: [...state.queue] } }).toEqual({
    stranger: { list: 'NOT_YOURS', edit: 'NOT_YOURS', delete: 'NOT_YOURS', cancelTurn: 'NOT_YOURS', cancelToolCall: 'NOT_YOURS' },
    state: { queue: [{ id: 'm1', queuedAt: 1, text: OWNER_TEXT }], cancelledTurns: [], cancelledCalls: [] },
  });

  // The control: the session's owner, holding the same scopes, does each of them.
  expect(await call('pairing:alice-phone', 'list')).toBe('read the text');
  expect(await call('pairing:alice-phone', 'cancelTurn')).toBe('done');
  expect(await call('pairing:alice-phone', 'cancelToolCall')).toBe('done');
  expect(await call('pairing:alice-phone', 'delete')).toBe('done');
  expect(state).toEqual({ queue: [], cancelledTurns: ['t1'], cancelledCalls: ['c1'] });
});

/** The surface hosting the session's conversation: what it holds, what was cut from it and what was put back. */
function hostedConversation() {
  const state = { messages: 5, cuts: 0, restored: [] as string[] };
  const port: RewindConversationPort & RewindConversationUndoPort = {
    preview: async () => ({ messagesToDrop: state.messages, messagesRemaining: 0, revision: `r${state.messages}` }),
    rewind: async () => { state.cuts += 1; state.messages = 0; return { droppedMessages: 5, undoSnapshotId: 'undo-1' }; },
    restoreBefore: (id) => { state.restored.push(id); state.messages = 5; return true; },
    messagesSinceRewind: (id) => (id === 'undo-1' && state.cuts > 0 ? 0 : null),
    snapshotSession: () => SESSION,
  };
  return { state, port };
}

test('a device that does not own a hosted session cannot plan, apply or undo a rewind of its conversation; its owner can', async () => {
  const { state, port } = hostedConversation();
  const holder = new SessionLiveTurnControlsHolder();
  holder.setSessionOwners((sessionId) => (sessionId === SESSION ? ['pairing:alice-phone'] : null));
  const service = new UnifiedRewindService({ conversation: port });
  const owners = (sessionId: string) => holder.ownersOf(sessionId);
  const plan = createRewindPlanHandler(service, owners);
  const apply = createRewindApplyHandler(service, owners);
  const undo = createRewindUndoHandler(service, { local: port }, owners);
  const call = async (principalId: string, handler: GatewayMethodHandler, body: Record<string, unknown>): Promise<unknown> => {
    try {
      return await handler({ body, context: { principalId, actor: device(principalId) } });
    } catch (error) {
      return (error as { code?: string }).code ?? 'threw';
    }
  };
  const { token } = await call('pairing:alice-phone', plan, { sessionId: SESSION, scope: 'conversation' }) as { token: string };
  const { token: bothToken } = await call('pairing:alice-phone', plan, { sessionId: SESSION, scope: 'both' }) as { token: string };

  // Holding write:sessions and the owner's own confirm token, another device is still refused at each step.
  const stranger = {
    planConversation: await call('pairing:other-phone', plan, { sessionId: SESSION, scope: 'conversation' }),
    planBoth: await call('pairing:other-phone', plan, { sessionId: SESSION, scope: 'both' }),
    applyConversation: await call('pairing:other-phone', apply, { sessionId: SESSION, scope: 'conversation', confirmToken: token }),
    applyBoth: await call('pairing:other-phone', apply, { sessionId: SESSION, scope: 'both', confirmToken: bothToken }),
  };
  expect({ stranger, state: { ...state, restored: [...state.restored] } }).toEqual({
    stranger: { planConversation: 'NOT_YOURS', planBoth: 'NOT_YOURS', applyConversation: 'NOT_YOURS', applyBoth: 'NOT_YOURS' },
    state: { messages: 5, cuts: 0, restored: [] },
  });

  // The control: the owner applies the rewind they planned.
  const applied = await call('pairing:alice-phone', apply, { sessionId: SESSION, scope: 'conversation', confirmToken: token }) as { receipt: { conversation: { rewound: boolean } } };
  expect(applied.receipt.conversation.rewound).toBe(true);
  // Another device cannot undo it, bringing back what the owner cut; the owner can.
  expect(await call('pairing:other-phone', undo, { sessionId: SESSION, undoSnapshotId: 'undo-1' })).toBe('NOT_YOURS');
  expect(state).toEqual({ messages: 0, cuts: 1, restored: [] });
  expect((await call('pairing:alice-phone', undo, { sessionId: SESSION, undoSnapshotId: 'undo-1' }) as { undone: boolean }).undone).toBe(true);
  expect(state).toEqual({ messages: 5, cuts: 1, restored: ['undo-1'] });
});
