import { expect, test } from 'bun:test';
import { captureProjectionArgs } from '../sdk/src/platform/tools/input-projection.ts';
import { snapshotJudgmentInput } from '../sdk/src/platform/gate/judgment-input.ts';
import { currentExecutionMode, currentExecutionModeOwner, isInvocationAdmitted, isYoloExecution, withExecutionMode, withExecutionModeOwner } from '../sdk/src/platform/gate/execution-context.ts';

test('simultaneous invocations retain their own mode across asynchronous work', async () => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const yolo = withExecutionMode('yolo', async () => {
    await waiting;
    expect(currentExecutionMode()).toBe('yolo');
    expect(isYoloExecution()).toBe(true);
  });
  await withExecutionMode('safe-owner', async () => {
    release();
    await yolo;
    expect(currentExecutionMode()).toBe('safe-owner');
    expect(isYoloExecution()).toBe(false);
  });
  expect(currentExecutionMode()).toBeUndefined();
});

test('YOLO can prepare protected tool arguments without sending them to judgment', () => {
  const args = { password: 'synthetic-inline-value' };
  withExecutionMode('yolo', () => {
    const captured = captureProjectionArgs(args, 'fixture');
    expect(captured).toEqual(args);
    expect(captured).not.toBe(args);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => snapshotJudgmentInput(captured, 'fixture')).toThrow();
  });
  withExecutionMode('safe-jev', () => {
    expect(captureProjectionArgs(args, 'fixture')).toEqual(args);
    expect(() => snapshotJudgmentInput(args, 'fixture')).toThrow();
  });
});

test('a mode selection cannot manufacture tool admission', () => {
  const args = {};
  expect(isInvocationAdmitted('exec', args)).toBe(false);
  withExecutionMode('yolo', () => { expect(isInvocationAdmitted('exec', args)).toBe(false); });
});

test('session owners stay isolated while exposing their current revision', async () => {
  const first = { getMode: () => 'safe-owner' as const, getRevision: () => 1 };
  const second = { getMode: () => 'yolo' as const, getRevision: () => 2 };
  await Promise.all([
    withExecutionModeOwner(first, async () => {
      await Promise.resolve();
      expect(currentExecutionModeOwner()).toBe(first);
      withExecutionMode('safe-jev', () => { expect(currentExecutionModeOwner()).toBe(first); });
    }),
    withExecutionModeOwner(second, async () => {
      await Promise.resolve();
      expect(currentExecutionModeOwner()).toBe(second);
    }),
  ]);
  expect(currentExecutionModeOwner()).toBeUndefined();
});

test('detached work cannot retain YOLO after its invocation has settled', async () => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let detached: Promise<boolean> = Promise.resolve(true);
  await withExecutionMode('yolo', async () => {
    detached = waiting.then(() => isYoloExecution());
  });
  release();
  await expect(detached).rejects.toThrow('Execution mode is no longer current');
});

test('queued work keeps its session owner until that owner is disposed', async () => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let detached: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const owner = { getMode: () => 'yolo' as const, getRevision: () => {
    if (disposed) throw new Error('fixture session disposed');
    return 0;
  } };
  await withExecutionModeOwner(owner, async () => {
    detached = waiting.then(() => currentExecutionModeOwner());
  });
  release();
  expect(await detached).toBe(owner);
  await withExecutionModeOwner(owner, async () => {
    disposed = true;
    expect(currentExecutionModeOwner).toThrow('fixture session disposed');
  });
});
