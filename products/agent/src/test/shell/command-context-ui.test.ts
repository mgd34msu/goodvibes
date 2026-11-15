import { describe, expect, test } from 'bun:test';
import { createCommandContextUi } from '../../shell/command-context-ui.ts';
import type { PendingPermissionState } from '../../shell/blocking-input.ts';

function makeUi() {
  let slot: PendingPermissionState | null = null;
  const ui = createCommandContextUi({
    compositor: { resetDiff: () => {} },
    stdout: { write: () => true },
    render: () => {},
    terminalWidth: () => 80,
    setPendingPermission: (pending) => {
      slot = pending;
    },
  });
  return { ui, slot: () => slot, clearSlot: () => { slot = null; } };
}

const ask = (callId: string) => ({ callId, tool: 'write', args: {}, category: 'write' }) as never;

describe('shell/command-context-ui requestPermission', () => {
  test('a second ask waits for the first card instead of replacing it', async () => {
    const { ui, slot, clearSlot } = makeUi();
    const first = ui.requestPermission(ask('a'));
    const second = ui.requestPermission(ask('b'));
    expect(slot()?.callId).toBe('a');

    slot()!.resolve(true, false);
    clearSlot(); // the shell empties the slot after the answer
    expect(await first).toEqual({ approved: true, remember: false });

    await Promise.resolve();
    expect(slot()?.callId).toBe('b');
    slot()!.resolve(false, false);
    expect(await second).toEqual({ approved: false, remember: false });
  });

  test('the same ask raised again replaces its card and both callers get the answer', async () => {
    const { ui, slot } = makeUi();
    const first = ui.requestPermission(ask('a'));
    const again = ui.requestPermission(ask('a'));
    slot()!.resolve(true, true);
    expect(await first).toEqual({ approved: true, remember: true });
    expect(await again).toEqual({ approved: true, remember: true });
  });

  test('an ask decided elsewhere takes its own card down and lets the next one show', async () => {
    const { ui, slot } = makeUi();
    const decided = new AbortController();
    const first = ui.requestPermission(ask('a'), { signal: decided.signal });
    const second = ui.requestPermission(ask('b'));
    expect(slot()?.callId).toBe('a');

    decided.abort();
    expect(await first).toEqual({ approved: false, remember: false });
    expect(slot()?.callId).toBe('b');

    slot()!.resolve(true, false);
    expect(await second).toEqual({ approved: true, remember: false });
  });

  test('an abort for a waiting ask removes it from the queue and leaves the shown card alone', async () => {
    const { ui, slot, clearSlot } = makeUi();
    const first = ui.requestPermission(ask('a'));
    const gone = new AbortController();
    const waiting = ui.requestPermission(ask('b'), { signal: gone.signal });
    gone.abort();
    expect(await waiting).toEqual({ approved: false, remember: false });
    expect(slot()?.callId).toBe('a');

    slot()!.resolve(true, false);
    clearSlot();
    expect(await first).toEqual({ approved: true, remember: false });
    await Promise.resolve();
    expect(slot()).toBeNull();
  });

  test('an abort that arrives after the card was answered does not clear a later card', async () => {
    const { ui, slot, clearSlot } = makeUi();
    const decided = new AbortController();
    const first = ui.requestPermission(ask('a'), { signal: decided.signal });
    slot()!.resolve(true, false);
    clearSlot();
    await first;
    const second = ui.requestPermission(ask('b'));
    decided.abort();
    expect(slot()?.callId).toBe('b');
    slot()!.resolve(true, false);
    await second;
  });
});
