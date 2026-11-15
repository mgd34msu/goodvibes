import { expect, test } from 'bun:test';
import { headlessSessionSnapshot, settleHeadlessTurn } from '../../cli/native-headless-turn.ts';

const ok = { exitCode: 0, response: 'the answer', stopReason: 'completed' };

test('a failing shutdown keeps the answer, writes the pointer and fails the exit code', async () => {
  const pointers: string[] = [];
  const result = await settleHeadlessTurn(async () => ok, {
    shutdown: async () => { throw new Error('durable save failed'); },
    sessionReady: () => true,
    writeSessionPointer: () => { pointers.push('s1'); },
  });
  expect(result.response).toBe('the answer');
  expect(result.exitCode).toBe(1);
  expect(result.error).toContain('durable save failed');
  expect(pointers).toEqual(['s1']);
});

test('a failing shutdown does not mask the error the turn threw', async () => {
  await expect(settleHeadlessTurn(async () => { throw new Error('turn broke'); }, {
    shutdown: async () => { throw new Error('shutdown broke'); },
    sessionReady: () => false,
    writeSessionPointer: () => { throw new Error('pointer must not be written'); },
  })).rejects.toThrow('turn broke');
});

test('a clean turn and shutdown return the result untouched', async () => {
  const result = await settleHeadlessTurn(async () => ok, {
    shutdown: async () => undefined, sessionReady: () => true, writeSessionPointer: () => undefined,
  });
  expect(result).toEqual(ok);
});

test('the saved headless session carries a return context and the title source', () => {
  const messages: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: 'fix the build' }];
  const saved = headlessSessionSnapshot({ messages, timestamp: 1 }, undefined, 1);
  expect(saved.messages).toBe(messages);
  expect(saved.timestamp).toBe(1);
  expect(saved.returnContext).toBeDefined();
});

test('a run that never got a session discards the empty one shutdown saved, after shutdown', async () => {
  const events: string[] = [];
  await expect(settleHeadlessTurn(async () => { throw new Error('No session named missing'); }, {
    shutdown: async () => { events.push('shutdown'); },
    sessionReady: () => false,
    writeSessionPointer: () => { throw new Error('pointer must not be written'); },
    discardUnusedSession: () => { events.push('discard'); },
  })).rejects.toThrow('No session named missing');
  expect(events).toEqual(['shutdown', 'discard']);
});

test('a run with a ready session is never discarded', async () => {
  const events: string[] = [];
  await settleHeadlessTurn(async () => ok, {
    shutdown: async () => undefined,
    sessionReady: () => true,
    writeSessionPointer: () => { events.push('pointer'); },
    discardUnusedSession: () => { events.push('discard'); },
  });
  expect(events).toEqual(['pointer']);
});
