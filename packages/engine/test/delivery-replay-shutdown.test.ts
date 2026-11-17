/**
 * A dead letter is a message that could not be sent. Replaying it while the
 * queue shuts down, or while another replay runs, must neither lose it nor send
 * it twice.
 */
import { expect, test } from 'bun:test';
import { DeliveryError, DeliveryQueue } from '../platform/src/platform/integrations/delivery.ts';

function deferred() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
const terminal = () => new DeliveryError('synthetic terminal failure', 'terminal');
async function seeded() {
  const queue = new DeliveryQueue();
  await queue.enqueue('fixture', 'retained', 'original synthetic payload', async () => { throw terminal(); });
  return queue;
}

for (const shutdown of ['close', 'dispose'] as const) {
  test(`${shutdown} during a failed replay keeps the dead letter and sends nothing again`, async () => {
    const queue = await seeded(); const original = queue.getDlq(); const held = deferred(); let calls = 0;
    const replay = queue.replay(async () => { calls++; await held.promise; });
    const result = replay.catch((error: unknown) => error);
    const closing = shutdown === 'close' ? queue.close() : (queue.dispose(), undefined);
    try {
      held.reject(terminal()); expect(await result).toBeInstanceOf(DeliveryError); await closing;
      expect(queue.getDlq()).toEqual(original); expect(calls).toBe(1);
    } finally { held.resolve(); await queue.close(); }
  });
}

test('a shutdown started from inside the failing send still keeps the dead letter', async () => {
  const queue = await seeded(); const original = queue.getDlq(); const held = deferred();
  let closing: Promise<void> | undefined;
  const replay = queue.replay(async () => { closing = queue.close(); await held.promise; });
  const result = replay.catch((error: unknown) => error);
  try {
    held.reject(terminal()); await closing;
    expect(queue.getDlq()).toEqual(original); expect(await result).toBeInstanceOf(DeliveryError);
  } finally { held.resolve(); await queue.close(); }
});

test('a replay that delivers removes exactly its own row, also when close is waiting on it', async () => {
  const queue = await seeded(); const id = queue.getDlq()[0]!.id; const held = deferred();
  const replay = queue.replay(() => held.promise); const closing = queue.close();
  try {
    held.resolve(); await closing;
    expect(queue.getDlq()).toEqual([]);
    expect(await replay).toEqual([{ id, outcome: 'delivered' }]);
  } finally { held.resolve(); await queue.close(); }
});

test('a replay that fails again leaves one row, not two', async () => {
  const queue = await seeded();
  try {
    const result = await queue.replay(async () => { throw terminal(); });
    expect(result.map((entry) => entry.outcome)).toEqual(['dead_letter']);
    expect(queue.getDlq().map((entry) => entry.payload)).toEqual(['original synthetic payload']);
  } finally { await queue.close(); }
});

test('two replays at once send a retained row once', async () => {
  const queue = await seeded(); const held = deferred(); let firstCalls = 0; let competingCalls = 0;
  const first = queue.replay(async () => { firstCalls++; await held.promise; });
  try {
    expect(await queue.replay(async () => { competingCalls++; })).toEqual([]);
    expect(competingCalls).toBe(0); held.resolve(); await first;
    expect(firstCalls).toBe(1); expect(queue.getDlq()).toEqual([]);
  } finally { held.resolve(); await first; await queue.close(); }
});

test('a later row one replay already delivered is not sent again by the other', async () => {
  const queue = await seeded(); const held = deferred(); const calls: string[] = [];
  await queue.enqueue('fixture', 'second', 'second synthetic payload', async () => { throw terminal(); });
  const first = queue.replay(async (entry) => { calls.push(entry.payload); if (entry.payload === 'original synthetic payload') await held.promise; });
  try {
    await queue.replay(async (entry) => { calls.push(entry.payload); }); held.resolve(); await first;
    expect(calls).toEqual(['original synthetic payload', 'second synthetic payload']);
    expect(queue.getDlq()).toEqual([]);
  } finally { held.resolve(); await first; await queue.close(); }
});

test('a shutdown after one row was delivered keeps the row not yet tried', async () => {
  const queue = await seeded();
  await queue.enqueue('fixture', 'second', 'second synthetic payload', async () => { throw terminal(); });
  const second = queue.getDlq()[1];
  if (!second) throw new Error('Second fixture dead letter was not recorded');
  let calls = 0; let closing: Promise<void> | undefined;
  const result = queue.replay(async () => { calls++; closing = queue.close(); }).catch((error: unknown) => error);
  expect(await result).toBeInstanceOf(DeliveryError); await closing;
  expect(calls).toBe(1); expect(queue.getDlq()).toEqual([second]);
});
