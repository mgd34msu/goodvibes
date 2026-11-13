import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createOperatorNativeConversationIntakeClient, type NativeConversationIntakeResult } from '../platform/src/platform/workflow/work-ledger/native-intake-client.js';
import type { OperatorRemoteClient } from '../operator-client/src/client-core.js';
import {
  admitNativeConversationTurn, failNativeConversationTurn, nativeConversationTurnLifecycle,
  readNativeConversationTurnStatus, settleNativeConversationTurn, startNativeConversationTurn,
} from '../platform/src/platform/core/native-turn-admission.js';

const text = 'Explain the release';
async function permit() {
  const inputId = randomUUID();
  const result: NativeConversationIntakeResult = { kind: 'turn', projectId: 'native-project', requestId: `request-${inputId}`,
    sourceRef: { version: 1, inputId, sourceId: `source-${inputId}`, sourceRevision: 'revision-1', sessionId: 'native-source-session' }, route: 'answer', text };
  const invoke: OperatorRemoteClient['invoke'] = async <T>() => structuredClone(result) as T;
  const client = createOperatorNativeConversationIntakeClient({ invoke }, 'native-project');
  const captured = await client.capture({ requestId: result.requestId, inputId, text, unsupportedSources: [] });
  return { client, permit: client.bindTurn(captured) };
}

test('a settled turn cannot be failed back into a retryable one, so it can never run twice', async () => {
  const { client, permit: p } = await permit();
  const turn = admitNativeConversationTurn(p, text)!;
  startNativeConversationTurn(turn);
  settleNativeConversationTurn(turn);
  failNativeConversationTurn(turn, true);
  expect(readNativeConversationTurnStatus(p)).toBe('settled');
  failNativeConversationTurn(turn, false);
  expect(readNativeConversationTurnStatus(p)).toBe('settled');
  expect(admitNativeConversationTurn(p, text)).toBeNull();
  client.dispose();
});

test('a turn that needs recovery is not upgraded to retryable by a later failure report', async () => {
  const { client, permit: p } = await permit();
  const turn = admitNativeConversationTurn(p, text)!;
  startNativeConversationTurn(turn);
  failNativeConversationTurn(turn, false);
  failNativeConversationTurn(turn, true);
  expect(readNativeConversationTurnStatus(p)).toBe('recovery_required');
  client.dispose();
});

test('the table names the six states and the legal moves', () => {
  expect(nativeConversationTurnLifecycle.states).toEqual(['unclaimed', 'queued', 'running', 'settled', 'retryable', 'recovery_required']);
  expect(nativeConversationTurnLifecycle.isTerminal('settled')).toBe(true);
  expect(nativeConversationTurnLifecycle.can('settled', 'retryable')).toBe(false);
  expect(nativeConversationTurnLifecycle.can('running', 'retryable')).toBe(true);
});
