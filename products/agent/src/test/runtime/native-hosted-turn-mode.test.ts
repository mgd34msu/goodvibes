import { expect, test } from 'bun:test';
import type { GatePresetName } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import { createNativeHostedTurnClient } from '../../runtime/native-hosted-turn.ts';

test('native start sends the surface execution choice through the authenticated start protocol only', async () => {
  let mode: GatePresetName = 'yolo';
  const calls: { method: string; target: unknown }[] = [];
  const operator: Pick<OperatorRemoteClient, 'invoke'> = {
    invoke: async <T,>(method: string, target: unknown): Promise<T> => {
      calls.push({ method, target });
      return { kind: 'not-found' } as T;
    },
  };
  const client = createNativeHostedTurnClient(operator, 'project-one', () => mode);
  const identity = { projectId: 'project-one', inputId: 'input-one', sourceRevision: 'source-one' };
  await client.start(identity);
  mode = 'safe-jev';
  await client.start(identity);
  await client.status(identity);
  await client.cancel(identity);
  expect(calls).toEqual([
    { method: 'workLedger.turn.startAgent', target: { ...identity, permissionMode: 'yolo' } },
    { method: 'workLedger.turn.startAgent', target: { ...identity, permissionMode: 'safe-jev' } },
    { method: 'workLedger.turn.status', target: identity },
    { method: 'workLedger.turn.cancel', target: identity },
  ]);
});

test('native host source identity is checked before any execution-mode request is sent', async () => {
  let calls = 0;
  const operator: Pick<OperatorRemoteClient, 'invoke'> = { invoke: async <T,>(): Promise<T> => { calls++; return { kind: 'not-found' } as T; } };
  const client = createNativeHostedTurnClient(operator, 'project-one', () => 'yolo');
  await expect(client.start({ projectId: 'another-project', inputId: 'input-one', sourceRevision: 'source-one' })).rejects.toThrow('project changed');
  expect(calls).toBe(0);
});
