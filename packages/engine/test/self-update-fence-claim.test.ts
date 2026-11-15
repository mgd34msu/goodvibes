import { expect, test } from 'bun:test';
import {
  UpdateTransactionContendedError, UpdateTransactionError, swapFileAtomically,
} from '../platform/src/platform/runtime/self-update.ts';
import { nativeMemoryIo } from './_helpers/daemon-native-cohort.ts';

const claim = (extra: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ operation: 'update', pid: process.ppid, startedAt: Date.now(), ...extra }));

function attempt(claimBytes: Buffer): UpdateTransactionError {
  const { io } = nativeMemoryIo({ '/fixture/daemon': Buffer.from('old'), '/fixture/daemon.update-transaction': claimBytes });
  try { swapFileAtomically('/fixture/daemon', Buffer.from('new'), { executable: true, io }); } catch (error) { return error as UpdateTransactionError; }
  throw new Error('the update was expected to be refused');
}

test('a recovery fence left by a failed transaction is recovery, never "retry once it finishes", even while its pid is alive', () => {
  const live = attempt(claim({}));
  expect(live.cause).toBeInstanceOf(UpdateTransactionContendedError);
  expect(live.receipt.recoveryRequired).toBe(false);

  const fenced = attempt(claim({ fenced: true }));
  expect(fenced.cause).not.toBeInstanceOf(UpdateTransactionContendedError);
  expect(fenced.receipt.recoveryRequired).toBe(true);
  expect(fenced.receipt.recoveryPaths).toContain('/fixture/daemon.update-transaction');
});

test('the claim a failed commit leaves behind is the fenced copy, so a second updater is not told to wait', () => {
  const memory = nativeMemoryIo({ '/fixture/daemon': Buffer.from('old') });
  const realRename = memory.io.rename.bind(memory.io);
  let renames = 0;
  memory.io.rename = (from, to) => { renames += 1; if (renames > 1) throw new Error('disk fault'); realRename(from, to); };
  let first: UpdateTransactionError | undefined;
  try { swapFileAtomically('/fixture/daemon', Buffer.from('new'), { executable: true, io: memory.io }); } catch (error) { first = error as UpdateTransactionError; }
  expect(first?.receipt.recoveryRequired).toBe(true);
  const left = memory.files.get('/fixture/daemon.update-transaction');
  expect(left).toBeDefined();
  expect(JSON.parse(left!.toString()).fenced).toBe(true);
  expect(left!.length).toBeGreaterThan(0);

  const second = attempt(left!);
  expect(second.cause).not.toBeInstanceOf(UpdateTransactionContendedError);
  expect(second.receipt.recoveryRequired).toBe(true);
});
