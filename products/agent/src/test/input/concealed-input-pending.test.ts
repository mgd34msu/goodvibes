import { expect, test } from 'bun:test';
import {
  beginConcealedInputFor, cancelConcealedInputFor, submitConcealedInputFor,
  waitForConcealedSubmission, maskConcealedText, type ConcealedInputHost,
} from '../../input/concealed-input.ts';
import { startCardEntryFlow } from '../../input/commands/payment-card-intake.ts';
import type { CommandContext } from '../../input/command-registry.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function host(): ConcealedInputHost {
  return { prompt: '', cursorPos: 0, concealedInput: null, requestRender: () => {} };
}

test('pending concealed submit keeps typing masked, consumes repeat Enter, and exposes real completion', async () => {
  const h = host(); const gate = deferred(); const calls: string[] = [];
  beginConcealedInputFor(h, { onSubmit: async value => { calls.push(value); await gate.promise; } });
  expect(submitConcealedInputFor(h, 'synthetic-first')).toBe(true);
  h.prompt = 'synthetic-second';
  expect(h.concealedInput).not.toBeNull();
  expect(maskConcealedText(h.prompt)).not.toContain('synthetic');
  expect(submitConcealedInputFor(h, h.prompt)).toBe(true);
  expect(h.concealedInput).not.toBeNull();
  expect(h.prompt).toBe('');
  expect(calls).toEqual(['synthetic-first']);
  const settled = waitForConcealedSubmission(h);
  gate.resolve(); await settled;
  expect(h.concealedInput).toBeNull();
});

function paymentFixture() {
  const h = host(); const prints: string[] = [];
  const context = {
    print: (text: string) => prints.push(text), renderRequest: () => {},
    beginConcealedInput: (request: Parameters<typeof beginConcealedInputFor>[1]) => beginConcealedInputFor(h, request),
  } as unknown as CommandContext;
  startCardEntryFlow(context);
  return { h, prints };
}

test('payment chain offers the next masked field straight away and never prints a typed answer', async () => {
  const f = paymentFixture();
  expect(f.h.concealedInput?.label).toBe('Card label');
  submitConcealedInputFor(f.h, 'synthetic-card-label');
  await waitForConcealedSubmission(f.h);
  expect(f.h.concealedInput?.label).toBe('Card kind (virtual or real; blank for virtual)');
  expect(f.prints.join('\n')).not.toContain('synthetic-card-label');
});

test('payment cancel discards the answers so far and says nothing was sent', async () => {
  const f = paymentFixture();
  submitConcealedInputFor(f.h, 'synthetic-card-label');
  await waitForConcealedSubmission(f.h);
  expect(cancelConcealedInputFor(f.h)).toBe(true);
  expect(f.h.concealedInput).toBeNull();
  expect(f.prints.join('\n')).toContain('Nothing was sent');
  expect(f.prints.join('\n')).not.toContain('synthetic-card-label');
});
